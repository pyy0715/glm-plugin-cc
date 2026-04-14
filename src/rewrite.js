// @ts-check

/**
 * Rewrite the request body's `model` field to a GLM model when the proxy
 * routes to GLM but the inbound model is not already `glm-*`.
 *
 * Why: Claude Code always sends `model` as one of the configured Anthropic
 * tier models (e.g. `claude-sonnet-4-6`). When the hook hint redirects the
 * request to GLM, forwarding that string verbatim makes Z.ai pick its own
 * default — so the user's choice (e.g. `glm-5.1`) is silently ignored.
 *
 * @param {any} body
 * @param {{ targetModel: string }} opts
 * @returns {{ body: any, modified: boolean }}
 */
export function rewriteModelForGlm(body, { targetModel }) {
	if (!body) return { body, modified: false };
	if (typeof body.model === "string" && body.model.startsWith("glm-")) {
		return { body, modified: false };
	}
	return { body: { ...body, model: targetModel }, modified: true };
}
