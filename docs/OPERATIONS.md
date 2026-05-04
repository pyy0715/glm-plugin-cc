# Operations

Runtime facts about how this plugin behaves, what's known to break, and how to debug it. For design rationale (why the pieces exist), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

This file is mostly empirically verified — anything surprising was observed, logged, and documented here so it doesn't have to be rediscovered.

---

## 1. Claude Code plugin system

### 1.1 Three places a plugin lives

| Path | Contents | How it updates |
|---|---|---|
| `~/.claude/plugins/marketplaces/<plugin>/` | full git clone (repo root) | `claude plugin marketplace update <name>` → `git pull` |
| `~/.claude/plugins/cache/<name>/<plugin>/<version>/` | only the `plugins/<name>/` subtree | `claude plugin update <plugin>@<marketplace>` — new directory only when `version` changes |
| `~/.claude/plugins/installed_plugins.json` | active-version metadata | updated by both commands above |

**Critical:** the cache contains **only** the `plugins/<name>/` subtree. Files at the repo root (`src/`, `bin/`) are **not** in the cache. Consequences:

- Hooks can only import relative paths inside the cache. `./classifier.js` works; `../../src/xxx.js` doesn't.
- The proxy entry point has to be referenced by absolute path (via `GLM_PROXY_PATH`) because it lives in the marketplace dir, not the cache.

### 1.2 Cache key = `plugin.json` version

`claude plugin update` creates a new cache directory **only when the `version` string changes**. Same version → stale cache reused silently. Bumping `version` in `plugins/glm/.claude-plugin/plugin.json` is the only reliable way to force end users to pick up new hook/skill content.

Old cache directories are harmless (just disk). The active one is whatever `installed_plugins.json`'s `installPath` points to.

### 1.3 `CLAUDE_PLUGIN_ROOT`

Injected by Claude Code when a hook runs. Points to the **cache** path, not the marketplace path. Use it in `hooks.json` as `${CLAUDE_PLUGIN_ROOT}/hooks/xxx.js`.

---

## 2. Claude Code API request internals

### 2.1 `body.metadata.user_id` is a stringified JSON

Claude Code packs this into the Anthropic Messages API `metadata.user_id` field:

```json
{
  "metadata": {
    "user_id": "{\"device_id\":\"...\",\"account_uuid\":\"...\",\"session_id\":\"...\"}"
  }
}
```

- Not part of the public Anthropic spec — a Claude Code convention.
- Internal haiku calls (title generation, summaries) share the session's `session_id`.
- `session_id` is a per-session UUID.
- Parse with `JSON.parse(metadata.user_id).session_id`; wrap in `try/catch` because it sometimes isn't a string.

### 2.2 `ANTHROPIC_BASE_URL` is re-applied to running sessions immediately

Edit `settings.json` and Claude Code picks up the new `ANTHROPIC_BASE_URL` without `/reload-plugins` or a restart. Implication:

- The moment `/glm:setup` writes to settings.json, **every** open `claude` session retargets to the new URL.
- If the proxy isn't up at that instant, every open session starts returning ECONNREFUSED.
- The setup skill tells the user to `/exit` and `/resume` each session to trigger SessionStart and spawn the proxy.

### 2.3 Model picker (`ANTHROPIC_CUSTOM_MODEL_OPTION`)

- Exactly **one** custom option slot.
- `CUSTOM_MODEL_OPTION_NAME` and `CUSTOM_MODEL_OPTION_DESCRIPTION` make the picker UI readable.
- Selecting it puts the ID string verbatim into the request's `model` field.
- Claude Code **skips validation** on this ID, so any string passes.

### 2.4 `"model": "glm-5.1"` without `ANTHROPIC_BASE_URL` → 400 "String should have at most 256 characters"

If `settings.json` has `"model": "glm-5.1"` as the default but `ANTHROPIC_BASE_URL` is unset, Claude Code sends the request to `api.anthropic.com` directly, the API rejects it, and Claude Code's internal retry/fallback path corrupts the model string to >256 chars. Reproducible, root cause unidentified — looks like a Claude Code bug.

Workaround: don't leave a `"model": "glm-..."` default in settings.json without the proxy running. Pick it with `/model` inside the session instead.

### 2.5 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`

- Set the concrete model ID for each tier.
- Internal calls (title generation etc.) use the haiku tier's ID.
- Setting `ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air` routes internal haiku through GLM — affects the routing prefix logic and eats GLM quota.

---

## 3. Hooks

### 3.1 SessionStart (active)

`session-start.js` calls `ensureProxyRunning()` from the shared `proxy-lifecycle.js` module. Probes port 4000; if dead, spawns the proxy detached and polls for readiness up to 3s.

### 3.2 UserPromptSubmit hook (removed)

> **Note:** The `UserPromptSubmit` hook has been removed. Only the `SessionStart` hook runs now. The sections below are kept as historical reference.

### 3.1 stdin schema (historical)

Empirically:

```json
{
  "prompt": "raw user message",
  "session_id": "UUID v4"
}
```

Both fields are top-level. Claude Code's public docs called this field `user_prompt`; the actual field name is `prompt`.

### 3.2 Hooks inherit `process.env`

- Every value in the `env` block of `settings.json` is available to the hook and to the proxy it spawns (`GLM_HOOK_DEBUG`, `GLM_API_KEY`, etc).
- Confirmed via `ps -Ewwp <proxy_pid>`.

---

## 4. Routing priority (as built)

```
1. model.startsWith("claude-haiku-")  → Claude   (internal ops traffic)
2. FUP breaker tripped ∧ glm-target   → Claude   (FUP 1313 recovery, §12)
3. blocked session ∧ glm-target       → Claude   (reactive overflow learning)
4. model.startsWith("glm-")           → GLM      (explicit user pick)
5. model.startsWith("claude-")        → Claude   (default tier)
6. config.defaultBackend              → final fallback
```

The rationale is in ARCHITECTURE §5. In practice:

- Concurrent internal haiku (`claude-haiku-4-6`) → always pinned to `claude`.

---

## 6. Proxy infrastructure

### 6.1 Auto-start + auto-recovery

Shared module: `plugins/glm/hooks/proxy-lifecycle.js` exports `checkPort`, `waitReady`, `spawnProxy`, `ensureProxyRunning` — returns one of `"already-up" | "started" | "missing-path" | "unreachable"`.

- **SessionStart hook:** on every session open. Probes port 4000; if dead, spawns the proxy detached (`spawn + detached + unref`, stdio → log file) and polls for readiness up to 3s.
- Skipped cleanly if `GLM_PROXY_PATH` isn't set (graceful degradation pre-setup).

### 6.2 Orphan log inode trap

Reproduced 2026-04-14:

- `rm -f /tmp/glm-proxy.log && touch /tmp/glm-proxy.log` while the proxy is running
- The proxy still holds a file descriptor pointing to the **deleted inode** — it keeps writing there
- `cat /tmp/glm-proxy.log` reads the new empty file; output looks like it disappeared
- `lsof -p <proxy_pid>` shows the fd's inode doesn't match `stat /tmp/glm-proxy.log`'s inode

**Fix:** restart the proxy (`pkill -9 -f glm-proxy.js`; next prompt respawns).

**Prevention:** truncate in place with `truncate -s 0 /tmp/glm-proxy.log`, or restart the proxy. Don't `rm && touch`.

### 6.3 `GLM_PROXY_LOG`

Default `/tmp/glm-proxy.log`. Override to point elsewhere.

### 6.4 SSE streaming

The proxy uses `upstreamRes.pipe(clientRes)` for the body. No special handling, no parsing — straight passthrough with back-pressure.

### 6.5 Auth header handling

- **Claude route:** preserve the request's `Authorization` header (OAuth passthrough).
- **GLM route:** drop `Authorization`, inject `x-api-key: $GLM_API_KEY`.

---

## 8. Dev loop vs release loop

### 8.1 Release loop (the supported path)

1. Edit in the dev repo.
2. `npm test` and `npx biome check`.
3. Commit and push to main.
4. End user: `claude plugin marketplace update <name> && claude plugin update <plugin>@<marketplace>`.
5. Restart `claude`.
6. If the cache is stale, bump `plugin.json` `version`.

Slow loop — every iteration is commit + push + update + restart.

### 8.2 Dev loop (symlinks)

**One-time setup:**

```bash
mv ~/.claude/plugins/marketplaces/<name> ~/.claude/plugins/marketplaces/<name>.bak
ln -s <dev_repo_absolute_path> ~/.claude/plugins/marketplaces/<name>
rm -rf ~/.claude/plugins/cache/<name>
mkdir -p ~/.claude/plugins/cache/<name>/<plugin>
ln -s <dev_repo_absolute_path>/plugins/<plugin> ~/.claude/plugins/cache/<name>/<plugin>/<version>
```

**Per-iteration:**

- Hook / skill / classifier edits land immediately on the next prompt.
- Proxy edits need a proxy restart (`node --watch bin/glm-proxy.js` auto-restarts).
- No commit/push/update cycle.

**Don't:**

- Run `claude plugin marketplace update` — it overwrites your symlink with a git clone.
- Run `claude plugin update` — it overwrites the cache symlink.
- Ship without reverting the symlinks and testing the release loop end-to-end.

**Revert:**

```bash
rm ~/.claude/plugins/marketplaces/<name>
rm -rf ~/.claude/plugins/cache/<name>
mv ~/.claude/plugins/marketplaces/<name>.bak ~/.claude/plugins/marketplaces/<name>
claude plugin marketplace update <name>
claude plugin update <plugin>@<marketplace>
```

### 8.3 Ad-hoc cache edit

Edit `~/.claude/plugins/cache/<name>/<plugin>/<version>/` directly for a one-off debug session. The next `claude plugin update` wipes it — always port the change back to the dev repo.

---

## 9. Debug environment variables

| Variable | Effect |
|---|---|
| `GLM_DEBUG=1` | Proxy logs `body.metadata` and `system` summary per request to stdout. |
| `GLM_PROXY_LOG` | File the SessionStart hook redirects proxy stdout/stderr to. Default `/tmp/glm-proxy.log`. |
| `GLM_PROXY_URL` | Where hooks reach the proxy. Default `http://localhost:4000`. |
| `GLM_PROXY_READY_TIMEOUT_MS` | Readiness-poll ceiling for SessionStart. Default 3000. |
| `GLM_BLOCK_TTL_MS` | How long a session stays blocked from GLM after a context overflow (§10.5). Default 600000 (10min). |

---

## 10. Issue log (mostly resolved)

### 10.1 Turn-1 blocking anomaly (no longer reproducible)

**Observation (early 2026-04-14):** 14ms between the classifier request and the main opus request on a session's first prompt — impossible if the classifier (700–900ms avg) actually returned. Turn 2 looked fine.

**Follow-up (after the thinking strip + cache cleanup):** 1–3s gap on both turn 1 and turn 2, consistently. Not reproducible.

**Most likely cause:** at the time, `installed_plugins.json` had `0.1.0` as active while the cache held `0.1.0`, `0.2.0`, and `0.2.1`. Claude Code probably loaded a hook that wasn't the intended version — an old one where `await fetch(...)` wasn't properly awaited. After `rm -rf ~/.claude/plugins/cache/glm-plugin-cc` and a `plugin.json` version bump, no recurrence.

**Lesson:** When debugging hooks, **always check which version is actually loaded first**:

```bash
cat ~/.claude/plugins/installed_plugins.json | \
  python3 -c "import json,sys; p=json.load(sys.stdin)['plugins']['glm@glm-plugin-cc']; print(p[0]['installPath'], p[0]['version'])"
ls ~/.claude/plugins/cache/glm-plugin-cc/glm/
```

The active `installPath` is what's running. Cached directories of other versions don't matter.

### 10.2 Thinking block signature mismatch (fixed)

```
API Error: 400
messages.1.content.0: Invalid `signature` in `thinking` block
```

**Symptom:** when the same session routes a turn to backend A (leaving a signed `thinking` block in history) and the next turn to backend B, B can't verify A's signature → 400.

**Fix:** `src/sanitize.js` strips `thinking` and `redacted_thinking` from every outbound assistant history message. Each backend sees clean history. The current turn's thinking is regenerated from the request's `thinking` field, so nothing is lost.

- Applied in `src/server.js` just before forwarding.
- Tests: `test/sanitize.test.js` (9 cases).
- Logged on `GLM_DEBUG=1`: `stripped thinking blocks from assistant history`.

### 10.3 Z.ai's context-overflow signaling (fixed)

**Discovered 2026-04-14.** Z.ai's Anthropic-compatible endpoint does **not** use `400 invalid_request_error` for window overflow. Instead:

- **Non-streaming:** `status=200` with body `{"content":[], "stop_reason":"model_context_window_exceeded", "usage":{"input_tokens":0,"output_tokens":0}}`.
- **Streaming (SSE):** `message_start` → `message_delta` (with `delta.stop_reason=model_context_window_exceeded`) → `message_stop`. No `content_block_start` — the model never starts generating.

Claude Code's "The model has reached its context window limit" user-facing error is the client's synthesis from this `stop_reason`.

**Fix:** bidirectional fallback in `src/fallback.js` + `src/server.js`:

- Non-streaming: buffer the upstream body (1MB ceiling), check `isContextLimitByStopReason`, fall back to Claude if true.
- Streaming: buffer the SSE prelude up to 64KB, feed it to `createSseDetector()`, decide `context_exceeded` / `normal` / keep-buffering. On exceed, discard the buffer and replay against Claude; on normal, flush and `pipe()`.
- Before fallback, restore the inbound `body.model` (the rewritten `glm-5.1` would be rejected by Claude).
- The 400 path stays in place as a second safety net (in case the endpoint changes behavior).

Log line: `[ctx-fallback] <inboundModel> -> claude (glm 200 stop_reason: model_context_window_exceeded)`.

### 10.4 `/reload-plugins` in isolation

`ANTHROPIC_BASE_URL` re-application happens without `/reload-plugins` (§2.2). What else `/reload-plugins` does on top remains untested.

### 10.5 1M opt-in sessions and GLM overflow loops (fixed, 2026-04-15)

**Discovered:** `/model claude-opus-4-6[1m]` tells Claude Code to treat the window as 1M (the `[1m]` suffix is detected by `has1mContext = /\[1m\]/i.test(model)` — confirmed from the `ultraworkers/claw-code` leak of CC's `src/utils/context.ts`). Auto-compact raises to ~987K. Once the session's context exceeds 200K, every CODE-classified turn triggers Z.ai's 200 + `model_context_window_exceeded` (§10.3), fallback retries on Claude, and next turn repeats the cycle. Context grows monotonically, so retrying is near-certain to overflow again — waste quota and latency every turn.

**Fix — reactive session learning:**

- `src/router.js` adds `blockedSessions: Map<sessionId, expiresAt>` (same GC-on-set as the hint map).
- `src/server.js`'s three overflow branches (400 / 200 / SSE) call `markSessionBlocked(sid)` just before the Claude fallback.
- `resolve()` checks the block before the hint. If block is active and the target is GLM (explicit `glm-*` or `hint.backend === "glm"`), route to Claude.
- TTL `GLM_BLOCK_TTL_MS`, default 10min — `/clear` or `/compact` eventually clears the session and GLM becomes eligible again.

**Savings:** one wasted GLM call per session is unavoidable (learning requires Z.ai's rejection). Every subsequent turn is skipped. No hard-coded thresholds, no language-specific branches.

Log: `[session-block] sid=<8char> ttl=600000ms` (emitted right after the fallback line).

### 10.6 Dead-proxy auto-recovery (fixed, 2026-04-15)

**Symptom:** With `ANTHROPIC_BASE_URL=http://localhost:4000` set, a dead proxy (dev reload, kill for the orphan-inode trap §6.2, post-reboot) made every open Claude Code session return ECONNREFUSED until the user did `/exit` + `/resume` to retrigger SessionStart.

**Fix:** `session-start.js` calls `ensureProxyRunning()` on every session open. Healthy proxy: ~1–5ms TCP probe, through. Dead proxy: respawn via the shared `plugins/glm/hooks/proxy-lifecycle.js` logic, up to 3s readiness poll.

**Race limitation:** The respawn happens during SessionStart, before any API requests fire. If the proxy dies mid-session, recovery requires a new session (`/exit` + `/resume`) to retrigger SessionStart.

**Visibility:** `plugins/glm/scripts/statusline.js` probes port 4000 with a 300ms timeout (1s cached). Down → bold-red `proxy down` at the end of the status line. Users see the state before hitting it.

**Debug trace:** `GLM_HOOK_DEBUG=1` writes `proxy-health-start` / `proxy-health-done state=already-up|started|unreachable|missing-path` to `/tmp/glm-route-hook.log`.

---

## 11. Debugging checklist (in order)

1. **Which version is actually active?**
   `cat ~/.claude/plugins/installed_plugins.json` — confirm `installPath` and `version`.
   `ls ~/.claude/plugins/cache/<name>/<plugin>/` — note which versions exist.
2. **Is the proxy up?**
   `lsof -ti:4000` and `curl -s http://localhost:4000/_status`.
3. **Is the log file an orphan inode?**
   `stat /tmp/glm-proxy.log` vs `lsof -p <proxy_pid>` — compare inodes.
4. **What did the router decide?**
   `model -> backend` lines in `/tmp/glm-proxy.log`.
5. **Does `session_id` match across logs?**
   Compare hook session IDs with the proxy log's `metadata`.

**When clearing logs:** `truncate -s 0 /tmp/glm-proxy.log`. Never `rm && touch` on a file an active process holds open — see §6.2.

---

## 12. FUP circuit breaker

### 12.1 Why this exists

Z.ai error code **1313** ("Your account's current usage pattern does not comply with the Fair Usage Policy…") is triggered by the *shape* of traffic, not its volume. Even a low-rate Max-plan account can get flagged if the traffic pattern looks automated.

Research context for the design choice: `1313` is account-level (not per-request like `1302`/`1303`). Continued requests during the cooldown observably extend the timer. Therefore the only safe recovery is a **long, enforced silence** — backoff with retries makes things worse.

### 12.2 Breaker

| Layer | Where | Role |
|---|---|---|
| Breaker | `src/router.js` `fupBreaker` (singleton) | If a GLM response comes back with `error.code === 1313`, trip the breaker; for `GLM_FUP_COOLDOWN_MS` (default 1h) every GLM-target turn drains to Claude. |

The breaker is a **single global state**, not per-session. 1313 is an account flag, so every session on this machine must pause.

### 12.3 Control flow

Proxy side, the 1313 detector lives in both `tryGlmNonStreaming` and `tryGlmStreaming` (non-200 path) next to the existing context-overflow logic.

### 12.4 Observability

- Proxy log: `glm 1313 FUP tripped (non-stream|stream): <message snippet>`.
- `GET /_status` response includes `fupBreaker: { tripped, cooldownRemainingMs }`.

### 12.5 Tuning knobs

| Env var | Default | When to change |
|---|---|---|
| `GLM_FUP_COOLDOWN_MS` | `3600000` | Lower if Z.ai's actual cooldown is shorter for your account; raise if the 1313 keeps retriggering. |

### 12.6 Persistence

Breaker state is persisted to `/tmp/glm-fup-breaker.json` so it survives proxy restarts (log rotation, dev reloads). On startup `router.js` reads the file; stale entries (>24h old) are discarded. The path can be overridden via `GLM_FUP_STATE_PATH` for tests or sandboxed environments. Deleting the file while tripped is a manual override — do it only when you're confident Z.ai has lifted the flag.

### 12.7 Known limits

- The **first** request that triggers 1313 still surfaces the error to the user — we can only trip the breaker after seeing the response.
- A user who explicitly `/model glm-5.1` during the cooldown still gets routed to Claude. No escape hatch by design (1313 severity argues for caution).
- Substring detection in streams accepts a superset (e.g. `"code":13131` would false-positive match `"code":1313`). Z.ai's documented error codes don't collide, but this is a known limitation — see `test/fup-detection.test.js` for the pinned behavior.

