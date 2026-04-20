// @ts-check
import http from "node:http";
import https from "node:https";
import { createSseDetector, isContextLimitByStopReason, isContextLimitError } from "./fallback.js";
import { dump400, forward } from "./proxy.js";
import { rewriteModelForGlm } from "./rewrite.js";
import {
	DEFAULT_BLOCK_TTL_MS,
	extractSessionId,
	fupCooldownRemainingMs,
	getClassificationVerdict,
	isFupTripped,
	markSessionBlocked,
	recordClassification,
	resolve,
	setHint,
	tripFupBreaker,
} from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

const NON_STREAM_BUFFER_LIMIT = 1024 * 1024;
const STREAM_PEEK_LIMIT = 64 * 1024;

function debug(...args) {
	if (process.env.GLM_DEBUG) console.log(...args);
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function writeBufferedResponse(clientRes, status, headers, bodyBuffer) {
	clientRes.writeHead(status, headers);
	clientRes.end(bodyBuffer);
}

function handleHint(res, body) {
	if (!body.session_id || !body.backend) {
		sendJson(res, 400, { error: "missing session_id or backend field" });
		return;
	}
	setHint(body.session_id, body.backend, body.ttl || 60_000);
	sendJson(res, 200, { ok: true, session_id: body.session_id, backend: body.backend });
}

function handleStatus(res, config) {
	sendJson(res, 200, {
		port: config.port,
		defaultBackend: config.defaultBackend,
		glmRoutedModel: config.glmRoutedModel,
		backends: Object.keys(config.backends),
		fupBreaker: {
			tripped: isFupTripped(),
			cooldownRemainingMs: fupCooldownRemainingMs(),
		},
	});
}

// Claude Code session IDs are UUIDs (~36 chars); cap well above that to
// reject accidental or malicious oversize keys that would grow the Map.
const MAX_SESSION_ID_LEN = 128;

function handleShouldClassify(res, url) {
	const raw = url.searchParams.get("session_id") || "";
	const sessionId = raw.length > MAX_SESSION_ID_LEN ? "" : raw;
	if (isFupTripped()) {
		sendJson(res, 200, {
			skip: true,
			reason: "tripped",
			cooldownRemainingMs: fupCooldownRemainingMs(),
		});
		return;
	}
	const verdict = getClassificationVerdict(sessionId);
	if (verdict) {
		sendJson(res, 200, { skip: true, reason: "throttled", cachedVerdict: verdict });
		return;
	}
	sendJson(res, 200, { skip: false });
}

function handleClassified(res, body) {
	const sid = typeof body.session_id === "string" ? body.session_id : "";
	if (!sid || sid.length > MAX_SESSION_ID_LEN) {
		sendJson(res, 400, { error: "missing or oversized session_id" });
		return;
	}
	if (body.verdict !== "CODE" && body.verdict !== "OTHER") {
		sendJson(res, 400, { error: "invalid verdict" });
		return;
	}
	recordClassification(sid, body.verdict);
	sendJson(res, 200, { ok: true });
}

// Z.ai error code 1313 = Fair Usage Policy flag (account-level). Trip the
// breaker so resolve() drains GLM-bound traffic until the quiet window
// elapses. Accepts numeric or string codes; Z.ai has historically used both.
export function maybeTripOnFupError(parsed, label) {
	const code = parsed?.error?.code;
	if (code === 1313 || code === "1313") {
		tripFupBreaker();
		const msg = String(parsed?.error?.message || "").slice(0, 120);
		console.log(`  glm 1313 FUP tripped (${label}): ${msg}`);
		return true;
	}
	return false;
}

// Cheap substring sniff for use inside SSE data chunks where we don't have a
// fully-parsed JSON body. Both forms have been observed in Z.ai responses.
// False positives are bounded: prelude window is ≤ 64KB, user content rarely
// looks like either literal.
export function looksLike1313(text) {
	return text.includes('"code":1313') || text.includes('"code":"1313"');
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

// Restore the user's original model so the Claude backend accepts the body
// after we rewrote it to glm-5.1 for the GLM attempt.
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

function forwardToClaude(clientReq, clientRes, config, outboundBody, inboundModel, reason) {
	const fallbackBuffer = buildFallbackBuffer(outboundBody, inboundModel);
	console.log(`[ctx-fallback] ${inboundModel || "unknown"} -> claude (${reason})`);
	forward(clientReq, clientRes, config.backends.claude, fallbackBuffer);
}

// Record the overflowing session so subsequent GLM-bound turns from the same
// session skip the wasted GLM round-trip (router preempts them to Claude).
function recordOverflowAndFallback(
	clientReq,
	clientRes,
	config,
	outboundBody,
	inboundModel,
	reason,
) {
	const sid = extractSessionId(outboundBody?.metadata);
	if (sid) {
		markSessionBlocked(sid);
		console.log(`[session-block] sid=${sid.slice(0, 8)} ttl=${DEFAULT_BLOCK_TTL_MS}ms`);
	}
	forwardToClaude(clientReq, clientRes, config, outboundBody, inboundModel, reason);
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

function onUpstreamError(clientRes) {
	return (err) => {
		if (!clientRes.headersSent) {
			sendJson(clientRes, 502, { error: { message: `Upstream error: ${err.message}` } });
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
	const { proto, options } = glmRequestOptions(clientReq, config.backends.glm, outboundBuffer);

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
				recordOverflowAndFallback(
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
				recordOverflowAndFallback(
					clientReq,
					clientRes,
					config,
					outboundBody,
					inboundModel,
					"glm 200 stop_reason: model_context_window_exceeded",
				);
				return;
			}
			if (status >= 400) {
				maybeTripOnFupError(parsed, "non-stream");
				if (parsed?.error?.message) {
					console.log(
						`  glm ${status} (no fallback): ${String(parsed.error.message).slice(0, 160)}`,
					);
				}
				if (status === 400) {
					dump400({ backend: "glm", reqBody: outboundBuffer, resBody: bodyBuf });
				}
			}
			writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
		});
	});

	upstream.on("error", onUpstreamError(clientRes));
	upstream.write(outboundBuffer);
	upstream.end();
}

function tryGlmStreaming(clientReq, clientRes, outboundBody, outboundBuffer, inboundModel, config) {
	const { proto, options } = glmRequestOptions(clientReq, config.backends.glm, outboundBuffer);

	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;

		// Non-200 streaming replies aren't streams at all — buffer and reuse
		// the same context-limit / passthrough logic the non-stream path has.
		if (status !== 200) {
			const chunks = [];
			upstreamRes.on("data", (c) => chunks.push(c));
			upstreamRes.on("end", () => {
				const bodyBuf = Buffer.concat(chunks);
				const parsed = parseMaybeJson(bodyBuf);
				if (isContextLimitError(status, parsed)) {
					const snippet = String(parsed?.error?.message || "").slice(0, 80);
					recordOverflowAndFallback(
						clientReq,
						clientRes,
						config,
						outboundBody,
						inboundModel,
						`glm 400: ${snippet}`,
					);
					return;
				}
				if (status >= 400) {
					maybeTripOnFupError(parsed, "stream");
					if (status === 400) {
						dump400({ backend: "glm", reqBody: outboundBuffer, resBody: bodyBuf });
					}
				}
				writeBufferedResponse(clientRes, status, upstreamRes.headers, bodyBuf);
			});
			return;
		}

		// 200 SSE: buffer the prelude until the detector commits. We cannot
		// write to the client before committing, because once writeHead fires
		// we can't roll back to the Claude fallback.
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
			const text = chunk.toString("utf8");
			const verdict = detector.feed(text);

			if (verdict === "context_exceeded") {
				upstreamRes.destroy();
				recordOverflowAndFallback(
					clientReq,
					clientRes,
					config,
					outboundBody,
					inboundModel,
					"glm stream stop_reason: model_context_window_exceeded",
				);
				return;
			}

			// Z.ai sometimes returns 200 + SSE `event: error` carrying a 1313.
			// Detect in the prelude window (before committing to passthrough)
			// so we still trip the breaker; the bytes are passed through so
			// the user sees the actual error message once.
			if (!committed && looksLike1313(text)) {
				tripFupBreaker();
				console.log("  glm 1313 FUP tripped (200-stream prelude)");
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

	upstream.on("error", onUpstreamError(clientRes));
	upstream.write(outboundBuffer);
	upstream.end();
}

function handleProxy(req, res, body, bodyBuffer, config) {
	const backend = resolve(body.model, body.metadata, config);
	const inboundModel = body.model || "unknown";

	const stripped = stripAssistantThinking(body);
	let outboundBody = stripped.body;
	let outboundModified = stripped.modified;
	if (stripped.modified) debug("  stripped thinking blocks from assistant history");

	if (backend.name === "glm") {
		const rewritten = rewriteModelForGlm(outboundBody, { targetModel: config.glmRoutedModel });
		if (rewritten.modified) {
			outboundBody = rewritten.body;
			outboundModified = true;
		}
	}

	const outboundModel = outboundBody?.model || inboundModel;
	const tag = outboundModel === inboundModel ? "" : ` [${outboundModel}]`;
	console.log(`[${new Date().toISOString()}] ${inboundModel} -> ${backend.name}${tag}`);
	debug(
		"  metadata:",
		JSON.stringify(body.metadata),
		"system:",
		Array.isArray(body.system) ? `array[${body.system.length}]` : typeof body.system,
	);

	const outboundBuffer = outboundModified ? Buffer.from(JSON.stringify(outboundBody)) : bodyBuffer;

	if (backend.name === "glm") {
		const run = body?.stream === true ? tryGlmStreaming : tryGlmNonStreaming;
		run(req, res, outboundBody, outboundBuffer, body.model, config);
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
			if (req.url === "/_classified" && req.method === "POST") {
				try {
					handleClassified(res, JSON.parse(bodyBuffer.toString()));
				} catch {
					sendJson(res, 400, { error: "invalid JSON" });
				}
				return;
			}
			if (req.method === "GET" && req.url?.startsWith("/_should-classify")) {
				const url = new URL(req.url, "http://localhost");
				handleShouldClassify(res, url);
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
