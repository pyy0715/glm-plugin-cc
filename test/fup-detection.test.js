import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { clearFupBreaker, isFupTripped } from "../src/router.js";
import { looksLike1313, maybeTripOnFupError } from "../src/server.js";

describe("maybeTripOnFupError", () => {
	beforeEach(() => {
		clearFupBreaker();
	});

	it("trips on numeric error.code 1313", () => {
		const parsed = { error: { code: 1313, message: "FUP" } };
		assert.equal(maybeTripOnFupError(parsed, "test"), true);
		assert.equal(isFupTripped(), true);
	});

	it("trips on string error.code '1313'", () => {
		const parsed = { error: { code: "1313", message: "FUP" } };
		assert.equal(maybeTripOnFupError(parsed, "test"), true);
		assert.equal(isFupTripped(), true);
	});

	it("does not trip on unrelated error codes", () => {
		const parsed = { error: { code: 1302, message: "concurrency" } };
		assert.equal(maybeTripOnFupError(parsed, "test"), false);
		assert.equal(isFupTripped(), false);
	});

	it("does not trip when parsed is null", () => {
		assert.equal(maybeTripOnFupError(null, "test"), false);
		assert.equal(isFupTripped(), false);
	});

	it("does not trip when error object is missing", () => {
		assert.equal(maybeTripOnFupError({}, "test"), false);
		assert.equal(isFupTripped(), false);
	});
});

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
