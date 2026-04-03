#!/usr/bin/env node

// Uses the Anthropic-compatible endpoint (Coding Plan).
// The paas/v4 endpoint requires separate pay-as-you-go credits.

const DEFAULT_MODEL = "glm-5.1";
const API_URL = "https://api.z.ai/api/anthropic/v1/messages";
const DEFAULT_MAX_TOKENS = 8192;

const apiKey = process.env.GLM_API_KEY;
if (!apiKey) {
	process.stderr.write("GLM_API_KEY not set. Run /glm:setup for instructions.\n");
	process.exit(1);
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
	let input;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString());
	} catch {
		process.stderr.write("Invalid JSON input on stdin.\n");
		process.exit(1);
	}

	const model = input.model || process.env.GLM_MODEL || DEFAULT_MODEL;

	// Convert to Anthropic Messages API format
	const system = input.messages?.find((m) => m.role === "system")?.content;
	const messages = input.messages?.filter((m) => m.role !== "system") || [];

	const body = {
		model,
		messages,
		max_tokens: input.max_tokens ?? DEFAULT_MAX_TOKENS,
	};
	if (system) {
		body.system = system;
	}

	try {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			process.stderr.write(`GLM API error ${res.status}: ${text}\n`);
			process.exit(1);
		}

		const data = await res.json();
		// Anthropic format: content[0].text
		const content = data.content?.[0]?.text;
		if (content) {
			process.stdout.write(content);
		} else {
			process.stderr.write(`Unexpected response: ${JSON.stringify(data)}\n`);
			process.exit(1);
		}
	} catch (err) {
		process.stderr.write(`Network error: ${err.message}\n`);
		process.exit(1);
	}
});
