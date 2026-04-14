// @ts-check

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 * @typedef {{ backend: string, expires: number }} Hint
 */

/** @type {Map<string, Hint>} */
const hints = new Map();

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

// Claude Code encodes {device_id, account_uuid, session_id} as a JSON string
// inside body.metadata.user_id.
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
 * Resolve which backend to route a request to. Priority (top-down):
 *   glm-*            → GLM  (explicit user pick)
 *   claude-haiku-*   → Claude  (internal title/summary calls; don't waste GLM quota)
 *   session hint     → hint.backend
 *   claude-*         → Claude  (default tier)
 *   fallback         → config.defaultBackend
 *
 * @param {string | undefined} model
 * @param {unknown} metadata
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, metadata, config) {
	if (model?.startsWith("glm-")) return config.backends.glm;
	if (model?.startsWith("claude-haiku-")) return config.backends.claude;

	const sid = extractSessionId(metadata);
	if (sid) {
		const h = hints.get(sid);
		if (h && Date.now() < h.expires) {
			return config.backends[h.backend] ?? config.backends[config.defaultBackend];
		}
	}

	if (model?.startsWith("claude-")) return config.backends.claude;
	return config.backends[config.defaultBackend] || config.backends.claude;
}
