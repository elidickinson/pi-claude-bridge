# TODO

Ideas and open questions, ordered by rough priority. Nothing is a commitment.

## Simplifications

Beyond the session-sync ones in Ideas #1. Ordered by value; each is independent unless noted.

- **Parameters only tests use.** `deliverToolResults`' `contextLength` and optional `messages` (`src/index.ts:1516`). About 20 test call sites pass them.
- **`loadSessionState` repeats `saveSessionState`'s field checks** and splits a catch on an error class nothing else throws (`src/session-store.ts:47-61`). `unit-session-store.mjs` pins the reject messages.

## Ideas

1. **Session-sync simplifications.** Each is independent.
    - **`knownSessionIds` / `registry.known` is test-only.** `src/index.ts:92`, `101`, `130`. Only `__test.resetSharedSession` reads it. Don't replace it by having the reset remove the whole sessions dir: a unit file run without `tests/lib/setup.mjs` would delete the developer's real resume pointers.
    - **`LiveRecording` has parameters only tests use.** `src/session-sync.ts:166`, `204`. Production always passes `acknowledged=false` and `uuid=undefined`. Shrink to `users(messages, start, uuid, steering)` and `assistant(digest, toolCalls, resetTools)`. About 25 test call sites change.

2. **Surface errors that arrive with no open pi stream.** When a result lands after the turn already ended on a tool call, `consumeQuery` records the error but has no `currentPiStream` to push it to, so the user sees a stall instead of "rate limited". Surfacing it means synthesizing a turn pi didn't ask for. `tests/unit-error-result.mjs` covers the recording, nothing covers surfacing. One of the stall causes behind #35.

3. **Use CC's native /compact for pi /compact instead of the isolated summary query.** Today `session_before_compact` lets pi run, `runIsolatedSummary` (`src/index.ts:330`) spawns a separate uncached CC query that re-reads the whole history, and the post-compact REBUILD makes the live session read its new (compacted) prefix back. Native compaction does both jobs in-session: CC summarizes its own cached conversation, appends the boundary to its session file, and the bridge returns `{compaction: {summary, firstKeptEntryId, tokensBefore: pre_tokens, ...}}` so pi rewrites to a shape CC already has — next query is a plain REUSE. No SDK control request exists (no `compact` subtype in sdk.d.ts 0.3.308); the only trigger is a `/compact [instructions]` user message dispatched as a slash command, which needs a live query for the session (parked query, or open a resume query when none). Probe first (`int-cc-contracts.mjs`): message shape and completion signals (`SDKCompactBoundaryMessage`, `SDKStatusMessage.compact_result`), whether `DISABLE_AUTO_COMPACT=1` leaves manual /compact working, whether kept-tail metadata (`preserved_messages`) maps cleanly to pi's `firstKeptEntryId` via the recording's uuid mirror, and whether microcompact (tool-result pruning) fires without a boundary — pi would then diverge silently. Then decide: manual-only first, threshold/overflow later (they fire mid-turn with `willRetry`, where the CC child may be parked at a tool boundary); forward `event.customInstructions`; keep CC-side autocompact off regardless. Blocking risk: CC's session copy can lag pi's history (dirty tail), so the summary would be of stale content — sync/REBUILD must complete before dispatching.

4. **CC's typed error fields are ignored.** The SDK assistant frame declares `error?: SDKAssistantMessageError` (`sdk.d.ts:3678`) and the result a snake_case `api_error_status`; the camelCase `apiErrorStatus` / `isApiErrorMessage` seen on disk are transcript fields only. Failure classification downstream of `resultErrorText` (`describeRateLimitFailure` and its consumers) still matches on wording. A contract pin on these fields would let it stop. `rate_limit_event` covers the common case.

5. **Run the contract tests against the newest SDK on a schedule.** `package.json` pins the SDK exactly, and the SDK pins its bundled CC binary to its own version, so a bump is the only way users get a newer CC. Run `tests/int-cc-contracts.mjs` regularly against `@anthropic-ai/claude-agent-sdk@latest` to learn when a bump is safe. It needs a logged-in CC and must run outside the sandbox, so either a local scheduled job or a CI job with a credential secret.

6. **Don't load Claude Code settings on the provider path by default.** Provider and AskClaude queries load CC's user settings (`settingSources: ["user"]`; project and local settings are already off), so `~/.claude` hooks and other settings reach provider turns (output style is already pinned to `default`, #220). The isolated summary query already uses `[]` (`src/index.ts:364`). Settings are loaded because Bedrock/Vertex users keep `env` and `apiKeyHelper` in `settings.json` (`src/cc-child.ts:74`). Add `provider.loadClaudeSettings` (the name proposed in #141), default `false`, for them and for anyone who wants their CC hooks or plugins in pi turns. That breaks Bedrock/Vertex setups until they turn it on, so say so in the changelog. With `[]` the `CLAUDE_MD_EXCLUDES` workaround only matters for the opt-in, and the README's hooks advice changes.

7. **Warn when inherited Anthropic env vars will redirect Claude Code** (#107). An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` reaches the CC child through `env: { ...process.env, ... }` and overrides the subscription login, so every turn fails with the gateway's auth error. Warn at every session start (not once ever, like the startup notice) naming the variables that are set, with a setting such as `provider.warnAnthropicEnv: false` for people who route through a gateway on purpose.

8. **Turn off Claude Code's tool search.** On first-party connections CC adds a `DeferredToolPlaceholder` tool with `defer_loading` to every request, but none of the bridge's 10 MCP tools were deferred (`diag/CACHE.md`, Pitfalls), so it adds a tool and does nothing. With enough pi tools CC could start hiding some behind its search tool. Add `ENABLE_TOOL_SEARCH: "false"` to `CC_CHILD_ENV` (`src/cc-child.ts:26`), as pi-claude-code does, and confirm with the capture proxy that the placeholder is gone. The tool list changes, so expect one cache miss per session on upgrade.

9. **Synthetic all-zero usage overwrites real counters.** A `<synthetic>` failure message carries all-zero usage, and `recordUsage`/`updateUsage` (`src/usage.ts`) only guard against missing usage, not zeros. A failure after real output in the same turn erases its input/output/cache totals.

10. **Audit tool parameter mismatches.** The bridge adds a 120s bash timeout because pi's bash has none and CC expects one. Compare CC's schemas with pi's for read, write, edit, grep and find for similar mismatches (units, defaults, optional vs required).

11. **Log dropped thinking signatures.** 26 of 2,363 `claude-bridge` thinking blocks have an empty `thinkingSignature`, so `src/convert.ts:129` rightly skips them, but silently. A WARNING at the drop site would turn a 1.1% invisible loss into a number someone can explain.

12. **Check the Claude Code login at startup.** Low priority. When CC isn't logged in, the first turn fails with CC's error. pi-claude-code runs `claude auth status` in its provider check and hides its models when logged out; a warning at session start would be enough here. Run it in the background so startup doesn't wait on it.

13. **A changed tool set may not reach Claude Code after reuse, a fork or a prefix-write.** The kept records include CC's `prompt_snapshot` (system prompt parts and tools), which CC replays on resume, so only a full import picks up a change (`diag/CACHE.md` C1). A changed append already takes a full import (`promptDigest`); the tools half is inferred from code and not measured. It matters for #176/#236, where `tool_search` adds pi tools mid-session: #236's live refresh covers the running query, but the next fork may bring back the old list. Probe first: add a tool between two turns and check the second request's `tools`, on reuse and on a fork. If it holds, fold the tool set into `promptDigest`, trading one cache miss for the right tools.

## Open questions

- **Never-answered tool calls** (`[no tool result recorded]` as the only stub of a single-`tool_use` turn). 389 historical hits are the fixed parallel-results bug, but one real one appeared after the audit baseline (js13k project, 2026-08-31), so the cause isn't gone. Re-run `diag/audit-transcripts.mjs --since <last good date>` to check for more.

- **Do messages starting with `/` reach the model?** The bridge hands pi's user text to CC as typed input, so CC may run a message that starts with `/` as one of its own commands (built-ins or `~/.claude/commands`) instead of sending it to the model. CC also expands `@path` itself, which `src/attachments.ts` relies on. pi-claude-code passes `--disable-slash-commands`; the SDK's per-message `client_composed: true` (see `verbatimPrompts` in `sdk.d.ts`) turns off both. No issue reports it, so it's probably rare. Probe: send "/Users/.../x.ts is broken", an unknown "/word" and a CC built-in name through the bridge and check what reaches the model. Marking pi's messages verbatim must still leave the bridge's own `/compact` (Ideas #3) working.

- **Can #152 (`--thinking off` still enables thinking) be fixed on 5.x models?** pi-claude-code's issue #2 reports that Opus 5.5 and Fable 5.1 reject `thinking: {type: "disabled"}` with a 400, which broke its `/tree` summaries. If so, "off" can't be passed through on those models; probe each current model before choosing a fix.

## Testing gaps

- **Int tests pollute the audit scan.** `rpc-harness.mjs` defaults `cwd` to the project root, so int-test sessions land in the real project's sessions dir and the transcript scanner counts them as defects (123 fake hits as of 2026-09-23). Fix: default to a temp dir, or have the scanner skip test sessions.

- **The proxy contract test can't see most first-party differences.** `tests/int-cc-contracts.mjs` ("routing through the capture proxy...") compares only init tool names and first-request size. Also compare the beta set, `system[0]` with its per-request fields masked, and a second-turn body. CC 2.1.308's `api-request` session records could show the production request shape without the proxy.

- **`int-cache.sh` depends on the model calling a tool.** It fails with `Only 1 tool call(s) (expected >= 2)` when Haiku answers from context instead of reading the file (1 in 15 runs). The count proves the recording/cache path ran, so it can't just be dropped; make the prompt harder to answer from context.

## Deferred

- **Keep the cache when instructions change.** A changed system prompt append takes a full import (`diag/CACHE.md` C3). Sending the changed parts as a `<system-reminder>` in the next user message would keep the cache instead. It needs the parts used at session start saved with the session state, and the model would see the old instructions in the system prompt next to the new ones in the reminder.

- **Superseded session files pile up.** When sync moves a pi session to a new CC session (fork, copied prefix, model or cwd change), the old JSONL in `~/.claude/projects/` is never deleted. Files from queries with no progress already are. Deleting on `session_shutdown` won't work, since saved state resumes the current CC session after a restart; only superseded files are safe to remove. A fork's saved tool results can expire with them (`diag/CACHE.md` C2).
