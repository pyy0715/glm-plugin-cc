#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import { classify } from "../../../src/classifier.js";

const PROXY_URL = process.env.GLM_PROXY_URL || "http://localhost:4000";
const CLASSIFIER_TIMEOUT = Number(process.env.GLM_CLASSIFY_TIMEOUT_MS || 5000);
const HINT_TTL = Number(process.env.GLM_HINT_TTL_MS || 60_000);
const DEBUG_LOG = process.env.GLM_HOOK_DEBUG ? "/tmp/glm-route-hook.log" : null;

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (DEBUG_LOG) {
		fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`);
	}
	const { prompt, session_id } = data;
	if (!prompt || !session_id) return;

	const result = await classify(prompt, {
		proxyUrl: PROXY_URL,
		timeoutMs: CLASSIFIER_TIMEOUT,
	});
	if (result === null) return; // classifier failed → no hint, falls back to default

	const backend = result === "CODE" ? "glm" : "claude";
	try {
		await fetch(`${PROXY_URL}/_hint`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ session_id, backend, ttl: HINT_TTL }),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// hint delivery failure is non-fatal
	}
}

main()
	.catch(() => {})
	.finally(() => process.exit(0));
