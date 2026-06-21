# Changelog

## UNRELEASED

- **Tests: add real auto-threshold compaction integration test** — added a real-provider RPC test that triggers pi's `threshold` auto-compaction path, verifies split-turn takeover with the deterministic 50-token keep window, checks file-op details, and confirms the session continues afterward.
- **Add: opt-in 1M context per model + `provider.plan` setting** — list bare model ids under `provider.enableLongContextModels` in `~/.pi/agent/claude-bridge.json` or `.pi/claude-bridge.json` to send `[1m]` and enable 1M for those models; the default is the 200K window for every model. The bridge registers the matching `contextWindow` with pi via `applyLongContext(MODELS, set, plan)` at the `registerProvider` site, so pi's status bar and auto-compaction threshold reflect the runtime window — preventing the issue #24/#17 "Prompt is too long" / credit-gate class where pi reports headroom while CC runs at 200K. Display names stay bare. New `provider.plan` (default `"pro"`) tells the bridge whether a bare Opus id auto-upgrades to 1M at runtime: `"max"` registers unlisted Opus at 1M **without appending `[1m]`** (CC auto-upgrades it), so Max/Team Premium/Enterprise pay-as-you-go/Anthropic API users get accurate 1M budgeting for Opus without the `opus[1m]` usage-credits-gate risk on Max 5x (claude-code#39841); `"pro"` registers 200K (accurate for Pro/Team Standard/Enterprise subscription). `plan` only affects Opus (the only family that auto-upgrades with a bare id) and never sends `[1m]` — that stays `enableLongContextModels`'s job (for Pro+Opus+credits, or Sonnet 1M which is metered via credits on *every* plan). Only 1M-capable models (Opus 4.6/4.7/4.8, Sonnet 4.6) honor an opt-in; Haiku 4.5 (200K) and unlisted ids stay at 200K otherwise.
- **Fix: prevent split-turn `/compact` hangs** — bridge now owns compaction and uses an isolated Claude Code summary subprocesses instead of the live provider stream path, so pi's concurrent split-turn summaries no longer overwrite shared stream state. If the takeover fails, compaction is cancelled rather than falling back to the known-buggy native path. Persistent failures may cause repeated auto-compaction cancellations without progress, but at least the user is notified that something is wrong.
- **Fix: preserve cumulative file-op carry-forward across extension-provided compactions** — re-inject prior compaction file ops from `session_before_compact` branch entries so `<read-files>`/`<modified-files>` stay cumulative despite pi's current `fromHook` seeding gate. This appears to be an upstream Pi issue with extension-owned compactions.
- **Fix: clear stale active queries before terminal stream events** — defensively clears/drains provider state before final success/error events and logs any stream overwrite before a terminal event. Not clear if this is needed, but included with logging to see if we missed anything in Issue #18
- **Tests: add compact takeover regressions** — compaction baseline and split-turn integration tests plus real second-compaction file-op carry-forward integration test.
- **Bump: pi dev and peer dependencies to 0.79+** — required for the current exported `compact()` API used by the bridge takeover.
- **Fix: preserve shared Claude Code sessions across shorter synthetic contexts (issue #25)** — shorter pi contexts are not continuations of the cached session, so they now start clean instead of resuming unrelated longer history, and their fresh SDK session is deleted instead of being adopted as the main shared session when the query completes. This fixes `/compact` hangs while preserving the original main session UUID for the post-compact rebuild, and also backstops other pi-side history rewrites such as `session_tree`. Added focused unit and integration regression coverage.

## 0.5.0 — 2026-06-05

- **Add: claude-opus-4-8 model** — migrated pi imports/dev peers from deprecated `@mariozechner/*` packages to `@earendil-works/*` 0.78.x so the official pi-ai registry supplies Opus 4.8. The `opus` shortcut now resolves to 4.8; 4.7/4.6 remain available for explicit pinning.
- **Docs: Agent SDK quota warning** — note Anthropic's announced June 15, 2026 Agent SDK billing/quota change.
- **Tests: isolate AskClaude config** — AskClaude integration tests now use project-local test config so they are unaffected by a user's global `askClaude.enabled` setting.
- **Tests: harden shell integration tests** — use explicit alternate provider/model settings and pre-increment counters under `set -e`.

## 0.4.0 — 2026-05-04

- **Fix: Opus 4.7 + xhigh sent wrong effort to SDK** — pi-ai 0.72 ships per-model `thinkingLevelMap` overrides (e.g. `claude-opus-4-7` declares `xhigh→xhigh`, not `xhigh→max`), but our hardcoded `REASONING_TO_EFFORT` table ignored them. Effort lookup now consults `model.thinkingLevelMap` first, falls back to the table for older pi-ai or unmapped levels. Forwarded `thinkingLevelMap` through `buildModels` projection.
- **Fix: zero out model cost in `buildModels`** — per-token pricing in the footer was wrong because models inherited pi-ai's non-zero cost fields, which pi then multiplied by the huge token counts from the SDK. Now explicitly zeroed so pi's footer shows no cost.
- **Use `tools: []` instead of `disallowedTools` blocklist** — switch from blocking specific tools to explicitly passing an empty tools list, preventing any new default tools from silently leaking into bridge sessions.
- **Disable CC-side autocompact (`DISABLE_AUTO_COMPACT=1`)** — pi already owns context management and propagates its own `/compact` to CC. Letting CC autocompact too double-flushed the prompt cache and raced pi's threshold; manual `/compact` in CC is unaffected.
- **Fix: pi `/compact` no longer triggers CC autocompact-thrashing (issue #8)** — pi's compaction shrinks its messages array, but `syncSharedSession`'s REUSE check (`slice(cursor)`) silently returned `[]`, so the bridge kept `--resume`ing the pre-compact CC session JSONL. Over long sessions CC's own autocompact then refilled within 3 turns and tripped its anti-thrashing guard. Now subscribes to pi's `session_compact` event and forces the next sync down the REBUILD path so CC sees the post-compact history. Also subscribes to `session_tree` (branch nav has the same shape).
- **Refactor: split `needsRebuild` into `needsRebuild` + `forceRotate`** — only the abort case needs UUID rotation (to dodge late writes from the dying CC subprocess). Compact/tree now rebuild in place, preserving the sessionId and not leaking orphan JSONL files into `~/.claude/projects/`.
- **Block user-installed MCP servers from leaking into bridge sessions** — pass `--strict-mcp-config` unconditionally and set `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the spawned CC env, suppressing both filesystem (`~/.claude.json`, `.mcp.json`) and claude.ai cloud MCP servers. Override with `provider.strictMcpConfig: false`.
- **Consolidate config** — SDK plumbing (`appendSystemPrompt`, `settingSources`, `strictMcpConfig`) moved from `~/.pi/agent/settings.json` (`claudeAgentSdkProvider` block) to a `provider` block in `~/.pi/agent/claude-bridge.json`. Old location no longer read. Drop deprecated, unsafe `maxHistoryMessages`.
- **Bump deps** — `@anthropic-ai/claude-agent-sdk` → ^0.2.126; migrate to TypeBox 1.x (new import paths per pi-mono 0.69); pi devDeps → ^0.72.1. Extract `registerTool` schemas to const with explicit `<typeof params>` generic to avoid TS2589 deep-instantiation under TypeBox 1.x.
- **Internal: move sources into `src/`** — `index.ts` and the extracted modules now live under `src/`; screenshots under `assets/`. `pi.extensions` and published `files` updated accordingly.

## 0.3.1 — 2026-04-18

- **Fix: empty thinking blocks on Opus 4.7** — Opus 4.7 silently changed default `thinking.display` from `"summarized"` to `"omitted"`, so streams emitted `thinking_start` + `signature_delta` with zero `thinking_delta` events, leaving `ThinkingBlock.thinking == ""`. Now pass `--thinking-display=summarized` via `extraArgs` whenever `effort` is set (both provider and AskClaude paths). Bump `@anthropic-ai/claude-agent-sdk` to ^0.2.111 (required for Opus 4.7 + `--thinking-display` CLI flag). See [anthropics/claude-agent-sdk-python#830](https://github.com/anthropics/claude-agent-sdk-python/pull/830).
- **Fix: `cachePct` debug metric misleading** — denominator was `input + cacheRead`, so once a conversation warmed up (tiny `input`, huge `cacheRead`) every turn rounded to 100% — even turns that rebuilt the cache from scratch. Now `cacheRead / (input + cacheRead + cacheWrite)`, so cache-rebuild turns show a low percentage.
- **Internal: extract pure modules from `index.ts`** — split `models`, `skills`, `session-verify`, `extract-tool-results`, and `query-state` into their own TS files with real unit tests (no more `.js`+`.d.ts` mirror drift). Add `typecheck` script, `typescript` + `tsx` devDeps; test scripts run via `--import tsx`.

## 0.3.0 — 2026-04-17

- **Add: claude-opus-4-7 model** — Added `claude-opus-4-7` as a selectable model. The `opus` shortcut now resolves to 4.7 by default; 4.6 remains available for explicit pinning. Bumped `@mariozechner/pi-ai` to ^0.67.6 to include official model definitions (removed fallback).
- **Refactor: QueryContext class replaces module-level state** — 12 mutable `let` variables + manual `SavedQueryState` push/pop replaced with a `QueryContext` class and context stack. Adding new per-query state is now 1 property instead of 6 edit sites. Fixes `deferredUserMessages` not being isolated across reentrant queries (subagent could consume parent's deferred steers). MCP handlers now close over captured context, abort handler captures context at the correct point after push.
- **Fix: MODELS baseUrl leak** — the MODELS array exported to pi's provider registration now projects only the fields pi needs (id/name/reasoning/input/cost/contextWindow/maxTokens), stripping pi-ai's `baseUrl`/`api`/`provider`/`headers` so they can't shadow the values `registerProvider` supplies.
- **Internal: `repairToolPairing` moved to cc-session-io 0.3.0**; convert logic extracted to `convert.js` with `convert.d.ts` types; various dead-code / type-safety cleanup.

## 0.2.0 — 2026-04-15

- **Fix: stale cursor after tool-using first turn (issue #4)** — after the first turn used tools, the session cursor pointed at the wrong message, causing Claude to re-process stale context. Now correctly advances past all tool_result blocks.
- **Fix: session resume on symlinked paths / CLAUDE_CONFIG_DIR** — cc-session-io now resolves symlinks (realpathSync + NFC) and honors `CLAUDE_CONFIG_DIR`, matching how Claude Code resolves session paths. Fixes "No conversation found" on macOS symlinked dirs. Bump cc-session-io → 0.2.0.
- **Verify-after-write for session files** — warns with diagnostic context if the written session file doesn't round-trip correctly, instead of letting Claude silently resume a corrupt session.
- **Session rebuild preserves sessionId** — provider switches no longer churn UUIDs.
- **CC CLI debug capture** — `CLAUDE_BRIDGE_DEBUG=1` now also writes Claude Code's own debug stream to `~/.pi/agent/cc-cli-logs/`, one file per query.
- **Fix: debug() logged Error objects as `{}`** — now formats with message and stack.
- **Repair orphan tool_use/tool_result pairs before import** — prevents potential API 400s when history starts mid-turn after a provider switch.

## 0.1.6 — 2026-04-10

- **Fix: steer messages during tool execution now reach Claude** — when a user sends a steer while a tool is executing, pi injects it into context alongside the tool result. The bridge previously only processed tool results in this path, silently dropping the steer. Now detected and replayed as a continuation query after the current query completes.
- **Fix: "No conversation found with session ID" in dirs with dots/underscores/spaces** — bump `cc-session-io` to 0.1.2; `projectPathToHash` now matches the CLI's sanitization (`/[^a-zA-Z0-9]/g` → `-`) instead of only replacing slashes
- **Fix: steer/followUp during tool execution no longer hangs** — `extractAllToolResults` now walks past injected user messages instead of stopping at them
- **ID-based tool result matching** — tool results are matched to MCP handlers by `toolCallId` instead of FIFO position; eliminates silent wrong-result delivery if order diverges
- Add integration tests for tool execution scenarios (normal, followUp, steer, parallel+steer, abort) with auto-restart on failure
- Add `defaultIsolated` config option for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
- **Fix: AskClaude action summary showed raw SDK tool names** — normalize `mcp__custom-tools__*` and SDK names at creation; hide redundant `BashOutput` and recursive `AskClaude`; collapse only consecutive same-tool calls
