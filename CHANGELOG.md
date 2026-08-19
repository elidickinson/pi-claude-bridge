# Changelog

## UNRELEASED

- **Fix: isolated subagents can resolve their captured system prompt (issue #64)** — prompt captures now share one bounded process-wide registry across extension module instances.

- **Fix: better isolate AskClaude tool (issue #59)** — AskClaude children no longer inherit the user's `~/.claude` `CLAUDE.md` files or skill listing, and now always get Claude Code's system prompt preset instead of only when pi-side skills exist. Thanks @JAtkinsonKO.
- **Fix: Bogus debug message about "record count mismatch" after switching providers** — the post-rebuild integrity check did not take `@file` expansion into account when switching providers.

## 0.7.0 — 2026-08-08

- **BREAKING: AskClaude tool now off by default** — If you want to continue using the AskClaude tool, set `askClaude.enabled` to `true` in your config (see README.md).
- **New: mid-turn steering actually works (issue #39)** — a steer sent while a tool was running used to be stashed and replayed as a follow-up after Claude's whole turn finished. The prompt is now a long-lived streaming generator and the steer is written to CC's stdin (`priority: "next"`) before the tool result is released, so CC drains it at that tool boundary and acts on it in the same turn.
- **Fix: system prompt loading** — Claude Code now receives the same global and hierarchical `AGENTS.md` / `CLAUDE.md` files that Pi loads. Config settings`provider.appendSystemPrompt` / `provider.settingSources` are no longer needed and have been removed gone). Improved compatibility with for children agent (i.e. subagents) and for other extensions that modify the system prompt. Unhandled system prompt configurations should fail loudly rather than silently discarding instructions.
- **Fix: branch summarization ran through the live provider** — rewinding or forking with "summarize" runs through the *agent's* stream function, so unlike `/compact` the request reached this provider and the live Claude Code session rather than an isolated subprocess. The bridge now takes over `session_before_tree` the way it already took over `session_before_compact`.
- **Fix: `@file` mentions were lost when a session was rebuilt** — Claude Code expands an at-mention itself (unlike pi) and stores the file's contents as an `attachment` record in its own session file; pi never sees it, so a rebuild kept the prompt text and silently dropped the file the model was reasoning about. Expansions are now carried across. Requires cc-session-io `^0.4.0`.
- **Fix: images dropped from prompts and rebuilt sessions (issue #34)** — an image followed by a trailing text preview lost the image, and tool results carrying images were flattened to text whenever the bridge rewrote pi's history into a Claude Code session. Images survive both paths now.
- **Fix: session rebuilds could corrupt turn structure** — pi records one message per tool result, and `repairToolPairing` (applied inside `Session.importMessages`, so unavoidable) only pairs results sharing the user message right after their assistant message, so tool results past the first can become `[no tool result recorded]`; a turn's results are now collected into one message placed directly after its assistant message. Minor: a turn aborted before anything streamed was rebuilt as `[incompatible content omitted]` potentially misleading the agent into thinking it is missing something. Empty turns are dropped now, while genuinely filtered content keeps its slot and label. Rebuilds also incorrectly wrote pi's bare model id instead of the resolved CLI id, dropping the `[1m]` suffix (issue #42; minor metadata fix only, since `--model` was already correct).
- **Fix: errored turns could report as a successful stop** — CC flags failures with `is_error` on a result whose subtype is still `"success"`, so the bridge duplicated the error text and finalized normally (issue #43); failed results now end the turn with `stopReason: "error"`, and the compact-summary path no longer accepts an errored result. Separately, a turn that ended on a tool call has its pi stream closed, and the guard suppressing content events for a closed stream also swallowed the `result` message, so a 429 or overload mid-tool set no `stopReason` and logged nothing (part of issue #35). The no-event stream watchdog idea in #35 has not been addressed.
- **Fix: a reentrant subagent could disturb the parent's session** — the shared session cursor was written from whichever context delivered tool results, so a background subagent dragged the parent's cursor backwards and cost its next turn a full rebuild and a flushed prompt cache. Removal from the active-context set is now guarded like the cleanups beside it, and an orphaned tool result no longer resets the live top-level context's turn state.
- **Fix: bridge could deadlock on a tool name Claude can't call** — Claude sometimes called `bash` instead of `mcp__custom-tools__bash`; CC rejected it with "No such tool available" and retried under a fresh tool_use id, but the bridge had already run the rejected call, so the retry's MCP handler waited on a result that never came. Calls for anything the bridge does not serve over MCP are now ignored. Rebuilt transcripts contributed to this by sometimes naming tools as `Bash`/`Read`/`Edit`/`Write` in past calls; those names now stay in the `mcp__custom-tools__` namespace.
- **Fix: nested tool schemas flattened (issue #44)** — converting pi schemas to Zod collapsed nested objects and dropped `anyOf`/`const`, so Claude saw only the top level of tools like `edit` and `subagent`. The MCP server now serves pi's JSON Schema verbatim.
- **Fix: tool results paired by call order** — MCP handlers took their `toolCallId` from a positional cursor, so a call arriving out of order silently paired its result with the wrong tool call. Now pairs by Claude's `_meta["claudecode/toolUseId"]` and fails loudly if it is absent.
- **Fix: Claude Code could write memory from bridge turns** — provider and AskClaude queries now disable auto-memory through the SDK; set `provider.autoMemoryEnabled` to `true` to opt in if you actually want it. Isolated compaction queries always disable it.
- **Tests: suites now drive the real code** — `tests/lib/record-sdk-streams.mjs` captures verbatim SDK streams (scrubbed, and refusing any fixture the username survived) for `tests/unit-stream-replay.mjs`, replacing hand-written messages that missed the `system/status` and `rate_limit_event` frames a real stream carries. `tests/int-shutdown-kills-cc.mjs` pins that a pi shutdown and a user abort each reap the Claude Code subprocess with a tool call in flight.
- **Tests: correctness audit tooling** — `diag/audit-{transcripts,cache,warnings}.mjs` scan session transcripts and the bridge log for silent data loss, prefix-cache breaks and stranded tool handlers, gated on `--since`; `diag/replay-write-path.mjs` replays any pi session through the rebuild. `tests/int-cc-contracts.mjs` pins the undocumented Claude Code behavior the bridge depends on against the installed SDK, and `tests/unit-convert-determinism.mjs` pins that a rebuild is deterministic and extends the previous transcript rather than rewriting it.
- **Internal: trim redundant dependencies** — pi bundles typebox and its extension loader always aliases the import to that copy, so shipping our own only made consumers install a redundant one that pi ignores. Now `peerDependencies: "*"` plus a devDependency for typechecking, as pi's packaging docs require; dev peers track pi 0.83.0. `@anthropic-ai/sdk` moves to devDependencies for the same reason — it is only ever imported for types.

## 0.6.3 — 2026-07-26

- **Add: claude-opus-5 model** — Claude Opus 5 is selectable via `/model` and the `opus` shortcut now points to it.
- **Bump: pi >=0.82.1** — required for the `claude-opus-5` model catalog entry.
- **Internal: remove obsolete QueryContext stack** — remove the unused push/pop/depth infrastructure superseded by `activeQueryContexts`.

## 0.6.2 — 2026-07-06

- **Fix: Sonnet 5 and Fable 5 with 1M context** — bare model IDs (`claude-sonnet-5`, `claude-fable-5`) are 200K context. Must pass `[1m]` suffix for both, similar to Opus 4.8.
- **Fix: xhigh thinking level hidden for Sonnet 5 and Sonnet 4.6 (issue #32)** — pi-ai ships no `thinkingLevelMap` for these models, and pi's `getSupportedThinkingLevels` requires an explicit mapping to show `xhigh` in the picker. This is a workaround for https://github.com/earendil-works/pi/issues/6371

## 0.6.1 — 2026-07-01

- **Add: claude-fable-5 and claude-sonnet-5 models** — Anthropic's Claude Fable 5 (released 2026-06-09) and Sonnet 5 (released 2026-06-30) are now selectable via `/model`. Both force adaptive thinking. The `fable` and `sonnet` shortcuts resolve to these new models.
- **Bump: pi-ai >=0.80.3** — required for claude-fable-5 and claude-sonnet-5 model catalog entries.

## 0.6.0 — 2026-06-29

- **Fix: `/compact` hang (issue #18)** — the bridge now owns compaction for claude-bridge models, running split-turn summaries as isolated Claude Code subprocesses instead of routing them through the live provider stream. File ops (`<read-files>`/`<modified-files>`) carry forward across compactions. If compaction fails it is cancelled with a notification rather than falling back to the buggy native path.
- **Fix: subagent routing (issue #19)** — provider calls from subagents while a parent query is active now start a nested query instead of being mistaken for empty tool-result delivery.
- **Fix: session preservation across `/compact` and tree nav (issue #25)** — the main Claude Code session is no longer clobbered by shorter synthetic contexts (compact summaries) or stale post-rewrite history.
- **Add: plan-aware 1M context (issue #24)** — new `provider.plan` (default `"pro"`) and `provider.longContextExtraUsage` config. See README for which models get 1M on which plan.
- **Add: reasoning token tracking** — Claude Code `reasoning_tokens`/`thinking_tokens` are preserved on pi usage objects and in debug logs.
- **Bump: pi 0.80 APIs** — compat catalog import, `CONFIG_DIR_NAME`, compaction metadata. Claude Agent SDK 0.2.x, TypeBox 1.3, tsx 4.22.

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
