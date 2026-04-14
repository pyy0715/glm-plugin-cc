// @ts-check

// Intent classifier for backend routing. The split is production vs.
// conversation: CODE = user wants code produced or changed (→ GLM);
// OTHER = everything else, including explanation/advice/chat about code
// (→ Claude). English-only prompt (glm-4.7 handles multilingual input at
// runtime). Keyword bias guarded by showing "error", "kubectl", "git" on
// both sides of the few-shot. See docs/LEARNINGS.md §7 for the history.

const SYSTEM_PROMPT = [
	"<task>",
	"Classify the user's next message as CODE or OTHER.",
	"Reply with exactly one word, uppercase, no explanation, no punctuation.",
	"</task>",
	"",
	"<definition>",
	"CODE: the user wants code produced or changed. Concretely:",
	"  - write / generate a new function, script, test, schema, config",
	"  - edit / refactor / migrate / optimize / rename existing code",
	"  - fix a bug in a named artifact (function, file, service)",
	"  - apply a concrete change the user is clearly planning to execute",
	"",
	"OTHER: everything else, including things that MENTION code:",
	"  - explain how something works (a command, a tool, a concept,",
	"    a regex, a piece of code the user pasted) — explanation is a",
	"    conversation task, not a production task",
	"  - recommend an approach, compare options, give advice",
	"  - answer factual or general-knowledge questions",
	"  - translate, summarize, rewrite prose",
	"  - casual chat, venting, status reports, complaints",
	'  - meta-questions about the prior turn ("say that again",',
	'    "what did you mean")',
	"</definition>",
	"",
	"<rules>",
	'- The split is production vs. conversation. CODE means "please',
	'  write or change code". Everything conversational — including',
	"  teaching, explaining, debugging-by-talking, or giving opinions —",
	"  is OTHER.",
	"- Technical vocabulary (error, kubectl, NullPointerException, regex)",
	"  is NOT a signal by itself. An explanation request about kubectl is",
	"  OTHER; a request to write a Helm chart is CODE.",
	'- A bare command like "git rebase onto main" is CODE only if the',
	'  user clearly wants it performed or scripted. "What does git rebase',
	'  do" is OTHER.',
	"- Any natural language is fine; judge by intent regardless of",
	"  language.",
	"- When genuinely uncertain, choose OTHER.",
	"</rules>",
].join("\n");

// 6 CODE + 6 OTHER with overlapping vocabulary so the split is learned
// from intent, not keywords.
const FEW_SHOT = [
	// CODE — production / modification
	{
		role: "user",
		content: "write a python function that validates IPv4 addresses",
	},
	{ role: "assistant", content: "CODE" },
	{
		role: "user",
		content: "this sort is O(n^2) with nested loops, rewrite it in O(n log n)",
	},
	{ role: "assistant", content: "CODE" },
	{
		role: "user",
		content: "fix OrderService.finalize so it stops throwing NullPointerException on empty carts",
	},
	{ role: "assistant", content: "CODE" },
	{
		role: "user",
		content: "migrate this test suite from jest to vitest",
	},
	{ role: "assistant", content: "CODE" },
	{
		role: "user",
		content: "add a /health endpoint to this Express app that returns version and uptime",
	},
	{ role: "assistant", content: "CODE" },
	{
		role: "user",
		content: "scaffold a typescript CLI that takes a file path and prints line counts",
	},
	{ role: "assistant", content: "CODE" },

	// OTHER — explanation, advice, chat (some with technical vocabulary)
	{
		role: "user",
		content: "explain what kubectl rollout restart does and when to use it",
	},
	{ role: "assistant", content: "OTHER" },
	{
		role: "user",
		content: "Sentry keeps showing NullPointerException but I have no repro, any ideas why?",
	},
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "this error keeps happening and it's annoying" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "what is the capital of France?" },
	{ role: "assistant", content: "OTHER" },
	{ role: "user", content: "what did you just say? say it again" },
	{ role: "assistant", content: "OTHER" },
	{
		role: "user",
		content: "should I pick Postgres or MySQL for a small side project?",
	},
	{ role: "assistant", content: "OTHER" },
];

const MAX_PROMPT_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = "glm-4.7";

/**
 * Returns null on any failure (timeout, bad response, unknown label) so
 * the caller falls back to the default backend rather than misrouting.
 *
 * @param {string} prompt
 * @param {{ proxyUrl: string, timeoutMs?: number, model?: string }} opts
 * @returns {Promise<"CODE" | "OTHER" | null>}
 */
export async function classify(prompt, opts) {
	const { proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS, model = DEFAULT_MODEL } = opts;
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
