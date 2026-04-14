// @ts-check

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 * @typedef {{ backend: string, expires: number }} Hint
 */

/** @type {Map<string, Hint>} */
const hints = new Map();

/**
 * Store a routing hint for a specific session with TTL.
 * Also GCs expired entries.
 * @param {string} sessionId
 * @param {string} backend - "glm" or "claude"
 * @param {number} [ttlMs=60000]
 */
export function setHint(sessionId, backend, ttlMs = 60_000) {
	hints.set(sessionId, { backend, expires: Date.now() + ttlMs });
	const now = Date.now();
	for (const [sid, h] of hints) {
		if (h.expires < now) hints.delete(sid);
	}
}

/** Clear all session hints. */
export function clearHints() {
	hints.clear();
}

/**
 * Extract Claude Code session_id from the Anthropic API metadata field.
 * Claude Code encodes {device_id, account_uuid, session_id} as a JSON string
 * inside `metadata.user_id`.
 * @param {unknown} metadata
 * @returns {string | null}
 */
function extractSessionId(metadata) {
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
 * Resolve which backend to route to.
 * Priority: 1) model prefix  2) session hint  3) default
 * @param {string | undefined} model
 * @param {unknown} metadata - request body metadata (for session_id)
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, metadata, config) {
	// 1. Model prefix — explicit user selection via /model always wins
	if (model?.startsWith("glm-")) return config.backends.glm;
	if (model?.startsWith("claude-")) return config.backends.claude;

	// 2. Session-keyed hint from UserPromptSubmit hook
	const sid = extractSessionId(metadata);
	if (sid) {
		const h = hints.get(sid);
		if (h && Date.now() < h.expires) {
			return config.backends[h.backend] ?? config.backends[config.defaultBackend];
		}
	}

	// 3. Default
	return config.backends[config.defaultBackend] || config.backends.claude;
}
