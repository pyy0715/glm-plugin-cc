---
name: review
description: "Run a GLM (Z.ai) code review. Reviews local changes or specified files using GLM. Invocable via /glm:review."
user-invocable: true
argument-hint: "[--model <model>] [file or scope]"
allowed-tools: Bash, Read, Glob, Grep
disable-model-invocation: true
---

# GLM Review

Run a code review using GLM (Z.ai) and present the findings.

Raw user request: $ARGUMENTS

## Workflow

### 1. Parse Arguments

- Extract `--model <name>` if present. Remove it from the scope text.
- The remaining text specifies files or scope to review.

### 2. Determine Review Target

- If the user specified files or paths, read those.
- If no scope is specified, collect local changes:
  1. Run `git diff` (unstaged changes)
  2. Run `git diff --cached` (staged changes)
  3. If both are empty, run `git diff HEAD~1` (last commit)
- If there is nothing to review, inform the user and stop.

### 3. Gather Context

- Read the diff or file contents.
- If a `CLAUDE.md` exists, read project conventions to inform the review.
- Keep total context under ~8000 lines.

### 4. Call GLM

Build a JSON payload with a system message for code review and a user message containing the diff/code wrapped in XML tags. Call directly:

```bash
echo '<JSON_PAYLOAD>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-call.js"
```

If `${CLAUDE_PLUGIN_ROOT}` is empty, use `$CLAUDE_PLUGIN_ROOT` instead.

### 5. Present the Result

- Show GLM's review findings verbatim.
- **Do NOT auto-apply any fixes.** Ask the user which issues, if any, they want fixed before touching any files.
