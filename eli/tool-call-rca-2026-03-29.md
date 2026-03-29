# Root Cause Analysis: Tool Call Bugs (2026-03-29)

## Architecture Context

The bridge has a push-based streaming architecture where:
- Pi calls `streamSimple` for each new prompt and each tool result delivery
- A single `query()` call to the Claude Agent SDK runs in a background `consumeQuery()` loop
- Pi's tools are exposed to Claude via an MCP server (`buildMcpServers`)
- Each MCP tool handler returns a `Promise` that blocks the SDK generator until pi delivers the result by calling `streamSimple` again and resolving the promise
- Module-level mutable state (`activeQuery`, `pendingToolCalls`, `toolCallDetected`, `currentPiStream`) coordinates between these two async flows

## Bug 1: Tool ID Sanitization (c336003)

**Root cause:** The Anthropic API requires tool IDs matching `^[a-zA-Z0-9_-]+$`. When importing conversation history from other providers (e.g., Kimi, which generates IDs like `functions.bash:0`), the `convertAndImportMessages` function passed IDs through verbatim.

**Manifestation:** API 400 errors when resuming a Claude session that contained imported history from a non-Anthropic provider.

**Fix:** A `sanitizeToolId()` closure replaces non-matching characters with `_`, using a Map cache to ensure tool_use/tool_result ID pairs stay consistent.

**Edge case:** If two different original IDs sanitize to the same string (e.g., `foo.bar` and `foo:bar` both become `foo_bar`), tool_result pairing still works because the Map keys on the original ID. Unlikely in practice.

## Bug 2: Empty Text Blocks with cache_control (9a77f75)

**Root cause:** Assistant text blocks were imported with `block.type === "text"` (no emptiness check), producing `{ type: "text", text: "" }`. The Claude Agent SDK's `importMessages` adds `cache_control: { type: "ephemeral" }` to imported blocks. The Anthropic API rejects empty text blocks with `cache_control` set.

**Manifestation:** API validation error on session resume when imported history contained assistant messages with empty text blocks from other providers.

**Fix:** Changed filter to `block.type === "text" && block.text`, dropping empty text blocks. Mirrors existing pattern in user message handling.

## Bug 3: Deadlock on 3+ Parallel Tool Calls (29ac4ff)

**Root cause:** Two bugs combined:

1. **MCP handler** (`buildMcpServers`): `toolCallDetected?.()` only called when `pendingToolCalls.length === 1`, then nulled. Third+ handlers never triggered the callback.

2. **Chained resolve** (`streamClaudeAgentSdk` TOOL_RESULT path): `resolveFromRemaining` callback set `toolCallDetected = null` after draining the while loop. If the SDK hadn't called the third MCP handler yet, that handler arrived to find `toolCallDetected === null`.

**Manifestation:** Complete deadlock. Pi hangs indefinitely. SDK generator blocked on third MCP handler's promise. No timeout breaks the cycle.

**Fix:** (1) Removed `pendingToolCalls.length === 1` guard so every MCP handler calls `toolCallDetected?.()`. (2) `resolveFromRemaining` keeps itself alive (`toolCallDetected = allResults.length > 0 ? resolveFromRemaining : null`) until all results consumed.

## Bug 4: Lost Final Text After Tool Calls (fb3c223)

**Root cause:** After the last tool result is resolved via DEFERRED, the SDK sends it to Claude. Claude responds with text + end_turn. The bridge processes this final response on the current pi stream. But pi's agent loop then calls `streamClaudeAgentSdk` again to deliver what it thinks is a pending tool result. The bridge sees `activeQuery` (still set) and `pendingToolCalls.length === 0`, enters DEFERRED, sets up a `toolCallDetected` callback that never fires (Claude said end_turn). Query finishes, empty stream finalized.

**Manifestation:** Claude's final text response (e.g., a full review/summary) silently lost. Pi receives an empty assistant message.

**Fix:** Added `queryResponseComplete` flag, set on non-tool-use `message_stop`. DEFERRED path checks this flag and returns an empty "done" stream immediately instead of waiting for an MCP handler that will never come.

## Architectural Vulnerabilities

**1. Module-level mutable state as synchronization:** `activeQuery`, `pendingToolCalls`, `toolCallDetected`, `currentPiStream` coordinate two async flows with no encapsulation. Timing assumptions are implicit.

**2. Dual-purpose callbacks:** `toolCallDetected` serves as both a "tool call arrived" signal (DEFERRED path) and a "resolve remaining tool calls" mechanism (TOOL_RESULT path). Different concerns sharing one variable.

**3. Lossy conversion with downstream side effects:** `convertAndImportMessages` output is further transformed by the SDK (`cache_control` addition). Bug 2 was caused by this invisible transformation.

**4. Cross-provider ID format assumptions:** Tool IDs pass through multiple layers with different constraints. The bridge should defensively sanitize at every boundary crossing.

**5. DEFERRED path fragility:** Only handles single tool calls via `extractLastToolResult`. If timing assumptions change, multi-tool DEFERRED scenarios would fail.

## Test Coverage Gaps

None of the 3 original bugs would have been caught by existing tests:
- Bugs 1-2 require cross-provider scenarios (import from kimi/fireworks)
- Bug 3 requires 3+ parallel tool calls in a single turn
- Bug 4 requires multi-round tool calls ending in a final text response

## Recommendations

1. Unit tests for `convertAndImportMessages` with non-compliant IDs, empty blocks, mixed-provider history
2. Unit tests for MCP handler/resolve lifecycle with 1, 2, 3, N parallel calls
3. Integration test with 3+ parallel tool calls
4. Encapsulate bridge state into a class instead of module-level variables
5. Unify DEFERRED and TOOL_RESULT resolution logic
6. Defensive boundary sanitization at `importMessages` boundary
