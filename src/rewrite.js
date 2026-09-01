// @ts-check

// Claude Code doesn't strip a [1m] context-window suffix from unrecognized
// model IDs like ANTHROPIC_CUSTOM_MODEL_OPTION values — see "Correct the
// window for a gateway or custom model ID" at
// https://code.claude.com/docs/en/model-config. Z.ai rejects the raw
// suffix, so strip it before every outbound GLM request.
const CONTEXT_SUFFIX_PATTERN = /\[1m\]$/i;

/**
 * @param {string} model
 * @returns {string}
 */
function stripContextSuffix(model) {
	return model.replace(CONTEXT_SUFFIX_PATTERN, "");
}

/**
 * When the hook hint redirects a `claude-*` request to GLM, forwarding the
 * original model name makes Z.ai pick its own default. This helper swaps
 * `body.model` to the configured target unless the request already names a
 * `glm-*` model (the user's explicit /model pick). Either way, a trailing
 * [1m] suffix is stripped — see CONTEXT_SUFFIX_PATTERN above.
 *
 * @param {any} body
 * @param {{ targetModel: string }} opts
 * @returns {{ body: any, modified: boolean }}
 */
export function rewriteModelForGlm(body, { targetModel }) {
	if (!body) return { body, modified: false };
	if (typeof body.model === "string" && body.model.startsWith("glm-")) {
		const stripped = stripContextSuffix(body.model);
		if (stripped === body.model) return { body, modified: false };
		return { body: { ...body, model: stripped }, modified: true };
	}
	return { body: { ...body, model: stripContextSuffix(targetModel) }, modified: true };
}
