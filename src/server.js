// @ts-check
import http from "node:http";
import https from "node:https";
import { createSseDetector, isContextLimitByStopReason, isContextLimitError } from "./fallback.js";
import { forward } from "./proxy.js";
import { rewriteModelForGlm } from "./rewrite.js";
import { resolve, setHint } from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

const NON_STREAM_BUFFER_LIMIT = 1024 * 1024; // 1 MB — full response capture
const STREAM_PEEK_LIMIT = 64 * 1024; // 64 KB worth of SSE prelude is plenty

const debugEnabled = () => Boolean(process.env.GLM_DEBUG);
function debug(...args) {
	if (debugEnabled()) console.log(...args);
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function handleHint(res, body) {
	if (!body.session_id || !body.backend) {
		sendJson(res, 400, { error: "missing session_id or backend field" });
		return;
	}
	setHint(body.session_id, body.backend, body.ttl || 60_000);
	sendJson(res, 200, {
		ok: true,
		session_id: body.session_id,
		backend: body.backend,
	});
}

function handleStatus(res, config) {
	sendJson(res, 200, {
		port: config.port,
		defaultBackend: config.defaultBackend,
		glmRoutedModel: config.glmRoutedModel,
		backends: Object.keys(config.backends),
	});
}

function buildHeaders(backend, sourceHeaders, bodyLength, hostname) {
	/** @type {Record<string, string | string[] | undefined>} */
	let headers;
	if (backend.name === "claude") {
		headers = { ...sourceHeaders };
	} else {
		const { authorization: _, ...rest } = sourceHeaders;
		headers = { ...rest, "x-api-key": backend.apiKey };
	}
	headers.host = hostname;
	headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
	headers["content-length"] = String(bodyLength);
	return headers;
}

function buildFallbackBuffer(outboundBody, inboundModel) {
	const { model: _dropped, ...rest } = outboundBody ?? {};
	const restored = inboundModel ? { ...rest, model: inboundModel } : rest;
	return Buffer.from(JSON.stringify(restored));
}

function parseMaybeJson(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return null;
	}
}

function writeBufferedResponse(clientRes, statusCode, headers, bodyBuffer) {
	clientRes.writeHead(statusCode, headers);
	clientRes.end(bodyBuffer);
}

function forwardToClaude(clientReq, clientRes, config, outboundBody, inboundModel, reason) {
	const fallbackBuffer = buildFallbackBuffer(outboundBody, inboundModel);
	console.log(`[ctx-fallback] ${inboundModel || "unknown"} -> claude (${reason})`);
	forward(clientReq, clientRes, config.backends.claude, fallbackBuffer);
}

function glmRequestOptions(clientReq, backend, outboundBuffer) {
	const url = new URL(backend.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;
	return {
		proto,
		options: {
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname,
			method: clientReq.method,
			headers: buildHeaders(backend, clientReq.headers, outboundBuffer.length, url.hostname),
		},
	};
}

function handleGlmUpstreamError(clientRes) {
	return (err) => {
		if (!clientRes.headersSent) {
			sendJson(clientRes, 502, {
				error: { message: `Upstream error: ${err.message}` },
			});
		}
	};
}

function tryGlmNonStreaming(
	clientReq,
	clientRes,
	outboundBody,
	outboundBuffer,
	inboundModel,
	config,
) {
	const backend = config.backends.glm;
	const { proto, options } = glmRequestOptions(clientReq, backend, outboundBuffer);

	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;
		const chunks = [];
		let total = 0;
		let truncated = false;

		upstreamRes.on("data", (chunk) => {
			total += chunk.length;
			if (total > NON_STREAM_BUFFER_LIMIT) {
				truncated = true;
				return;
			}
			chunks.push(chunk);
		});

		upstreamRes.on("end", () => {
			const bodyBuf = Buffer.concat(chunks);
			if (truncated) {
				writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
				return;
			}
			const parsed = parseMaybeJson(bodyBuf);

			if (isContextLimitError(status, parsed)) {
				const snippet = String(parsed?.error?.message || "").slice(0, 80);
				forwardToClaude(
					clientReq,
					clientRes,
					config,
					outboundBody,
					inboundModel,
					`glm 400: ${snippet}`,
				);
				return;
			}
			if (status === 200 && isContextLimitByStopReason(parsed)) {
				forwardToClaude(
					clientReq,
					clientRes,
					config,
					outboundBody,
					inboundModel,
					"glm 200 stop_reason: model_context_window_exceeded",
				);
				return;
			}
			if (status >= 400 && parsed?.error?.message) {
				console.log(`  glm ${status} (no fallback): ${String(parsed.error.message).slice(0, 160)}`);
			}
			writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
		});
	});

	upstream.on("error", handleGlmUpstreamError(clientRes));
	upstream.write(outboundBuffer);
	upstream.end();
}

function tryGlmStreaming(clientReq, clientRes, outboundBody, outboundBuffer, inboundModel, config) {
	const backend = config.backends.glm;
	const { proto, options } = glmRequestOptions(clientReq, backend, outboundBuffer);

	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;

		if (status !== 200) {
			const chunks = [];
			upstreamRes.on("data", (c) => chunks.push(c));
			upstreamRes.on("end", () => {
				const bodyBuf = Buffer.concat(chunks);
				const parsed = parseMaybeJson(bodyBuf);
				if (isContextLimitError(status, parsed)) {
					const snippet = String(parsed?.error?.message || "").slice(0, 80);
					forwardToClaude(
						clientReq,
						clientRes,
						config,
						outboundBody,
						inboundModel,
						`glm 400: ${snippet}`,
					);
					return;
				}
				writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
			});
			return;
		}

		const detector = createSseDetector();
		const prelude = [];
		let preludeBytes = 0;
		let committed = false;

		function commitPassthrough() {
			if (committed) return;
			committed = true;
			clientRes.writeHead(200, upstreamRes.headers);
			for (const chunk of prelude) clientRes.write(chunk);
			upstreamRes.pipe(clientRes);
		}

		upstreamRes.on("data", (chunk) => {
			if (committed) return;
			const asString = chunk.toString("utf8");
			const verdict = detector.feed(asString);

			if (verdict === "context_exceeded") {
				upstreamRes.destroy();
				forwardToClaude(
					clientReq,
					clientRes,
					config,
					outboundBody,
					inboundModel,
					"glm stream stop_reason: model_context_window_exceeded",
				);
				return;
			}

			prelude.push(chunk);
			preludeBytes += chunk.length;

			if (verdict === "normal" || preludeBytes > STREAM_PEEK_LIMIT) {
				commitPassthrough();
			}
		});

		upstreamRes.on("end", () => {
			if (!committed) commitPassthrough();
		});
		upstreamRes.on("error", () => {
			if (!committed && !clientRes.headersSent) {
				sendJson(clientRes, 502, { error: { message: "upstream stream error" } });
			}
		});
	});

	upstream.on("error", handleGlmUpstreamError(clientRes));
	upstream.write(outboundBuffer);
	upstream.end();
}

function handleProxy(req, res, body, bodyBuffer, config) {
	const backend = resolve(body.model, body.metadata, config);
	const inboundModel = body.model || "unknown";

	const stripped = stripAssistantThinking(body);
	let outboundBody = stripped.body;
	let outboundModified = stripped.modified;
	if (stripped.modified) {
		debug("  stripped thinking blocks from assistant history");
	}

	if (backend.name === "glm") {
		const rewritten = rewriteModelForGlm(outboundBody, {
			targetModel: config.glmRoutedModel,
		});
		if (rewritten.modified) {
			outboundBody = rewritten.body;
			outboundModified = true;
		}
	}

	const outboundModel = outboundBody?.model || inboundModel;
	const sameModel = outboundModel === inboundModel;
	const tag = sameModel ? "" : ` [${outboundModel}]`;
	console.log(`[${new Date().toISOString()}] ${inboundModel} -> ${backend.name}${tag}`);
	if (debugEnabled()) {
		debug(
			"  metadata:",
			JSON.stringify(body.metadata),
			"system:",
			Array.isArray(body.system) ? `array[${body.system.length}]` : typeof body.system,
		);
	}

	const outboundBuffer = outboundModified ? Buffer.from(JSON.stringify(outboundBody)) : bodyBuffer;

	if (backend.name === "glm") {
		const isStream = body?.stream === true;
		if (isStream) {
			tryGlmStreaming(req, res, outboundBody, outboundBuffer, body.model, config);
		} else {
			tryGlmNonStreaming(req, res, outboundBody, outboundBuffer, body.model, config);
		}
		return;
	}

	forward(req, res, backend, outboundBuffer);
}

function parseJsonOrEmpty(buffer) {
	try {
		return JSON.parse(buffer.toString());
	} catch {
		return {};
	}
}

/**
 * Create the proxy server.
 * @param {import("./config.js").Config} config
 * @returns {http.Server}
 */
export function createServer(config) {
	return http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const bodyBuffer = Buffer.concat(chunks);

			if (req.url === "/_hint" && req.method === "POST") {
				try {
					handleHint(res, JSON.parse(bodyBuffer.toString()));
				} catch {
					sendJson(res, 400, { error: "invalid JSON" });
				}
				return;
			}

			if (req.url === "/_status" && req.method === "GET") {
				handleStatus(res, config);
				return;
			}

			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config);
		});
	});
}
