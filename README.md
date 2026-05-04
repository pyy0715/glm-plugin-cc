# glm-plugin-cc

Claude Code plugin + local proxy that lets you use [GLM (Z.ai)](https://z.ai) and Claude side-by-side in the same session — switch with `/model`, no restart needed.

## Why this exists

I pay for both a Claude Pro/Max subscription and a Z.ai Coding Plan (GLM-5.1). Using both meant `/model`-switching by hand on every turn, or giving up one entirely.

Existing Claude Code proxies don't solve this well:

- Most are **format converters** (OpenAI/Gemini → Anthropic Messages). GLM already speaks the Anthropic format on Z.ai's Coding Plan endpoint, so the conversion layer is pure overhead.
- They route **every** Anthropic call through the alternate backend — including Claude Code's internal haiku plumbing (title generation, summaries), which silently burns your coding quota.
- Many depend on **litellm**, which had a credential-stealing supply-chain compromise on PyPI (2026-03-24, v1.82.8) and a trail of SSRF/RCE CVEs.
- **Third-party hosted proxies** share credentials across users, violating ToS and eating quota opaquely.

This plugin is a **local proxy + Claude Code hook** that makes GLM a first-class model inside Claude Code. You pick the model with `/model`; the proxy handles auth, context-overflow fallback, and safety. Zero runtime dependencies, runs only on your machine, uses your own credentials.

## How it compares

| Project | Approach | Dual-backend | Context overflow safety | Dependencies |
|---|---|---|---|---|
| **glm-plugin-cc** (this) | hook + local proxy | ✅ same session | ✅ auto-fallback to Claude | 0 |
| [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins) (official) | env vars only | ❌ GLM-only | ❌ | 0 |
| [starbaser/ccproxy](https://github.com/starbaser/ccproxy) | LiteLLM | ✅ | ❌ | LiteLLM |
| [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) | LiteLLM | ✅ | ❌ | LiteLLM |
| [fuergaosi233/claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy) | plain proxy | ✅ | ❌ | 0 |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | AI gateway | ✅ | ❌ | gateway |
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | CLI wrapper | ❌ | — | Codex CLI |

What makes this plugin different:

- **Same-session model switching.** `/model glm-5.1` and `/model opus` work without restarting the session. Z.ai's official plugin can't do this — it's GLM-only.
- **Context-overflow fallback.** GLM has a 200K context window vs Claude's 1M. When GLM rejects a turn, the proxy automatically retries on Claude — your turn isn't lost.

## Key properties

- **Manual `/model` switching** — you decide which backend to use. `/model glm-5.1` for GLM, `/model opus` for Claude.
- **Internal haiku calls always go to Claude** so Claude Code's title/summary plumbing doesn't burn GLM quota.
- **Thinking blocks stripped from history** before forwarding, so backends don't reject each other's signatures when you switch mid-session.
- **Context-overflow aware** — when GLM rejects a turn with `model_context_window_exceeded` (common on `claude-opus-4-6[1m]` sessions that grow past GLM's 200K limit), the proxy automatically falls back to Claude and records the session. Subsequent GLM-bound turns skip the wasted round-trip for 10 minutes.
- **FUP circuit breaker** — if Z.ai returns error `1313` (Fair Usage Policy flag), the proxy drains all GLM-target traffic to Claude for 1 hour, letting the quiet window elapse. State is surfaced as `glm throttled (Nm)` in the statusline.
- **Proxy auto-start** — the SessionStart hook spawns the proxy on demand. If it crashes mid-session, restart with `/exit` + `/resume`.
- **OAuth token passthrough** — Claude-routed requests reuse your Claude Code OAuth header unchanged. GLM-routed requests swap it for `x-api-key: $GLM_API_KEY`.
- **Zero runtime dependencies** — plain Node.js stdlib (`http`, `net`, `child_process`). No LiteLLM.

## Limitations

- **macOS/Linux verified; Windows untested.**
- **Z.ai Coding Plan only.** The Standard GLM API (`api/paas/v4`) returns 429 — this plugin targets `https://api.z.ai/api/anthropic/v1/messages`.
- **First context-overflow turn per session is unavoidable.** The reactive block learns from GLM's actual rejection — the first overflowing turn still makes one wasted GLM call. Every subsequent turn in that session is saved.
- **Relies on Claude Code internals that aren't public API.** `body.metadata.user_id` stringified JSON, the `[1m]` suffix, internal `claude-haiku-*` for plumbing. May drift across Claude Code releases.
- **No proxy respawn mid-session.** If the proxy dies mid-session, you need `/exit` + `/resume` to trigger SessionStart again. (Previous versions had a UserPromptSubmit hook for this; it was removed with the classifier.)

## How it works

```
User → Claude Code → proxy (:4000) → GLM or Claude
                        │
                        ├─ model starts with "glm-"?  → GLM (unless blocked)
                        ├─ model starts with "claude-"? → Claude
                        ├─ internal haiku?              → Claude (always)
                        └─ FUP breaker tripped?         → Claude

If GLM rejects (overflow or error):
  → proxy records session block, retries on Claude
  → next GLM-bound turns skip to Claude for 10 min
```

## Installation

```bash
claude plugin marketplace add pyy0715/glm-plugin-cc
claude plugin install glm@glm-plugin-cc
```

## Setup (one-time)

Inside Claude Code:

```
/glm:setup
```

The skill merges three keys into `~/.claude/settings.json` under `env`:

| Key | Purpose |
|-----|---------|
| `ANTHROPIC_BASE_URL=http://localhost:4000` | Routes all API calls through the proxy |
| `GLM_API_KEY=<your Z.ai key>` | Used by the proxy when forwarding to GLM |
| `GLM_PROXY_PATH=<absolute path>` | SessionStart hook uses this to spawn the proxy |

**After setup, `/exit` and `/resume` every running `claude` session.** Claude Code re-applies `ANTHROPIC_BASE_URL` to running sessions immediately, so any session that's open while you run `/glm:setup` will get `ECONNREFUSED` until the proxy is up. The restart triggers SessionStart, which spawns the proxy.

## Usage

After setup, use Claude Code normally. Switch backends with `/model`:

- `/model glm-5.1` — route to GLM
- `/model opus` — route to Claude
- `/model sonnet` — route to Claude

The proxy handles the rest — auth headers, model rewriting, overflow fallback. Routing decisions land in `/tmp/glm-proxy.log` (set `GLM_DEBUG=1` under `env` for extra detail).

## `/model` picker — register GLM

`ANTHROPIC_CUSTOM_MODEL_OPTION` accepts one custom model. `/glm:setup` adds it automatically, or add manually to `env`:

```json
{
  "env": {
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.1 (routed via glm-proxy)"
  }
}
```

Available GLM models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`. Quota weights: GLM-5.x at 3x peak / 2x off-peak; GLM-4.7 at 1x.

## Statusline (optional)

Add manually to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/marketplaces/glm-plugin-cc/plugins/glm/scripts/statusline.js"
  }
}
```

Shows Claude 5-hour coding quota and GLM coding quota side-by-side. When the local proxy is unreachable, `proxy down` appears in bold red.

## Troubleshooting

- **API errors after `/glm:setup`** — Claude Code picked up `ANTHROPIC_BASE_URL` but the proxy isn't up. `/exit` + `/resume` each session to trigger SessionStart.
- **`API error: 400 model: String should have at most 256 characters`** — `"model": "glm-..."` in settings.json but proxy isn't running. Start the proxy or remove the `"model"` line.
- **Port 4000 already in use** — set `PROXY_PORT=<other>` under `env`.
- **`proxy down` in statusline** — check `lsof -ti:4000` and `/tmp/glm-proxy.log`.
- **See routing decisions** — `GLM_DEBUG=1` under `env`.
- **Cache stale after update** — `ls ~/.claude/plugins/cache/glm-plugin-cc/glm/` and confirm the version directory matches `installed_plugins.json`. A `plugin update` only rebuilds cache when `version` changes.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | — | Set by `/glm:setup` to `http://localhost:4000` |
| `GLM_API_KEY` | — | Z.ai API key |
| `GLM_PROXY_PATH` | — | Absolute path to `bin/glm-proxy.js`, used by SessionStart hook |
| `PROXY_PORT` | `4000` | Proxy listen port |
| `DEFAULT_BACKEND` | `claude` | Fallback when no model prefix matches |
| `GLM_ROUTED_MODEL` | `glm-5.1` | Model the proxy substitutes when routing a non-`glm-*` request to GLM |
| `GLM_PROXY_URL` | `http://localhost:4000` | Where the hook reaches the proxy |
| `GLM_PROXY_READY_TIMEOUT_MS` | `3000` | How long the hook polls for proxy readiness after spawning |
| `GLM_BLOCK_TTL_MS` | `600000` | How long a session stays blocked from GLM after a context overflow |
| `GLM_FUP_COOLDOWN_MS` | `3600000` | How long GLM-target traffic drains to Claude after a 1313 FUP error |
| `GLM_PROXY_LOG` | `/tmp/glm-proxy.log` | Where the proxy's stdout/stderr go |
| `GLM_DEBUG` | unset | Proxy logs per-request metadata |

## Architecture and design decisions

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design rationale: proxy vs skill, routing priority, OAuth passthrough, why no LiteLLM, reactive session block.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — runtime facts and debugging: plugin cache keying, `ANTHROPIC_BASE_URL` re-application, thinking-block signatures, Z.ai overflow signaling, dev loop, debugging checklist.
