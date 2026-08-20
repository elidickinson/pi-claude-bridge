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

   Partly covered now: `convertPiMessages` returns a `dropped` summary and
   `convertAndImportMessages` logs `dropped N thinking (<providers>)`, so the loss is
   countable at conversion time. That is the aggregate, not the source — the
   empty-signature case still needs the WARNING at `:1056` to tell "we minted
   nothing" apart from "another provider minted it".

3. **Delete `reasoningText`** (`src/index.ts:825`): `reasoning=` appears in 0 of
   14,994 `usage:` lines, so the SDK never supplies the field. Right now it reads
   as a working diagnostic. Delete it or record why it stays.

4. **Fail an int run that logs `BUG:` or an unexpected `WARNING:`.** Those lines
   mean a real defect and the int suite can emit them while passing — the
   stuck-handler bug shipped exactly that way. `diag/audit-warnings.mjs` already
   parses them; the gap is that no test consults it. Needs an explicit allowlist
   for the tests that induce one on purpose.

5. **Stop the benchmark harness manufacturing the phantom-tool-call condition.**
   Replay calls the conversion without a populated `customToolNameToSdk` map, so
   pi's `bash` is rebuilt as Claude Code's builtin `Bash` — the prompt condition
   behind the deadlock fixed in 122914dd. A benchmark run can therefore reproduce
   *or mask* that bug for reasons unrelated to the code under test. Fix: pass the
   recorded tool list through to `convertPiMessages`. Production is unaffected
   (verified over 86,652 real pi messages).

6. **Mirror `eli/lifecycle-coverage-gaps.md` into a tracked file** — the
   QueryContext lifecycle × sync-path coverage map is in a gitignored directory, so
   nobody else gets it. Belongs in `docs/` or as a section of `diag/AUDIT.md`. (The
   provenance rule is already in `AGENTS.md`.)

7. **Give every query its own `QueryContext`.** A top-level query reuses the
   module-level singleton while a reentrant one gets a fresh context, so the same
   teardown code serves two different lifetimes and `activeQuery` answers three
   different questions: is a top-level query in flight (1389), which SDK query owns
   this context (1571, 1628, 1648, 1672), and is this context the top-level one
   (1416). Cleanup then has to reverse-engineer ownership from a field three
   callbacks mutate — which is how the `.finally` guard came to test only
   `=== sdkQuery`, a condition `.then`/`.catch` had already made unreachable on the
   non-reentrant path, stranding the top-level context in `activeQueryContexts`
   forever.

   The change: `const queryCtx = new QueryContext()` unconditionally; drop
   `!isReentrant &&` from the `.then`/`.catch` clears; drop the `.finally` guard
   entirely, since nobody else can own the context. `isReentrant` survives only as
   "may this query touch the shared session and cursor," which is what it means.
   Replace the `resultCtx === ctx()` identity test at 1416 with an explicit
   module-level `topLevelCtx` pointer set at query start and cleared in that query's
   `.finally`, so "top-level" is a role rather than a property of which instance
   happens to be the singleton.

   Nothing depends on the singleton being long-lived: every field is already
   re-initialized on the fresh-query path (1452–1460, plus `activeQuery` and
   `promptStream`), so reuse loads no prior state and only saves an allocation.
   Leave `resetTurnState`'s deliberate non-clearing of `turnToolCallIds`
   (`query-state.ts:64`) alone — tool-result delivery calls it on the routed context
   and needs those ids to survive. `ctx()`/`resetCtx()` are test handles, so test
   setup needs adjusting.

   Does not fix, and worth a comment either way: between `.then` finalizing the
   stream and `.finally` removing the context, a finished query is still in the
   routing set with stale `turnToolCallIds`, so a late orphaned result landing in
   that microtask gap would take the delivery branch and return a stream nobody
   ends.

8. **A mid-turn steer shifts the attachment ordinal space, losing every later
   `@file` carry.** The two sides count prompts differently. Claude Code records a
   drained steer as a `queued_command` attachment whose parent is a tool_result
   record, so `collectCarriedAttachments` gives it no ordinal (`userPromptText`
   requires `type: "user"`). pi keeps it as an ordinary user message — the agent
   loop pushes drained steering messages into `context.messages` verbatim — so
   `placeCarriedAttachments` does count it. Every prompt after the first steer is
   off by one, the text check drops the attachment, and only `debug()` says so.

   Confirmed on disk: sessions `1020e4f3` and `108f73ea` show
   `user(tool_result) → queue-operation → attachment(queued_command) → assistant`
   with no companion user record. Attachments on prompts *before* the first steer
   are unaffected. It stays dormant while the session is reused and only bites on
   a rebuild — but aborts alone are 46% of rebuilds and unconditionally set
   `needsRebuild`, so any session that uses `@file`, steers once and then aborts
   loses the rest.

   Fix direction: on the pi side, exclude a user message that follows a toolResult
   with no intervening assistant — that is what a mid-turn steer looks like — from
   the ordinal space. Beware the interaction: CC also writes its own
   `[Request interrupted by user]` user record on abort, which shifts the *other*
   way and can coincidentally cancel a steer's shift, so any fix needs to be
   validated against an aborted session too, not just a steered one.

   Test that would pin it: `@file` prompt A → mid-turn steer → `@file` prompt B →
   force a rebuild → assert B's file survived. `int-tool-message.mjs` already
   produces a verified `queued_command`.

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

  The one cold boundary seen outside the proxy has not recurred; it differed from the
  clean runs only in how turn 1 attached to the preceding stages' prefix (see
  `diag/AUDIT.md`). If chased again, loop the whole `smoke → multi-turn → cache`
  chain — looping `int-cache.sh` alone cannot reproduce that state.

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

## Testing strategy

A review session found ten real bugs. The unit suite found roughly none of them and
stayed green throughout; the throw in `resolveOrDerive` found two, `audit-warnings.mjs`
caught the phantom-tool deadlock live, and a 135-message session on disk was the
fixture for the eviction bug. That is the datum to design around.

The reason is structural: in glue code the bug is a false belief about the
counterparty, and a hand-written fixture encodes the same belief as the code. The
queue tests paired by id *by construction* because we believed pairing was by id, and
stayed green through the whole mispairing bug. So the question for any new test is
where its inputs and its oracle come from that did not pass through our own head.
Only three sources qualify: recorded real traffic, the live counterparty, and
conservation laws ("nothing vanished") that hold without knowing the right answer.

Ranked by leverage per effort:

1. **Quiescence and leak assertions.** After a turn settles, `activeQueryContexts`
   should be empty, no tool call pending, no prompt stream live. The
   `activeQueryContexts` leak was present on *every* run of the happy path — it
   needed no adversarial interleaving, just an assertion that anything ends clean.
   Shipped as a debug-gated shutdown dump so real sessions report it too.
2. **Corpus replay as a release gate.** `diag/replay-write-path.mjs` replays one
   session on suspicion; point it at every session on disk and assert zero synthetic
   stubs, zero skipped attachments, no capture throws. `placeCarriedAttachments`
   already returns `skipped` — the accounting existed and the `@file` bug happened
   anyway, because no hand-written fixture contained a mid-turn steer. Accounting
   plus synthetic fixtures stays green; accounting plus the real corpus goes red.
3. **Fixture provenance, and drive production objects.** Counterparty-shaped test
   input must be recorded (`tests/fixtures/sdk-streams`, `tests/lib/record-sdk-streams.mjs`),
   never hand-written; a test must drive the real object through its real entry point
   rather than a model of it. Corollary: a regression test never observed failing
   without its fix is not evidence.
4. **`strictNullChecks`.** Exactly 27 errors today (13 `convert.ts`, 9 `index.ts`,
   5 `session-verify.ts`). The tsconfig comment fears `!` noise, but each forced `!`
   marks a nullable-at-type-level, non-null-by-invariant claim — the exact category of
   unchecked belief that keeps biting. Hygiene, not strategy: it catches its own class
   and nothing else.
5. **Source-inventory tripwires over pi.** Claude Code is closed, so we probe it;
   pi is installed in `node_modules`, so read it. A behavioural contract file can only
   probe entry points we already know about, which is why nothing caught branch
   summarization routing through the agent stream function. Assert instead that the
   set of pi modules consuming `streamFn` still matches the handled list, so a new one
   goes red at bump time.
6. **Byte conservation on `projectPromptCapture`** — wrap a recorded prompt in
   arbitrary text and assert every byte outside the substituted spans survives.

Not worth doing: randomised sequence/invariant harnesses (their invariants come from
the same head that wrote the bug — the eviction bug's wrong spec would have been
asserted as the invariant, and the promise-ordering bug lives below the abstraction
such a harness would model); boundary fuzzing (the failures are semantic
disagreements between two structured systems, not parser crashes); mutation testing
in CI; live shadow execution, which recorded-traffic replay subsumes at no API cost.

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

- **verifyWrittenSession: one failure path untested**: The helper does not
  throw. It returns an array of warning strings and lets the caller decide how
  to surface them; the `index.ts` wrapper fans each one out to the debug log, a
  `piUI.notify` and a `diagDump`. `tests/unit-session-integrity.mjs` now
  induces and asserts four of the five paths (missing file, record-count
  mismatch, sessionId drift, malformed JSONL) plus the clean round-trip. The
  remaining gap is the file-unreadable path, where `statSync` succeeds but
  `readFileSync` throws. Low priority.

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
