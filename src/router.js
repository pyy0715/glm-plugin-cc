// @ts-check

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 * @typedef {{ backend: string, expires: number }} Hint
 */

/** @type {Map<string, Hint>} */
const hints = new Map();

/** @type {Map<string, number>} sessionId → expiresAt (ms epoch) */
const blockedSessions = new Map();

// Default block TTL: long enough to survive a burst of turns after overflow,
// short enough that /clear or /compact eventually gets a retry window.
export const DEFAULT_BLOCK_TTL_MS = (() => {
	const v = Number.parseInt(process.env.GLM_BLOCK_TTL_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
})();

/**
 * Store a session-scoped routing hint. Also GCs expired entries.
 * @param {string} sessionId
 * @param {string} backend
 * @param {number} [ttlMs=60000]
 */
export function setHint(sessionId, backend, ttlMs = 60_000) {
	hints.set(sessionId, { backend, expires: Date.now() + ttlMs });
	const now = Date.now();
	for (const [sid, h] of hints) {
		if (h.expires < now) hints.delete(sid);
	}
}

export function clearHints() {
	hints.clear();
}

/**
 * Remember that GLM already rejected this session for context overflow, so
 * subsequent GLM-bound turns can skip the wasted round-trip and go straight
 * to Claude. TTL lets /clear or /compact eventually re-enable GLM.
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

// Claude Code encodes {device_id, account_uuid, session_id} as a JSON string
// inside body.metadata.user_id.
/**
 * @param {unknown} metadata
 * @returns {string | null}
 */
export function extractSessionId(metadata) {
	try {
		const m = /** @type {{ user_id?: unknown } | undefined} */ (metadata);
		const u = m?.user_id;
		if (!u) return null;
		const parsed = typeof u === "string" ? JSON.parse(u) : u;
		return parsed?.session_id ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve which backend to route a request to. Priority (top-down):
 *   claude-haiku-*          → Claude  (internal title/summary calls; don't waste GLM quota)
 *   blocked ∧ glm-target    → Claude  (reactive learning: session already got overflow)
 *   glm-*                   → GLM     (explicit user pick)
 *   session hint            → hint.backend
 *   claude-*                → Claude  (default tier)
 *   fallback                → config.defaultBackend
 *
 * @param {string | undefined} model
 * @param {unknown} metadata
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, metadata, config) {
	if (model?.startsWith("claude-haiku-")) return config.backends.claude;

	const sid = extractSessionId(metadata);
	const hint = sid ? hints.get(sid) : undefined;
	const hintActive = !!(hint && Date.now() < hint.expires);

	if (sid && isSessionBlocked(sid)) {
		const targetsGlm = model?.startsWith("glm-") || (hintActive && hint?.backend === "glm");
		if (targetsGlm) return config.backends.claude;
	}

	if (model?.startsWith("glm-")) return config.backends.glm;

	if (hintActive && hint) {
		return config.backends[hint.backend] ?? config.backends[config.defaultBackend];
	}

	if (model?.startsWith("claude-")) return config.backends.claude;
	return config.backends[config.defaultBackend] || config.backends.claude;
}
