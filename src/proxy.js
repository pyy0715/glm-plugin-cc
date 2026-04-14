// @ts-check
import http from "node:http";
import https from "node:https";

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
		clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
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
