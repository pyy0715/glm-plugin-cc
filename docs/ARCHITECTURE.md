# Architecture

Design rationale for glm-plugin-cc — why it's built the way it is. For operational facts (how it actually runs, known pitfalls, debugging), see [`OPERATIONS.md`](OPERATIONS.md).

## Goals

Use [GLM (Z.ai)](https://z.ai) and Claude together inside one Claude Code session, with:

- Code-authoring turns routed to GLM automatically (Z.ai Coding Plan is cheaper per token)
- Explanatory / conversational turns left on Claude (context continuity matters)
- Both quotas visible at a glance
- Free switching via `/model` without tearing down the session

The plugin is one piece per concern: a **local proxy** for model-aware request rewriting, a **SessionStart hook** for proxy lifecycle management, and a **setup skill** for one-shot configuration.

---

## Architectural evolution

### Phase 1 — plugin skill (implemented, abandoned)

The original shape was a plugin skill (`/glm:task`) that called the GLM API directly. Claude Code would collect context, hand it to the skill, and the skill would POST to Z.ai.

Why it didn't work:

- **Double serialization.** Claude read files, serialized them to JSON, POST'd them to GLM. Every turn paid two context-collection passes.
- **GLM couldn't use tools.** The skill path gave GLM a text prompt only — no `Read`/`Write`/`Bash`. Interactive coding was impossible.
- **No iteration.** One-shot by design: GLM couldn't run tests, read output, adjust.
- **Two quotas per turn.** Claude burned tokens gathering context; GLM burned tokens producing code.

The only pieces worth keeping: the statusline (shows both quotas) and the "code intent → GLM" auto-trigger idea — which we reimplemented in Phase 3 as a hook.

### Phase 2 — local proxy (current foundation)

An HTTP proxy sits between Claude Code and the upstream APIs. Claude Code points at `http://localhost:4000` via `ANTHROPIC_BASE_URL`; the proxy rewrites the `model` field and forwards to either `api.anthropic.com` or `api.z.ai`.

Effect: **GLM becomes a native Claude Code model**. Every CC tool (Read/Edit/Bash/Task) works unchanged. The proxy is stateless, zero-dependency Node.js, and speaks Anthropic Messages on both sides.

Files: `src/server.js`, `src/router.js`, `src/proxy.js`, `src/config.js`, `bin/glm-proxy.js`.

### Phase 3 — hook-based session safety

Model-name routing alone (`/model glm-5.1` → GLM) requires manual switching every turn. The original hook included an auto-routing classifier, but it has been **removed** in favor of manual `/model` switching — users now explicitly select GLM when needed.

- `plugins/glm/hooks/session-start.js` spawns the proxy on demand via `ensureProxyRunning()` (shared module `proxy-lifecycle.js`).
- `plugins/glm/skills/setup/SKILL.md` (`/glm:setup`) merges `ANTHROPIC_BASE_URL` / `GLM_API_KEY` / `GLM_PROXY_PATH` into `~/.claude/settings.json`.

A block map keyed by `session_id` (10min TTL, see [Design decision: reactive session block](#8-reactive-session-block)) handles context-overflow learning.

---

## Design decisions

### 1. Proxy over plugin skill

| | Plugin skill | Proxy (chosen) |
|---|---|---|
| GLM file access | ❌ text-only | ✅ native Claude Code tools |
| Auto-detect code intent | ✅ skill description trigger | ❌ model-name only (recovered via hook) |
| Per-turn overhead | high (double serialization) | none |
| Install complexity | low | medium (proxy must be running) |

The proxy wins on the fundamental capability. Auto-detection, the one thing the skill did better, is recovered by the hook.

### 2. Node.js over Python / TypeScript

| | Node.js (chosen) | Python | TypeScript |
|---|---|---|---|
| Dependencies | 0 (`http`/`fetch`/`net` built in) | fastapi/uvicorn/httpx minimum | build step (tsc/tsx) |
| Ships with | Claude Code runtime | not guaranteed | compiles to JS anyway |
| Streaming | `pipe()` with back-pressure | needs a framework | same runtime as JS |
| Type safety | `// @ts-check` + JSDoc suffices here | type hints | full checker |

Node.js + `// @ts-check`. Zero runtime dependencies, same interpreter Claude Code already uses.

### 3. No LiteLLM

- Credential-stealing supply-chain compromise on PyPI (v1.82.8, 2026-03-24): stole SSH keys, AWS credentials, Docker config.
- Open CVEs: SSRF, RCE, auth bypass.
- **Not useful here anyway.** Claude and GLM both speak Anthropic Messages on Z.ai's Coding Plan endpoint — there's no format to convert.

### 4. OAuth passthrough

Pro/Max Claude Code users authenticate with an OAuth token. A proxy that strips or rewrites auth breaks them.

- **Claude route:** forward `Authorization` untouched.
- **GLM route:** strip `Authorization`, inject `x-api-key: $GLM_API_KEY`.
- Don't set `ANTHROPIC_API_KEY` — it would shadow the OAuth flow.

This is a **local** proxy (your own credentials, on your own machine), not a hosted relay. That's a ToS-material distinction — third-party proxies like ohmycode share user credentials and are a different thing entirely.

### 5. Routing priority

| Rank | Source | Rationale |
|---|---|---|
| 1 | `claude-haiku-*` prefix | CC's own plumbing. Pin to Claude so GLM quota isn't wasted on ops traffic. |
| 2 | FUP breaker tripped ∧ `glm-*` | Account-level flag recovery. |
| 3 | Session block ∧ `glm-*` | Session already hit GLM overflow. Preempt to Claude until TTL expires. |
| 4 | `glm-*` prefix | User picked GLM explicitly via `/model`. Always GLM (unless blocked). |
| 5 | `claude-*` prefix | Default tier. |
| 6 | `config.defaultBackend` | Final fallback, defaults to `claude`. |

**Why session-block outranks explicit `glm-*`:** A session that picked `glm-5.1` and then grew past GLM's 200K context window gets the same rejection whether you asked for it or not. Retrying wastes quota and latency. The block auto-clears on TTL so `/clear` or `/compact` re-enables GLM.

### 6. Registering GLM in `/model`

Claude Code's model picker rejects unknown IDs ("Model not found"). `ANTHROPIC_CUSTOM_MODEL_OPTION` lets you inject one:

```json
{
  "env": {
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.1 (routed via glm-proxy)"
  }
}
```

Claude Code skips validation on this ID, so any string works. Only one custom option is allowed.

### 7. Statusline quota mapping

From Z.ai's official plugin (`zai-org/zai-coding-plugins`):

- `TOKENS_LIMIT` → 5-hour coding quota (what users actually care about).
- `TIME_LIMIT` → monthly MCP usage (Vision/Search/Reader).

The initial mapping swapped these; fixed after confirming against the official source.

### 8. Reactive session block

**Problem:** `/model claude-opus-4-6[1m]` tells Claude Code to treat the window as 1M (detected via the `/\[1m\]/i` pattern, confirmed from the `ultraworkers/claw-code` leak in `src/utils/context.ts`). Auto-compact pushes to ~987K. GLM still tops out at 200K, so once a session's accumulated context clears that line, every CODE-classified turn triggers Z.ai's `200 OK + stop_reason=model_context_window_exceeded`, fallback to Claude, retry next turn, same result. Context grows monotonically, so retrying is near-guaranteed to fail again.

**Alternatives considered:**

| | Reactive block (chosen) | Byte threshold | `[1m]` → Claude always |
|---|---|---|---|
| Hard-coded constants | none (TTL only) | needs tuning (~600KB?) | none |
| Language/content bias | none | English-biased | none |
| Adapts if Z.ai limit changes | automatic | manual retune | irrelevant |
| Avoids the first overflow | ❌ unavoidable (1x) | ✅ | ✅ |
| Subsequent turns | ✅ | ✅ | ✅ |
| Small coding turns still on GLM | ✅ (until block fires) | ✅ | ❌ (everything to Claude) |

**Design:**

- `src/router.js` holds `blockedSessions: Map<sessionId, expiresAt>`, GC-on-set.
- `src/server.js` calls `markSessionBlocked(sid)` from each of three overflow branches: 400 `isContextLimitError`, 200 `isContextLimitByStopReason`, and SSE `verdict === 'context_exceeded'`.
- `resolve()` checks the block before the model prefix — if active and the request targets GLM, route to Claude.
- TTL `GLM_BLOCK_TTL_MS`, default 10min — enough to survive a burst of turns, short enough for `/clear` / `/compact` to eventually re-enable GLM.

**Tradeoff:** The first overflow per session still costs one wasted GLM call — the proxy learns from Z.ai's actual rejection, which only arrives after the request is sent. Every subsequent turn is saved. State lives in-memory only; a proxy restart resets it, which is fine (the first overflow re-teaches).

### 9. Dead-proxy auto-recovery

If the proxy dies mid-session (dev reload, orphaned log inode, reboot), every open Claude Code session starts returning ECONNREFUSED until `/exit` + `/resume` retriggers SessionStart. UserPromptSubmit fires on every turn and is the natural recovery point.

- Extract the spawn logic (port probe, readiness poll, detached spawn) to `plugins/glm/hooks/proxy-lifecycle.js`.
- `session-start.js` calls `ensureProxyRunning()` on every session open. Healthy proxy: ~1–5ms TCP probe. Dead proxy: respawn + up to 3s readiness poll.
- Statusline adds a bold-red `proxy down` tail when the probe fails, with a 1s filesystem cache so repeated renders don't spam syscalls.

**Race limit:** If Claude Code's hook-blocking guarantee slips (see OPERATIONS §3.2), the main API request can leave before the respawn completes — that turn still 502s, next turn recovers. Statusline flags the state so users notice.

---

## Verification baseline

These were verified empirically during Phases 2–3 and gate all subsequent design decisions:

**Hook contract**
- UserPromptSubmit is **blocking** (exits before the main API request fires), under normal conditions. Race is observed but not reproducible (see OPERATIONS §3.2).
- User message is on `stdin` as JSON with `prompt` + `session_id` at top level. Claude Code's public docs list `user_prompt`; the actual field name is `prompt`.
- `systemMessage` output from the hook reaches the model context.
- Hooks can curl `localhost`; hooks cannot share state with each other.

**Proxy behavior**
- `glm-5.1` → `api.z.ai`; `claude-opus-4-6` → `api.anthropic.com`.
- OAuth passthrough works for the Claude route.
- SSE streaming passes through `pipe()` unchanged.
- `/_status` reports proxy state, FUP breaker, and backend list.
- `/model glm-5.1` requires `ANTHROPIC_CUSTOM_MODEL_OPTION`.

**GLM API**
- Endpoint for Coding Plan: `https://api.z.ai/api/anthropic/v1/messages` (the `api/paas/v4` endpoint returns 429 — requires a separate Standard top-up).
- Auth: `x-api-key: $GLM_API_KEY` (Bearer is not the Anthropic shape).
- Models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`.
- Quota weights: GLM-5.1 / 5 / 5-Turbo at 3× peak, 2× off-peak; GLM-4.7 at 1× (cheapest — used for the classifier).
- Quota endpoint: `GET https://api.z.ai/api/monitor/usage/quota/limit` (accepts `Authorization`, `x-api-key`, or `Bearer`).

---

## Related work

**Adjacent CC proxies and wrappers.**

- [`zai-org/zai-coding-plugins`](https://github.com/zai-org/zai-coding-plugins) — Z.ai's own; wraps CC to use GLM as the sole backend, no dual-backend support.
- [`starbaser/ccproxy`](https://github.com/starbaser/ccproxy) — LiteLLM-based; routes by body shape (model name, thinking mode, token count, tool presence), not prompt content. Inspired the hook+proxy split.
- [`1rgs/claude-code-proxy`](https://github.com/1rgs/claude-code-proxy) — LiteLLM-based; format conversion to OpenAI/Gemini.
- [`fuergaosi233/claude-code-proxy`](https://github.com/fuergaosi233/claude-code-proxy) — dependency-free but format-conversion-only, no intent routing.
- [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) — delegates to the Codex CLI as a subagent. Different shape (local CLI wrapper).
- [`yangtau/claude-agents-plugins`](https://github.com/yangtau/claude-agents-plugins) — same local-CLI-wrapper pattern for Cursor.

**AI gateways.** Route by metadata/structure, not request content.

- [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway) — conditional routing on request metadata.
- [`alibaba/higress`](https://github.com/alibaba/higress) — URL/header-based proxy routing.

**Security reference (the reason LiteLLM is out).**

- LiteLLM PyPI supply-chain compromise, 2026-03-24, v1.82.8: credential stealer (SSH, AWS, Docker) activated on import.
- LiteLLM CVE-2026-24486 and CVE-2025-67221: unpatched at time of writing.
- LiteLLM SSRF + RCE: `api_base` parameter + guardrail sandbox gap.

**Primary references.**

- Z.ai Coding Plan FAQ: `https://docs.z.ai/devpack/faq`
- Z.ai Claude Code config: `https://docs.z.ai/devpack/tool/claude`
- Z.ai GLM-5.1 usage: `https://docs.z.ai/devpack/using5.1`
- Z.ai best practices: `https://docs.z.ai/devpack/resources/best-practice`
- GLM OpenAPI spec: `https://docs.bigmodel.cn/openapi/openapi.json`
- Claude Code hooks: `https://code.claude.com/docs/en/hooks`
- Claude Code model config: `https://code.claude.com/docs/en/model-config`
- Anthropic SDK (TypeScript): `https://github.com/anthropics/anthropic-sdk-typescript`
- Leaked Claude Code source (used as the authoritative reference for internal prompt structure and `[1m]` detection): `https://github.com/ultraworkers/claw-code`

---

## Repository layout

```
glm-plugin-cc/
├── bin/
│   └── glm-proxy.js                CLI entry point
├── src/
│   ├── config.js                   env loader
│   ├── router.js                   session block + FUP breaker + resolve()
│   ├── proxy.js                    upstream piping + OAuth passthrough
│   ├── server.js                   HTTP server (/v1/messages, /_status)
│   ├── sanitize.js                 strips thinking/redacted_thinking from history
│   ├── rewrite.js                  rewrites model field for GLM route
│   └── fallback.js                 context-overflow detector (400 + 200+stop_reason + SSE)
├── plugins/glm/                    ← cache copies only this subtree
│   ├── .claude-plugin/
│   │   └── plugin.json             version is the cache key; bump to invalidate
│   ├── scripts/
│   │   └── statusline.js           quota + proxy-down indicator
│   ├── hooks/
│   │   ├── hooks.json              SessionStart registration
│   │   ├── proxy-lifecycle.js      checkPort/waitReady/spawnProxy/ensureProxyRunning
│   │   └── session-start.js        spawns proxy via ensureProxyRunning()
│   └── skills/
│       └── setup/SKILL.md          /glm:setup — one-time settings.json merge
├── .claude-plugin/
│   └── marketplace.json            marketplace metadata
├── test/                           node --test suite
├── docs/
│   ├── ARCHITECTURE.md             (this file)
│   └── OPERATIONS.md               runtime facts and debugging
```

---

## Roadmap

**Shipped**
- Phase 2 — proxy + routing core (0.3.x)
- Phase 3 — classifier + hook auto-routing + `/glm:setup` (0.4.0)
- Thinking-block strip for cross-backend signature safety (0.4.0)
- Model rewrite to `glm-5.1` on GLM route (0.4.0)
- Context-overflow fallback, non-stream + streaming (0.4.0)
- Classifier redesign — production vs. conversation intent (0.4.1)
- Reactive session block for overflow learning (0.4.2)
- Dead-proxy auto-recovery via UserPromptSubmit (0.4.2)
- `proxy down` indicator on statusline (0.4.2)
- Manual-only GLM routing (classifier removed)

**Open**
- Investigate the ~20s lag when switching models mid-session.

**Candidates (build if demanded)**
- Multi-entry `ANTHROPIC_CUSTOM_MODEL_OPTION` if Claude Code ever supports it.
- Auto-select GLM-5.1 vs GLM-4.7 by request complexity.
- Auto-fallback to Claude when the GLM quota is exhausted.
- Richer statusline fed by proxy response metadata.

**Explicitly out of scope**
- launchd / systemd service files — SessionStart auto-recovery covers the same ground without requiring OS-specific setup.
- Self-written `--detach` — same reason.
- Plugin-skill path (`/glm:task`) — superseded by the proxy (commit 34e19bf).
- Full TypeScript — `// @ts-check` + JSDoc is enough here, YAGNI.
