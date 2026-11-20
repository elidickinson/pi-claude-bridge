# Silent-loss audit

Scanners for the two places the bridge can lose or corrupt data without anything throwing:

1. **Write path** -- pi history → `convertPiMessages` → `repairToolPairing` → `Session.importMessages` → JSONL → `--resume`.
2. **Tool loop** -- pi tools served over in-process MCP, `tool_use` blocks streamed back into pi, results paired by `_meta["claudecode/toolUseId"]`.

```
node --import tsx diag/audit-transcripts.mjs [file.jsonl | projects-dir] [--since YYYY-MM-DD]
node --import tsx diag/audit-warnings.mjs    [claude-bridge.log] [--since YYYY-MM-DD]
node --import tsx diag/replay-write-path.mjs <pi-session.jsonl>
```

Defaults are `~/.claude/projects` and the bridge log in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Prompt-cache scanning (`audit-cache.mjs`) and live cache experiments are in [CACHE.md](CACHE.md).

**`--since` makes these gates rather than reports.** Everything found is printed, but the exit code counts only what falls inside the window. Most of what is on disk is damage from bugs already fixed, so pass the date of the last known-good run. A rewrite re-stamps old messages with the time it ran, so a session rewritten inside the window brings its whole history with it.

**Anchor every log scan.** Tool output is echoed into `claude-bridge.log` verbatim, so a bare `grep WARNING:` matches compiler output and any file an agent read. Every scan anchors on the bridge's line prefix `^\[<iso-ts>\] \[<module-id>\] `, and the transcript scanner only matches markers inside bodies under 200 chars. Unanchored counts are mostly echo: raw `grep -c` finds 900 `[no tool result recorded]` where the structured count is 799, and 126 `[image]` where it is 0.

## `audit-transcripts.mjs`

Walks `~/.claude/projects/**/*.jsonl` (or one file) and reports loss markers and structural defects. It splits bridge-written records from CC's and regroups CC's split records by `message.id`; see [CACHE.md, Pitfalls](CACHE.md#pitfalls) for those rules.

Baseline (2026-07-29): scanned 1810 (cc-authored 854, bridge-written 564, mixed 352, no-assistant 40). A new defect kind, or any count growing, is what matters.

| Real projects | Count | What it is |
|---|---:|---|
| `[no tool result recorded]` | 407 | the parallel-results bug fixed in ff60313c; 389 of 406 non-subagent ones sit next to a real result from the same turn |
| `[incompatible content omitted]` | 125 | not lost content: about 75% replace assistant messages already empty in pi, the rest are other providers' thinking-only messages |
| `tool_use` unanswered at EOF | 30 | CC-authored tails cut off by an abort or process exit |
| bridge-written non-MCP tool name | 20 | `Read {"path":"token0.txt"}` unit-test fixtures |
| `tool_use` with no `tool_result` | 5 | CC's own `subagents/*.jsonl` sidechains, which interleave concurrent subagents |
| `tool_result` after next turn | 5 | same |

Zero real occurrences of `[empty]`, `[image]`, `[document]`, `[thinking]`, `[orphaned tool result removed]`, duplicate `tool_use` ids, orphan `tool_result`, empty assistant records, or transcripts starting mid-turn.

**Old replays invented builtin calls.** `convertPiMessages` without a tool map used to map pi's `bash` to CC's builtin `Bash`, the condition behind the phantom-call deadlock fixed in 122914dd. That is where the 5,525 non-MCP tool names in test and temp dirs come from. Without a map it now gives every tool its `mcp__custom-tools__` name.

## `audit-warnings.mjs`

Counts `WARNING:`/`BUG:` lines with date spans, plus two tool-loop checks that have no WARNING of their own: MCP handlers that waited and were never resolved, and tool results queued for a handler that never claimed them.

Baseline (2026-07-29, 84,115 anchored lines, 1,929 pi processes):

| Count | Dates | Line | What it is |
|---:|---|---|---|
| 3 | 2026-04-10..2026-07-29 | `WARNING: N MCP handlers still waiting after delivering N results` | |
| 2 | 2026-04-12 | `WARNING session verify: forced test failure` | `tests/` |
| 1 | 2026-05-04 | `WARNING: mcp handler bash has no toolCallId` | predates `fc2efeb6`, which moved pairing to `_meta["claudecode/toolUseId"]` |
| 1 | 2026-07-29 | `BUG: both maps non-empty! handlers=1 results=1` | the phantom-tool bug caught live, fixed in 122914dd |
| 32 | | MCP handlers never resolved | 28 follow an abort or `session_shutdown`; 4 are pi processes that exited mid-dispatch |
| 14 | | tool results never claimed | 10 match an `Unknown tool <name>` id in the cc-cli log, the phantom-tool bug's other half |

The 169 `session_shutdown left state behind` lines in the log (2026-08-12..2026-10-30) counted every live context in the process, mostly a subagent shutting down while its parent's query was live; that check no longer exists. In `closeSessionQueries` a parked query logs `session_shutdown: closing parked query` (expected after a `terminate: true` tool, #210), and only a real leak warns `session_shutdown left a context with no query`. Zero occurrences of `currentPiStream overwritten before terminal event` and `steer with no prompt stream, dropping`.

## Not covered by these scripts

**Orphaned Claude Code subprocess, trigger unknown.** A CC child outlived its MCP transport: every tool call failed at once with `Stream closed`, CC fed that to the model as an ordinary tool error, and it kept making API requests for up to an hour.

| # | cc-cli log | onset | `Stream closed` calls | API requests | stopped by |
|---|---|---|---:|---:|---|
| A | `2026-07-10T22-48-21-609Z-provider-1.log:474` | 23:08:21 | 1,396 | 1,416 | LSP shutdown, 59 min |
| B | `2026-06-03T20-19-06-231Z-provider-1.log:422` | 20:24:12 | 356 | 375 | **429 rate_limit_error**, 23 min |
| C | `2026-08-03T15-53-14-639Z-provider-1.log:320` | 15:55:34 | 8 | 21 | LSP shutdown, 65 s |
| D | `2026-08-23T19-45-39-979Z-provider-1.log:506` | 19:50:03 | 4 | 30 | LSP shutdown, 43 s |

B used enough quota to hit the account rate limit, which affects the user's other sessions too. `tests/int-shutdown-kills-cc.mjs` shows that pi exiting or aborting kills the child within a second, so these needed pi alive with its control channel closed. A and B predate the July 2026 tool-loop fixes; none since 2026-08-23.

**Thinking blocks with no signature.** `processAssistantMessage` stores `thinkingSignature: block.signature ?? ""`, and `convertPiMessages` replays only signed thinking, so an unsigned block drops out of every rewrite: 26 of 2,363 bridge thinking blocks (1.1%). Dropping it is correct; why the SDK omits the signature is unknown.
