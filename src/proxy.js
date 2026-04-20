// @ts-check
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

/**
 * Forward a request to the upstream backend. Claude gets the original auth
 * headers (OAuth passthrough); GLM gets x-api-key swapped in. Response is
 * piped back as-is, so SSE streams work transparently.
 *
 * @param {http.IncomingMessage} clientReq
 * @param {http.ServerResponse} clientRes
 * @param {import("./config.js").Backend} backend
 * @param {Buffer} bodyBuffer
 */
export function forward(clientReq, clientRes, backend, bodyBuffer) {
	const url = new URL(backend.baseUrl + clientReq.url);
	const proto = url.protocol === "https:" ? https : http;

	/** @type {Record<string, string | string[] | undefined>} */
	let headers;
	if (backend.name === "claude") {
		headers = { ...clientReq.headers };
	} else {
		const { authorization: _, ...rest } = clientReq.headers;
		headers = { ...rest, "x-api-key": backend.apiKey };
	}

	headers.host = url.hostname;
	headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
	headers["content-length"] = String(bodyBuffer.length);

	const options = {
		hostname: url.hostname,
		port: url.port || (url.protocol === "https:" ? 443 : 80),
		path: url.pathname,
		method: clientReq.method,
		headers,
	};

	const upstream = proto.request(options, (upstreamRes) => {
		const status = upstreamRes.statusCode || 502;
		if (status === 400 && process.env.GLM_DUMP_400) {
			const chunks = [];
			upstreamRes.on("data", (c) => chunks.push(c));
			upstreamRes.on("end", () => {
				const resBuf = Buffer.concat(chunks);
				dump400({ backend: backend.name, reqBody: bodyBuffer, resBody: resBuf });
				if (!clientRes.headersSent) {
					clientRes.writeHead(status, upstreamRes.headers);
				}
				clientRes.end(resBuf);
			});
			return;
		}
		clientRes.writeHead(status, upstreamRes.headers);
		upstreamRes.pipe(clientRes);
	});

	upstream.on("error", (err) => {
		if (!clientRes.headersSent) {
			clientRes.writeHead(502, { "content-type": "application/json" });
			clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
		}
	});

	upstream.write(bodyBuffer);
	upstream.end();
}

export function dump400({ backend, reqBody, resBody }) {
	if (!process.env.GLM_DUMP_400) return;
	try {
		const dir = process.env.GLM_DUMP_DIR || "/tmp";
		const ts = Date.now();
		const file = path.join(dir, `glm-req-400-${backend}-${ts}.json`);
		let parsedReq;
		try {
			parsedReq = JSON.parse(reqBody.toString("utf8"));
		} catch {
			parsedReq = { _raw: reqBody.toString("utf8") };
		}
		let parsedRes;
		try {
			parsedRes = JSON.parse(resBody.toString("utf8"));
		} catch {
			parsedRes = { _raw: resBody.toString("utf8") };
		}
		fs.writeFileSync(file, JSON.stringify({ backend, request: parsedReq, response: parsedRes }, null, 2));
		console.log(`  dumped 400 -> ${file}`);
	} catch (err) {
		console.error("  dump400 failed:", err?.message || err);
	}
}
