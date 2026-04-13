// @ts-check
import http from "node:http";
import { forward } from "./proxy.js";
import { resolve, setHint } from "./router.js";

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

			// POST /_hint — receive routing hint from hook
			if (req.url === "/_hint" && req.method === "POST") {
				try {
					const hint = JSON.parse(bodyBuffer.toString());
					if (hint.backend) {
						setHint(hint.backend, hint.ttl || 60_000);
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ ok: true, backend: hint.backend }));
					} else {
						res.writeHead(400, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: "missing backend field" }));
					}
				} catch {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "invalid JSON" }));
				}
				return;
			}

			// GET /_status — show current config
			if (req.url === "/_status" && req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						port: config.port,
						defaultBackend: config.defaultBackend,
						backends: Object.keys(config.backends),
					}),
				);
				return;
			}

			// Proxy all other requests
			let body = {};
			try {
				body = JSON.parse(bodyBuffer.toString());
			} catch {
				// Non-JSON request — forward as-is
			}

			const backend = resolve(body.model, config);
			const ts = new Date().toISOString();
			console.log(`[${ts}] ${body.model || "unknown"} -> ${backend.name}`);

			forward(req, res, backend, bodyBuffer);
		});
	});
}
