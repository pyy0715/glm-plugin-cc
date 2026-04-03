#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const CACHE_TTL_MS = 60_000;

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function colorize(pct) {
	if (pct >= 85) return RED;
	if (pct >= 60) return YELLOW;
	return GREEN;
}

function formatResetTime(epochSec) {
	const diffMs = epochSec * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const hours = Math.floor(diffMs / 3_600_000);
	const mins = Math.floor((diffMs % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h${mins > 0 ? `${mins}m` : ""}` : `${mins}m`;
}

async function loadGlmQuota(cacheDir) {
	const apiKey = process.env.GLM_API_KEY;
	if (!apiKey) return null;

	const cachePath = cacheDir ? path.join(cacheDir, "glm_quota_cache.json") : null;

	// Try cache first
	if (cachePath) {
		try {
			const raw = fs.readFileSync(cachePath, "utf8");
			const cached = JSON.parse(raw);
			if (Date.now() - cached._ts < CACHE_TTL_MS) return cached;
		} catch {
			// No cache or invalid — proceed to API call
		}
	}

	// Fetch from API
	// The quota endpoint accepts Authorization, x-api-key, and Bearer formats.
	try {
		const res = await fetch(QUOTA_URL, { headers: { Authorization: apiKey } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const result = { ...json.data, _ts: Date.now() };

		if (cachePath) {
			try {
				fs.mkdirSync(path.dirname(cachePath), { recursive: true });
				fs.writeFileSync(cachePath, JSON.stringify(result));
			} catch {
				// Cache write failure is non-fatal
			}
		}
		return result;
	} catch {
		// API failure — try stale cache
		if (cachePath) {
			try {
				const raw = fs.readFileSync(cachePath, "utf8");
				const stale = JSON.parse(raw);
				stale._stale = true;
				return stale;
			} catch {
				return null;
			}
		}
		return null;
	}
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
	let input = {};
	try {
		input = JSON.parse(Buffer.concat(chunks).toString());
	} catch {
		// Empty or invalid stdin — proceed with defaults
	}

	const parts = [];

	// Claude section: 5h usage + reset time
	const rl = input.rate_limits;
	if (rl?.five_hour) {
		const pct = Math.round(rl.five_hour.used_percentage);
		const c = colorize(pct);
		const reset = formatResetTime(rl.five_hour.resets_at);
		parts.push(`claude 5h:${c}${pct}%${RESET} ~${reset}`);
	} else {
		parts.push("claude 5h:--");
	}

	// GLM section: plan level + 5h usage (no reset time — API returns billing cycle reset, not 5h window)
	// CLAUDE_PLUGIN_DATA is only set in plugin hook context, not in statusLine.
	// Fall back to /tmp for cache when run from settings.json statusLine command.
	const cacheDir = process.env.CLAUDE_PLUGIN_DATA || "/tmp";
	const glm = await loadGlmQuota(cacheDir);
	if (glm) {
		const timeLim = glm.limits?.find((l) => l.type === "TIME_LIMIT");
		if (timeLim) {
			const pct = timeLim.percentage;
			const c = colorize(pct);
			const stale = glm._stale ? "!" : "";
			const level = glm.level || "?";
			parts.push(`glm[${level}] 5h:${c}${pct}%${stale}${RESET}`);
		} else {
			parts.push("glm --");
		}
	}

	process.stdout.write(parts.join(" | "));
});
