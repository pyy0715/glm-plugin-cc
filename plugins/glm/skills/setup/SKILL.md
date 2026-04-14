---
name: setup
description: One-time setup for the GLM plugin. Configures ANTHROPIC_BASE_URL, GLM_API_KEY, and GLM_PROXY_PATH in ~/.claude/settings.json so the SessionStart hook can auto-start the proxy and the UserPromptSubmit hook can route prompts. Invoke via /glm:setup.
---

# GLM plugin setup

Performs a one-time configuration of `~/.claude/settings.json` so the GLM proxy runs automatically on every Claude Code session.

## What to do

Follow these steps **exactly**. Do not skip any.

### 1. Determine `GLM_PROXY_PATH`

Check these locations in order and use the first one that exists:

1. `~/.claude/plugins/marketplaces/glm-plugin-cc/bin/glm-proxy.js` (marketplace install — the normal case)
2. `~/Personal/glm-plugin-cc/bin/glm-proxy.js` (dev-repo fallback, if user has cloned source)

If neither exists, ask the user where `glm-proxy.js` is located and use that absolute path.

### 2. Collect `GLM_API_KEY`

Read `~/.claude/settings.json`. If `env.GLM_API_KEY` is already present and non-empty, reuse it. Otherwise ask the user:

> "Enter your Z.ai API key (https://z.ai → Dashboard → API Keys):"

### 3. Update `~/.claude/settings.json`

Read the current file, then merge the following into the `env` object (create `env` if missing). Preserve every other existing key unchanged.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "GLM_API_KEY": "<from step 2>",
    "GLM_PROXY_PATH": "<from step 1>"
  }
}
```

Write the file back with 2-space indentation, matching the existing formatting.

### 4. Inform the user

Tell the user, verbatim:

> Setup complete. Claude Code re-applies `ANTHROPIC_BASE_URL` to running sessions immediately, so any open `claude` will fail with API errors until the proxy is up. `/exit` and `/resume` each running session — the `SessionStart` hook starts the proxy if it isn't already running.
>
> To confirm, check `/tmp/glm-proxy.log` after your next prompt — you should see routing lines like `claude-sonnet-4-6 -> claude` or `glm-4.7 -> glm`.

## Important constraints

- **Do not** overwrite unrelated keys in `settings.json`. Use a merge strategy, not a full rewrite from template.
- **Do not** commit the user's API key anywhere. It stays only in `~/.claude/settings.json`.
- **Do not** attempt to start the proxy manually — the `SessionStart` hook handles that on the next session.
- If `~/.claude/settings.json` does not exist, create it with just the `env` block above (and valid JSON structure).
