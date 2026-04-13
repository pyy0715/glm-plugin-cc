import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { clearHint, resolve, setHint } from "../src/router.js";

const config = {
	port: 4000,
	defaultBackend: "claude",
	backends: {
		claude: { name: "claude", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" },
		glm: { name: "glm", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "glm-test" },
	},
};

describe("router", () => {
	beforeEach(() => clearHint());

	it("routes glm-* models to GLM", () => {
		const backend = resolve("glm-5.1", config);
		assert.equal(backend.name, "glm");
	});

	it("routes claude-* models to Claude", () => {
		const backend = resolve("claude-opus-4-6", config);
		assert.equal(backend.name, "claude");
	});

	it("uses default backend when model is unknown", () => {
		const backend = resolve("unknown-model", config);
		assert.equal(backend.name, "claude");
	});

	it("uses default backend when model is undefined", () => {
		const backend = resolve(undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("model prefix takes priority over hint", () => {
		setHint("glm");
		const backend = resolve("claude-opus-4-6", config);
		assert.equal(backend.name, "claude");
	});

	it("uses hint when model has no known prefix", () => {
		setHint("glm");
		const backend = resolve("some-model", config);
		assert.equal(backend.name, "glm");
	});

	it("ignores expired hint", () => {
		setHint("glm", 1); // 1ms TTL
		// Wait for expiry
		const start = Date.now();
		while (Date.now() - start < 5) {} // busy wait 5ms
		const backend = resolve("some-model", config);
		assert.equal(backend.name, "claude");
	});
});
