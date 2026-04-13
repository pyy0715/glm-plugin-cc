# glm-plugin-cc

Claude Code plugin for [GLM (Z.ai)](https://z.ai) integration — delegate coding tasks to GLM and monitor usage quotas.

## Installation

```bash
claude plugin marketplace add pyy0715/glm-plugin-cc
claude plugin install glm@glm-plugin-cc
```

## Setup

### 1. Set your GLM API key

**Claude Code settings (recommended):**

```json
// ~/.claude/settings.json
{
  "env": {
    "GLM_API_KEY": "your-api-key-here"
  }
}
```

**or Shell:**

```bash
# ~/.zshrc or ~/.bashrc
export GLM_API_KEY="your-api-key-here"
```

### 2. Verify setup

```
/glm:setup
```

### 3. (Optional) Configure statusline

Plugins cannot auto-register a statusline. Add manually to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/marketplaces/glm-plugin-cc/plugins/glm/scripts/statusline.js"
  }
}
```

> The path above assumes marketplace installation. Adjust if installed elsewhere.
> `${CLAUDE_PLUGIN_ROOT}` does NOT work in settings.json — use an absolute path.

## Usage

### `/glm:task`

Delegate any coding work to GLM. Auto-triggers on all coding requests.

```
/glm:task write a binary search function in Python
/glm:task --model glm-5-turbo refactor this module
```

### `/glm:setup`

Check API key configuration and show setup instructions.

## Model Configuration

Default model: `glm-5.1`

Available models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`

Override per-call:

```
/glm:task --model glm-5-turbo "task description"
```

Override globally:

```bash
export GLM_MODEL="glm-5-turbo"
```

> GLM-5.1/5/5-Turbo consume 3x quota at peak hours, 2x off-peak (1x off-peak promo through April).
> GLM-4.7 consumes 1x — recommended for routine tasks.
