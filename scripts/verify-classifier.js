#!/usr/bin/env node
// @ts-check
/**
 * Live classifier verification.
 * Requires a running proxy on $GLM_PROXY_URL (default http://localhost:4000).
 * Not part of `npm test` because it depends on network + GLM quota.
 *
 * Usage: node scripts/verify-classifier.js
 *
 * The split we're testing is production vs. conversation. GLM (CODE) is
 * the workhorse we hand off to when the user wants code PRODUCED or
 * CHANGED. Claude (OTHER) handles explanation, advice, chat, and any
 * conversational task — even about technical topics.
 *
 * All cases English-only to match the classifier prompt. The runtime
 * handles other languages via the intent-only rule, but mixing languages
 * in the regression suite would muddy the signal when a case fails.
 */
import { classify } from "../plugins/glm/hooks/classifier.js";

const PROXY_URL = process.env.GLM_PROXY_URL || "http://localhost:4000";

const CASES = [
	// ==== OTHER: casual complaints / venting / status ====
	{ prompt: "this error keeps happening and it's annoying", expected: "OTHER" },
	{ prompt: "deploy failed again, so frustrating", expected: "OTHER" },
	{ prompt: "nothing works today", expected: "OTHER" },
	{ prompt: "why is it still broken", expected: "OTHER" },

	// ==== OTHER: explanation of technical concepts (was wrongly CODE before) ====
	{ prompt: "explain what kubectl rollout restart does", expected: "OTHER" },
	{ prompt: "what does git rebase do?", expected: "OTHER" },
	{ prompt: "explain what this regex matches", expected: "OTHER" },
	{ prompt: "how does OAuth refresh token flow work?", expected: "OTHER" },
	{ prompt: "what does a stack trace tell you?", expected: "OTHER" },

	// ==== OTHER: diagnostic questions without a fix request ====
	{
		prompt: "Sentry keeps showing NPE in finalize, any ideas why?",
		expected: "OTHER",
	},
	{
		prompt: "my build is slow, what could be causing that?",
		expected: "OTHER",
	},

	// ==== OTHER: recommendations / opinions ====
	{ prompt: "should I pick Postgres or MySQL for a side project?", expected: "OTHER" },
	{ prompt: "which option do you think is better?", expected: "OTHER" },
	{ prompt: "what should I have for lunch?", expected: "OTHER" },

	// ==== OTHER: general knowledge / natural language ====
	{ prompt: "what is the capital of France?", expected: "OTHER" },
	{ prompt: "explain photosynthesis in one paragraph", expected: "OTHER" },
	{ prompt: "translate into Korean: The weather is nice today.", expected: "OTHER" },
	{
		prompt: "rewrite this email to be more polite: Could we reschedule?",
		expected: "OTHER",
	},

	// ==== OTHER: meta / small talk ====
	{ prompt: "what did you just say?", expected: "OTHER" },
	{ prompt: "say that again please", expected: "OTHER" },

	// ==== CODE: implementation (write / generate) ====
	{ prompt: "write a python sort function", expected: "CODE" },
	{
		prompt: "write a binary-search tree with insert, delete, inorder traversal",
		expected: "CODE",
	},
	{
		prompt: "scaffold a typescript CLI that counts lines in a file",
		expected: "CODE",
	},
	{
		prompt: "add a /health endpoint that returns version and uptime",
		expected: "CODE",
	},

	// ==== CODE: modification (edit / refactor / migrate) ====
	{ prompt: "refactor this function to use list comprehension", expected: "CODE" },
	{ prompt: "migrate this test suite from jest to vitest", expected: "CODE" },
	{
		prompt: "this sort is O(n^2), rewrite it in O(n log n)",
		expected: "CODE",
	},
	{
		prompt: "rename the User class to Account everywhere in the project",
		expected: "CODE",
	},

	// ==== CODE: fix a bug in a named artifact ====
	{
		prompt: "fix OrderService.finalize, it throws NullPointerException",
		expected: "CODE",
	},
	{
		prompt: "the login form submits twice on slow networks, fix it",
		expected: "CODE",
	},
];

function pad(s, n) {
	return s.length >= n ? `${s.slice(0, n - 1)}…` : s + " ".repeat(n - s.length);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyWithRetry(prompt) {
	for (let i = 0; i < 2; i++) {
		const r = await classify(prompt, { proxyUrl: PROXY_URL });
		if (r !== null) return r;
		await sleep(500);
	}
	return null;
}

async function main() {
	console.log(`Proxy: ${PROXY_URL}`);
	console.log(`Total cases: ${CASES.length}\n`);

	const results = [];
	for (const c of CASES) {
		const result = await classifyWithRetry(c.prompt);
		const pass = result === c.expected;
		results.push({ ...c, result, pass });
		const mark = pass ? "✓" : "✗";
		console.log(`${mark} [${pad(c.expected, 5)}→${pad(String(result), 5)}] ${c.prompt}`);
		await sleep(250);
	}

	const failed = results.filter((r) => !r.pass);
	console.log("");
	console.log(`Passed: ${results.length - failed.length}/${results.length}`);

	if (failed.length > 0) {
		console.log("\nFailures:");
		for (const f of failed) {
			console.log(`  expected=${f.expected} got=${f.result}  ${f.prompt}`);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("verify-classifier error:", err);
	process.exit(2);
});
