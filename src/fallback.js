// @ts-check

// Z.ai signals context overflow via this stop_reason in both non-streaming
// responses and the SSE `message_delta` event.
export const CONTEXT_EXCEEDED_STOP_REASON = "model_context_window_exceeded";

// Substrings that identify a context-window error from a conventional
// Anthropic-style 400. Kept narrow; extend only when a new message is
// actually observed in the wild.
/** @type {string[]} */
export const CONTEXT_LIMIT_PATTERNS = ["context window", "reached"];

/**
 * 400 path. Safety net for the Anthropic endpoint and for a future Z.ai
 * policy change.
 * @param {number} status
 * @param {unknown} parsedBody
 */
export function isContextLimitError(status, parsedBody) {
	if (status !== 400) return false;
	if (!parsedBody || typeof parsedBody !== "object") return false;
	const body = /** @type {Record<string, any>} */ (parsedBody);
	const err = body.error;
	if (!err || err.type !== "invalid_request_error") return false;
	if (typeof err.message !== "string") return false;
	const lower = err.message.toLowerCase();
	return CONTEXT_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

/**
 * 200 non-streaming path: Z.ai returns empty content with the sentinel
 * stop_reason at the top level.
 * @param {unknown} parsedBody
 */
export function isContextLimitByStopReason(parsedBody) {
	if (!parsedBody || typeof parsedBody !== "object") return false;
	const body = /** @type {Record<string, any>} */ (parsedBody);
	return body.stop_reason === CONTEXT_EXCEEDED_STOP_REASON;
}

/**
 * Incremental SSE detector. Feed bytes as they arrive; the detector
 * returns a verdict after each chunk:
 *   - "context_exceeded": `message_delta` carried the overflow sentinel
 *   - "normal": a `content_block_start` arrived, or a delta with any
 *     other stop_reason — safe to passthrough
 *   - "unknown": keep buffering
 *
 * Once a terminal verdict is reached, subsequent feeds return it
 * unchanged.
 *
 * @returns {{ feed(chunk: string): "context_exceeded" | "normal" | "unknown" }}
 */
export function createSseDetector() {
	let buffer = "";
	/** @type {"context_exceeded" | "normal" | "unknown"} */
	let verdict = "unknown";

	function scanEvents() {
		for (;;) {
			const idx = buffer.indexOf("\n\n");
			if (idx === -1) return;
			const rawEvent = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
			if (!dataLine) continue;
			const payload = dataLine.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			let evt;
			try {
				evt = JSON.parse(payload);
			} catch {
				continue;
			}
			if (evt?.type === "content_block_start") {
				verdict = "normal";
				return;
			}
			if (evt?.type === "message_delta") {
				if (evt?.delta?.stop_reason === CONTEXT_EXCEEDED_STOP_REASON) {
					verdict = "context_exceeded";
				} else if (evt?.delta?.stop_reason) {
					verdict = "normal";
				}
				return;
			}
		}
	}

	return {
		feed(chunk) {
			if (verdict !== "unknown") return verdict;
			buffer += chunk;
			scanEvents();
			return verdict;
		},
	};
}
