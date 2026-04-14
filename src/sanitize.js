// @ts-check

/**
 * Strip thinking blocks (and redacted thinking) from assistant messages in
 * an Anthropic Messages API request body.
 *
 * Why: thinking blocks carry a cryptographic signature from the backend that
 * produced them. When a session's routing switches between backends (e.g.
 * Claude -> GLM or the reverse), the new backend cannot verify the other's
 * signature and rejects the request with `Invalid signature in thinking block`.
 * We strip these blocks on the outbound path so each backend sees clean
 * history. The current turn's thinking is unaffected because it's generated
 * fresh from the `thinking` request option, not from history.
 *
 * @param {any} body - parsed request body (must be an object)
 * @returns {{ body: any, modified: boolean }}
 *   body is a new object when modified, or the original when untouched.
 */
export function stripAssistantThinking(body) {
	if (!body || !Array.isArray(body.messages)) {
		return { body, modified: false };
	}
	let modified = false;
	const newMessages = body.messages.map((msg) => {
		if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
			const filtered = msg.content.filter(
				(b) => !b || (b.type !== "thinking" && b.type !== "redacted_thinking"),
			);
			if (filtered.length !== msg.content.length) {
				modified = true;
				return { ...msg, content: filtered };
			}
		}
		return msg;
	});
	if (!modified) return { body, modified: false };
	return { body: { ...body, messages: newMessages }, modified: true };
}
