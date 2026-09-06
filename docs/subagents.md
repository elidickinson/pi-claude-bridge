# Subagents Integration Guide

`pi-claude-bridge` is designed to support multi-agent workflows, isolated subagent spawning, and cross-model delegation.

## Subagent Architecture

When Pi spawns a subagent (for example via the `subagent_spawn` tool or `@gotgenes/pi-subagents`), the subagent operates in its own execution context:
1. It has its own message history and system prompt.
2. It cannot directly mutate the parent session.
3. If configured with `isolated: true`, it runs in an independent workspace without parent conversation history.

## Subagent Support Features

### 1. Tail-Stripped Prompt Inheritance (PR #89, Issue #88)
`@gotgenes/pi-subagents` constructs subagent prompts by copying the parent's assembled prompt and stripping Pi's per-session footer (`inheritedIdentity`), which includes:
- The `<available_skills>` catalogue.
- The `Current working directory:` footer.

`src/prompt-capture.ts` handles this by:
- Storing both `assembledPrompt` (full prompt) and `tailStrippedPrompt` (footer-stripped version) in `PromptCapture`.
- Matching parent prompts using either representation.
- Preventing Pi's raw harness instructions from being forwarded into `--append-system-prompt`, which prevents Anthropic subscription OAuth lockups.

### 2. Process-Wide Shared Captures (PR #67, Issue #64)
Isolated subagents re-evaluate extension modules in fresh instances. Without shared state, an isolated child cannot find the parent prompt in its local map.

`src/prompt-capture.ts` exports `sharedPromptCaptures()`, which registers the capture cache on `globalThis[Symbol.for("claude-bridge:promptCaptures")]`. This ensures all extension instances within the process share the same prompt capture registry.

### 3. Reentrant QueryContext Isolation
When a subagent executes while a parent query is running:
- `streamClaudeAgentSdk` detects reentrancy (`activeQuery !== null`).
- It instantiates an isolated `QueryContext` for the subagent.
- Tool result delivery queues are routed by `toolCallId` to the correct context.
- The parent session cursor is protected from being moved backwards by child operations.

---

## Delegated Execution with AskClaude

The `AskClaude` tool allows Pi to delegate questions and tasks to Claude Code when using any provider:

```typescript
// Example call from Pi:
ask_claude({
  prompt: "Review the authentication module in src/auth.ts and list potential security vulnerabilities.",
  mode: "read",
  model: "opus",
  thinking: "high",
  isolated: true
})
```

### Modes
- `read` (default): Claude Code can inspect files, search codebase symbols, and run web lookups, but cannot make changes.
- `none`: No filesystem or tool access (pure reasoning and general knowledge).
- `full`: Allows writing files and executing bash commands (disable globally with `"allowFullMode": false`).

### Context Boundaries
AskClaude children do not inherit host `~/.claude/CLAUDE.md` files or global Claude Code skills, ensuring that host settings do not override project-level instructions in `AGENTS.md`.
