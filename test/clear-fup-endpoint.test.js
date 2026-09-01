import { strict as assert } from "node:assert";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { clearFupBreaker, isFupTripped, tripFupBreaker } from "../src/router.js";
import { createServer } from "../src/server.js";

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function post(port, path) {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST" }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

const config = {
	port: 0,
	defaultBackend: "claude",
	glmRoutedModel: "glm-5.3-flash",
	backends: {
		claude: { name: "claude", baseUrl: "https://api.anthropic.com", apiKey: "" },
		glm: { name: "glm", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "" },
	},
};

describe("POST /_status/clear-fup", () => {
	let server;
	let port;

	before(async () => {
		server = createServer(config);
		port = await listen(server);
	});

	after(() => {
		server.close();
		clearFupBreaker();
	});

	beforeEach(() => {
		clearFupBreaker();
	});

	it("clears an active trip and reports wasTripped: true", async () => {
		tripFupBreaker();
		assert.equal(isFupTripped(), true);

		const res = await post(port, "/_status/clear-fup");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { cleared: true, wasTripped: true });
		assert.equal(isFupTripped(), false);
	});

	it("is a no-op when the breaker wasn't tripped, and reports wasTripped: false", async () => {
		assert.equal(isFupTripped(), false);

		const res = await post(port, "/_status/clear-fup");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { cleared: true, wasTripped: false });
		assert.equal(isFupTripped(), false);
	});
});
