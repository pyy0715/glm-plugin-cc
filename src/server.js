// @ts-check
import http from "node:http";
import { forward } from "./proxy.js";
import { rewriteModelForGlm } from "./rewrite.js";
import { resolve, setHint } from "./router.js";
import { stripAssistantThinking } from "./sanitize.js";

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
