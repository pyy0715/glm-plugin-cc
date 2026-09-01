// @ts-check
import fs from "node:fs";

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 */

const BREAKER_STATE_PATH = process.env.GLM_FUP_STATE_PATH || "/tmp/glm-fup-breaker.json";

/** @type {{ trippedAt: number | null }} */
const fupBreaker = { trippedAt: null };

(function loadBreakerState() {
	try {
		const raw = fs.readFileSync(BREAKER_STATE_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.trippedAt === "number") {
			const age = Date.now() - parsed.trippedAt;
			if (age >= 0 && age < 24 * 60 * 60_000) {
				fupBreaker.trippedAt = parsed.trippedAt;
			}
		}
	} catch {}
})();

function persistBreakerState() {
	try {
		fs.writeFileSync(BREAKER_STATE_PATH, JSON.stringify({ trippedAt: fupBreaker.trippedAt }));
	} catch {}
}

export const FUP_COOLDOWN_MS = (() => {
	const v = Number.parseInt(process.env.GLM_FUP_COOLDOWN_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
})();

export function tripFupBreaker() {
	if (!isFupTripped()) {
		fupBreaker.trippedAt = Date.now();
		persistBreakerState();
	}
}

/** @returns {boolean} */
export function isFupTripped() {
	if (fupBreaker.trippedAt == null) return false;
	if (Date.now() - fupBreaker.trippedAt >= FUP_COOLDOWN_MS) {
		fupBreaker.trippedAt = null;
		persistBreakerState();
		return false;
	}
	return true;
}

/** @returns {number} ms remaining in the cooldown, or 0 if not tripped. */
export function fupCooldownRemainingMs() {
	if (fupBreaker.trippedAt == null) return 0;
	const remaining = FUP_COOLDOWN_MS - (Date.now() - fupBreaker.trippedAt);
	if (remaining <= 0) {
		fupBreaker.trippedAt = null;
		persistBreakerState();
		return 0;
	}
	return remaining;
}

export function clearFupBreaker() {
	fupBreaker.trippedAt = null;
	persistBreakerState();
}

/**
 * Resolve which backend to route a request to. Priority:
 *   claude-haiku-*     → Claude  (internal ops traffic)
 *   FUP tripped ∧ glm  → Claude  (account-level flag recovery)
 *   glm-*              → GLM     (explicit /model pick)
 *   claude-*           → Claude  (default tier)
 *   fallback           → config.defaultBackend
 *
 * GLM-5.3 and later support a 1M-token context window (parity with
 * Claude's extended context), so there is no context-overflow case to
 * preempt here anymore — see docs/ARCHITECTURE.md.
 *
 * @param {string | undefined} model
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, config) {
	if (model?.startsWith("claude-haiku-")) return config.backends.claude;

	const targetsGlm = model?.startsWith("glm-");

	if (isFupTripped() && targetsGlm) return config.backends.claude;

	if (targetsGlm) return config.backends.glm;

	if (model?.startsWith("claude-")) return config.backends.claude;
	return config.backends[config.defaultBackend] || config.backends.claude;
}
