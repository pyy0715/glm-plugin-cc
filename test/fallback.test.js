import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	CONTEXT_EXCEEDED_STOP_REASON,
	CONTEXT_LIMIT_PATTERNS,
	createSseDetector,
	isContextLimitByStopReason,
	isContextLimitError,
} from "../src/fallback.js";

describe("isContextLimitError", () => {
	it("returns true for the real Z.ai context-limit message", () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "The model has reached its context window limit.",
			},
		};
		assert.equal(isContextLimitError(400, body), true);
	});

	it("matches case-insensitively", () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "CONTEXT WINDOW overflow",
			},
		};
		assert.equal(isContextLimitError(400, body), true);
	});

	it("matches 'reached' alone (the other sentinel word)", () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "input reached maximum supported size",
			},
		};
		assert.equal(isContextLimitError(400, body), true);
	});

	it("returns false for non-400 statuses even with matching message", () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "context window exceeded",
			},
		};
		assert.equal(isContextLimitError(500, body), false);
		assert.equal(isContextLimitError(200, body), false);
		assert.equal(isContextLimitError(429, body), false);
	});

	it("returns false for 400 without invalid_request_error type", () => {
		const body = {
			type: "error",
			error: {
				type: "authentication_error",
				message: "context window",
			},
		};
		assert.equal(isContextLimitError(400, body), false);
	});

	it("returns false for unrelated 400 messages", () => {
		const body = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Prefilling assistant messages is not supported.",
			},
		};
		assert.equal(isContextLimitError(400, body), false);
	});

	it("returns false for null / undefined body", () => {
		assert.equal(isContextLimitError(400, null), false);
		assert.equal(isContextLimitError(400, undefined), false);
	});

	it("returns false when error field is missing", () => {
		assert.equal(isContextLimitError(400, { type: "error" }), false);
		assert.equal(isContextLimitError(400, {}), false);
	});

	it("returns false when message is missing or non-string", () => {
		assert.equal(
			isContextLimitError(400, {
				error: { type: "invalid_request_error" },
			}),
			false,
		);
		assert.equal(
			isContextLimitError(400, {
				error: { type: "invalid_request_error", message: 42 },
			}),
			false,
		);
	});

	it("exports CONTEXT_LIMIT_PATTERNS for inspection", () => {
		assert.ok(Array.isArray(CONTEXT_LIMIT_PATTERNS));
		assert.ok(CONTEXT_LIMIT_PATTERNS.length >= 2);
		assert.ok(CONTEXT_LIMIT_PATTERNS.every((p) => typeof p === "string"));
	});
});

describe("isContextLimitByStopReason (non-streaming 200)", () => {
	it("returns true when top-level stop_reason matches the Z.ai sentinel", () => {
		const body = {
			id: "msg_x",
			type: "message",
			role: "assistant",
			content: [],
			stop_reason: "model_context_window_exceeded",
		};
		assert.equal(isContextLimitByStopReason(body), true);
	});

	it("returns false for normal stop_reasons", () => {
		for (const r of ["end_turn", "max_tokens", "stop_sequence", "tool_use"]) {
			assert.equal(isContextLimitByStopReason({ stop_reason: r }), false);
		}
	});

	it("returns false when stop_reason is missing or null", () => {
		assert.equal(isContextLimitByStopReason({ stop_reason: null }), false);
		assert.equal(isContextLimitByStopReason({}), false);
	});

	it("returns false for null / non-object inputs", () => {
		assert.equal(isContextLimitByStopReason(null), false);
		assert.equal(isContextLimitByStopReason(undefined), false);
		assert.equal(isContextLimitByStopReason("str"), false);
	});

	it("exports the stop_reason sentinel string", () => {
		assert.equal(CONTEXT_EXCEEDED_STOP_REASON, "model_context_window_exceeded");
	});
});

describe("createSseDetector (streaming)", () => {
	const overflowSse = [
		"event: message_start\n",
		'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-4.7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
		"event: ping\n",
		'data: {"type":"ping"}\n\n',
		"event: message_delta\n",
		'data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":0}}\n\n',
		"event: message_stop\n",
		'data: {"type":"message_stop"}\n\n',
	].join("");

	const normalSse = [
		"event: message_start\n",
		'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"glm-4.7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
		"event: content_block_start\n",
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
		"event: content_block_delta\n",
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
	].join("");

	it("flags context_exceeded when overflow delta arrives", () => {
		const det = createSseDetector();
		const result = det.feed(overflowSse);
		assert.equal(result, "context_exceeded");
	});

	it("returns normal when content_block_start arrives first", () => {
		const det = createSseDetector();
		const result = det.feed(normalSse);
		assert.equal(result, "normal");
	});

	it("returns unknown when neither signal has arrived yet", () => {
		const det = createSseDetector();
		const partial = 'event: message_start\ndata: {"type":"message_start"}\n\n';
		assert.equal(det.feed(partial), "unknown");
	});

	it("handles chunked delivery across multiple feeds", () => {
		const det = createSseDetector();
		assert.equal(det.feed(overflowSse.slice(0, 40)), "unknown");
		assert.equal(det.feed(overflowSse.slice(40, 200)), "unknown");
		assert.equal(det.feed(overflowSse.slice(200)), "context_exceeded");
	});

	it("handles a normal delta with end_turn as normal", () => {
		const det = createSseDetector();
		const endTurn = [
			'event: message_start\ndata: {"type":"message_start"}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
		].join("");
		assert.equal(det.feed(endTurn), "normal");
	});

	it("stops scanning after a terminal verdict (idempotent)", () => {
		const det = createSseDetector();
		det.feed(overflowSse);
		assert.equal(det.feed(normalSse), "context_exceeded");
	});
});
