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

## 3. UserPromptSubmit hook

### 3.1 stdin schema

Empirically:

```json
{
  "prompt": "raw user message",
  "session_id": "UUID v4"
}
```

Both fields are top-level. Claude Code's public docs called this field `user_prompt`; the actual field name is `prompt`.

### 3.2 Execution timing

By spec, **blocking** — the hook exits before the main API request fires. Usually true:

- Typical trace: classifier takes ~800ms, hook exits, ~900ms later the main prompt arrives at the proxy. Blocking confirmed.

**Anomaly once observed:** on a session's first prompt, the interval between the classifier request and the main prompt hitting the proxy was 14ms — the classifier couldn't have returned yet, so the hook was clearly *not* blocking. Not reproducible after cleaning the plugin cache; most likely cause was a stale hook version from a dirty cache (see §10.1).

Current defense: `process.exit(0)` in `.finally()` guarantees the hook exits cleanly even if `await fetch(...)` misbehaves. The blocking contract itself is Claude Code's to keep.

### 3.3 Hooks inherit `process.env`

- Every value in the `env` block of `settings.json` is available to the hook and to the proxy it spawns (`GLM_HOOK_DEBUG`, `GLM_API_KEY`, etc).
- Confirmed via `ps -Ewwp <proxy_pid>`.

---

## 4. Routing priority (as built)

```
1. model.startsWith("claude-haiku-")  → Claude   (internal ops traffic)
2. FUP breaker tripped ∧ glm-target   → Claude   (FUP 1313 recovery, §12)
3. blocked session ∧ glm-target       → Claude   (reactive overflow learning, §10.5)
4. model.startsWith("glm-")           → GLM      (explicit user pick)
5. session hint (from hook)           → hint.backend
6. model.startsWith("claude-")        → Claude   (default tier)
7. config.defaultBackend              → final fallback
```

The rationale is in ARCHITECTURE §5. In practice:

- `write a python function...` → classifier: CODE → hint=glm → opus request → routed to `glm`. ✅
- `what is the capital of France?` → classifier: OTHER → hint=claude → opus request → routed to `claude`. ✅
- Concurrent internal haiku (`claude-haiku-4-6`) → always pinned to `claude`. ✅

---

## 5. Session-keyed hints

### 5.1 The bug that forced this

The first implementation used `let currentHint = null` at module scope — one global hint per proxy. Two sessions sharing the same proxy would see each other's hints for the TTL window.

### 5.2 The fix

- `const hints = new Map()` keyed by `session_id → { backend, expires }`.
- `extractSessionId(metadata)` parses `metadata.user_id`.
- `resolve()` looks up by session.

TTL 60s covers multi-request bursts within one turn; the Map keeps sessions isolated.

### 5.3 `/_hint` schema change

Was `{ backend, ttl? }`, now **`{ session_id, backend, ttl? }`**. Missing `session_id` → 400.

---

## 6. Proxy infrastructure

### 6.1 Auto-start + auto-recovery

Shared module: `plugins/glm/hooks/proxy-lifecycle.js` exports `checkPort`, `waitReady`, `spawnProxy`, `ensureProxyRunning` — returns one of `"already-up" | "started" | "missing-path" | "unreachable"`.

- **SessionStart hook:** on every session open. Probes port 4000; if dead, spawns the proxy detached (`spawn + detached + unref`, stdio → log file) and polls for readiness up to 3s.
- **UserPromptSubmit hook:** every prompt. Runs `ensureProxyRunning()` before the classifier. Healthy case is a ~1–5ms TCP probe and through; dead case respawns and polls. Recovery of open sessions no longer needs `/exit` + `/resume`.
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

## 7. Classifier

### 7.1 Implementation

- Model: `glm-4.7` (1× quota, the cheapest GLM tier).
- Calls the proxy's own `/v1/messages` — the `glm-` prefix routes it to GLM automatically, no extra auth needed.
- System prompt separated from user turn; user prompt truncated to the first 2000 chars.
- 5s timeout; `null` on any failure → no hint sent → default backend applies.

### 7.2 Redesign history (2026-04-14)

The original "software-related == CODE" framing broke twice:

**Round 1 — few-shot vocabulary bias (7 → 5 balanced).** Symptom: simple complaints like "에러나는데" misclassified as CODE → routed to GLM → context overflow. Cause: the `NullPointerException` CODE example pulled the Korean word 에러 toward CODE. Fix: fewer examples, vocabulary spread across both labels.

**Round 2 — "production vs. conversation" redefinition (inspired by NVIDIA's LLM Router pattern).** Symptom: `explain kubectl`, `explain what this regex matches` classified as CODE. Feedback: explanatory questions belong on Claude for context continuity. Redefinition: CODE only = intent to **produce or modify** code on a named artifact. Everything else (explanation, diagnostic questions, advice, chat) = OTHER.

Current shape:

- English-only system prompt with XML `<task>` / `<definition>` / `<rules>` blocks.
- 6+6 few-shot: CODE (production/modification/fix), OTHER (explanation/diagnostic/opinion/chat/general/meta).
- Vocabulary spread: "error", "NullPointerException", "kubectl", "git" all appear on both sides.
- Asymmetric tie-breaker: uncertain → OTHER (see §7.5).

### 7.3 Verification harness

`scripts/verify-classifier.js` — 17 cases (previous misclassification recoveries + regression guards). 50ms sleep between calls, single retry on null. Excluded from `npm test` because it hits live GLM and burns quota. Run it after any classifier change.

Latest result: **17/17 pass**.

### 7.4 Latency

- Warm: 600–900ms.
- Cold: slower (suspected contributor to the anomaly in §10.1).

### 7.5 Asymmetric safety principle

| Misclassification | Cost |
|---|---|
| OTHER → GLM (a conversational turn routed to GLM) | 1 wasted GLM call + risk of context overflow; fallback absorbs it |
| CODE → Claude (a code turn routed to Claude) | functionally fine; Claude handles coding too |

When uncertain, OTHER is the economically safer default. The classifier's rule list bakes this in explicitly.

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
| `GLM_HOOK_DEBUG=1` | `route-hook.js` writes phase timings to `/tmp/glm-route-hook.log`. |
| `GLM_PROXY_LOG` | File the SessionStart hook redirects proxy stdout/stderr to. Default `/tmp/glm-proxy.log`. |
| `GLM_PROXY_URL` | Where hooks reach the proxy. Default `http://localhost:4000`. |
| `GLM_CLASSIFY_TIMEOUT_MS` | Classifier fetch timeout. Default 5000. |
| `GLM_HINT_TTL_MS` | TTL attached to each hint. Default 60000. |
| `GLM_PROXY_READY_TIMEOUT_MS` | Readiness-poll ceiling for SessionStart/UserPromptSubmit. Default 3000. |
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

**Fix:** `route-hook.js` calls `ensureProxyRunning()` before the classifier. Healthy proxy: ~1–5ms TCP probe, through. Dead proxy: respawn via the shared `plugins/glm/hooks/proxy-lifecycle.js` logic, up to 3s readiness poll.

**Race limitation:** if the anomaly of §3.2 resurfaces (hook not blocking the main request), the respawn may finish after the main API request has already fired — that one turn still 502s, the next turn recovers. Under normal ~900ms blocking, the respawn precedes the main request.

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
4. **Did the hook actually run?**
   `GLM_HOOK_DEBUG=1`, then look for phase markers in `/tmp/glm-route-hook.log`.
5. **Did classification return?**
   `classify-done result=CODE|OTHER|null` in the hook log.
6. **Did the hint POST succeed?**
   `hint-post-done status=200` in the hook log.
7. **What did the router decide?**
   `model -> backend` lines in `/tmp/glm-proxy.log`.
8. **Does `session_id` match across logs?**
   Compare the hook log's `session_id` with the proxy log's `metadata`.

**When clearing logs:** `truncate -s 0 /tmp/glm-proxy.log`. Never `rm && touch` on a file an active process holds open — see §6.2.

---

## 12. Classifier throttle + FUP circuit breaker

### 12.1 Why this exists

Z.ai error code **1313** ("Your account's current usage pattern does not comply with the Fair Usage Policy…") is triggered by the *shape* of traffic, not its volume. The classifier's original pattern — a fixed-template request with `max_tokens: 4` fired on every user prompt — is a textbook bot fingerprint from Z.ai's perspective, so even a low-rate Max-plan account gets flagged.

Research context for the design choice: `1313` is account-level (not per-request like `1302`/`1303`). Continued requests during the cooldown observably extend the timer. Therefore the only safe recovery is a **long, enforced silence** — backoff with retries makes things worse.

### 12.2 Two layers

| Layer | Where | Role |
|---|---|---|
| Throttle | `src/router.js` `classifyCache` (Map) | Re-use the last classifier verdict for the same session for `GLM_CLASSIFY_THROTTLE_MS` (default 60s), so we don't classify every prompt. |
| Breaker | `src/router.js` `fupBreaker` (singleton) | If a GLM response comes back with `error.code === 1313`, trip the breaker; for `GLM_FUP_COOLDOWN_MS` (default 1h) every GLM-target turn drains to Claude. |

The breaker is a **single global state**, not per-session. 1313 is an account flag, so every session on this machine must pause.

### 12.3 Control flow

```
hook  UserPromptSubmit
 │
 ├─ GET  /_should-classify?session_id=…
 │   ├─ breaker tripped     → { skip:true, reason:"tripped", cooldownRemainingMs }
 │   ├─ session cache hit   → { skip:true, reason:"throttled", cachedVerdict }
 │   └─ else                → { skip:false }
 │
 ├─ skip=false:
 │   ├─ classify() (glm-4.7 via proxy)
 │   ├─ POST /_classified  { session_id, verdict }
 │   └─ POST /_hint        { session_id, backend }
 │
 ├─ skip=true/throttled:
 │   └─ POST /_hint (reuse cachedVerdict → backend)
 │
 └─ skip=true/tripped:
     └─ (nothing — proxy.resolve() drains to Claude anyway)
```

Proxy side, the 1313 detector lives in both `tryGlmNonStreaming` and `tryGlmStreaming` (non-200 path) next to the existing context-overflow logic.

### 12.4 Observability

- Proxy log: `glm 1313 FUP tripped (non-stream|stream): <message snippet>`.
- Statusline: `glm throttled (Nm)` in bold red — queried from `GET /_status` once per render when the proxy is alive.
- `GET /_status` response includes `fupBreaker: { tripped, cooldownRemainingMs }`.

### 12.5 Tuning knobs

| Env var | Default | When to change |
|---|---|---|
| `GLM_CLASSIFY_THROTTLE_MS` | `60000` | Raise if you hit 1313 despite the throttle (e.g. 300000 = 5min); lower only if misrouting during rapid task-switching is observed. |
| `GLM_FUP_COOLDOWN_MS` | `3600000` | Lower if Z.ai's actual cooldown is shorter for your account; raise if the 1313 keeps retriggering. |

### 12.6 Persistence

Breaker state is persisted to `/tmp/glm-fup-breaker.json` so it survives proxy restarts (log rotation, dev reloads). On startup `router.js` reads the file; stale entries (>24h old) are discarded. The path can be overridden via `GLM_FUP_STATE_PATH` for tests or sandboxed environments. Deleting the file while tripped is a manual override — do it only when you're confident Z.ai has lifted the flag.

### 12.7 Known limits

- The **first** request that triggers 1313 still surfaces the error to the user — we can only trip the breaker after seeing the response.
- A user who explicitly `/model glm-5.1` during the cooldown still gets routed to Claude. No escape hatch by design (1313 severity argues for caution).
- Substring detection in streams accepts a superset (e.g. `"code":13131` would false-positive match `"code":1313`). Z.ai's documented error codes don't collide, but this is a known limitation — see `test/fup-detection.test.js` for the pinned behavior.

