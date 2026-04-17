import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	clearBlockedSessions,
	clearClassifyCache,
	clearFupBreaker,
	clearHints,
	fupCooldownRemainingMs,
	getClassificationVerdict,
	isFupTripped,
	isSessionBlocked,
	markSessionBlocked,
	recordClassification,
	resolve,
	setHint,
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

// Claude Code encodes session_id inside metadata.user_id as a JSON string.
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
		clearHints();
		clearBlockedSessions();
		clearClassifyCache();
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

	it("uses default backend when model is unknown", () => {
		const backend = resolve("unknown-model", undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("uses default backend when model is undefined", () => {
		const backend = resolve(undefined, undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("glm-* prefix wins over session hint (explicit opt-in)", () => {
		setHint("sessA", "claude");
		const backend = resolve("glm-5.1", metaFor("sessA"), config);
		assert.equal(backend.name, "glm");
	});

	it("session hint overrides claude-* default model", () => {
		setHint("sessA", "glm");
		const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
		assert.equal(backend.name, "glm");
	});

	it("claude-haiku-* stays on claude even with glm hint (internal haiku)", () => {
		setHint("sessA", "glm");
		const backend = resolve("claude-haiku-4-6", metaFor("sessA"), config);
		assert.equal(backend.name, "claude");
	});

	it("session hint redirects claude-* model to claude when hint=claude", () => {
		setHint("sessA", "claude");
		const backend = resolve("claude-sonnet-4-6", metaFor("sessA"), config);
		assert.equal(backend.name, "claude");
	});

	it("falls back to claude-* when no hint is set", () => {
		const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
		assert.equal(backend.name, "claude");
	});

	it("uses session hint when model has no known prefix", () => {
		setHint("sessA", "glm");
		const backend = resolve("some-model", metaFor("sessA"), config);
		assert.equal(backend.name, "glm");
	});

	it("isolates hints per session — no cross-session pollution", () => {
		setHint("sessA", "glm");
		const a = resolve("some-model", metaFor("sessA"), config);
		const b = resolve("some-model", metaFor("sessB"), config);
		assert.equal(a.name, "glm");
		assert.equal(b.name, "claude");
	});

	it("falls back to default when metadata is undefined", () => {
		setHint("sessA", "glm");
		const backend = resolve("some-model", undefined, config);
		assert.equal(backend.name, "claude");
	});

	it("falls back to default when user_id is not valid JSON", () => {
		setHint("sessA", "glm");
		const backend = resolve("some-model", { user_id: "not-json-garbage" }, config);
		assert.equal(backend.name, "claude");
	});

	it("handles user_id that is already an object (not stringified)", () => {
		setHint("sessA", "glm");
		const backend = resolve("some-model", { user_id: { session_id: "sessA" } }, config);
		assert.equal(backend.name, "glm");
	});

	it("ignores expired hint", () => {
		setHint("sessA", "glm", 1); // 1ms TTL
		const start = Date.now();
		while (Date.now() - start < 5) {} // busy wait 5ms
		const backend = resolve("some-model", metaFor("sessA"), config);
		assert.equal(backend.name, "claude");
	});

	it("falls back to default when hint backend name is unknown", () => {
		setHint("sessA", "nonexistent-backend");
		const backend = resolve("some-model", metaFor("sessA"), config);
		assert.equal(backend.name, "claude");
	});

	describe("session blocking (reactive overflow learning)", () => {
		it("blocked session with glm hint routes to Claude", () => {
			setHint("sessA", "glm");
			markSessionBlocked("sessA");
			const backend = resolve("claude-opus-4-6[1m]", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("block overrides explicit glm-* model", () => {
			markSessionBlocked("sessA");
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("block does not affect sessions without glm target", () => {
			// No hint, no glm-* model — blocking is irrelevant, follows default path
			markSessionBlocked("sessA");
			const backend = resolve("claude-opus-4-6[1m]", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("block is isolated per session", () => {
			setHint("sessA", "glm");
			setHint("sessB", "glm");
			markSessionBlocked("sessA");
			const a = resolve("claude-opus-4-6", metaFor("sessA"), config);
			const b = resolve("claude-opus-4-6", metaFor("sessB"), config);
			assert.equal(a.name, "claude");
			assert.equal(b.name, "glm");
		});

		it("expired block auto-clears and allows GLM again", () => {
			setHint("sessA", "glm");
			markSessionBlocked("sessA", 1); // 1ms TTL
			const start = Date.now();
			while (Date.now() - start < 5) {} // busy wait 5ms
			const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
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

	describe("classifier throttle cache", () => {
		it("returns null when nothing recorded", () => {
			assert.equal(getClassificationVerdict("sessA"), null);
		});

		it("stores and retrieves a verdict", () => {
			recordClassification("sessA", "CODE");
			assert.equal(getClassificationVerdict("sessA"), "CODE");
		});

		it("expires after TTL", () => {
			recordClassification("sessA", "CODE", 1);
			const start = Date.now();
			while (Date.now() - start < 5) {}
			assert.equal(getClassificationVerdict("sessA"), null);
		});

		it("is isolated per session", () => {
			recordClassification("sessA", "CODE");
			recordClassification("sessB", "OTHER");
			assert.equal(getClassificationVerdict("sessA"), "CODE");
			assert.equal(getClassificationVerdict("sessB"), "OTHER");
		});

		it("ignores empty sessionId", () => {
			recordClassification("", "CODE");
			assert.equal(getClassificationVerdict(""), null);
		});
	});

	describe("FUP circuit breaker", () => {
		it("starts untripped", () => {
			assert.equal(isFupTripped(), false);
			assert.equal(fupCooldownRemainingMs(), 0);
		});

		it("tripping routes glm-* to claude", () => {
			tripFupBreaker();
			assert.equal(isFupTripped(), true);
			const backend = resolve("glm-5.1", metaFor("sessA"), config);
			assert.equal(backend.name, "claude");
		});

		it("tripping routes glm-hinted sessions to claude", () => {
			tripFupBreaker();
			setHint("sessA", "glm");
			const backend = resolve("claude-opus-4-6", metaFor("sessA"), config);
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
			// Second call should NOT reset the window; remaining should be less,
			// not equal or greater.
			tripFupBreaker();
			const secondTripped = fupCooldownRemainingMs();
			assert.ok(secondTripped < firstTripped);
		});
	});
});
