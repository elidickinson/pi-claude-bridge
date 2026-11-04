# Cache

What the bridge's session sync costs in prompt cache and in the model's earlier thinking, and how to measure it. Current numbers are from 2026-11-03 runs at commit 864330f7 and 2026-11-04 runs at d521b675 and 8c4c1870, with Claude Code 2.1.308, Agent SDK 0.3.308 and pi 1.5.0, on Haiku 5.5 at medium effort unless noted. Runs dated 2026-10-21 used CC 2.1.293 behind the capture proxy without the first-party override unless marked, with the thinking-binding beta added through `ANTHROPIC_BETAS`. CC source citations (`chunk-*.js:<line>`) are against `../reference-code/cc-293-deobf/` (CC 2.1.293); chunk names change between builds.

## What each history change costs

On each fresh turn the bridge compares pi's history with what Claude Code last received and takes one of four paths:

| Path | What it writes | Triggered by | Cache read | Earlier thinking |
|---|---|---|---|---|
| reuse | nothing; resumes CC's session as is | no change | all | all kept |
| fork | nothing; resumes CC's session cut at a record (`resumeSessionAt` + `forkSession`) | restart, `/tree`, pi `/fork` and clone, a forced no-op | all the ancestor cached | all kept |
| prefix-write | a new file: CC's records up to the cut, then pi's history | abort, API error, an edit with a cut before it | up to the cut | kept before the cut; past it, see [Earlier thinking](#earlier-thinking) |
| full import | a new file with pi's whole history | an edit with no cut before it (compaction is one), a changed system prompt append, a model change, a cwd change | tools + system prompt at most | all dropped |

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
| edit before an image and an oversized result | prefix-write | 4/13 | 4529 = ancestor at the cut | 2 / 2 |
| edit in message 0 | full import | 0/8 | 3820 (tools + system) | none in history |
| pi clone | fork | 10/10 | 5122 = ancestor | 2 / 0 |
| `/reload` | reuse | 4/4 | 4634 = ancestor | none in history |
| AGENTS.md edit, then `/reload` | full import | 0/8 | 2315 of 4791 (up to the append) | none in history |

- A fork reads back everything its ancestor had cached. For `/tree` the ancestor is the request at the branch point.
- An abort or API error takes a prefix-write, not a fork. pi's aborted or failed assistant message has no slot in the pointer, so the digests differ there and pi's version is written after the cut. In `abort-fresh` the aborted reply's own thinking, imported from pi right after the cut, was kept.
- `abort-continuation` cut the continued request off upstream and took a prefix-write in 3 of 3 runs (2026-11-03, b6fd42ce plus its 600-word prompt and first-delta abort). Its table row is from an earlier run in which the request finished before the abort reached it; the pi-side abort and the next turn happened as listed.
- After an edit the read stops at the cut: `recent-redaction`'s latest request had 4948 cached and the cut kept 4535. The thinking block after the edited message was dropped, and dropped again on the next reuse.
- The analyzer cannot link requests across pi session ids, so `clone-fork` was compared by hand.
- A changed append also misses part of the system prompt: the read stopped short of the 3820 tokens of tools + system that an edit in message 0 keeps.
- An extension's `context` transform that redacts text without changing the message count reaches CC. The mask was sent and the secret was not.

For each pi session the bridge saves a pointer, `claude-bridge/sessions/s-<hash>.json` in pi's agent dir (`src/session-store.ts`). It holds CC's session id, cwd, model and a digest of the system prompt append (the context files, skills and extension sections the bridge forwards), and for each pi message a digest, the CC record uuid it maps to, and whether a cut may follow it. On each fresh turn `syncSharedSession` (`src/index.ts`) digests pi's messages before the prompt and compares them with the pointer (`src/session-sync.ts`). The cut is the last cuttable message inside the common prefix: one with no tool call left open, and not inside a group of pi messages CC stores as one record (coalesced prompts, parallel results). A prefix-write keeps every record before the cut, including parallel results CC parented off the cut's own parent path. Both sides are digests of pi's own messages, so CC's form of a tool result never counts as a difference. A write copies the block CC recorded for each tool result pi holds unchanged (see [Saved tool results](#saved-tool-results)). Abort, a failed query, `/tree`, compaction and loading a pointer from disk mark it dirty, so the next turn forks or writes even when the digests match. A pi `/fork` or clone starts from a dirty copy of its parent's pointer (in memory only, until its first turn saves its own); a fork of an in-memory pi session has no parent file to read it from, so it takes row 2. CC replays the append it recorded at the session's start on every resume and fork, so a changed append takes a full import, the only path on which CC records a new one. Each fork or write gets a new CC session id and leaves the replaced file on disk; a query that made no progress deletes the file it created. The pointer is saved after the CC child exits. A user message enters the pointer when CC replays it (`--replay-user-messages`). CC never replays a turn's opening prompt holding one of its own tags, such as `<task-notification>` or `<bash-stdout>` (`Ove()` in `chunk-a1cg2ptw.js`, CC 2.1.308), so the bridge records that prompt at the turn's first output instead. That covers the query's prompt and a steer CC runs as a later turn. If CC's file is missing, the bridge drops the pointer and takes row 2. Two bridge processes using the same pi session id at once are unsupported: the pointer file is written atomically but not locked. The trace's `decision` event names the row: 0 no pi session id, 1 clean start, 2 no pointer, 3 model or append changed, 4 reuse, 5 cwd changed or no cut, 6 fork, 7 prefix-write.

Evidence: in table order, `noop-rebuild`, `thinking-rebuild`, `restart-resume`, `restart-thinking`, `tree-back`, `tree-thinking`, `abort-fresh`, `abort-continuation`, `injected-error`, `recent-redaction`, `redaction` (2026-11-03), `hard-content-edit`, `clone-fork`, `reload-instructions` (2026-11-04); path choice and dirty marks from `syncSharedSession`.

## What a full import loses

A full import, and a prefix-write past its cut, loses the context records and earlier thinking below. CC adds fresh context after the new prompt itself, so recreating its records past a cut would gain little. Saved tool results are copied when pi holds them unchanged.

### Context records

Measured. Claude Code stores context as attachment records in its session file and sends each one's stored `rendered` text with its `renderedRole`. An import carries only `file` attachments (`src/attachments.ts`), so the rest vanish from the imported part. On Haiku 5.5, Opus 5.5 and Fable 5.1 the layout is the same:

- `session_context` (account context, including the user's email) as a reminder block in the first user message;
- environment, model, the `total_tokens` countdown and date together in one system message right after it;
- a `<total_tokens>` countdown system message after every tool result and every later prompt, each from its own record. A full import loses two messages per turn: 35 became 27 at `--turns 4`.

Haiku 4.5 folds the same records into user content and into the tool result as a second block. Dropping `session_context` alone stops the read at tools + system. Dropping `environment` alone stops it after the first user message. In an imported request CC adds `session_context` and the environment message after the new prompt and leaves index 1 as an empty system message carrying only `output_config: {effort}`.

CC sends `rendered`, not the record's fields: editing `attachment.date` or a countdown value changed nothing on the wire. With a stored date older than today, CC appended "The date has changed..." at the end of the request, so a session resumed on a later day keeps its prefix. `prompt_snapshot` holds the system prompt parts, tools and wire-shape flags, not context; CC replays it on resume (see [C1](#known-gaps-and-open-questions)). `silent_turn_reminder`, `queued_command` (how CC stores steers) and `instructions` records can only be reproduced by copying them. From the code, not measured: none of these records can be switched off except the countdowns (`CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`), and `--bare`, which removes environment and model, also disables OAuth. `client_composed: true` defers CC's turn-start context pass rather than skipping it, despite the SDK docs.

Evidence: `probe-cache-mutations.mjs` cases `drop-attachment-session_context`, `drop-attachment-environment`, `edit-attachment-date`, `drop-attachment-prompt_snapshot` (2026-10-21, both orders for the first two); `noop-rebuild` session snapshots (2026-10-21); `probe-writer.mjs` arm PREFIX for the gain past a cut; real sessions under `~/.claude/projects` for the copy-only records; CC's `from_snapshot` path, `chunk-q4w8aqm9.js`.

### Earlier thinking

Measured. The bridge sends thinking blocks back byte-identical, with the same signature. The API binds each block to the context it was produced in, and an import changes that context, so the request reports `thinking_dropped / prefix_binding_mismatch` for every earlier block. The model loses its earlier reasoning even once the cache has expired, which makes this a correctness issue, not only a cost. The API reports drops only when the request carries the beta `thinking-binding-controls-2026-08-01`, which CC adds itself on thinking requests to a first-party endpoint. 92 `thinking_drop` records with reason `prefix_mismatch` in real provider-path sessions were all in sessions the bridge had fully imported.

Past a prefix-write's cut, a block survives only if everything ahead of it matches the request CC would have sent. An extra `timeout: 120` on one `bash` call dropped both thinking blocks after it; the bridge applies that default when the tool runs, not to the stored input (#203), but still stores some inputs changed (C4). A writer that rebuilds the file from pi's messages reproduced CC's request byte for byte only once it also copied CC's tool_result shape and tool input. That needs pi messages matched to CC records by content, which fails exactly where pi's history was edited, so the bridge keeps CC's records instead.

Evidence: `thinking-rebuild` on Haiku 5.5, Opus 5.5 (2/2 dropped) and Fable 5.1 (1/1) (2026-10-21); real sessions under `~/.claude/projects`; `probe-writer.mjs` arms WRITER and WRITER-FIXED; beta from `chunk-nwqfvmza.js:115334-115340`.

### Saved tool results

CC records each tool result in the form it sent, which can differ from pi's. A prefix-write or full import copies the block CC recorded, key order included, for every tool result pi holds unchanged (its digest is in the old pointer) that the replaced records include, and writes pi's form for any other, such as one pi or an extension changed. A fork keeps CC's records as they are.

- **Oversized output.** CC saves output over 50,000 characters, or over the MCP token limit, to the session's `tool-results/` directory and sends the model a short notice instead. pi stores the full output. A write sends the notice again (sampled for the MCP form, "exceeds maximum allowed tokens"; see C12); in pi's form the same 59,887-character result wrote 30,205 cache tokens, and the model saw content it never saw before.
- **Images.** CC saves the PNG to `tool-results/` and sends the image plus a text block `[Image: source: <path>]`. A write sends both; pi's form has only the image.
- **Copied paths** point into the `tool-results/` of the session that first saved the file, however many writes back (see C2).
- **Error results** keep their error flag either way.
- **Key order and shape.** pi's form is a string with the bridge's key order; CC's is usually a text-block array with its own. A copied block keeps CC's. In pi's form both differences are cache-neutral on their own; ahead of a thinking block they end the cache read at that block, though the block is kept.

Evidence: `hard-content-rebuild` (fork, 2026-11-04: error, image and notice sent byte-identical); `hard-content-edit` (prefix-write, 2026-11-04: image and notice blocks as CC sent them, keys included, with cc-session-io 0.4.1; write 1,293 tokens; pi's form 30,205 tokens at e4cea69d); `probe-cache-mutations.mjs` cases `tool-result-content-shape`, `tool-result-key-order` (both orders); `probe-writer.mjs` arm WRITER.

## How to measure

Cache numbers come from the API's usage report on each response (`cache_read_input_tokens`, `cache_creation_input_tokens`). What matters is where the read stops, not the token count: "tools + system" means the whole conversation missed, however long it is. A probe result counts only if the request difference between its arms is the targeted change and nothing else: same model, tools, system, thinking settings, top-level body fields, auth and betas. Measure on a call's first attempt that reached the model, with an ancestor well inside the 1h TTL. A seed that cached nothing is inconclusive, never neutral.

### audit-cache over real logs

```
node --import tsx diag/audit-cache.mjs [claude-bridge.log] [--since YYYY-MM-DD] [--ceiling 0.30]
```

A request that reads back less cache than the previous one left means the prompt prefix changed. The scanner expects `cacheRead[N] == cacheRead[N-1] + cacheWrite[N-1]` and counts a shortfall of at least 2,000 tokens, CC's own `MIN_CACHE_MISS_TOKENS`, as a break. It anchors on the bridge's line prefix like the other log scanners (see [AUDIT.md](AUDIT.md)). `--since` and `--ceiling` make it a gate: it fails when the boundary rate inside the window exceeds `--ceiling`, which should sit just above the latest measured rate, when any break inside the window lands on a fork, or when a query ended cleanly with messages CC never acknowledged (`recording: clean end left messages unrecorded`). A fork should read back everything its ancestor cached. Unacknowledged messages cost the next turn a prefix-write, and if the query had started a new session file, the bridge deletes it and keeps the old pointer, so the next turn cuts at the same place again. The scanner also counts sync paths in the window.

Pairs are per pi session: the bridge tags its usage, sync and compaction lines with `piSession=`, and the scanner reads tags only from those lines, never from tool output echoed into others. Older builds' lines have no tag and pair per process, where in-process subagents interleave with the parent, so most in-query breaks in those logs compare two conversations (e.g. `z6fojf`, 2026-10-25T15:03-15:08). Since 2026-10-25, at least 609 of 1,071 in-query breaks (78M of 84M tokens) are a request from a smaller conversation. Use in-query breaks as a control only on tagged logs.

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

Each scenario drives real pi, the bridge and CC through a short sequence (rebuild, abort, steer, injected errors, restart, redaction, `/tree`, compaction) and analyzes every request boundary. A scenario that does not reach its intended state is reported NOT EXERCISED, never as a pass. `--bridge` runs another checkout to confirm a scenario can tell the difference: on a checkout without the #199/#200 fix, `abort-continuation` let the aborted request stream to completion (2026-10-21). `clone-fork` runs two thinking turns, pi's clone, and one more turn. `reload-instructions` runs a turn, `/reload`, a turn, an AGENTS.md edit, `/reload`, and a turn. `abort-fresh` aborts a fresh turn at its first delta, then runs one more turn. Two scenarios cited here are scratch additions to a copy of the runner, not in the repo: `restart-thinking` and `tree-thinking` (`restart-resume` and `tree-back` with thinking prompts). The ad hoc SDK probes cited here are not in the repo either. CC retries a 529 itself, even with `x-should-retry: false`, so pi never sees it (`injected-retry`). All of these, and the probes, are paid and must run outside the sandbox.

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

Both rows count full imports as residual breaks; the scanner leaves them out, so compare its boundary rate with the reuse figure. Since the content-based sync, `--since 2026-10-25` (to 2026-11-03) gives a boundary rate of 18/926 (1.9%). These figures pair per process (the log predates the tags). That window also has 32 prefix-writes; 9 of them cut a session at the same message as its previous prefix-write. All followed opening prompts holding `<task-notification>`, including pi-subagents' "Background agent group completed" messages, which CC never replays (fixed in `8e3b623e`), so start a gating window after that fix. Pairs exclude idle gaps over 5 minutes, effort, model and tool-set changes, and compaction. Nearly all of the September window is CC 2.1.141 or earlier. The July window predates the git-status fix, the September one spans it, and both predate the current session sync. Bin by CC version and date before comparing later runs, and compare against the nearest dated baseline, not against zero.

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

Numbered so `TODO.md` can refer to them.

Bridge behavior with a known cost:

- **C1. A changed tool set may not reach CC until a full import.** Reuse, forks and prefix-writes keep CC's `prompt_snapshot`, which holds the tools as well as the system prompt, and CC replays it on resume. A changed append takes a full import; a changed tool set does not, so CC may keep the old list. Inferred from the code. Fix: TODO #13.
- **C2. Replaced session files pile up, and a fork's saved tool results can expire.** A fork's kept records, and the tool results a write copies, point into an earlier session's `tool-results/`, which is no longer written, so CC's 30-day cleanup can delete it while the fork still refers to it. The expiry is inferred from the code. TODO: Deferred, "Superseded session files pile up".
- **C3. A changed system prompt append costs a full import.** The append holds the context files, skills and extension sections the bridge forwards. An extension that rewrites its section on every turn pays this on every turn, and so does a tool set that gains or loses pi's `read`, which adds or drops the skills block (`hasRead` in `src/index.ts`). TODO: Deferred, "Keep the cache when instructions change".
- **C4. A write does not reproduce CC's request between the cut and the first real difference.** The cut can sit before the first message pi changed, and a write rewrites everything after the cut from pi's form. That form differs from what CC sent: tool input `mapToolArgs` renamed or reparsed (CC-style names such as `file_path`, an `edits` JSON string); messages only CC has, such as the "No response requested." assistant CC inserts when it resumes a session that ends at a user message (#241's shape); and [context records](#context-records). Tool results pi holds unchanged are copied as CC recorded them. The read stops where the bytes first differ, and thinking blocks after that point are dropped. In every measured run the cut sat right before the edit, so this stretch was empty. Inferred from the code and `probe-writer.mjs`, not measured on a real gap.
- **C5. A prompt-capture failure fails the turn (#232).** On omp, `closestKnown` in `src/prompt-capture.ts` met a capture key that was not a string. omp answered each failed turn by compacting and retrying, a full cache write each time: 4.16M write tokens in 42 minutes in the report. Why the key was not a string is unknown; not seen on pi.

Caused elsewhere:

- **C6. pi-context-prune's default mode costs cache on every tool-using turn.** Its moving `<pruner-note>` changes the previous tool result on each delivery, so each sync cuts there. Users can turn it off with `remindUnprunedCount: false`.
- **C7. CC's resume reorders parallel tool results with the same timestamp.** The order is fixed per session file, so it costs one cache write. 2 of 417 CC-authored parallel groups tie ([audit-cache over real logs](#audit-cache-over-real-logs)).

Open questions:

- **C8. Are any remaining breaks the bridge's?** The 2026-10-25 to 11-03 figures in [Baselines](#baselines) pair per process, where a parent's requests interleave with its subagents', so some of those breaks may be pairing artifacts. Tagged logs start 2026-11-04: after a few days of use, run `node diag/audit-cache.mjs --since 2026-11-04` and compare the boundary rate with the in-query control. #241 reported a full rewrite right after a normally completed turn on 0.9.3, trigger unknown; on the current bridge a completed turn reuses the session, which a tagged log would confirm.
- **C9. How far back a prefix-write still reads to its cut.** The API looks back only about 20 content blocks from a cache marker (Anthropic's docs), so an edit far back may read only tools + system. `recent-redaction`'s edit was 6 messages back and read to the cut. README "Known issues" warns about this.
- **C10. Model and cwd changes** are full imports by code and not measured.
- **C11. Unexplained shortfalls.** The reuse after a prefix-write read 25 tokens short of what the write cached, in all three runs that measured it: `recent-redaction` 4944 of 4969, `hard-content-edit` 5797 of 5822, and a scratch run 34,713 of 34,738. Native reuses read everything, so something near the end of the written request changes on the next one; not investigated. A lead: in the two reruns (2026-11-04, 5803 of 5828 and 4895 of 4920) that reuse also reported the write's dropped thinking blocks again. Not reproduced: a short native continuation after a turn without thinking read 2654 instead of 2987 in an ad hoc SDK probe.
- **C12. Never sampled:** redacted thinking, CC's `<persisted-output>` form of large results, a mid-session effort change, the analyzer's rule that a single text block equals a string, and the `cc_prompt_index` and `cc_turn_index` billing-header fields that rewritten sessions lack.

Evidence: C1 `probe-prompt-recording.mjs`, `probe-session-fork.mjs`; C2 `probe-session-fork.mjs`, `chunk-hrmg67aa.js:573-597` (CC 2.1.293); C3 `reload-instructions` (2026-11-04); C4 `probe-writer.mjs` arms WRITER and WRITER-FIXED, `mapToolArgs` in `src/index.ts`, `chunk-a1cg2ptw.js:81516` (CC 2.1.308), #241; C5 #232; C6 pi-context-prune 2.1.0 trace; C7 capture-proxy runs (8 of 10 sessions with 10 parallel reads); C9 and C11 `recent-redaction` (2026-11-03); C11 `hard-content-edit` (2026-11-04); C12 `probe-writer.mjs` first-party rerun.
