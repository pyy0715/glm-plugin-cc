import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	clearFupBreaker,
	fupCooldownRemainingMs,
	isFupTripped,
	resolve,
	tripFupBreaker,
} from "../src/router.js";

const config = {
	port: 4000,
	defaultBackend: "claude",
	backends: {
		claude: { name: "claude", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" },
		glm: { name: "glm", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "glm-test" },
	},
};

describe("router", () => {
	beforeEach(() => {
		clearFupBreaker();
	});

	it("routes glm-* models to GLM", () => {
		const backend = resolve("glm-5.3-flash", config);
		assert.equal(backend.name, "glm");
	});

	it("routes claude-* models to Claude", () => {
		const backend = resolve("claude-opus-4-6", config);
		assert.equal(backend.name, "claude");
	});

	it("routes claude-haiku-* to Claude always", () => {
		const backend = resolve("claude-haiku-4-6", config);
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

	describe("FUP circuit breaker", () => {
		it("starts untripped", () => {
			assert.equal(isFupTripped(), false);
			assert.equal(fupCooldownRemainingMs(), 0);
		});

		it("tripping routes glm-* to Claude", () => {
			tripFupBreaker();
			assert.equal(isFupTripped(), true);
			const backend = resolve("glm-5.3-flash", config);
			assert.equal(backend.name, "claude");
		});

		it("tripping does not affect claude-* requests", () => {
			tripFupBreaker();
			const backend = resolve("claude-opus-4-6", config);
			assert.equal(backend.name, "claude");
		});

		it("clearFupBreaker resets state", () => {
			tripFupBreaker();
			clearFupBreaker();
			assert.equal(isFupTripped(), false);
			const backend = resolve("glm-5.3-flash", config);
			assert.equal(backend.name, "glm");
		});

		it("cooldownRemainingMs decreases over time", () => {
			tripFupBreaker();
			const first = fupCooldownRemainingMs();
			assert.ok(first > 0);
			const start = Date.now();
			while (Date.now() - start < 5) {}
			const second = fupCooldownRemainingMs();
			assert.ok(second < first);
		});

		it("tripFupBreaker is idempotent within an active cooldown", () => {
			tripFupBreaker();
			const firstTripped = fupCooldownRemainingMs();
			const start = Date.now();
			while (Date.now() - start < 5) {}
			tripFupBreaker();
			const secondTripped = fupCooldownRemainingMs();
			assert.ok(secondTripped < firstTripped);
		});
	});
});
