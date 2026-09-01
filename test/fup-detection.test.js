import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { looksLike1313 } from "../src/server.js";

describe("looksLike1313 (SSE chunk sniff)", () => {
	it("matches numeric form", () => {
		assert.equal(looksLike1313('event: error\ndata: {"error":{"code":1313}}\n\n'), true);
	});

	it("matches string form", () => {
		assert.equal(looksLike1313('data: {"code":"1313","message":"x"}'), true);
	});

	it("does not match other codes", () => {
		assert.equal(looksLike1313('data: {"error":{"code":1302}}'), false);
	});

	it("documents substring false-positive window", () => {
		// The cheap substring check will accept any number that happens to
		// start with 1313 (e.g. 13131, 13132). Z.ai's error code space doesn't
		// currently contain codes like that, but this pins the behavior so a
		// future regression tightening the check is a conscious choice.
		assert.equal(looksLike1313('"code":13131'), true);
		assert.equal(looksLike1313('"code":1131'), false);
	});
});
