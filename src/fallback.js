// @ts-check

/**
 * Z.ai signals context-window overflow via this stop_reason in both the
 * non-streaming Messages API response and the SSE `message_delta` event.
 * Extracted as a constant so detectors and tests share a single source.
 */
export const CONTEXT_EXCEEDED_STOP_REASON = "model_context_window_exceeded";

/**
 * 400-path safety net: substrings that identify a context-window error
 * from a conventional Anthropic-style 400 response. Intentionally narrow —
 * extend only when a new message is actually observed.
 *
 * @type {string[]}
 */
export const CONTEXT_LIMIT_PATTERNS = ["context window", "reached"];

/**
 * Classic 400 invalid_request_error path. Kept as a safety net for the
 * Anthropic endpoint and in case Z.ai changes its policy.
 *
 * @param {number} status
 * @param {unknown} parsedBody
 * @returns {boolean}
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
 * Z.ai 200-path: observed behavior is status 200 + empty content + a top-level
 * `stop_reason` set to the sentinel. Call on a parsed non-streaming body.
 *
 * @param {unknown} parsedBody
 * @returns {boolean}
 */
export function isContextLimitByStopReason(parsedBody) {
	if (!parsedBody || typeof parsedBody !== "object") return false;
	const body = /** @type {Record<string, any>} */ (parsedBody);
	return body.stop_reason === CONTEXT_EXCEEDED_STOP_REASON;
}

/**
 * Incremental SSE detector. The proxy feeds bytes as they arrive; the
 * detector tells the caller whether to fall back (`context_exceeded`),
 * commit to passthrough (`normal`), or keep buffering (`unknown`).
 *
 * A "normal" verdict is reached the moment we see evidence the model started
 * generating content: either `content_block_start` event, or a
 * `message_delta` whose `stop_reason` is not the overflow sentinel. Any
 * later chunks past a terminal verdict keep the same verdict.
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
