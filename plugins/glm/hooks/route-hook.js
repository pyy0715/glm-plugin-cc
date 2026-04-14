#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import { classify } from "./classifier.js";

const PROXY_URL = process.env.GLM_PROXY_URL || "http://localhost:4000";
const CLASSIFIER_TIMEOUT = Number(process.env.GLM_CLASSIFY_TIMEOUT_MS || 5000);
const HINT_TTL = Number(process.env.GLM_HINT_TTL_MS || 60_000);
const DEBUG_LOG = process.env.GLM_HOOK_DEBUG ? "/tmp/glm-route-hook.log" : null;

const START = Date.now();
function log(phase, extra = "") {
	if (!DEBUG_LOG) return;
	const dt = Date.now() - START;
	fs.appendFileSync(
		DEBUG_LOG,
		`[${new Date().toISOString()}] +${dt}ms ${phase}${extra ? " " + extra : ""}\n`,
	);
}

async function main() {
	log("start");

	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	log("stdin-read", `bytes=${input.length}`);

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		log("stdin-parse-fail");
		return;
	}
	const { prompt, session_id } = data;
	log(
		"stdin-parsed",
		`session_id=${session_id ?? "null"} prompt_len=${prompt?.length ?? 0}`,
	);
	if (!prompt || !session_id) return;

	log("classify-start");
	const result = await classify(prompt, {
		proxyUrl: PROXY_URL,
		timeoutMs: CLASSIFIER_TIMEOUT,
	});
	log("classify-done", `result=${result}`);
	if (result === null) return;

	const backend = result === "CODE" ? "glm" : "claude";
	try {
		log("hint-post-start", `backend=${backend}`);
		const res = await fetch(`${PROXY_URL}/_hint`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ session_id, backend, ttl: HINT_TTL }),
			signal: AbortSignal.timeout(2000),
		});
		log("hint-post-done", `status=${res.status}`);
	} catch (err) {
		log("hint-post-fail", `err=${err?.message ?? err}`);
	}
}

main()
	.catch((err) => log("main-error", `err=${err?.message ?? err}`))
	.finally(() => {
		log("exit");
		process.exit(0);
	});
