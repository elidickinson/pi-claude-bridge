# TODO

Ideas and open questions, ordered by rough priority. Nothing is a commitment.

## Ideas

1. **#30: pruning costs Claude all context for that turn.** When `pi-context-prune`
   shrinks pi's history below our cursor we clean-start, so Claude answers that turn
   with no prior conversation. Rebuilding from the pruned messages keeps the
   (compressed) context and still bounds the JSONL, which is what the issue asks
   for. The discriminator must be **reentrancy, not message count**: the
   shorter-context branch in `syncSharedSession` is also the guard that stops a
   subagent resuming and overwriting the parent's session, and a subagent's priors
   are not empty. `isReentrant` is computed immediately before the main
   `syncSharedSession` call (`src/index.ts:1642`; AskClaude's at `:1903`) and just
   isn't passed in. The stale `fix/issue-30-pruned-history` branch discriminates on
   `priorMessages.length === 0` and would break subagent isolation -- do not merge
   it. Decide deliberately what the AskClaude caller should pass. Guarded by
   `unit-sync-shared-session.mjs` plus `int-subagent-rpiv-codebase-locator.mjs`.

2. **Synthetic all-zero usage overwrites real counters.** A `<synthetic>` failure
   message carries all-zero usage, and `recordUsage`/`updateUsage` (`src/usage.ts`)
   guard absence, not zeros — so a failure after real output in the same turn erases
   input/output/cache totals. Pre-existing (the synthetic message always reached
   `recordUsage`); reachable pre-#162 too, since synthetic ids are UUIDs and always
   pass the different-id check.

3. **CC's typed error fields are ignored.** The SDK assistant frame declares only
   `error?: SDKAssistantMessageError` (`sdk.d.ts:3605`), the result a snake_case
   `api_error_status`; the camelCase `apiErrorStatus` / `isApiErrorMessage: true`
   seen on disk are transcript-record fields, and `error: "rate_limit"` rides on the
   assistant frame. `resultErrorText` already types off `is_error`/`subtype`/`errors[]`
   — the word-matching lives downstream (`describeRateLimitFailure` and consumers).
   A contract pin on these fields would let failure classification stop relying on
   wording. The `rate_limit_event` path covers the common case.

4. **Make the dropped-thinking-signature rate visible.** 26 of 2,363
   `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
   `src/convert.ts:144` correctly refuses to replay them (Anthropic rejects
   unverifiable signatures) -- but silently. A WARNING at the drop site turns a
   1.1% invisible loss into a number, which is the prerequisite for ever
   explaining it.

5. **Per-query rewrite staleness — done for the serving instance; worktree-spawn instances still mark via the `Symbol.for` hook registry** (`claude-bridge:markRebuildHooks`), which relies on every instance loading the same module. If a future pi loader change makes that unreliable, the hook registry needs to grow into a shared state channel (per-session mark records the serving instance reads). Session id attribution rides on `options.sessionId`, which pi-ai documents as ignorable metadata — verify it stays set on `streamSimple` calls (agent.ts passes `sessionManager.getSessionId()` today).
6. **Decide which other `WARNING:` lines should fail integration runs.** The suite gates bridge-origin `BUG:` and stranded MCP-handler markers; `diag/audit-warnings.mjs` inventories the remaining warnings. Add a warning only when its meaning and any intentional test cases are pinned.

7. **Stop the diag replay harness manufacturing the phantom-tool-call condition.**
   `diag/replay-write-path.mjs` and `diag/lib/write-path.mjs` (also used by
   `unit-convert-determinism`) call the conversion without a populated
   `customToolNameToSdk` map, so pi's `bash` is rebuilt as Claude Code's builtin
   `Bash` -- the prompt condition behind the deadlock fixed in 122914dd. A replay
   run can therefore reproduce *or mask* that bug for reasons unrelated to the code
   under test. Fix: pass the recorded tool list through to `convertPiMessages`.
   Production is unaffected (verified over 86,652 real pi messages).

8. **Mirror `eli/lifecycle-coverage-gaps.md` into a tracked file** -- the
   QueryContext lifecycle x sync-path coverage map is in a gitignored directory, so
   nobody else gets it. Belongs in `docs/` or as a section of `diag/AUDIT.md`. (The
   provenance rule is already in `AGENTS.md`.)

9. **Surface errors that arrive with no open pi stream.** When a result lands
   after the turn already ended on a tool call, `consumeQuery` records the error
   (stopReason, errorMessage, log) but there is no open `currentPiStream` to push
   an error event onto, so the user sees a stalled turn rather than "rate limited".
   Surfacing it means synthesizing a turn pi did not ask for.
   `tests/unit-error-result.mjs` covers the recording; nothing covers the
   surfacing. This is also the third stall cause behind GitHub #35.

10. **Handler timeout / stall watchdog** -- whether the bridge should give up on an
   MCP handler that has waited implausibly long instead of only warning.

11. **Markdown rendering** in expanded tool result view. Currently plain text.
   Use `Markdown` from `@earendil-works/pi-tui` with a `MarkdownTheme`.

12. **`/claude config` slash command** for runtime configuration. Currently
    requires editing JSON and `/reload`.

13. **`/claude:btw` command** for ephemeral questions: response displayed but
    not added to LLM context.

14. **Audit tool parameter mismatches**: The bash timeout default (120s) was added
    because pi's bash has no default while Claude Code expects one. Other bridged
    tools may have similar mismatches (units, defaults, optional-vs-required params).
    Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

15. **AskUserQuestion pi shim** (main provider only): CC never sees
    AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
    user questions interactively. Port a pi-native version using `ctx.ui.custom()`
    for an option picker with free-text fallback. Not applicable to AskClaude
    subagents (can't interact with user). See `fractary/pi-claude-code`
    `AskUserQuestion.ts` for reference.

16. **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
    ExitPlanMode are blocked. A pi-native plan mode could use
    `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
    via `tool_call` event, and surface plan approval through pi's TUI. Not
    applicable to AskClaude subagents. See `fractary/pi-claude-code`
    `PlanMode.ts`.

## Open questions

- **18 never-answered tool calls** (`[no tool result recorded]` as the lone stub of
  a single-`tool_use` turn). 389 of the historical occurrences are the fixed
  parallel-results bug, but one is NEW since the audit baseline (js13k project,
  2026-08-31, real session) -- so the cause is not extinct. Two other grep hits
  are docs quoting the marker, not records. Re-run
  `diag/audit-transcripts.mjs --since <last good date>` to check for growth.

## Lower-priority testing gaps

- **Int tests pollute the audit scan.** `rpc-harness.mjs` defaults `cwd` to the
  project root, so int sessions (SlowTool fixtures, `token0.txt`) write JSONLs
  into the real `-Users-esd-projects-pi-claude-code-acp` sessions dir and the
  transcript scanner counts them as real-project defects -- 123 fake hits
  in-window as of 2026-09-23. Fix: default test cwd to a temp dir, or teach the
  scanner to exclude self-authored test sessions.

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

- **`int-cache.sh` asserts on model whim**: the run fails with `Only 1 tool call(s)
  (expected >= 2)` when Haiku answers the read prompt from context instead of
  calling the tool. Observed once in 15 runs. The tool-call count is a proxy for
  "the cursor/cache path got exercised", so it cannot simply be dropped; making the
  prompt harder to satisfy from context would be the fix.

## Upstream

Nothing to fix here -- filed or inherent in the other project.

- **CC's resume reorders same-millisecond `tool_result` blocks.** 8 of 10 sessions
  (10 parallel `Read` calls, then a resume): the resumed request's block order
  differs from the on-disk record order, always as adjacent-pair swaps, and in all
  8 every swapped pair shared a millisecond timestamp. The live request matched
  disk 10 of 10, so CC's writer is faithful and its reader is not. Deterministic
  per session file, so it costs one cache write rather than a recurring tax, and
  rare: 2 of 417 real parallel groups carry a tie. Repro pattern in
  `diag/AUDIT.md`.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Sessions
  accumulate indefinitely with no cleanup or reuse. (`persistSession: false` is
  already used on the isolated paths; the main path needs CC to append to the
  shared session, so the fix is deletion, not suppression.)

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.

- **Bun/Node hash mismatch for >200-char paths** (cc-session-io known
  limitation, documented in its README). Node writes with djb2, Bun reads
  with wyhash -- for long encoded paths the dirs don't match and CC can't
  find the session. Rare in practice (requires deep nesting), but the fix is
  to make cc-session-io's `projectPathToHash` Bun-aware at write time. Would
  live upstream in cc-session-io.

- **Post-abort rebuild rotates sessionId** (see `Case 4 post-abort` log line).
  Normal Case 4 rebuilds preserve the sessionId by wiping the file in place
  (`deleteSession` + `createSession({sessionId})`). The post-abort path can't
  safely do that: the killed CC subprocess flushes a late `[Request interrupted
  by user]` record during its own cleanup, and if that write lands on the
  freshly-rewritten file it appends an orphan record with a dangling
  `parentUuid`, which breaks CC's parent-uuid chain on the next resume -- CC
  silently starts with empty context and produces a confidently-wrong
  answer. Diagnosed in debug log during branch work, see commit e317461.

  Current fix: post-abort rebuild takes a fresh UUID, so the orphan writes can
  only land on a dead inode. Deterministic, zero-latency, costs one extra UUID
  in the debug log per abort.

  Options to revisit:
  - **Short delay (~500ms) before post-abort rebuild**, keep the UUID stable.
    Overprovisions the observed ~1-2ms race window by 250-500x. Adds visible
    latency on the post-abort turn. Risk: still probabilistic -- loaded systems
    could extend subprocess cleanup past the delay.
  - **Drain the aborted query's AsyncGenerator to completion**, then rebuild.
    Narrows the race window but doesn't close it (CC's pending `fs.appendFile`
    calls are invisible to the drain). Also requires making `syncSharedSession`
    async. Strictly worse than rotation.
  - **Listen for the ChildProcess `exit` event directly.** Deterministic fix
    (open-claude-agent-sdk does exactly this). Official SDK's Query interface
    doesn't expose the child process -- would need to fork the SDK or reach
    into private state. Rejected unless the SDK grows a `close({ graceful: true
    })` or equivalent hook.
