import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../plugins/glm/scripts/glm-call.js",
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
		if (input !== undefined) {
			child.stdin.write(JSON.stringify(input));
		}
		child.stdin.end();
	});
}

describe("glm-call.js", () => {
	it("exits 1 when GLM_API_KEY is not set", async () => {
		const { code, stderr } = await run(
			{ messages: [{ role: "user", content: "hi" }] },
			{ GLM_API_KEY: "" },
		);
		assert.equal(code, 1);
		assert.ok(stderr.includes("GLM_API_KEY not set"));
	});

	it("exits 1 on invalid JSON input", async () => {
		const child = execFile(
			"node",
			[SCRIPT],
			{ env: { ...process.env, GLM_API_KEY: "test" } },
			() => {},
		);
		await new Promise((resolve) => {
			child.on("exit", (code) => {
				assert.equal(code, 1);
				resolve();
			});
			child.stdin.write("not json");
			child.stdin.end();
		});
	});

	// Integration test — only runs when GLM_API_KEY is set
	it("calls GLM API successfully when key is set", { skip: !process.env.GLM_API_KEY }, async () => {
		const { code, stdout, stderr } = await run({
			messages: [{ role: "user", content: "Reply with just the word OK" }],
		});
		if (code !== 0) {
			console.log("stderr:", stderr);
		}
		assert.equal(code, 0);
		assert.ok(stdout.length > 0, "Expected non-empty response");
	});
});
