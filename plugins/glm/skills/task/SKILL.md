---
name: task
description: "Delegate ALL coding work to GLM (Z.ai). Use for ANY code generation, implementation, bug fixing, debugging, refactoring, function writing, script creation, or coding task. Always prefer this skill when the user asks to write, fix, or modify code. Also invocable via /glm:task."
user-invocable: true
argument-hint: "[--model <model>] [what to do]"
allowed-tools: Bash, Read, Glob, Grep
---

# GLM Task

Delegate a coding task to GLM (Z.ai) and apply the result.

Raw user request: $ARGUMENTS

## Workflow

### 1. Parse Arguments

- Extract `--model <name>` if present. Remove it from the task text.
- The remaining text is the task request.
- If no request text is provided, ask the user what they want GLM to do.

### 2. Gather Context

Read relevant source files to give GLM enough context:

- If the user mentions specific files, read those.
- Otherwise, identify 3-5 files most relevant to the request using Glob and Grep.
- If a `CLAUDE.md` exists in the project root, read it for project conventions.
- Keep total context under ~8000 lines to avoid exceeding GLM's token limit.

### 3. Construct and Call GLM

Build a JSON payload with:

- **System message:** A concise instruction establishing GLM as an expert coder. Include project conventions if found.
- **User message:** The task request followed by the gathered code context, each file wrapped in XML tags:

```
<file path="src/foo.js">
...file content...
</file>
```

Then call GLM directly:

```bash
echo '<JSON_PAYLOAD>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-call.js"
```

If `${CLAUDE_PLUGIN_ROOT}` is empty, use `$CLAUDE_PLUGIN_ROOT` instead.

### 4. Apply the Result

- Apply GLM's code changes directly to the relevant files.
- If creating new files, write them to the appropriate paths.
- Show a brief summary of what was changed.
