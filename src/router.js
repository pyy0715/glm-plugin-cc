// @ts-check

/**
 * @typedef {import("./config.js").Backend} Backend
 * @typedef {import("./config.js").Config} Config
 * @typedef {{ backend: string, expires: number }} Hint
 */

/** @type {Hint | null} */
let currentHint = null;

/**
 * Store a routing hint with TTL.
 * @param {string} backend - "glm" or "claude"
 * @param {number} [ttlMs=60000]
 */
export function setHint(backend, ttlMs = 60_000) {
	currentHint = { backend, expires: Date.now() + ttlMs };
}

/** Clear the current hint. */
export function clearHint() {
	currentHint = null;
}

/**
 * Resolve which backend to route to.
 * Priority: 1) model prefix  2) hook hint  3) default
 * @param {string | undefined} model - model field from request body
 * @param {Config} config
 * @returns {Backend}
 */
export function resolve(model, config) {
	// 1. Model prefix — explicit user selection via /model always wins
	if (model?.startsWith("glm-")) return config.backends.glm;
	if (model?.startsWith("claude-")) return config.backends.claude;

	// 2. Hook hint — auto-classification result
	if (currentHint && Date.now() < currentHint.expires) {
		const backend = config.backends[currentHint.backend];
		if (backend) return backend;
	}

	// 3. Default
	return config.backends[config.defaultBackend] || config.backends.claude;
}
