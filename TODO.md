# TODO

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently
  requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but
  not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added
  because pi's bash has no default while Claude Code expects one. Other bridged
  tools may have similar mismatches (units, defaults, optional-vs-required params).
  Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible Enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees
  AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
  user questions interactively. Port a pi-native version using `ctx.ui.custom()`
  for an option picker with free-text fallback. Not applicable to AskClaude
  subagents (can't interact with user). See `fractary/pi-claude-code`
  `AskUserQuestion.ts` for reference.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
  ExitPlanMode are blocked. A pi-native plan mode could use
  `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
  via `tool_call` event, and surface plan approval through pi's TUI. Not
  applicable to AskClaude subagents. See `fractary/pi-claude-code`
  `PlanMode.ts`.

## Architecture Issues

- **Module-level mutable state**: `activeQuery`, `currentPiStream`, `pendingToolCalls`, etc.
  are module-level variables coordinating two async flows. The `queryStateStack` save/restore
  pattern works but is fragile — any new state variable must be manually included in the
  save/restore or reentrant queries corrupt parent state. Consider encapsulating into a
  class instance keyed by session/query ID.

- ~~**Per-turn queries**~~ — investigated and abandoned. The SDK has no supported
  path to inject tool_results externally: resuming a session that ends in
  `user(tool_result)` with a new prompt forces a fresh user turn instead of
  letting the model respond to the tool result. MCP handler blocking is the
  sanctioned mechanism. See `per-turn-queries` branch for the writeup.

## Testing Gaps

- **maxHistoryMessages capping + tool pairing**: `convertAndImportMessages` caps
  history to `maxHistoryMessages` by slicing from the end. If the slice boundary
  falls mid-tool-sequence, an orphaned `tool_use` or `tool_result` block could
  produce an invalid API request. Needs a test and possibly boundary-aware slicing.

- **Structured diagnostics for tests**: Tests currently grep freeform debug log
  strings (e.g. 'Case 1/2/3/4') to verify internal state. Emit these as
  structured NDJSON events or dedicated diagLog entries so tests can query
  without brittle string matching.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **Case 4 session reuse**: `syncSharedSession` Case 4 creates a fresh session
  every time there are missed messages (e.g., user switched providers mid-conversation).
  Ideally we'd overwrite the existing JSONL with new contents under the same session
  ID, but cc-session-io's API is append-only with auto-generated UUIDs. Would need
  either a `clear()` method upstream or manual file deletion + reconstruction.
  Low priority — the cleanup task above is more impactful.

