# TODO

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

## Testing Gaps

- **`int-session-resume` Turn 8 flake (low priority)**: The isolated-AskClaude
  assertion fails intermittently (~1-in-5). The alt provider invokes AskClaude
  with a verbatim prompt in some runs (test passes — isolated CC correctly
  returns "UNKNOWN") but may embed the secret word into the prompt in others
  (test fails — but the leak is in the calling model, not in our isolation).
  We confirmed the verbatim case from logs; the failing case wasn't captured
  before the next run overwrote the log. Either pin the alt model to one with
  strict prompt fidelity, or instrument the test to assert on the AskClaude
  prompt args (not just the response) so we can distinguish "calling model
  embedded the answer" from a real bridge-side context leak.

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

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

