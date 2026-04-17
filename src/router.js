// @ts-check
import fs from "node:fs";

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 * @typedef {{ backend: string, expires: number }} Hint
 */

// Keep alongside /tmp/glm-proxy.log for debug symmetry. Overridable for tests
// or non-standard environments. macOS's os.tmpdir() returns /var/folders/...
// which would split state from the rest of our tmp files; pinning /tmp here.
const BREAKER_STATE_PATH = process.env.GLM_FUP_STATE_PATH || "/tmp/glm-fup-breaker.json";

/** @type {Map<string, Hint>} */
const hints = new Map();

/** @type {Map<string, number>} sessionId → expiresAt (ms epoch) */
const blockedSessions = new Map();

/** @type {Map<string, { verdict: "CODE" | "OTHER", expires: number }>} */
const classifyCache = new Map();

/** @type {{ trippedAt: number | null }} */
const fupBreaker = { trippedAt: null };

// Load persisted breaker state at module load. The proxy may be restarted
// (log rotation, dev reload, OS reboot) while Z.ai's account flag is still
// active — resuming GLM traffic in that state would re-trip 1313 on the
// first request. Reading a plain JSON file once at startup costs nothing
// and makes the cooldown survive restarts.
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
	} catch {
		// No file / invalid JSON / bad shape → start clean.
	}
})();

function persistBreakerState() {
	try {
		fs.writeFileSync(BREAKER_STATE_PATH, JSON.stringify({ trippedAt: fupBreaker.trippedAt }));
	} catch {
		// Non-fatal: in-memory state still works for this process lifetime.
	}
}

// Default block TTL: long enough to survive a burst of turns after overflow,
// short enough that /clear or /compact eventually gets a retry window.
export const DEFAULT_BLOCK_TTL_MS = (() => {
	const v = Number.parseInt(process.env.GLM_BLOCK_TTL_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
})();

// Throttle TTL for classifier verdicts — re-use the same verdict for a session
// for this long to avoid hitting Z.ai on every prompt (FUP 1313 avoidance).
export const CLASSIFY_THROTTLE_MS = (() => {
	const v = Number.parseInt(process.env.GLM_CLASSIFY_THROTTLE_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

// FUP circuit-breaker cooldown. Z.ai error 1313 is an account-level pattern
// flag — the safe recovery is to fully stop GLM traffic so the quiet window
// can elapse without resetting the server-side timer.
export const FUP_COOLDOWN_MS = (() => {
	const v = Number.parseInt(process.env.GLM_FUP_COOLDOWN_MS || "", 10);
	return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
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

/**
 * Record a classifier verdict for a session. Throttle window starts now.
 * @param {string} sessionId
 * @param {"CODE" | "OTHER"} verdict
 * @param {number} [ttlMs=CLASSIFY_THROTTLE_MS]
 */
export function recordClassification(sessionId, verdict, ttlMs = CLASSIFY_THROTTLE_MS) {
	if (!sessionId) return;
	classifyCache.set(sessionId, { verdict, expires: Date.now() + ttlMs });
	const now = Date.now();
	for (const [sid, entry] of classifyCache) {
		if (entry.expires < now) classifyCache.delete(sid);
	}
}

/**
 * @param {string | null | undefined} sessionId
 * @returns {"CODE" | "OTHER" | null}
 */
export function getClassificationVerdict(sessionId) {
	if (!sessionId) return null;
	const entry = classifyCache.get(sessionId);
	if (!entry) return null;
	if (Date.now() >= entry.expires) {
		classifyCache.delete(sessionId);
		return null;
	}
	return entry.verdict;
}

export function clearClassifyCache() {
	classifyCache.clear();
}

/**
 * Trip the FUP breaker. Subsequent GLM-target requests fall back to Claude
 * until the cooldown elapses. Idempotent — repeated calls inside an active
 * cooldown do NOT push the end time out, which matters when multiple 1313
 * responses arrive in close succession (e.g. burst of in-flight requests).
 * isFupTripped() clears expired state first, so a fresh trip after a previous
 * cooldown expires gets a full new window.
 */
export function tripFupBreaker() {
	if (!isFupTripped()) {
		fupBreaker.trippedAt = Date.now();
		persistBreakerState();
	}
}

/**
 * @returns {boolean}
 */
export function isFupTripped() {
	if (fupBreaker.trippedAt == null) return false;
	if (Date.now() - fupBreaker.trippedAt >= FUP_COOLDOWN_MS) {
		fupBreaker.trippedAt = null;
		persistBreakerState();
		return false;
	}
	return true;
}

/**
 * @returns {number} ms remaining in the cooldown, or 0 if not tripped.
 */
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
 *   FUP tripped ∧ glm-target → Claude (account-level flag recovery; see tripFupBreaker)
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
	const targetsGlm = model?.startsWith("glm-") || (hintActive && hint?.backend === "glm");

	if (isFupTripped() && targetsGlm) return config.backends.claude;

	if (sid && isSessionBlocked(sid) && targetsGlm) return config.backends.claude;

	if (model?.startsWith("glm-")) return config.backends.glm;

	if (hintActive && hint) {
		return config.backends[hint.backend] ?? config.backends[config.defaultBackend];
	}

	if (model?.startsWith("claude-")) return config.backends.claude;
	return config.backends[config.defaultBackend] || config.backends.claude;
}
