// @ts-check

/** @typedef {{ name: string, baseUrl: string, apiKey: string }} Backend */
/** @typedef {{ backends: { claude: Backend, glm: Backend }, defaultBackend: string, port: number }} Config */

/**
 * Load configuration from environment variables.
 * @param {object} [overrides]
 * @returns {Config}
 */
export function load(overrides = {}) {
	const claudeKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
	const glmKey = process.env.GLM_API_KEY || "";

	return {
		port: Number(overrides.port || process.env.PROXY_PORT || 4000),
		defaultBackend: overrides.defaultBackend || process.env.DEFAULT_BACKEND || "claude",
		backends: {
			claude: {
				name: "claude",
				baseUrl: "https://api.anthropic.com",
				apiKey: claudeKey,
			},
			glm: {
				name: "glm",
				baseUrl: "https://api.z.ai/api/anthropic",
				apiKey: glmKey,
			},
		},
	};
}
