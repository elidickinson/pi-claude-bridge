# Architecture Overview

`pi-claude-bridge` connects the [Pi coding agent](https://github.com/earendil-works/pi) to Anthropic's [Claude Code Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). It allows Pi to use Claude models with full streaming, MCP tool bridging, native skills forwarding, and subagent delegation.

## System Design

Rather than keeping all logic in a single file, the codebase is decomposed into single-responsibility modules with a strictly acyclic dependency graph:

```
                  ┌─────────────────┐
                  │   src/index.ts  │ (Extension entry point)
                  └────────┬────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌────────────────┐
│src/provider.ts│   │src/askclaude.ts│ │src/session-sync.ts│
└──────┬───────┘   └──────┬───────┘   └───────┬────────┘
       │                  │                   │
       ▼                  ▼                   ▼
┌──────────────────────┐  │           ┌────────────────┐
│src/stream-consumer.ts│  │           │src/convert.ts  │
└──────┬───────────────┘  │           └───────┬────────┘
       │                  │                   │
       └──────────┬───────┴───────────────────┘
                  ▼
       ┌─────────────────────┐
       │ src/bridge-state.ts │ (Shared module singletons)
       └──────────┬──────────┘
                  ▼
       ┌─────────────────────┐
       │  src/query-state.ts │ (Per-query reentrant execution state)
       └─────────────────────┘
```

## Core Modules

### 1. `src/provider.ts`
Implements the Pi provider entry point (`streamClaudeAgentSdk`).
- Manages the lifecycle of Claude Code subprocesses via `query()`.
- Implements Pi provider request hooks (`onPayload` and `onResponse`) so observability, policy, and logging extensions can intercept queries.
- Coordinates abort handling by sending `interrupt()` and terminating child processes with `close()`.

### 2. `src/stream-consumer.ts`
Consumes the asynchronous SDK message generator and translates events into Pi's streaming format:
- Translates `stream_event` deltas (`text_delta`, `thinking_delta`, `toolcall_delta`).
- Handles `rate_limit_event` notifications, converting raw usage fractions to percentages and throttling notifications to 5% increments.
- Formats rate-limit errors via `describeRateLimitFailure` so Pi model-fallback chains (`fallbackModels`) recognize quota exhaustion.
- Cleans up rate-limit markers on turn and query completion to prevent state leakage.

### 3. `src/session-sync.ts`
Coordinates session persistence and synchronizes Pi conversation history with Claude Code's session JSONL files:
- Evaluates whether an incoming turn can reuse an existing Claude Code session (`REUSE`) or requires rewriting the transcript (`REBUILD`).
- Verifies working directory consistency before reusing sessions.
- Carries `@file` attachments and expansions across rebuilds.
- Marks sessions for rotation when an abort signal is detected, avoiding collisions with terminating subprocesses.

### 4. `src/tool-delivery.ts`
Manages tool result queues and mid-turn steering:
- Maintains separate queues for pending tool handlers and incoming tool results, matching them by Claude's `_meta["claudecode/toolUseId"]`.
- Writes mid-turn steering instructions to standard input with priority `next` before releasing tool results, allowing Claude to react at the tool boundary.
- Guards diagnostic serialization with debug flags to avoid overhead on large tool outputs.

### 5. `src/askclaude.ts`
Implements the optional `AskClaude` delegation tool:
- Enables Pi to delegate second-opinion queries, complex codebase reviews, or implementation sub-tasks to Claude Code.
- Provides configurable permission presets (`read`, `none`, `full`).
- Isolates child contexts by excluding host `~/.claude` files while forwarding Pi-side skills and context.
- Provides streaming progress and tool-call status summaries.

### 6. `src/prompt-capture.ts`
Recovers the hierarchical inheritance graph of Pi system prompts:
- Captures system prompts on `before_agent_start`.
- Extracts portable project context and skills while discarding Pi's harness preamble.
- Matches tail-stripped prompts for compatibility with subagents (such as `@gotgenes/pi-subagents`).
- Shares captures process-wide via `Symbol.for("claude-bridge:promptCaptures")` so isolated subagent module instances resolve parent prompts seamlessly.

### 7. `src/models.ts`
Defines model catalogs, display ordering, and runtime entitlement policies:
- Exposes Claude Fable 5.1, Opus, Sonnet, and Haiku models.
- Resolves exact model IDs first before falling back to family shortcuts.
- Configures 1M context windows based on user plan entitlements.
