// @ts-check
import http from "node:http";
import https from "node:https";
import { forward } from "./proxy.js";
import { rewriteModelForGlm } from "./rewrite.js";
import {
	clearFupBreaker,
	fupCooldownRemainingMs,
	isFupTripped,
	resolve,
	tripFupBreaker,
} from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

function debug(...args) {
	if (process.env.GLM_DEBUG) console.log(...args);
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
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

// Clears a breaker that tripped on a false positive — see docs/OPERATIONS.md
// §12.6. Restarting used to be the only way; the file it wrote to persists
// state, but a running process never re-reads a file someone else edited.
function handleClearFup(res) {
	const wasTripped = isFupTripped();
	clearFupBreaker();
	console.log(`[fup-clear] manual reset via /_status/clear-fup (was tripped: ${wasTripped})`);
	sendJson(res, 200, { cleared: true, wasTripped });
}

// Cheap substring sniff for use inside SSE data chunks where we don't have a
// fully-parsed JSON body. Both forms have been observed in Z.ai responses.
// False positives are bounded: prelude window is ≤ 64KB, user content rarely
// looks like either literal.
export function looksLike1313(text) {
	return text.includes('"code":1313') || text.includes('"code":"1313"');
}

const FUP_SNIFF_LIMIT = 64 * 1024;

/**
 * Forward a request to GLM, watching the response only far enough to trip
 * the FUP breaker on a 1313 error. Once past that check (or once the sniff
 * window is exhausted), the rest of the response — including the entire
 * body for streaming replies — is piped straight to the client unmodified.
 *
 * GLM-5.3 and later carry a 1M-token context window, matching Claude's
 * extended context, so there is no overflow case to detect or fall back
 * from here anymore — see docs/ARCHITECTURE.md.
 */
function forwardToGlm(clientReq, clientRes, backend, outboundBuffer) {
	const url = new URL(backend.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;

	const { authorization: _auth, ...rest } = clientReq.headers;
	const headers = {
		...rest,
		"x-api-key": backend.apiKey,
		host: url.hostname,
		"anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
		"content-length": String(outboundBuffer.length),
	};

	const upstream = proto.request(
		{
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: url.pathname,
			method: clientReq.method,
			headers,
		},
		(upstreamRes) => {
			const status = upstreamRes.statusCode || 502;

			if (status < 400) {
				clientRes.writeHead(status, upstreamRes.headers);
				upstreamRes.pipe(clientRes);
				return;
			}

			// Error response: sniff a bounded prefix for the FUP code before
			// piping the rest through untouched. We still forward the full
			// body to the client either way — this only decides whether we
			// also trip the breaker.
			clientRes.writeHead(status, upstreamRes.headers);
			let sniffed = 0;
			let sniffText = "";
			let tripped = false;

			upstreamRes.on("data", (chunk) => {
				if (!tripped && sniffed < FUP_SNIFF_LIMIT) {
					sniffText += chunk.toString("utf8");
					sniffed += chunk.length;
					if (looksLike1313(sniffText)) {
						tripFupBreaker();
						console.log("  glm 1313 FUP tripped (error response)");
						tripped = true;
					}
				}
				clientRes.write(chunk);
			});
			upstreamRes.on("end", () => clientRes.end());
		},
	);

	upstream.on("error", (err) => {
		if (!clientRes.headersSent) {
			sendJson(clientRes, 502, { error: { message: `Upstream error: ${err.message}` } });
		}
	});
	upstream.write(outboundBuffer);
	upstream.end();
}

function handleProxy(req, res, body, bodyBuffer, config) {
	const backend = resolve(body.model, config);
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
		forwardToGlm(req, res, backend, outboundBuffer);
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

			if (req.url === "/_status" && req.method === "GET") {
				handleStatus(res, config);
				return;
			}
			if (req.url === "/_status/clear-fup" && req.method === "POST") {
				handleClearFup(res);
				return;
			}
			handleProxy(req, res, parseJsonOrEmpty(bodyBuffer), bodyBuffer, config);
		});
	});
}
