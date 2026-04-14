// @ts-check

const SYSTEM_PROMPT =
	"Classify the user's request. Reply with exactly one word: CODE or OTHER. " +
	"CODE = writing, fixing, debugging, refactoring, reviewing, explaining, designing, or testing code. " +
	"OTHER = anything else.";

/**
 * Classify whether a user prompt is code-related.
 * Sends a small Anthropic-Messages-formatted request to the proxy using
 * `glm-4.7` so the proxy routes it to GLM via its model-prefix rule.
 *
 * Returns null on any failure (timeout, network, unknown output) so callers
 * fall back to the default backend.
 *
 * @param {string} prompt
 * @param {{ proxyUrl: string, timeoutMs?: number }} opts
 * @returns {Promise<"CODE" | "OTHER" | null>}
 */
export async function classify(prompt, { proxyUrl, timeoutMs = 5000 }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${proxyUrl}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-4.7",
				max_tokens: 4,
				system: SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt.slice(0, 2000) }],
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
