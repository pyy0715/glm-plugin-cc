// @ts-check

const SYSTEM_PROMPT = [
	"You route a developer's chat message to the right backend.",
	"Reply with exactly one token: CODE or OTHER. No other words, no punctuation.",
	"",
	"CODE — anything a software engineer would do in their editor or terminal:",
	"  • writing, modifying, refactoring, reviewing, or explaining source code",
	"  • debugging errors, stack traces, or test failures",
	"  • shell, git, build, deployment, or infrastructure commands",
	"  • configuration files, schemas, regex, queries, API requests",
	"  • commit messages, PR descriptions, code comments, technical READMEs",
	"  • requests that include code snippets even if the ask is conceptual",
	"",
	"OTHER — everything else:",
	"  • general knowledge or factual questions",
	"  • casual conversation, opinions, advice not about code",
	"  • translation, summarization, or rewriting of non-technical text",
	"  • scheduling, planning, brainstorming with no code artifact",
].join("\n");

const FEW_SHOT = [
	{ role: "user", content: "write a fibonacci function in python" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "explain what /^\\d{3}-\\d{4}$/ matches" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "git log에서 마지막 커밋만 보고 싶어" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "이 스택 트레이스 왜 NullPointerException 나는거야?" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "What's the capital of France?" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "오늘 점심 뭐 먹지" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "이 영어 문장 한국어로 번역해줘: The weather is nice." },
	{ role: "assistant", content: "OTHER" },
];

const MAX_PROMPT_CHARS = 2000;

/**
 * Classify whether a user prompt is code-related.
 * Routed through the local proxy so the call hits GLM via the proxy's
 * model-prefix rule; no separate auth needed.
 *
 * Returns null on any failure so callers fall back to the default backend
 * rather than misroute on noise.
 *
 * @param {string} prompt
 * @param {{ proxyUrl: string, timeoutMs?: number, model?: string }} opts
 * @returns {Promise<"CODE" | "OTHER" | null>}
 */
export async function classify(prompt, opts) {
	const { proxyUrl, timeoutMs = 5000, model = "glm-4.7" } = opts;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${proxyUrl}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				max_tokens: 4,
				system: SYSTEM_PROMPT,
				messages: [...FEW_SHOT, { role: "user", content: prompt.slice(0, MAX_PROMPT_CHARS) }],
			}),
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const data = /** @type {any} */ (await res.json());
		const text = data?.content?.[0]?.text?.trim().toUpperCase() ?? "";
		if (text.startsWith("CODE")) return "CODE";
		if (text.startsWith("OTHER")) return "OTHER";
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
