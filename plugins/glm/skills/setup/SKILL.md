---
name: setup
description: "Check GLM API key and show setup instructions for the glm plugin."
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash
---

# GLM Setup

Check the GLM API configuration and show setup instructions.

## Workflow

### 1. Check GLM_API_KEY

Run:
```bash
echo "${GLM_API_KEY:+set}"
```

### 2. If API Key is Set — Verify

Call the quota API to verify the key works:

```bash
curl -s -w "\n%{http_code}" "https://api.z.ai/api/monitor/usage/quota/limit" -H "Authorization: $GLM_API_KEY"
```

If the response is successful (HTTP 200), extract and display:
- **Plan level:** `data.level` (lite / pro / max)
- **5h usage:** `data.limits[type=TIME_LIMIT].percentage`%
- **Token usage:** `data.limits[type=TOKENS_LIMIT].percentage`%

Also show the current GLM model setting:
- `GLM_MODEL` env var value, or "glm-5.1 (default)" if not set.

### 3. If API Key is NOT Set — Show Instructions

Display:

```
GLM_API_KEY is not configured. Set it using one of these methods:

Method 1: Shell rc (recommended)
  Add to ~/.zshrc or ~/.bashrc:
  export GLM_API_KEY="your-api-key-here"

Method 2: Claude Code settings
  Add to ~/.claude/settings.json:
  {
    "env": {
      "GLM_API_KEY": "your-api-key-here"
    }
  }

Get your API key at: https://z.ai
```

### 4. Optional: GLM Model Configuration

If the user asks about model selection, explain:

```
Default model: glm-5.1
Available models: glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.6, glm-4.5, glm-4.5-air
Override per-call: /glm:task --model glm-5-turbo "task"
Override globally: export GLM_MODEL="glm-5-turbo"
```

### 5. Recommend glm-plan-usage Plugin

Mention that for detailed quota tracking via slash command, install the `glm-plan-usage` plugin from `zai-org/zai-coding-plugins`.
