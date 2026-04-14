#!/usr/bin/env node
// @ts-check
/**
 * Live classifier verification.
 * Requires a running proxy on $GLM_PROXY_URL (default http://localhost:4000).
 * Not part of `npm test` because it depends on network + GLM quota.
 *
 * Usage: node scripts/verify-classifier.js
 */
import { classify } from "../plugins/glm/hooks/classifier.js";

const PROXY_URL = process.env.GLM_PROXY_URL || "http://localhost:4000";

const CASES = [
	// OTHER — previously misclassified plus regression guards
	{ prompt: "이전 프롬프트 확인해 계속 에러나잖아", expected: "OTHER" },
	{ prompt: "에러나는데", expected: "OTHER" },
	{ prompt: "뭐가 자꾸 에러나", expected: "OTHER" },
	{ prompt: "프랑스 수도가 어디야?", expected: "OTHER" },
	{ prompt: "세종대왕 업적 요약해줘", expected: "OTHER" },
	{ prompt: "other임", expected: "OTHER" },
	{ prompt: "계속 안돼", expected: "OTHER" },
	{ prompt: "방금 뭐라고 했어", expected: "OTHER" },
	{ prompt: "오늘 점심 뭐 먹지", expected: "OTHER" },
	{ prompt: "이 영어 문장 한국어로 번역: The weather is nice.", expected: "OTHER" },

	// CODE
	{ prompt: "write a python sort function", expected: "CODE" },
	{ prompt: "이 함수 refactor 해줘", expected: "CODE" },
	{ prompt: "git에서 마지막 커밋 되돌리는 명령 알려줘", expected: "CODE" },
	{ prompt: "왜 이 함수 NullPointerException 나는지 고쳐줘", expected: "CODE" },
	{ prompt: "이 regex 뭐 매칭하는지 설명해줘", expected: "CODE" },
	{ prompt: "스택 트레이스 분석해줘", expected: "CODE" },
	{ prompt: "debug this function", expected: "CODE" },
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
