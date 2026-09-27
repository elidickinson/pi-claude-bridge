# TODO

Ordered by what to build and ship next, not by when it was found. "Build next" is
ready to write today; the sections after it are gated on a decision, on evidence
that does not exist yet, or on someone else's repo.

## Build next

1. **#30: pruning costs Claude all context for that turn.** When `pi-context-prune`
   shrinks pi's history below our cursor we clean-start, so Claude answers that turn
   with no prior conversation. Rebuilding from the pruned messages keeps the
   (compressed) context and still bounds the JSONL, which is what the issue asks
   for. The discriminator must be **reentrancy, not message count**: the
   shorter-context branch in `syncSharedSession` is also the guard that stops a
   subagent resuming and overwriting the parent's session, and a subagent's priors
   are not empty. `isReentrant` is already computed at `src/index.ts:1354`,
   immediately before the call at `:1375`, and just isn't passed in. The stale
   `fix/issue-30-pruned-history` branch discriminates on `priorMessages.length === 0`
   and would break subagent isolation — do not merge it. Decide deliberately what
   the AskClaude caller at `:1625` should pass. Guarded by
   `unit-sync-shared-session.mjs` plus `int-subagent-rpiv-codebase-locator.mjs`.

2. **Make the dropped-thinking-signature rate visible.** 26 of 2,363
   `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
   `src/convert.ts:135` correctly refuses to replay them (Anthropic rejects
   unverifiable signatures) — but silently. A WARNING at the `?? ""` site
   (`src/index.ts:1056`) turns a 1.1% invisible loss into a number, which is the
   prerequisite for ever explaining it.

3. **Fail an int run that logs `BUG:` or an unexpected `WARNING:`.** Those lines
   mean a real defect and the int suite can emit them while passing — the
   stuck-handler bug shipped exactly that way. `diag/audit-warnings.mjs` already
   parses them; the gap is that no test consults it. Needs an explicit allowlist
   for the tests that induce one on purpose.

4. **Stop the benchmark harness manufacturing the phantom-tool-call condition.**
   Replay calls the conversion without a populated `customToolNameToSdk` map, so
   pi's `bash` is rebuilt as Claude Code's builtin `Bash` — the prompt condition
   behind the deadlock fixed in 122914dd. A benchmark run can therefore reproduce
   *or mask* that bug for reasons unrelated to the code under test. Fix: pass the
   recorded tool list through to `convertPiMessages`. Production is unaffected
   (verified over 86,652 real pi messages).

5. **Mirror `eli/lifecycle-coverage-gaps.md` into a tracked file** — the
   QueryContext lifecycle × sync-path coverage map is in a gitignored directory, so
   nobody else gets it. Belongs in `docs/` or as a section of `diag/AUDIT.md`. (The
   provenance rule is already in `AGENTS.md`.)

## Blocked on a decision

Both are fallback-shaped and need explicit sign-off on the shape before anyone
writes them.

- **A failure that arrives while no pi stream is open never reaches the user.**
  7ff04fd2 made `consumeQuery` record the error (stopReason, errorMessage, log)
  when a result lands after the turn already ended on a tool call, but there is no
  open `currentPiStream` to push an error event onto, so the user sees a stalled
  turn rather than "rate limited". Surfacing it means synthesizing a turn pi did
  not ask for. `tests/unit-error-result.mjs` covers the recording; nothing covers
  the surfacing, because there is nothing to surface it with. This is also the
  third stall cause behind GitHub #35.

- **Handler timeout / stall watchdog** — whether the bridge should give up on an
  MCP handler that has waited implausibly long instead of only warning.

## Open questions — watch, don't build

No repro, so there is nothing to write yet. Re-run the scanners with
`--since <date of last good run>`; `diag/AUDIT.md` holds the evidence.

- **~25% of `--resume` boundaries re-send the whole conversation** (12.9M tokens,
  recomputed with the corrected metric) — unexplained and unattributed. Two
  controlled runs now come back 0 cold: 33 bridge-free boundaries at 45–85k prompts
  on Haiku, and 90 bridge boundaries at 13k (15 `int-cache.sh` runs under
  `diag/capture-proxy.mjs`). Neither implicates nor exonerates CC; the audited
  failures are `claude-opus-5[1m]` at `xhigh` with 100–400k prompts collapsing to
  2–13% cache hit, a regime neither control approaches. Next step is still to leave
  the proxy on during a real session of that shape rather than paying to synthesize
  one. **Also recompute the dose-response table**, which was built on the metric's
  false-positive mode.

  One cold boundary was seen outside the proxy, in `int-cache.sh` running as stage 4
  of `npm test`: turn 7 read 0 and wrote 13042 at a reuse boundary. It has not
  recurred. The only structural difference from the 16 clean runs is how turn 1
  attached — 8309 read / 3976 write (partial, sharing a prefix with the smoke and
  multi-turn stages that preceded it) versus 12283 read / 0 write (full) in every
  looped run, which shares a prefix only with itself. If this is chased again, loop
  the whole `smoke → multi-turn → cache` chain; looping `int-cache.sh` alone cannot
  produce the partial attach.

- **4 stranded MCP handlers and 7 orphan queued results** (of 32 and 14; the rest
  are accounted for by abort/shutdown or the phantom-tool bug). Each of the 4 is a
  pi process whose last log line ever is the `waiting` warning, with the CC log
  ending 0.3–3.2 s later — consistent with pi exiting mid-dispatch, not confirmed.

- **17 never-answered tool calls** (`[no tool result recorded]` as the lone stub of
  a single-`tool_use` turn). The other 389 occurrences are the fixed
  parallel-results bug.

- **Orphaned Claude Code subprocess, trigger unknown.** A CC child outlived its pi
  session and burned API requests for 59 minutes; a second incident ran 23 and
  tripped an account-wide 429. `tests/int-shutdown-kills-cc.mjs` shows both
  reachable triggers already reap the child — pi exiting closes its stdin, which CC
  honours even mid-tool-call, and a user abort interrupts and closes the query. So
  the incidents needed a third condition that leaves pi alive with its control
  channel closed. Two in 1,159 cc-cli logs, none since 2026-07-10, all predating
  the July tool-loop fixes, and no log has between 1 and 5 failures — likely
  already fixed. Those tests are the tripwire; reopen only if one goes red.

- **Why the SDK omits a thinking signature** (see build item 2 for the visibility
  step).

## File upstream, nothing to fix here

- **CC's resume reorders same-millisecond `tool_result` blocks.** 8 of 10 sessions
  (10 parallel `Read` calls, then a resume): the resumed request's block order
  differs from the on-disk record order, always as adjacent-pair swaps, and in all
  8 every swapped pair shared a millisecond timestamp. The live request matched
  disk 10 of 10, so CC's writer is faithful and its reader is not. Deterministic
  per session file, so it costs one cache write rather than a recurring tax, and
  rare: 2 of 417 real parallel groups carry a tie. Repro pattern in
  `diag/AUDIT.md`.

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@earendil-works/pi-tui` with a `MarkdownTheme`.

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

## Lower-priority testing gaps

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

- **verifyWrittenSession failure paths untested**: The helper throws on
  missing file / record-count mismatch / malformed JSONL / sessionId drift,
  but no unit test deliberately induces each failure to confirm the error
  messages stay useful. Low priority — the logic is simple and visual
  inspection of the current code is enough for now.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.

- **Bun/Node hash mismatch for >200-char paths** (cc-session-io known
  limitation, documented in its README). Node writes with djb2, Bun reads
  with wyhash — for long encoded paths the dirs don't match and CC can't
  find the session. Rare in practice (requires deep nesting), but the fix is
  to make cc-session-io's `projectPathToHash` Bun-aware at write time. Would
  live upstream in cc-session-io.

- **Post-abort rebuild rotates sessionId** (see `Case 4 post-abort` log line).
  Normal Case 4 rebuilds preserve the sessionId by wiping the file in place
  (`deleteSession` + `createSession({sessionId})`). The post-abort path can't
  safely do that: the killed CC subprocess flushes a late `[Request interrupted
  by user]` record during its own cleanup, and if that write lands on the
  freshly-rewritten file it appends an orphan record with a dangling
  `parentUuid`, which breaks CC's parent-uuid chain on the next resume — CC
  silently starts with an empty context and produces a confidently-wrong
  answer. Diagnosed in debug log during branch work, see commit e317461.

  Current fix: post-abort rebuild takes a fresh UUID, so the orphan writes can
  only land on a dead inode. Deterministic, zero-latency, costs one extra UUID
  in the debug log per abort.

  Considered and rejected:
  - **Append-only session (never delete+recreate).** Doesn't help. The race
    isn't specific to delete+recreate — it's that two processes write to the
    same file with no coordination. After abort, the bridge appends new records
    (parentUuid chained from its last known record) while the dying subprocess
    flushes a late write (parentUuid chained from *its* last record). Order is
    nondeterministic; either way the parent-uuid chain forks and CC sees
    orphaned records on resume. Append-only just moves the corruption from
    "orphan on a fresh file" to "orphan in the middle of an existing file."
    Any approach sharing a mutable file between bridge and CC subprocess is
    inherently racy after abort.

  Options to revisit:
  - **Short delay (~500ms) before post-abort rebuild**, keep the UUID stable.
    Overprovisions the observed ~1–2ms race window by 250–500×. Adds visible
    latency on the post-abort turn. Eli's lean: 500ms feels like plenty and
    the UX is fine. Risk: still probabilistic — loaded systems could extend
    subprocess cleanup past the delay and we'd never know until a user hits
    the silent context-loss path.
  - **Drain the aborted query's AsyncGenerator to completion**, then rebuild.
    Investigated in detail. The real SDK's Query class (`lX`) delegates its
    iterator protocol (`next`/`return`/`throw`/`[Symbol.asyncIterator]`) to
    a native async generator. Draining the generator only observes messages
    CC has emitted via stream — it says nothing about pending `fs.appendFile`
    calls CC has queued in its event loop for the session JSONL. CC can emit
    the orphan marker's stream message, pi's drain sees it and returns, pi
    rebuilds, and CC's *still-pending* file write lands on the fresh inode.
    Drain narrows the race window but doesn't close it. Also requires making
    `syncSharedSession` async and restructuring `streamClaudeAgentSdk`'s
    kickoff path to await a pending drain promise — 4+ pieces of added state
    for a still-probabilistic fix. Strictly worse than rotation.
  - **Listen for the ChildProcess `exit` event directly.** This is the only
    deterministic fix (open-claude-agent-sdk does exactly this in its
    `gracefulClose()` via `proc.on('exit', ...)`). Official SDK's Query
    interface doesn't expose the child process — would need to either fork
    the SDK or reach into private state. Rejected unless the SDK grows a
    `close({ graceful: true })` or equivalent hook that awaits subprocess
    exit.
