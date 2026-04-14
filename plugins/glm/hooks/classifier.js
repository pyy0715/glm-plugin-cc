// @ts-check

const SYSTEM_PROMPT = [
	"<task>",
	"Classify the user message as CODE or OTHER.",
	"Reply with exactly one word, uppercase, no punctuation.",
	"</task>",
	"",
	"<rules>",
	"CODE = the user explicitly asks for a coding/engineering action:",
	"  write, edit, fix, run, debug, refactor, review, implement, analyze,",
	"  explain, or teach a specific piece of code, a shell/git command,",
	"  a regex, or a CLI flag. Asking 'how do I do X with a command' is CODE.",
	"",
	"OTHER = anything else, including:",
	"  - complaints or status reports that mention errors/bugs without a concrete request",
	"  - general knowledge, opinions, casual chat, translation of prose",
	"  - short acknowledgements or meta-questions about the prior turn",
	"",
	"Tie-breaker: when in doubt, choose OTHER.",
	"The mere presence of technical vocabulary (error, bug, code, stack trace,",
	"function name, exception type) is NOT sufficient on its own. The user",
	"must explicitly request a coding action.",
	"</rules>",
].join("\n");

// 5-shot: CODE ×2, OTHER ×3. "에러/error" vocabulary intentionally appears
// on BOTH sides so the model cannot shortcut on keywords alone.
const FEW_SHOT = [
	{ role: "user", content: "write a python function to reverse a string" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "왜 이 함수 NullPointerException 나는지 고쳐줘" },
	{ role: "assistant", content: "CODE" },
	{ role: "user", content: "프랑스 수도가 어디야?" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "에러 계속 나서 짜증나네" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "방금 뭐라고 했어?" },
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
