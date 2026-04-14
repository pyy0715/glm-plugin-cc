// @ts-check

/** @typedef {{ name: string, baseUrl: string, apiKey: string }} Backend */
/**
 * @typedef {object} Config
 * @property {{ claude: Backend, glm: Backend }} backends
 * @property {string} defaultBackend
 * @property {number} port
 * @property {string} glmRoutedModel - model substituted by rewriteModelForGlm
 *   when a non-`glm-*` request routes to GLM.
 */

/**
 * Load config from env vars. Claude auth is OAuth passthrough so no
 * Claude key is loaded here.
 *
 * @param {object} [overrides]
 * @returns {Config}
 */
export function load(overrides = {}) {
	return {
		port: Number(overrides.port || process.env.PROXY_PORT || 4000),
		defaultBackend: overrides.defaultBackend || process.env.DEFAULT_BACKEND || "claude",
		glmRoutedModel: process.env.GLM_ROUTED_MODEL || "glm-5.1",
		backends: {
			claude: {
				name: "claude",
				baseUrl: "https://api.anthropic.com",
				apiKey: "",
			},
			glm: {
				name: "glm",
				baseUrl: "https://api.z.ai/api/anthropic",
				apiKey: process.env.GLM_API_KEY || "",
			},
		},
	};
}
