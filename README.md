# glm-plugin-cc

Claude Code plugin + local proxy for [GLM (Z.ai)](https://z.ai) integration. Auto-routes code-related prompts to GLM, everything else to Claude, within the same session.

## How it works

```
User prompt
  └─▶ UserPromptSubmit hook ─▶ classifier (glm-4.7) ─▶ "CODE" or "OTHER"
                                                               │
                                                               ▼
                                     POST /_hint {session_id, backend}
                                                               │
                                                               ▼
Claude Code ─▶ localhost:4000 (glm-proxy) ─▶ routes by:
                                              1. model prefix (/model glm-5.1)
                                              2. session-keyed hint (from hook)
                                              3. default (Claude)
```

- Proxy runs in the background — started automatically on each Claude Code session via the `SessionStart` hook.
- Routing hints are **keyed by `session_id`** so multiple Claude Code sessions don't cross-contaminate.
- `/model glm-5.1` or `/model opus` always overrides the classifier.

## Installation

```bash
claude plugin marketplace add pyy0715/glm-plugin-cc
claude plugin install glm@glm-plugin-cc
```

## Setup (one-time)

Inside Claude Code, run:

```
/glm:setup
```

This writes the following to `~/.claude/settings.json` (merged into your existing `env`):

- `ANTHROPIC_BASE_URL=http://localhost:4000` — routes API calls through the proxy
- `GLM_API_KEY=<your Z.ai key>` — used by the proxy when routing to GLM
- `GLM_PROXY_PATH=<absolute path to bin/glm-proxy.js>` — used by `SessionStart` hook to auto-start the proxy

**Restart Claude Code after setup** (or try `/reload-plugins`). `ANTHROPIC_BASE_URL` is read once at startup.

## Usage

After setup, just use Claude Code normally:

- Code-related prompts → classified as CODE → routed to GLM
- Everything else → Claude
- `/model glm-5.1` → forces GLM for the session
- `/model opus` → forces Claude for the session

Check `/tmp/glm-proxy.log` if you want to see routing decisions (set `GLM_DEBUG=1` for verbose logs).

## Statusline (optional)

Plugins cannot auto-register a statusline. Add manually to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/marketplaces/glm-plugin-cc/plugins/glm/scripts/statusline.js"
  }
}
```

Shows Claude 5-hour coding quota + GLM monthly MCP quota side-by-side.

## Models

Available GLM models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`.

- GLM-5.1/5/5-Turbo: 3x quota peak, 2x off-peak
- GLM-4.7: 1x quota (recommended for routine tasks)

Register GLM in the `/model` picker by adding to `~/.claude/settings.json` (one model only):

```json
{
  "env": {
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.1 (routed via glm-proxy)"
  }
}
```

## Troubleshooting

- **First prompt after setup hangs or errors:** Claude Code didn't reread `ANTHROPIC_BASE_URL`. Quit and restart.
- **`API error: 400 model: ... at most 256 characters`:** you have `"model": "glm-5.1"` as the default in settings.json but the proxy isn't running. Either start the proxy (`node bin/glm-proxy.js`) or remove the `"model"` line to default to Claude.
- **Proxy port already in use:** set `PROXY_PORT=<other>` in `~/.claude/settings.json`'s `env`.
- **See routing decisions:** `GLM_DEBUG=1` in the `env` block.

## Advanced

Manually running the proxy (for dev/debugging):

```bash
GLM_API_KEY=... node bin/glm-proxy.js
# or with debug logs:
GLM_DEBUG=1 GLM_API_KEY=... node bin/glm-proxy.js
```

For always-on proxy (runs even when `claude` isn't active), see `docs/DECISIONS.md` Phase 4 — `launchd`/`systemd` templates are on the roadmap.

## Architecture

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for design decisions, verification results, and the full file map.
