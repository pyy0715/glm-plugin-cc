// @ts-check

/**
 * When the hook hint redirects a `claude-*` request to GLM, forwarding the
 * original model name makes Z.ai pick its own default — silently ignoring
 * the user's configured GLM model. This helper swaps `body.model` to the
 * configured target unless the request already names a `glm-*` model (which
 * means the user picked it explicitly via /model).
 *
 * @param {any} body
 * @param {{ targetModel: string }} opts
 * @returns {{ body: any, modified: boolean }}
 */
export function rewriteModelForGlm(body, { targetModel }) {
	if (!body) return { body, modified: false };
	if (typeof body.model === "string" && body.model.startsWith("glm-")) {
		// Claude Code appends a `[1m]` suffix to flag 1M context. Z.ai is
		// natively 1M and rejects the suffix with 1211 Unknown Model, so strip
		// it before forwarding. The user's explicit glm-* pick still wins.
		if (body.model.endsWith("[1m]")) {
			return { body: { ...body, model: body.model.slice(0, -4) }, modified: true };
		}
		return { body, modified: false };
	}
	return { body: { ...body, model: targetModel }, modified: true };
}
