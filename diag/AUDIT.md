# Silent-loss audit

Scanners for the two places the bridge can lose or corrupt data without anything throwing:

1. **Write path** -- pi history → `convertPiMessages` → `repairToolPairing` → `Session.importMessages` → JSONL → `--resume`.
2. **Tool loop** -- pi tools served over in-process MCP, `tool_use` blocks streamed back into pi, results paired by `_meta["claudecode/toolUseId"]`.

```
node --import tsx diag/audit-transcripts.mjs [file.jsonl | projects-dir] [--since YYYY-MM-DD]
node --import tsx diag/audit-cache.mjs       [claude-bridge.log] [--since YYYY-MM-DD] [--ceiling 0.30]
node --import tsx diag/audit-warnings.mjs    [claude-bridge.log] [--since YYYY-MM-DD]
node --import tsx diag/replay-write-path.mjs <pi-session.jsonl>
```

Defaults are `~/.claude/projects` and the bridge log in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). For live cache experiments see `diag/probe-rebuild-fidelity.mjs`, `diag/probe-cache-mutations.mjs` and [CACHE-TRACE.md](CACHE-TRACE.md); their output holds conversation content.

**`--since` makes these gates rather than reports.** Everything found is printed, but the exit code counts only what falls inside the window. Most of what is on disk is damage from bugs already fixed, so pass the date of the last known-good run. A rebuild re-stamps old messages with the time it ran, so a session rebuilt inside the window brings its whole history with it.

`--ceiling` is the boundary break rate `audit-cache.mjs` tolerates; set it just above the latest measured rate. Compare a run against the dated baseline nearest it, not against zero.

## Anchor every log scan

Tool output is echoed into `claude-bridge.log` verbatim, so a bare `grep WARNING:` matches compiler output and any file an agent read. Every scan anchors on the bridge's line prefix `^\[<iso-ts>\] \[<module-id>\] `, and the transcript scanner only matches markers inside bodies under 200 chars. Unanchored counts are mostly echo: raw `grep -c` finds 900 `[no tool result recorded]` where the structured count is 799, and 126 `[image]` where it is 0.

## `audit-transcripts.mjs`

Walks `~/.claude/projects/**/*.jsonl` (or one file) and reports loss markers and structural defects.

- **Provenance.** Bridge-written records carry `message.id` `msg_syn_*` and `requestId` `req_syn_*` (cc-session-io). CC's carry real ids, `promptId` on user records, and cache usage. One file often holds both: the bridge writes the prefix at a rebuild and CC appends its live turns.
- **Regroup by `message.id` first.** CC stores one content block per record and each `tool_result` in its own `user` record; cc-session-io writes one record per message. Without regrouping, CC's own files show hundreds of phantom defects. CC also splits a turn's tool results across records, while `convertPiMessages` emits them as one message because `repairToolPairing` requires it. `tests/int-cc-contracts.mjs` pins both.

### Baseline (2026-07-29)

```
scanned: 1810   cc-authored 854 | bridge-written 564 | mixed 352 | no-assistant 40

REAL PROJECTS
  [no tool result recorded]        407
  [incompatible content omitted]   125
  tool_use unanswered at EOF        30
  bridge-written non-MCP tool name  20
  tool_use with no tool_result       5
  tool_result after next turn        5
```

A new defect kind, or any count growing, is what matters.

- **`[no tool result recorded]`** is the parallel-results bug fixed in ff60313c: 389 of the 406 non-subagent ones sit next to a real result from the same turn. Should not grow.
- **`[incompatible content omitted]`** is not lost content. About 75% replace assistant messages that were already empty in pi (aborted or errored); the rest are thinking-only messages from other providers, whose signatures can't be replayed.
- **`tool_use` unanswered at EOF** are CC-authored tails cut off by an abort or process exit.
- **bridge-written non-MCP tool name** are `Read {"path":"token0.txt"}` unit-test fixtures.
- **`tool_use with no tool_result` / `tool_result after next turn`** are inside CC's own `subagents/*.jsonl` sidechains, which interleave concurrent subagents.

Zero real occurrences of `[empty]`, `[image]`, `[document]`, `[thinking]`, `[orphaned tool result removed]`, duplicate `tool_use` ids, orphan `tool_result`, empty assistant records, or transcripts starting mid-turn.

### Replays without a tool map invent builtin calls

`convertPiMessages` called without `customToolNameToSdk`, as `replay-write-path.mjs` and benchmark replays do, maps pi's `bash` to CC's builtin `Bash` and other names through `pascalCase` (`mapPiToolNameToSdk` in `src/convert.ts`). The provider path runs CC with `tools: []`, so such a transcript says the model used a builtin it can't call, which is the condition behind the phantom-call deadlock fixed in 122914dd. A replay can reproduce that bug, or hide a real regression, for reasons unrelated to the code under test. This is where the 5,525 non-MCP tool names in test and temp dirs come from; real projects have 3,991 `mcp__*` names against the 18 fixtures. Pass the recorded tool list when replaying.

## `audit-cache.mjs`

A request that reads back less cache than the previous one left means the prompt prefix changed. The scanner expects `cacheRead[N] == cacheRead[N-1] + cacheWrite[N-1]`. Uncached `in` tokens are left out because they were never cached, and a tool-heavy turn sends its results that way. A break is a shortfall of at least 2,000 tokens, CC's own `MIN_CACHE_MISS_TOKENS`.

- A turn logs several `usage:` lines as its output grows. Dedupe on (cacheRead, cacheWrite, model) and keep the *first* record's preceding log lines, or query boundaries get misread as in-query.
- Skip pairs where the request's own `cachePct ≥ 95`: a prefix that got shorter (a rebuild that dropped messages) is a shrink, not a break.
- Pairs are per module id, not per query. In-process subagents can share the parent's module and model, so since 2026-09-26 most in-query breaks are interleaved conversations (e.g. `z6fojf`, 2026-10-25T15:03-15:08). Pair by query or session before using in-query as a control.

### Baselines

| Window | Requests | In-query breaks | `--resume` boundary breaks |
|---|---:|---|---|
| to 2026-07-29 | 7,543 | 40/6,466 (0.6%) | 136/549 (24.8%) |
| to 2026-09-25 | 17,917 | 130/15,033 (0.9%) | 310/1,360 (22.8%): rebuild 89/139 (64.0%), reuse 216/1,121 (19.3%) |

Pairs exclude idle over 5 minutes, effort, model and tool-set changes, and compaction. Nearly all of the September window is CC 2.1.141 or earlier; bin by CC version before comparing later runs.

### What the boundary breaks are

- **System-prompt changes, mostly git status (fixed 2026-08-24, `deb1f316`).** CC's preset ended its cached system block with a `gitStatus:` section, and the bridge re-runs CC every turn, so any git transition (new untracked file, `git add`, commit) changed the system prompt and cut the read back to the tools prefix. The provider path now sets `includeGitInstructions: false`; `diag/probe-git-cache.mjs` reproduces the old behavior. From 2026-04-09 to 2026-08-24, 173 of 1,025 strict boundaries (16.9%) were system-prompt breaks, 25.6M tokens. Boundaries spanning a commit broke 78.8% of the time against 17.9% without; the rest mixes other git transitions with date rollover and CLAUDE.md edits. The signature is `cacheRead` equal to the process's first-request read (the tools prefix, e.g. 6,599 or 7,976). Bin by date: logs before the fix are dominated by it.
- **Rebuilds.** What a rebuild costs on current CC is in [CACHE-REBUILD-FINDINGS.md](CACHE-REBUILD-FINDINGS.md).
- **The rest is unexplained.** Controlled runs never went cold (33 bridge-free `claude -p --resume` boundaries, 90 bridge boundaries under the capture proxy). The audited cold resumes were Opus 1M at `xhigh` with 100-400k prompts, so leave `diag/capture-proxy.mjs` on during a real session of that shape and diff the first cold boundary with `diag/diff-captures.mjs`.

Settled by captures:

- `system[0]` is CC's per-request billing header (`cch=<hash>`). It has no `cache_control` and changes every request without breaking the cache; every capture diff shows it, so look past it.
- CC requests a 1-hour cache TTL (`cache_control: {type: "ephemeral", ttl: "1h"}`).
- CC's resume reorders same-millisecond parallel `tool_result` records: 8 of 10 sessions with 10 parallel reads. It's deterministic per session file, so it costs one cache write, and rare in real use (2 of 417 CC-authored parallel groups tie; bridge-written records can't). Worth filing upstream.
- Debug logging doesn't show CC's `[PROMPT CACHE BREAK]` reasons: CC 2.1.293 logs them only in cowork, desktop or remote mode (`cc-293-deobf/chunk-q21zbtsq.js:4231`).

## `audit-warnings.mjs`

Counts `WARNING:`/`BUG:` lines with date spans, plus two tool-loop checks that have no WARNING of their own: MCP handlers that waited and were never resolved, and tool results queued for a handler that never claimed them.

### Baseline (2026-07-29, 84,115 anchored lines, 1,929 pi processes)

```
   3  2026-04-10..2026-07-29   WARNING: N MCP handlers still waiting after delivering N results
   2  2026-04-12               WARNING session verify: forced test failure   (from tests/)
   1  2026-05-04               WARNING: mcp handler bash has no toolCallId
   1  2026-07-29               BUG: both maps non-empty! handlers=1 results=1

MCP handlers that waited and were never resolved: 32  (28 after abort/shutdown, 4 unexplained)
tool results queued for a handler that never claimed them: 14  (7 after abort/shutdown, 7 unexplained)
```

- **`session verify: forced test failure`** is `tests/`.
- **`mcp handler … has no toolCallId`** predates `fc2efeb6`, which moved pairing to `_meta["claudecode/toolUseId"]`.
- **`BUG: both maps non-empty!`** is the phantom-tool bug caught live, fixed in 122914dd.
- **`session_shutdown left state behind`** (169, 2026-08-12..2026-10-30) came from a shutdown check that counted every live context in the process, so most are a subagent shutting down while its parent's query was live. `closeSessionQueries` replaced it: it looks only at the shutting-down session, logs a parked query as `session_shutdown: closing parked query` (expected after a `terminate: true` tool, #210), and warns `session_shutdown left a context with no query` only for a real leak.
- **Stranded handlers:** 28 of 32 follow an abort or `session_shutdown`. The other 4 are pi processes that exited mid-dispatch.
- **Orphan queued results:** 10 of 14 match an `Unknown tool <name>` id in the cc-cli log, the phantom-tool bug's other half.

Zero occurrences of `currentPiStream overwritten before terminal event` and `steer with no prompt stream, dropping`.

## Not covered by these scripts

**Orphaned Claude Code subprocess, trigger unknown.** A CC child outlived its MCP transport: every tool call failed at once with `Stream closed`, CC fed that to the model as an ordinary tool error, and it kept making API requests for up to an hour.

| # | cc-cli log | onset | `Stream closed` calls | API requests | stopped by |
|---|---|---|---:|---:|---|
| A | `2026-07-10T22-48-21-609Z-provider-1.log:474` | 23:08:21 | 1,396 | 1,416 | LSP shutdown, 59 min |
| B | `2026-06-03T20-19-06-231Z-provider-1.log:422` | 20:24:12 | 356 | 375 | **429 rate_limit_error**, 23 min |
| C | `2026-08-03T15-53-14-639Z-provider-1.log:320` | 15:55:34 | 8 | 21 | LSP shutdown, 65 s |
| D | `2026-08-23T19-45-39-979Z-provider-1.log:506` | 19:50:03 | 4 | 30 | LSP shutdown, 43 s |

B used enough quota to hit the account rate limit, which affects the user's other sessions too. `tests/int-shutdown-kills-cc.mjs` shows that pi exiting or aborting kills the child within a second, so these needed pi alive with its control channel closed. A and B predate the July 2026 tool-loop fixes; none since 2026-08-23.

**Thinking blocks with no signature.** `processAssistantMessage` stores `thinkingSignature: block.signature ?? ""`, and `convertPiMessages` replays only signed thinking, so an unsigned block drops out of every rebuild: 26 of 2,363 bridge thinking blocks (1.1%). Dropping it is correct; why the SDK omits the signature is unknown. A WARNING there would make the rate visible.
