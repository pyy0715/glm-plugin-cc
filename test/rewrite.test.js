import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { rewriteModelForGlm } from "../src/rewrite.js";

describe("rewriteModelForGlm", () => {
	it("rewrites claude-* model to the configured GLM model", () => {
		const body = { model: "claude-opus-4-6", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.1",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.1");
		// Original untouched
		assert.equal(body.model, "claude-opus-4-6");
	});

	it("leaves glm-* model alone (user's explicit pick wins)", () => {
		const body = { model: "glm-4.7", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.1",
		});
		assert.equal(modified, false);
		assert.equal(out, body);
	});

	it("rewrites unknown / unprefixed model names", () => {
		const body = { model: "something-else", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.1",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.1");
	});

	it("rewrites when model field is missing", () => {
		const body = { messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.1",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.1");
	});

	it("handles null body gracefully", () => {
		const { body: out, modified } = rewriteModelForGlm(null, {
			targetModel: "glm-5.1",
		});
		assert.equal(modified, false);
		assert.equal(out, null);
	});

	it("preserves other body fields when rewriting", () => {
		const body = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "x" }],
			max_tokens: 100,
			metadata: { user_id: "abc" },
		};
		const { body: out } = rewriteModelForGlm(body, {
			targetModel: "glm-5.1",
		});
		assert.equal(out.model, "glm-5.1");
		assert.deepEqual(out.messages, body.messages);
		assert.equal(out.max_tokens, 100);
		assert.deepEqual(out.metadata, body.metadata);
	});
});
