// @ts-check
import fs from "node:fs";

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 */

const BREAKER_STATE_PATH = process.env.GLM_FUP_STATE_PATH || "/tmp/glm-fup-breaker.json";

/** @type {Map<string, number>} sessionId → expiresAt (ms epoch) */
const blockedSessions = new Map();

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

export const DEFAULT_BLOCK_TTL_MS = (() => {
	const v = Number.parseInt(process.env.GLM_BLOCK_TTL_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
})();

export const FUP_COOLDOWN_MS = (() => {
	const v = Number.parseInt(process.env.GLM_FUP_COOLDOWN_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
})();

/**
 * Remember that GLM already rejected this session for context overflow.
 * @param {string} sessionId
 * @param {number} [ttlMs=DEFAULT_BLOCK_TTL_MS]
 */
export function markSessionBlocked(sessionId, ttlMs = DEFAULT_BLOCK_TTL_MS) {
	if (!sessionId) return;
	blockedSessions.set(sessionId, Date.now() + ttlMs);
	const now = Date.now();
	for (const [sid, exp] of blockedSessions) {
		if (exp < now) blockedSessions.delete(sid);
	}
}

/**
 * @param {string | null | undefined} sessionId
 * @returns {boolean}
 */
export function isSessionBlocked(sessionId) {
	if (!sessionId) return false;
	const exp = blockedSessions.get(sessionId);
	if (!exp) return false;
	if (Date.now() >= exp) {
		blockedSessions.delete(sessionId);
		return false;
	}
	return true;
}

export function clearBlockedSessions() {
	blockedSessions.clear();
}

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
 * @param {unknown} metadata
 * @returns {string | null}
 */
export function extractSessionId(metadata) {
	try {
		const m = /** @type {{ user_id?: unknown } | undefined } */ (metadata);
		const u = m?.user_id;
		if (!u) return null;
		const parsed = typeof u === "string" ? JSON.parse(u) : u;
		return parsed?.session_id ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve which backend to route a request to. Priority:
 *   claude-haiku-*     → Claude  (internal ops traffic)
 *   FUP tripped ∧ glm  → Claude  (account-level flag recovery)
 *   blocked ∧ glm      → Claude  (session already overflowed)
 *   glm-*              → GLM     (explicit /model pick)
 *   claude-*           → Claude  (default tier)
 *   fallback           → config.defaultBackend
 *
 * @param {string | undefined} model
 * @param {unknown} metadata
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, metadata, config) {
	if (model?.startsWith("claude-haiku-")) return config.backends.claude;

	const sid = extractSessionId(metadata);
	const targetsGlm = model?.startsWith("glm-");

	if (isFupTripped() && targetsGlm) return config.backends.claude;

	if (sid && isSessionBlocked(sid) && targetsGlm) return config.backends.claude;

	if (targetsGlm) return config.backends.glm;

	if (model?.startsWith("claude-")) return config.backends.claude;
	return config.backends[config.defaultBackend] || config.backends.claude;
}
