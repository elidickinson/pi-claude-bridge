# Cache

What the bridge's session sync costs in prompt cache and in the model's earlier thinking, and how to measure it. Current numbers are from 2026-11-03 runs at commit 864330f7 with Claude Code 2.1.308, Agent SDK 0.3.308 and pi 1.5.0, on Haiku 5.5 at medium effort unless noted. Runs dated 2026-10-21 used CC 2.1.293 behind the capture proxy without the first-party override unless marked, with the thinking-binding beta added through `ANTHROPIC_BETAS`. CC source citations (`chunk-*.js:<line>`) are against `../reference-code/cc-293-deobf/` (CC 2.1.293); chunk names change between builds.

## What each history change costs

On each fresh turn the bridge compares pi's history with what Claude Code last received and takes one of four paths:

| Path | What it writes | Triggered by | Cache read | Earlier thinking |
|---|---|---|---|---|
| reuse | nothing; resumes CC's session as is | no change | all | all kept |
| fork | nothing; resumes CC's session cut at a record (`resumeSessionAt` + `forkSession`) | restart, `/tree`, a forced no-op | all the ancestor cached | all kept |
| prefix-write | a new file: CC's records up to the cut, then pi's history | abort, API error, an edit with a cut before it | up to the cut | kept before the cut; past it, see [Earlier thinking](#earlier-thinking) |
| full import | a new file with pi's whole history | an edit with no cut before it, `/fork` and clone, a model change, a cwd change | tools + system prompt only | all dropped |

Measured, one run each. "Cut" is the kept pi messages out of the history before the prompt; "thinking" is earlier blocks sent / dropped.

| Change | Path | Cut | Read | Thinking |
|---|---|---|---|---|
| forced no-op | fork | 8/8 | 4704 = ancestor | none in history |
| forced no-op, with thinking | fork | 8/8 | 4935 = ancestor | 2 / 0 |
| restart | fork | 8/8 | 4697 = ancestor | none in history |
| restart, with thinking | fork | 8/8 | 4978 = ancestor | 2 / 0 |
| `/tree` back one turn | fork | 4/4 | 4537 = ancestor | none in history |
| `/tree` back two turns | fork | 4/4 | 4578 = ancestor | 1 / 0 |
| abort mid-text | prefix-write | 5/6 | 4818 = ancestor | 2 / 0 |
| abort of a continued query | prefix-write | 4/5 | 4634 = ancestor | 1 / 0 |
| API error at a tool boundary | prefix-write | 7/8 | 4597 = ancestor | none in history |
| edit 6 messages back | prefix-write | 4/10 | 4535 = ancestor at the cut | 1 / 1 |
| edit in message 0 | full import | 0/8 | 3820 (tools + system) | none in history |
| pi clone | full import | 0/10 | 3820 of 5063 | 2 / 2 |

- A fork reads back everything its ancestor had cached. For `/tree` the ancestor is the request at the branch point.
- An abort or API error takes a prefix-write, not a fork. pi's aborted or failed assistant message has no slot in the pointer, so the digests differ there and pi's version is written after the cut. In `abort-fresh` the aborted reply's own thinking, imported from pi right after the cut, was kept.
- `abort-continuation` cut the continued request off upstream and took a prefix-write in 3 of 3 runs (2026-11-03, b6fd42ce plus its 600-word prompt and first-delta abort). Its table row is from an earlier run in which the request finished before the abort reached it; the pi-side abort and the next turn happened as listed.
- After an edit the read stops at the cut: `recent-redaction`'s latest request had 4948 cached and the cut kept 4535. The thinking block after the edited message was dropped, and dropped again on the next reuse.
- The analyzer cannot link requests across pi session ids, so `clone-rebuild` was compared by hand.
- An extension's `context` transform that redacts text without changing the message count reaches CC. The mask was sent and the secret was not.

For each pi session the bridge saves a pointer, `claude-bridge/sessions/s-<hash>.json` in pi's agent dir (`src/session-store.ts`). It holds CC's session id, cwd and model, and for each pi message a digest, the CC record uuid it maps to, and whether a cut may follow it. On each fresh turn `syncSharedSession` (`src/index.ts`) digests pi's messages before the prompt and compares them with the pointer (`src/session-sync.ts`). The cut is the last cuttable message inside the common prefix: one with no tool call left open, and not inside a group of pi messages CC stores as one record (coalesced prompts, parallel results). A prefix-write keeps every record before the cut, including parallel results CC parented off the cut's own parent path. Both sides are digests of pi's own messages, so CC's form of a tool result never counts as a difference. Abort, a failed query, `/tree`, compaction and loading a pointer from disk mark it dirty, so the next turn forks or writes even when the digests match. Each fork or write gets a new CC session id and leaves the replaced file on disk; a query that made no progress deletes the file it created. The pointer is saved after the CC child exits. If CC's file is missing, the bridge drops the pointer and takes row 2. Two bridge processes using the same pi session id at once are unsupported: the pointer file is written atomically but not locked. The trace's `decision` event names the row: 0 no pi session id, 1 clean start, 2 no pointer, 3 model changed, 4 reuse, 5 cwd changed or no cut, 6 fork, 7 prefix-write.

Evidence: in table order, `noop-rebuild`, `thinking-rebuild`, `restart-resume`, `restart-thinking`, `tree-back`, `tree-thinking`, `abort-fresh`, `abort-continuation`, `injected-error`, `recent-redaction`, `redaction`, `clone-rebuild` (2026-11-03); path choice and dirty marks from `syncSharedSession`.

## What a full import loses

Everything below is lost in a full import, and in a prefix-write past its cut. CC adds fresh context after the new prompt itself, so recreating these records past a cut would gain little.

### Context records

Measured. Claude Code stores context as attachment records in its session file and sends each one's stored `rendered` text with its `renderedRole`. An import carries only `file` attachments (`src/attachments.ts`), so the rest vanish from the imported part. On Haiku 5.5, Opus 5.5 and Fable 5.1 the layout is the same:

- `session_context` (account context, including the user's email) as a reminder block in the first user message;
- environment, model, the `total_tokens` countdown and date together in one system message right after it;
- a `<total_tokens>` countdown system message after every tool result and every later prompt, each from its own record. A full import loses two messages per turn: 35 became 27 at `--turns 4`.

Haiku 4.5 folds the same records into user content and into the tool result as a second block. Dropping `session_context` alone stops the read at tools + system. Dropping `environment` alone stops it after the first user message. In an imported request CC adds `session_context` and the environment message after the new prompt and leaves index 1 as an empty system message carrying only `output_config: {effort}`.

CC sends `rendered`, not the record's fields: editing `attachment.date` or a countdown value changed nothing on the wire. With a stored date older than today, CC appended "The date has changed..." at the end of the request, so a session resumed on a later day keeps its prefix. `prompt_snapshot` holds the system prompt parts, tools and wire-shape flags, not context; CC replays it on resume (see [Known gaps](#known-gaps-and-open-questions)). `silent_turn_reminder`, `queued_command` (how CC stores steers) and `instructions` records can only be reproduced by copying them. From the code, not measured: none of these records can be switched off except the countdowns (`CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`), and `--bare`, which removes environment and model, also disables OAuth. `client_composed: true` defers CC's turn-start context pass rather than skipping it, despite the SDK docs.

Evidence: `probe-cache-mutations.mjs` cases `drop-attachment-session_context`, `drop-attachment-environment`, `edit-attachment-date`, `drop-attachment-prompt_snapshot` (2026-10-21, both orders for the first two); `noop-rebuild` session snapshots (2026-10-21); `clone-rebuild` (2026-11-03); `probe-writer.mjs` arm PREFIX for the gain past a cut; real sessions under `~/.claude/projects` for the copy-only records; CC's `from_snapshot` path, `chunk-q4w8aqm9.js`.

### Earlier thinking

Measured. The bridge sends thinking blocks back byte-identical, with the same signature. The API binds each block to the context it was produced in, and an import changes that context, so the request reports `thinking_dropped / prefix_binding_mismatch` for every earlier block. The model loses its earlier reasoning even once the cache has expired, which makes this a correctness issue, not only a cost. The API reports drops only when the request carries the beta `thinking-binding-controls-2026-08-01`, which CC adds itself on thinking requests to a first-party endpoint. 92 `thinking_drop` records with reason `prefix_mismatch` in real provider-path sessions were all in sessions the bridge had fully imported.

Past a prefix-write's cut, a block survives only if everything ahead of it matches the request CC would have sent. An extra `timeout: 120` on one `bash` call dropped both thinking blocks after it; the bridge stores CC's tool input as sent (#203). A writer that rebuilds the file from pi's messages reproduced CC's request byte for byte only once it also copied CC's tool_result shape and tool input. That needs pi messages matched to CC records by content, which fails exactly where pi's history was edited, so the bridge keeps CC's records instead.

Evidence: `thinking-rebuild` on Haiku 5.5, Opus 5.5 (2/2 dropped) and Fable 5.1 (1/1) (2026-10-21); `clone-rebuild` (2026-11-03, 2/2); real sessions under `~/.claude/projects`; `probe-writer.mjs` arms WRITER and WRITER-FIXED; beta from `chunk-nwqfvmza.js:115334-115340`.

### Saved tool results

Measured, on a 2026-10-21 `hard-content-rebuild` run whose forced step took a full import. On the current bridge that step is a fork, by code; it was not rerun.

- **Oversized output.** CC saves output over 50,000 characters, or over the MCP token limit, to the session's `tool-results/` directory and sends the model a short reference instead. pi stores the full output, so the import sent all 59,887 characters: the model saw content it never saw before, and the request wrote 30,943 cache tokens.
- **Images.** CC saves the PNG to `tool-results/` and sends the image plus a text block `[Image: source: <path>]`. The image survives an import; the text block does not.
- **Error results** survive an import unchanged apart from key order.
- **Shape.** pi sends tool_result content as a string in its own key order; CC sends a text-block array. Both differences are cache-neutral on their own. Ahead of a thinking block they end the cache read at that block, though the block is kept.

Evidence: `hard-content-rebuild` (2026-10-21); `probe-cache-mutations.mjs` cases `tool-result-content-shape`, `tool-result-key-order` (both orders); `probe-writer.mjs` arm WRITER.

## How to measure

Cache numbers come from the API's usage report on each response (`cache_read_input_tokens`, `cache_creation_input_tokens`). What matters is where the read stops, not the token count: "tools + system" means the whole conversation missed, however long it is. A probe result counts only if the request difference between its arms is the targeted change and nothing else: same model, tools, system, thinking settings, top-level body fields, auth and betas. Measure on a call's first attempt that reached the model, with an ancestor well inside the 1h TTL. A seed that cached nothing is inconclusive, never neutral.

### audit-cache over real logs

```
node --import tsx diag/audit-cache.mjs [claude-bridge.log] [--since YYYY-MM-DD] [--ceiling 0.30]
```

A request that reads back less cache than the previous one left means the prompt prefix changed. The scanner expects `cacheRead[N] == cacheRead[N-1] + cacheWrite[N-1]` and counts a shortfall of at least 2,000 tokens, CC's own `MIN_CACHE_MISS_TOKENS`, as a break. It anchors on the bridge's line prefix like the other log scanners (see [AUDIT.md](AUDIT.md)). `--since` and `--ceiling` make it a gate: it fails when the boundary rate inside the window exceeds `--ceiling`, which should sit just above the latest measured rate, or when any break inside the window lands on a fork. A fork should read back everything its ancestor cached.

Pairs are per module id, not per query. In-process subagents can share the parent's module and model, so most in-query breaks since 2026-09-26 are interleaved conversations (e.g. `z6fojf`, 2026-10-25T15:03-15:08). Pair by query or session before using in-query breaks as a control.

What the boundary breaks are:
- **System-prompt changes, mostly git status**, fixed in `deb1f316` (2026-08-24). CC's preset ended its cached system block with `gitStatus:`, so any git transition cut the read back to the tools prefix. From 2026-04-09 to 2026-08-24, 173 of 1,025 strict boundaries (16.9%, 25.6M tokens) were system-prompt breaks; the rest of them came from date rollover and CLAUDE.md edits. The signature is a `cacheRead` equal to the process's first-request read. `diag/probe-git-cache.mjs` reproduces it.
- **Full imports** (`path=rebuild`), whose cost is [above](#what-each-history-change-costs). The scanner counts them as expected prefix changes, not residual breaks.
- **The rest is unexplained.** Controlled runs never went cold (33 bridge-free `claude -p --resume` boundaries, 90 bridge boundaries under the capture proxy). The audited cold resumes were Opus 1M at `xhigh` with 100-400k prompts; to catch one, run a real session of that shape through `diag/capture-proxy.mjs` and diff the first cold boundary with `diag/diff-captures.mjs`.
- **Parallel tool results** with the same millisecond timestamp are reordered by CC's resume, deterministically per session file, so it costs one cache write. 2 of 417 CC-authored parallel groups tie.

Evidence: `audit-cache.mjs` over the bridge log, 2026-04-09 to 2026-09-25; `probe-git-cache.mjs`; capture-proxy runs for the controlled boundaries and for the reorder (8 of 10 sessions with 10 parallel reads).

### The cache trace

The trace checks every API request against two contracts. **Preservation:** when pi's history only grew or did not change, the part of a request its ancestor already sent must not change on the wire. It is checked on a normalized view (billing header, moving `cache_control`, a single text block vs a string), with raw differences kept alongside. **Propagation:** pi's effective history, after extension transforms, must reach the request CC sends. Each transition reports what the cache did against what the ancestor cached, the bridge's decision, and whether the evidence is good enough to conclude anything.

```
node diag/capture-proxy.mjs --port 8787 --out ~/cc-trace/capture &
CLAUDE_BRIDGE_TRACE_DIR=~/cc-trace/trace \
CLAUDE_BRIDGE_TRACE_RAW=1 \
CLAUDE_BRIDGE_TRACE_PROXY=http://127.0.0.1:8787 \
  pi --model claude-bridge/...
node diag/analyze-trace.mjs --capture ~/cc-trace/capture --trace ~/cc-trace/trace
```

Raw mode records whole conversations, including file contents and the account details CC injects. Files are owner-only and nothing is uploaded; treat the directories like the conversation itself.

- `src/cache-trace.ts` records provider inputs, session decisions and query lifecycle, and copies CC's session file before the bridge replaces it. `diag/capture-proxy.mjs` records request bodies and ties each to the query that sent it. Without `CLAUDE_BRIDGE_TRACE_RAW=1` only digests and block shapes are recorded: propagation cannot be checked and no session files are copied.
- The recorder refuses to route if `ANTHROPIC_BASE_URL` is already set. If it cannot write, the next turn fails before a query starts. Anything over `CLAUDE_BRIDGE_TRACE_MAX_ARTIFACT_BYTES` (64 MiB) or `CLAUDE_BRIDGE_TRACE_MAX_RUN_BYTES` (2 GiB) is left out and marked, never truncated.
- `analyze-trace.mjs` also takes a bare capture, or `--probe DIR` for `probe-cache-mutations.mjs` output. Without a trace, ancestry is a guess and every transition is marked unattributed.

### Lifecycle scenarios and probes

```
node diag/lifecycle-runner.mjs [--scenario noop-rebuild,abort-continuation,...] [--turns N] [--out DIR] [--bridge OTHER_CHECKOUT]
```

Each scenario drives real pi, the bridge and CC through a short sequence (rebuild, abort, steer, injected errors, restart, redaction, `/tree`, compaction) and analyzes every request boundary. A scenario that does not reach its intended state is reported NOT EXERCISED, never as a pass. `--bridge` runs another checkout to confirm a scenario can tell the difference: on a checkout without the #199/#200 fix, `abort-continuation` let the aborted request stream to completion (2026-10-21). `clone-rebuild` runs two thinking turns, pi's clone, and one more turn. `abort-fresh` aborts a fresh turn at its first delta, then runs one more turn. Two scenarios cited here are scratch additions to a copy of the runner, not in the repo: `restart-thinking` and `tree-thinking` (`restart-resume` and `tree-back` with thinking prompts). The ad hoc SDK probes cited here are not in the repo either. CC retries a 529 itself, even with `x-should-retry: false`, so pi never sees it (`injected-retry`). All of these, and the probes, are paid and must run outside the sandbox.

- `probe-cache-mutations.mjs` warms a native session, then sends the same continuation from the unchanged file and from a file with one change. Run one case per invocation (`--cases`) on a fresh seed, once with each `--order`.
- `probe-session-fork.mjs` pins what forks rely on. Every fork case read back its ancestor's cached total with no thinking drops, including after an abort mid-text or mid-tool, after a 93,599-character saved tool result, and two turns back past a steer. `resumeSessionAt` slices CC's chain at any record; a uuid not on the chain is a hard error. With `forkSession` the kept records keep their uuids in a new file, and the old file and its `tool-results/` stay untouched. Streamed SDK message uuids equal the file's, and CC adopts a prompt uuid supplied in `SDKUserMessage.uuid`. An abort at the first text delta still leaves a partial assistant record whose uuid no stream event carries, which is why an aborted message gets no slot. `resumeDropsTurn` refuses a cut whose dropped range holds a steer, so the bridge does not use it. Avoid the SDK's `forkSession()` function (as opposed to the option): it assigns new uuids and edits records. `getSessionMessages` returns no attachments, and a `sessionStore` resume runs in a temp config dir that is deleted on exit, taking new `tool-results/` files with it.
- `probe-prompt-recording.mjs` shows CC resending its recorded system prompt on resume. `probe-writer.mjs` compares a native session with rewritten ones. `probe-git-cache.mjs` and `probe-rebuild-fidelity.mjs` cover the git-status and rebuild cases.

Evidence: `probe-session-fork.mjs` cases `fork-after-abort-text`, `fork-after-abort-tool`, `fork-after-big-result`, `fork-two-turns-back`, `fork-at-aborted-prompt`, `abort-at-first-delta`, `steer-refusal` (CC 2.1.293 and 2.1.308); `chunk-0z76cjt8.js:29029-29061` and `:2016-2075`.

### Baselines

`audit-cache.mjs` break rates:

| Window | Requests | In-query breaks | `--resume` boundary breaks |
|---|---:|---|---|
| to 2026-07-29 | 7,543 | 40/6,466 (0.6%) | 136/549 (24.8%) |
| to 2026-09-25 | 17,917 | 130/15,033 (0.9%) | 310/1,360 (22.8%): rebuild 89/139 (64.0%), reuse 216/1,121 (19.3%) |

Both rows count full imports as residual breaks; the scanner leaves them out, so compare its boundary rate with the reuse figure. Since the content-based sync, `--since 2026-10-25` (to 2026-11-03) gives a boundary rate of 18/926 (1.9%). Pairs exclude idle gaps over 5 minutes, effort, model and tool-set changes, and compaction. Nearly all of the September window is CC 2.1.141 or earlier. The July window predates the git-status fix, the September one spans it, and both predate the current session sync. Bin by CC version and date before comparing later runs, and compare against the nearest dated baseline, not against zero.

### Pitfalls

**The proxy matches production only with the production env.** The bridge sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (`CC_CHILD_ENV`, `src/index.ts`), which stops CC fetching its server flags, so it uses each flag's built-in default. Without it CC reads cached flags from `~/.claude.json`: a direct connection adds a token-countdown reminder, and CC sends a session-title request. `diag/lib/first-party.mjs` sets it for probes.

**The proxy is not first-party.** Pointing `ANTHROPIC_BASE_URL` at it makes CC treat the connection as third-party (`chunk-fsnz81vy.js:1263-1289`). `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, set by `src/cache-trace.ts` and `diag/lib/first-party.mjs`, restores production behavior for every row but the last:

| Behind the proxy without the override | In production |
|---|---|
| no `thinking-binding-controls` beta, so no drop reports | sent on thinking requests |
| thinking from another model stripped by CC | sent, and the API drops it (`model_binding_mismatch`) |
| tool search off | a `DeferredToolPlaceholder` tool; none of the bridge's MCP tools deferred |
| static billing header, no `diagnostics` field, no `cache-diagnosis-2026-04-07` beta | per-request values |
| system prompt in 3 blocks | 4 blocks, same text |
| per-turn reminders removed on the next request | kept as records with `clearAt: "next_user_message"` |

The contract test `tests/int-cc-contracts.mjs` compares only init tool names and first-request size, which match either way, so it cannot catch a difference here.

- **Session files mix bridge and CC records.** `~/.claude/projects/**` is not evidence of what CC does. Bridge-written records carry `message.id` `msg_syn_*` and `requestId` `req_syn_*`; CC's carry real ids, `promptId` on user records, and cache usage. One file often holds both. CC stores one content block per record and each `tool_result` in its own `user` record, while the bridge writes one record per message, so regroup by `message.id` before comparing (`diag/audit-transcripts.mjs` does both). CC 2.1.308 also writes `api-request`, `api-request-shape` and `api-request-blob` records with no uuid or parent; the bridge turns them off (`CLAUDE_CODE_ELEGANT_MEADOW=0`), and anything that reads CC's chain or scans session files by content must skip them.
- The billing header in `system[0]` and `diagnostics.previous_message_id` change on every request without breaking the cache; look past them in every diff. A new CC session id has no cache effect either.
- CC's debug log does not show `[PROMPT CACHE BREAK]` reasons outside cowork, desktop or remote mode (`chunk-q21zbtsq.js:4231`).
- Steers arrive inside the tool result on Haiku 4.5 and as a system message after the tool results on 5.5. Code-word steers ("mention PAPAYA") are sometimes refused as prompt injection. On-topic steers were obeyed 12/12, so steer tests should use those or assert only transport.

Evidence: `tests/int-cc-contracts.mjs` tests "routing through the capture proxy does not change what CC sends" and "a truncating fork preserves parallel results outside the leaf's parent path" (679fdfe6); `noop-rebuild` and `thinking-rebuild` reruns with the override (2026-10-21); ad hoc SDK model-switch probe; `probe-cache-mutations.mjs` case `rotate-session-id`; `steer-parallel` (2026-10-21) and an ad hoc SDK steer probe.

## Known gaps and open questions

Current behavior with a known cost:

- **pi `/fork` and clone take a full import.** They start a new pi session id with no pointer, so history CC already holds is written again, losing the cache and every earlier thinking block.
- **Forks and prefix-writes keep CC's `prompt_snapshot`.** A changed system prompt or tool set does not reach CC until a full import. Reuse does the same, since the bridge does not set `systemPrompt.snapshot: false`.
- **Replaced session files pile up, and their saved tool results expire.** A fork's kept records point into the replaced session's `tool-results/`, which is no longer written, so CC's 30-day cleanup deletes it while the fork still refers to it. This part is inferred from the code.
- **pi-context-prune's default mode costs cache on every tool-using turn.** Its moving `<pruner-note>` changes the previous tool result on each delivery, so each sync cuts there. Users can turn it off with `remindUnprunedCount: false`.

Not established:

- **The 25-token shortfall.** The reuse after `recent-redaction`'s prefix-write read 4944 of its ancestor's 4969. One run; cause unchecked.
- **How far back a prefix-write still reads to its cut.** The API looks back only about 20 content blocks from a cache marker (Anthropic's docs), so an edit far back may read only tools + system. `recent-redaction`'s edit was 6 messages back.
- **Model and cwd changes** are full imports by code and not measured. `hard-content-rebuild` was not rerun on the current bridge.
- **A short native continuation** after a turn without thinking read 2654 instead of 2987 once, in an ad hoc SDK probe; not reproduced.
- **Billing-header fields:** rewritten sessions lack the `cc_prompt_index` and `cc_turn_index` fields a native session's header has. No cache effect measured.
- **Never sampled:** redacted thinking, CC's `<persisted-output>` form of large results, a mid-session effort change, and the analyzer's rule that a single text block equals a string.

Evidence: `clone-rebuild`, `recent-redaction` (2026-11-03); `probe-prompt-recording.mjs`; `probe-session-fork.mjs` for forks keeping `prompt_snapshot` and pointing into the old `tool-results/`; `chunk-hrmg67aa.js:573-597`; pi-context-prune 2.1.0 trace; `probe-writer.mjs` first-party rerun.
