import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	clearBlockedSessions,
	clearFupBreaker,
	fupCooldownRemainingMs,
	isFupTripped,
	isSessionBlocked,
	markSessionBlocked,
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

function metaFor(sessionId) {
	return {
		user_id: JSON.stringify({
			device_id: "dev",
			account_uuid: "acc",
			session_id: sessionId,
		}),
	};
}

describe("router", () => {
	beforeEach(() => {
		clearBlockedSessions();
		clearFupBreaker();
	});

	it("routes glm-* models to GLM", () => {
		const backend = resolve("glm-5.1", undefined, config);
		assert.equal(backend.name, "glm");
	});

	it("routes claude-* models to Claude", () => {
		const backend = resolve("claude-opus-4-6", undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("routes claude-haiku-* to Claude always", () => {
		const backend = resolve("claude-haiku-4-6", undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("uses default backend when model is unknown", () => {
		const backend = resolve("unknown-model", undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("uses default backend when model is undefined", () => {
		const backend = resolve(undefined, undefined, config);
		assert.equal(backend.name, "claude");
	});

	describe("session blocking", () => {
		it("blocked session with glm-* model routes to Claude", () => {
			markSessionBlocked("sessA");
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("blocked session with claude-* model still routes to Claude", () => {
			markSessionBlocked("sessA");
			const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("block is isolated per session", () => {
			markSessionBlocked("sessA");
			const a = resolve("glm-5.1", metaFor("sessA"), config);
			const b = resolve("glm-5.1", metaFor("sessB"), config);
			assert.equal(a.name, "claude");
			assert.equal(b.name, "glm");
		});

		it("expired block auto-clears and allows GLM again", () => {
			markSessionBlocked("sessA", 1);
			const start = Date.now();
			while (Date.now() - start < 5) {}
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
			assert.equal(backend.name, "glm");
			assert.equal(isSessionBlocked("sessA"), false);
		});

		it("clearBlockedSessions() resets all", () => {
			markSessionBlocked("sessA");
			markSessionBlocked("sessB");
			clearBlockedSessions();
			assert.equal(isSessionBlocked("sessA"), false);
			assert.equal(isSessionBlocked("sessB"), false);
		});

		it("markSessionBlocked is a no-op for empty sessionId", () => {
			markSessionBlocked("");
			assert.equal(isSessionBlocked(""), false);
		});
	});

	describe("FUP circuit breaker", () => {
		it("starts untripped", () => {
			assert.equal(isFupTripped(), false);
			assert.equal(fupCooldownRemainingMs(), 0);
		});

		it("tripping routes glm-* to Claude", () => {
			tripFupBreaker();
			assert.equal(isFupTripped(), true);
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("tripping does not affect claude-* requests", () => {
			tripFupBreaker();
			const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("clearFupBreaker resets state", () => {
			tripFupBreaker();
			clearFupBreaker();
			assert.equal(isFupTripped(), false);
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
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
