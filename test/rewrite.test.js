import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { rewriteModelForGlm } from "../src/rewrite.js";

describe("rewriteModelForGlm", () => {
	it("rewrites claude-* model to the configured GLM model", () => {
		const body = { model: "claude-opus-4-6", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.3-flash");
		// Original untouched
		assert.equal(body.model, "claude-opus-4-6");
	});

	it("leaves glm-* model alone (user's explicit pick wins)", () => {
		const body = { model: "glm-4.7", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash",
		});
		assert.equal(modified, false);
		assert.equal(out, body);
	});

	it("strips a trailing [1m] context suffix from an explicit glm-* pick", () => {
		// Z.ai rejects "glm-5.3-flash[1m]" outright — see rewrite.js.
		const body = { model: "glm-5.3-flash[1m]", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.3-flash");
	});

	it("strips [1m] case-insensitively", () => {
		const body = { model: "glm-5.3-flash[1M]", messages: [] };
		const { body: out } = rewriteModelForGlm(body, { targetModel: "glm-5.3-flash" });
		assert.equal(out.model, "glm-5.3-flash");
	});

	it("strips [1m] from the fallback targetModel too", () => {
		const body = { model: "claude-opus-4-6", messages: [] };
		const { body: out } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash[1m]",
		});
		assert.equal(out.model, "glm-5.3-flash");
	});

	it("rewrites unknown / unprefixed model names", () => {
		const body = { model: "something-else", messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.3-flash");
	});

	it("rewrites when model field is missing", () => {
		const body = { messages: [] };
		const { body: out, modified } = rewriteModelForGlm(body, {
			targetModel: "glm-5.3-flash",
		});
		assert.equal(modified, true);
		assert.equal(out.model, "glm-5.3-flash");
	});

	it("handles null body gracefully", () => {
		const { body: out, modified } = rewriteModelForGlm(null, {
			targetModel: "glm-5.3-flash",
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
			targetModel: "glm-5.3-flash",
		});
		assert.equal(out.model, "glm-5.3-flash");
		assert.deepEqual(out.messages, body.messages);
		assert.equal(out.max_tokens, 100);
		assert.deepEqual(out.metadata, body.metadata);
	});
});
