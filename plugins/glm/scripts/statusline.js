#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const CACHE_TTL_MS = 60_000;
const PROXY_PORT = Number(process.env.PROXY_PORT || 4000);
const PROXY_PROBE_TIMEOUT_MS = 300;

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RED_BOLD = "\x1b[1;31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";

function probePort(port) {
	return new Promise((resolve) => {
		const sock = net.createConnection(port, "127.0.0.1");
		const timer = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, PROXY_PROBE_TIMEOUT_MS);
		sock.on("connect", () => {
			clearTimeout(timer);
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

// Claude Code refreshes statusline roughly every 300ms. Cache the TCP probe
// for a second so we're not burning a syscall per render.
const PROXY_PROBE_CACHE_TTL_MS = 1000;
async function checkProxyAlive(port, cacheDir) {
	if (!cacheDir) return probePort(port);
	const cachePath = path.join(cacheDir, "glm_proxy_alive.json");
	try {
		const raw = fs.readFileSync(cachePath, "utf8");
		const cached = JSON.parse(raw);
		if (cached.port === port && Date.now() - cached._ts < PROXY_PROBE_CACHE_TTL_MS) {
			return cached.alive;
		}
	} catch {
		// miss → probe
	}
	const alive = await probePort(port);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify({ port, alive, _ts: Date.now() }));
	} catch {
		// non-fatal
	}
	return alive;
}

function colorize(pct) {
	if (pct >= 85) return RED;
	if (pct >= 60) return YELLOW;
	return GREEN;
}

// Renders a fixed-width Unicode block bar, e.g. "████░░░░░░". Colored by the
// same red/yellow/green thresholds as the percentage text next to it.
function renderBar(pct) {
	const clamped = Math.max(0, Math.min(100, pct));
	const filledCount = Math.round((clamped / 100) * BAR_WIDTH);
	const bar = FILLED.repeat(filledCount) + EMPTY.repeat(BAR_WIDTH - filledCount);
	return `${colorize(clamped)}${bar}${RESET}`;
}

function formatResetTime(epochSec) {
	const diffMs = epochSec * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const hours = Math.floor(diffMs / 3_600_000);
	const mins = Math.floor((diffMs % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h${mins > 0 ? `${mins}m` : ""}` : `${mins}m`;
}

// One row: "<label> <bar> <pct>% (Reset <time>)" — pct and reset are omitted
// gracefully when the underlying data isn't available yet.
function renderRow(label, pct, resetEpochSec) {
	if (pct == null) return `${label} ${DIM}--${RESET}`;
	const bar = renderBar(pct);
	const pctText = `${colorize(pct)}${Math.round(pct)}%${RESET}`;
	const resetText =
		resetEpochSec != null ? ` ${DIM}(Reset ${formatResetTime(resetEpochSec)})${RESET}` : "";
	return `${label} ${bar} ${pctText}${resetText}`;
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

async function loadProxyStatus(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/_status`, {
			signal: AbortSignal.timeout(300),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// GLM quota's TOKENS_LIMIT window has no reset timestamp in the API
// response, unlike Claude's rate_limits.*.resets_at. Surface the reset
// interval it's documented to use (5h, matching Claude's window) so the row
// stays visually consistent even without a live countdown.
function glmResetLabel(quota) {
	const tokLim = quota.limits?.find((l) => l.type === "TOKENS_LIMIT");
	return tokLim ? `${DIM}(resets every 5h)${RESET}` : "";
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

	const lines = [];
	// CLAUDE_PLUGIN_DATA is only set in plugin hook context, not in statusLine.
	// Fall back to /tmp for cache when run from settings.json statusLine command.
	const cacheDir = process.env.CLAUDE_PLUGIN_DATA || "/tmp";

	// Proxy liveness probe (cached 1s), checked once up front so both the
	// header line and the tail warning can use it without a second fetch.
	const proxyAlive = await checkProxyAlive(PROXY_PORT, cacheDir);

	// Header: model + context window usage bar.
	const modelName = input.model?.display_name || "Claude";
	const ctxPct = input.context_window?.used_percentage ?? null;
	lines.push(`${modelName} │ ${renderRow("Ctx", ctxPct, null)}`);

	// Claude 5h / 7d usage-limit bars with reset time.
	const rl = input.rate_limits;
	lines.push(renderRow("5H ", rl?.five_hour?.used_percentage ?? null, rl?.five_hour?.resets_at));
	lines.push(renderRow("7D ", rl?.seven_day?.used_percentage ?? null, rl?.seven_day?.resets_at));

	// GLM section — same bar style, no reset countdown (API doesn't return
	// one), just the known window length.
	const glm = await loadGlmQuota(cacheDir);
	if (glm) {
		const stale = glm._stale ? ` ${YELLOW}(stale)${RESET}` : "";
		const level = glm.level || "?";
		const tokLim = glm.limits?.find((l) => l.type === "TOKENS_LIMIT");
		const pct = tokLim ? tokLim.percentage : null;
		lines.push(`${renderRow(`GLM[${level}]`, pct, null)} ${glmResetLabel(glm)}${stale}`);
	}

	// Tail warnings: proxy down / FUP throttled. Kept as plain text on their
	// own line so they stay visible even when everything above is `--`.
	const warnings = [];
	if (!proxyAlive) {
		warnings.push(`${RED_BOLD}proxy down${RESET}`);
	} else {
		const status = await loadProxyStatus(PROXY_PORT);
		if (status?.fupBreaker?.tripped) {
			const mins = Math.max(1, Math.ceil(status.fupBreaker.cooldownRemainingMs / 60_000));
			warnings.push(`${RED_BOLD}glm throttled (${mins}m)${RESET}`);
		}
	}
	if (warnings.length > 0) lines.push(warnings.join(" | "));

	process.stdout.write(lines.join("\n"));
});
