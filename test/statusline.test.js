import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../plugins/glm/scripts/statusline.js",
);

function run(input, env = {}) {
	return new Promise((resolve) => {
		const child = execFile(
			"node",
			[SCRIPT],
			{ env: { ...process.env, ...env } },
			(err, stdout, stderr) => {
				resolve({ code: err?.code ?? 0, stdout, stderr });
			},
		);
		child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
		child.stdin.end();
	});
}

// Strip ANSI escapes so assertions can match on plain text regardless of
// color codes. Built via RegExp() + fromCharCode rather than a literal with
// an embedded escape, since biome's noControlCharactersInRegex forbids raw
// control characters in regex literals.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function plain(text) {
	return text.replace(ANSI_ESCAPE, "");
}

describe("statusline.js", () => {
	it("shows the model name, context bar, and 5h/7d bars with reset times", async () => {
		const now = Math.floor(Date.now() / 1000);
		const { stdout } = await run(
			{
				model: { display_name: "Sonnet 5" },
				context_window: { used_percentage: 43 },
				rate_limits: {
					five_hour: { used_percentage: 42, resets_at: now + 3600 },
					seven_day: { used_percentage: 18, resets_at: now + 86400 * 2 + 3600 * 5 },
				},
			},
			{ GLM_API_KEY: "" },
		);
		const text = plain(stdout);
		assert.ok(text.includes("Sonnet 5"), `Expected model name, got: ${text}`);
		assert.ok(text.includes("Ctx"), `Expected context row, got: ${text}`);
		assert.ok(text.includes("43%"), `Expected context percentage, got: ${text}`);
		assert.ok(text.includes("42%"), `Expected 5h percentage, got: ${text}`);
		assert.ok(text.includes("18%"), `Expected 7d percentage, got: ${text}`);
		assert.ok(text.includes("Reset"), `Expected a reset time label, got: ${text}`);
		assert.ok(text.includes("2d "), `Expected a day-scale reset time, got: ${text}`);
		assert.ok(/[█░]/.test(text), `Expected a block bar, got: ${text}`);
		// Ctx, 5H, and 7D render on a single line, separated by │.
		assert.equal(text.split("\n")[0].match(/│/g)?.length, 3, `Expected one line, got: ${text}`);
	});

	it("shows -- for rows with no data instead of a bar", async () => {
		const { stdout } = await run({}, { GLM_API_KEY: "" });
		const text = plain(stdout);
		assert.ok(text.includes("Ctx --"), `Expected Ctx --, got: ${text}`);
		assert.ok(text.includes("5H --"), `Expected 5H --, got: ${text}`);
		assert.ok(text.includes("7D --"), `Expected 7D --, got: ${text}`);
	});

	it("handles empty stdin gracefully", async () => {
		const { stdout, code } = await run("", { GLM_API_KEY: "" });
		assert.equal(code, 0);
		const text = plain(stdout);
		assert.ok(text.includes("--"), `Expected graceful fallback, got: ${text}`);
	});

	it("falls back to a generic model label when display_name is absent", async () => {
		const { stdout } = await run({}, { GLM_API_KEY: "" });
		const text = plain(stdout);
		assert.ok(text.startsWith("Claude"), `Expected default label, got: ${text}`);
	});

	// Integration test — only runs when GLM_API_KEY is set
	it("shows GLM quota when key is set", { skip: !process.env.GLM_API_KEY }, async () => {
		const { stdout } = await run({
			model: { display_name: "Sonnet 5" },
			context_window: { used_percentage: 10 },
		});
		const text = plain(stdout);
		assert.ok(text.includes("GLM["), `Expected GLM section, got: ${text}`);
	});
});
