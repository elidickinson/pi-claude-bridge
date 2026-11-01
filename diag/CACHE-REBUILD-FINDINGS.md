# Cache rebuild findings

What a bridge rebuild costs -- the prompt cache and, it turns out, the model's earlier thinking -- and how each point was established. The tools are described in [CACHE-TRACE.md](CACHE-TRACE.md).

Versions: Claude Code 2.1.293, Agent SDK 0.3.293, pi 1.3.0. CC 2.1.308 / SDK 0.3.308 are out; a source diff against 2.1.308 found the mechanisms used here unchanged, with one addition: 308 writes request-audit records (`api-request`, `api-request-shape`, `api-request-blob`; no uuid or parent) into session files by default, interleaved with the conversation. `diag/probe-session-fork.mjs` was re-run on 2.1.308: every fork case held as on 2.1.293 (reads equal to the ancestor, no thinking drops, prompt uuids adopted, `prompt_snapshot` copied, the same steer refusal and hidden partial assistant after an abort) with those records present. The rest has not been re-measured on 308. Models Haiku 5.5 unless marked; Opus 5.5, Fable 5.1 and Haiku 4.5 where noted. Medium effort throughout. All runs 2026-10-21, routed through the capture proxy without the first-party override the tooling now sets (see "The proxy is not neutral").

Claude Code source citations (`chunk-*.js:<line>`) refer to the deobfuscated Claude Code 2.1.293 npm binary. Chunk names are build-specific, so they only hold for that build. To regenerate: `npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.293` (the platform package ships the binary), extract its embedded JS with bun-demincer's `extract.mjs`, then run its `deobfuscate.mjs` with `--skip extract --skip extract-names --skip rename` (its rename stages corrupt the chunk layout).

## How we measure

- **Cache numbers** come from the API's usage report on each response (`cache_read_input_tokens`, `cache_creation_input_tokens` on `message_start`), recorded by `diag/capture-proxy.mjs`. The proxy changes what CC sends unless CC is told to treat it as first-party; see "The proxy is not neutral" below. The contract test in `tests/int-cc-contracts.mjs` compares only init tool names and first-request size, which match with or without that override, so it does not detect the difference.
- **What matters is where the read stops**, not the token count: "stops at the tools + system prompt" means the whole conversation missed, however long it is.
- **Thinking drops** are reported by the API in `input_transformations` -- but only when the request carries the beta `thinking-binding-controls-2026-08-01`. CC adds it itself on every thinking-enabled request to a first-party endpoint (CC source: `chunk-nwqfvmza.js:115334-115340`), so drops are reported in bridge production. Behind the proxy without the first-party override CC does not send it, so in these runs the lifecycle runner and the probes marked "binding beta on" added it via `ANTHROPIC_BETAS`.
- **Lifecycle runs** are `diag/lifecycle-runner.mjs` scenarios, cited below by scenario name (with `--turns N` where extra history was added first). They drive real pi, the bridge and Claude Code; the bridge's trace also copies CC's session file before a rebuild deletes it (the "pre-delete snapshot" below), and `diag/analyze-trace.mjs` checks every request boundary.
- **Mutation probes** (`diag/probe-cache-mutations.mjs`) create a native CC session, warm the cache, then for one change to the session file send the same continuation from the unchanged file (control) and the changed file, with the bridge's CC settings. Results marked "both orders" ran one case per invocation (`--cases`) on a fresh seed, once with each `--order`.
- **Ad hoc SDK probes** are scratch scripts, not in the repo, that drive the Agent SDK directly with the bridge's provider options through the capture proxy.
- **Attribution gate**: a probe result counts only if the request difference between the arms is the targeted change and nothing else -- same model, tools, system, thinking settings, top-level body fields, auth and betas.
- **Independent sweeps** of all captured data by two reviewer agents (Opus 5.5, qwen3.8-flash) looked for anything the analyzer does not surface; their points below were checked against the captured data.

## What we know

### 1. Every rebuild loses the whole cached conversation

A rebuild changes the request from its first message, so the cache read stops at the tools + system prompt and everything after misses. Loss grows with the conversation; the read point does not move.

| Scenario | Model | Rebuild | Messages | Ancestor cached | Read | Lost |
|---|---|---|---|---|---|---|
| `noop-rebuild` | Haiku 5.5 | forced no-op, same id | 11 | 4384 | 3500 | 884 |
| `noop-rebuild --turns 4` | Haiku 5.5 | forced no-op, same id | 35 | 5064 | 3500 | 1564 |
| `noop-rebuild --turns 10` | Haiku 5.5 | forced no-op, same id | 71 | 6084 | 3500 | 2584 |
| `restart-resume --turns 10` | Haiku 5.5 | after restart, new id | 71 | 6077 | 3500 | 2577 |
| `injected-error --turns 10` | Haiku 5.5 | after API error, new id | 71 | 5978 | 3500 | 2478 |
| `tree-back` | Haiku 5.5 | after `/tree`, same id | 5 | 4216 | 3500 | 716 |
| `abort-continuation` | Haiku 5.5 | after abort, new id | 5 | 4313 | 3500 | 813 |
| `noop-rebuild` | Opus 5.5 | forced no-op, same id | 11 | 3606 | 2720 | 886 |
| `noop-rebuild` | Fable 5.1 | forced no-op, same id | 11 | 5474 | 4579 | 895 |
| `noop-rebuild` | Haiku 4.5 | forced no-op, same id | 7 | 5536 | 4189 | 1347 |

How we know: in every case the analyzer reports the first changed element as message 0, all differences inside the ancestor's cached region, the ancestor seconds old (TTL 1h), and the read equal to a fresh session's first request (tools + system only; that amount differs by model because each model gets a different system prompt). "Forced no-op" means pi's history was unchanged; the rebuild was triggered through the bridge's own rebuild hook.

### 2. The cache cause: Claude Code's context attachment records, which a rebuild does not write

Claude Code stores context as attachment records in its session file and sends each one's stored `rendered` text with its `renderedRole`. The bridge's rebuild carries only `file` attachments (`src/attachments.ts`), so the rest vanish. On Haiku 5.5, Opus 5.5 and Fable 5.1 the layout is the same:

- `session_context` (account context, including the user's email) as a reminder block in the first user message;
- environment, model, the `total_tokens` countdown and date together in one system-role message right after it;
- a `<total_tokens>` countdown system message **after every tool result and every later prompt**, each from its own record. In `noop-rebuild`, the last request before the rebuild carried them as messages 4, 7 and 10, from records 14, 21 and 24 of the pre-delete snapshot. Rebuilds lose two messages per turn (35 -> 27 messages at `--turns 4`, 71 -> 51 at `--turns 10`).

Haiku 4.5 folds the same records into user content and into the tool result as a second block (which is also where CC's extra `"\n"` on tool-result text comes from).

Probe evidence (`diag/probe-cache-mutations.mjs`, fresh seed per case, run in both orders, which agree):

| Case | Change to the session file | Read | Gate |
|---|---|---|---|
| `drop-attachment-session_context` | drop `session_context` | 2222 (tools + system) | valid, loss |
| `drop-attachment-environment` | drop `environment` | 2512 (through first user message) | valid, loss |
| `tool-result-content-shape` | tool_result content array <-> string | full | valid, neutral* |
| `tool-result-key-order` | tool_result key order | full | valid, neutral* |
| `rotate-session-id` | same records under a new session id | full | valid, neutral |

\* Only when no thinking block follows the tool result: this seed had none. In the writer probe (section 11) the same differences ahead of a thinking block cost the cache read through that block, though the thinking itself was kept.

A single-seed run of the drop and tool-result cases dropped each type alone: environment, model, date and the first countdown each gave the same 2512 read (they share one message, so their individual costs cannot be separated). The probe seed had one tool call, so it did not show the per-turn countdowns; the lifecycle snapshots do.

### 3. What a rebuilt request looks like instead

- CC adds fresh context **after the new prompt**, not in the old place (the environment message moves from index 1 to the tail, byte-identical text but without its cache marker).
- Index 1 is left as an **empty system message** carrying only `output_config: {effort}` -- on every rebuild, every model. Effort placement comes from per-turn effort fields on CC's assistant records, which the bridge does not write.

How we know: the rebuilt request bodies in the lifecycle captures (e.g. the rebuilt request in `noop-rebuild`), and both sweeps' passes over all captured bodies.

### 4. `rendered` is what CC sends; `prompt_snapshot` is the system prompt

`prompt_snapshot` holds the system prompt parts, tools and wire-shape flags (`systemTurns`, `reminderFold`, ...), not the context text. A session carries two: a short first one and a fuller later one. When present, CC replays its system prompt and tool descriptions (CC source: `chunk-q4w8aqm9.js`, the `from_snapshot` path). Dropping it was cache-neutral with an unchanged prompt (single-seed mutation run, `drop-attachment-prompt_snapshot`). Copying it into a rebuild would freeze the system prompt and tools -- today a rebuild is how a changed append reaches the model. This is the known `systemPrompt.snapshot` issue, measured with `diag/probe-prompt-recording.mjs`: on REUSE, CC resends its recording and ignores the bridge's new append unless `snapshot: false` is set. Any fix that keeps CC's records must decide this deliberately rather than inherit it.

Editing a record's `attachment.date` or countdown value changed nothing on the wire because `rendered` was untouched. With the stored date older than today, CC appended "The date has changed. Today's date is now ..." at the *end* of the request (`edit-attachment-date` case), so a native session resumed on a later day keeps its prefix.

### 5. A rebuild also makes the API discard all earlier thinking

The bridge sends thinking blocks back byte-identical -- same text, same signature (pi stores it as `thinkingSignature`). But the API binds each thinking block to the context it was produced in, and a rebuild changes that context:

- **Measured (Haiku 5.5, beta on, `thinking-rebuild`):** REUSE requests reported no drops; the rebuilt request reported `thinking_dropped / prefix_binding_mismatch` for both thinking blocks.
- **Measured (Opus 5.5, Fable 5.1, `thinking-rebuild` with the first-party override, so CC sent the beta itself):** the rebuilt request reported `thinking_dropped / prefix_binding_mismatch` for every earlier block (2 of 2 on Opus, 1 of 1 on Fable), and its read stopped at tools + system. Opus REUSE requests carrying a block reported no drops; Fable thought only on the turn before the rebuild, so its REUSE with thinking is untested.
- **Real sessions:** 92 `thinking_drop` records with reason `prefix_mismatch` in provider-path sessions under `~/.claude/projects`, all in sessions the bridge rebuilt.

So a rebuild silently removes the model's earlier reasoning, even once the cache has expired. That makes it a correctness issue, not just cost.

### 6. Three of five rebuild triggers have nothing to copy from

After an abort, an API error or a restart, the bridge has no mirror (`rebuild / no-mirror`, `ccSessionBefore: null`), so it starts a new CC session and takes no snapshot. The old CC file is still on disk, orphaned. pi's session holds no CC session id. Only no-op, `/tree` and compaction rebuilds have the replaced session at hand.

### 7. Countdown values can be computed from pi's data

Value = 15,000,000 - (total tokens of the latest request - total of the last request before the turn's prompt), totals from pi's stored usage; it resets at each prompt. Matched all 10 lifecycle snapshots on Haiku 4.5 and 5.5. A possible fallback when no native file exists, though the 15M budget is server-configured, so copying records is sturdier.

### 8. Records a rebuild cannot regenerate, and records it must not carry forward

- **Only copying reproduces** (seen in real sessions, not in the lifecycle runs): `silent_turn_reminder`, `queued_command` (how CC stores steers -- a rebuild writes them as user text instead), `instructions`. Fable adds `batching_reminder_sent`, a per-turn reminder CC removes itself in the next request, after the cache marker. That removal is proxy-only behavior: in production CC keeps such reminders as records (`clearAt: "next_user_message"`, beta `mid-conversation-system-clear-at-2026-08-21`; CC source, gated on the raw base-URL check, not fixed by the override below).
- **Must not be copied forward:** an aborted reply's longer text and `[Request interrupted by user]`; `isApiErrorMessage` records; anything past a `/tree` branch point; message content after a redaction or compaction (it must come from pi); the `model` attachment and `prompt_snapshot` after a model, tool or prompt change.

### 9. Claude Code stores some tool results differently from pi, and a rebuild sends pi's version

From the `hard-content-rebuild` scenario (Haiku 5.5, one run of seven requests):

- **Oversized output** (59,887 characters; CC saves only above 50,000 characters or the MCP token limit): CC counted it with a `count_tokens` request, saved the full text to the session's `tool-results/` directory, and sent the model a 1,369-character reference ("exceeds maximum allowed tokens. Output has been saved to ..."). The model then read the file with pi's `read` tool. pi stores the full output, so the rebuild sent all of it: the rebuilt request wrote 30,943 cache tokens, and the model now sees content it never saw before.
- **Images**: CC saves the PNG to `tool-results/` and sends the image plus a text block `[Image: source: <path>]`. The image bytes survive a rebuild; the text block does not.
- **Error results** (`is_error`) survive a rebuild unchanged apart from key order (cache-neutral).
- **The saved files are lost on an in-place rebuild** (inferred from code): `deleteSession` removes the whole session directory, including `tool-results/`, while the history still points into it (including the path in the model's `read` call). The trace's snapshot did capture them.
- **The thinking loss persists**: the rebuilt request and the next one both reported both earlier thinking blocks dropped; thinking produced after the rebuild was kept.

So for tool results CC rewrote, pi's content is not the content the model saw. Taking it breaks the prefix and changes the conversation.

### 10. Other bridge behavior found along the way

- **#203: pi stores tool arguments CC never sent.** The bridge's `mapToolArgs` adds `timeout: 120` to `bash` calls when mapping them for pi (`src/index.ts:972-975`; pi's bash tool has no default), so pi's stored call differs from CC's. A rebuild writes it, which breaks the prefix at that call independently of the attachments -- and, with thinking binding, would drop every thinking block after the first `bash` call.
- **Same-length in-process context changes never reach Claude Code** (`redaction` scenario). An extension's `context` transform that redacts text without changing the message count gets REUSE (the bridge compares lengths only), and CC keeps the original text (Haiku 4.5 and 5.5).
- **CC retries a 529 itself**, even with `x-should-retry: false`; pi never sees it (`injected-retry`). A non-retryable error drops the bridge's mirror, so the next turn rebuilds.
- **Steers** arrive inside the tool result on Haiku 4.5 and as a system message after the tool results on 5.5. Code-word steers ("mention PAPAYA", "end with PINEAPPLE") are sometimes refused as prompt injection (Haiku 4.5 in `steer-parallel`, Haiku 5.5 in an ad hoc SDK fork probe). Natural on-topic steers (a corrected order number, an extra order to check) were obeyed 12/12 on Haiku 4.5 and 5.5 from the same placements (ad hoc SDK steer probe), so the content, not the placement, triggers refusal. Steer tests should assert transport, or use on-topic steers.
- **#199/#200**: before the fix, aborting a run that continued a parked query let the request stream to completion; after it, the request is cut off upstream (`abort-continuation`, run with `--bridge` on a checkout from before the fix and on one with it).

## What a fix must preserve

To keep both the cache and the model's thinking, a rebuild has to reproduce the request Claude Code would have sent, up to each thinking block:

1. every attachment record of the replaced session, in its original position, copied verbatim with `rendered`/`renderedRole` -- the first-turn bundle and every per-turn countdown;
2. message content from pi only where pi actually changed it (redaction, compaction, `/tree`); otherwise CC's stored content -- including tool results CC replaced with a file reference or annotated (section 9), tool results in CC's shape (text-block array, CC's key order), and the tool input CC actually sent (#203; section 11 measured it dropping thinking);
3. no `prompt_snapshot` when the prompt, model or tools changed (it would freeze them), and none of the must-not-copy records above;
4. the session's `tool-results/` files, which an in-place rebuild currently deletes;
5. a way to find the replaced session after an abort, error or restart -- e.g. persist the CC session id in pi's session -- or those triggers stay uncovered.

The record set is the same on Haiku 5.5, Opus 5.5 and Fable 5.1, so copying records covers all three; Haiku 4.5's different layout comes from the same records.

### 11. A writer can reproduce Claude Code's request exactly, but only with CC's message details too

`diag/probe-writer.mjs` (Haiku 5.5, binding beta on): a 6-request native session with 3 thinking blocks, then one resume per arm from a rewritten session file. CONTROL (the native file) reproduced production, so the arms count. WRITER-FIXED is the script's WRITER-FIXED arm (`rebuildRecords` with `nativeToolDetails`). A rerun in first-party mode (CC sending the beta itself) matched every arm's read stop and drop count; reads were higher by the larger first-party tools + system prefix (3816 vs 3724), and WRITER-FIXED's tools, system and messages were byte-identical to CONTROL's, differing only in the session id, `diagnostics.previous_message_id` and billing-header fields, none of which cost cache (read 5672, 0 written).

| Arm | Read | Read stops at | Thinking dropped |
|---|---|---|---|
| CONTROL (native file) | 5375 | whole conversation | 0/3 |
| BRIDGE (today's rebuild) | 3724 | tools + system | 3/3 |
| WRITER (pi's messages + CC's attachments) | 4470 | msgs 0-4 | 2/3 |
| PREFIX (CC's records to end of turn 2, pi's after) | 5027 | last cache point before the cut | 1/3, the one after the cut |
| WRITER-FIXED (WRITER + CC's tool_result shape + CC's tool input) | 5558 | whole request (byte-identical to CONTROL's) | 0/3 |

WRITER's layout of attachments was right; only two message details differed from CONTROL: tool_result blocks (pi converts them to a string with a different key order) and a `bash` call carrying pi's stored `timeout: 120` (#203). The `timeout` difference dropped the two thinking blocks after it. The tool_result shape did not drop thinking but did end the cache read at the next thinking block (see the footnote under section 2).

The writer (`diag/lib/session-writer.mjs`) matches CC's message records to pi's by content (tool ids, thinking signatures, text) and anchors each attachment on its parent chain, throwing on anything ambiguous. That matching is the complicated part, and it fails exactly where pi's history was edited -- the cases a rebuild exists for. PREFIX, by contrast, kept the cache and thinking up to its cut with no matching beyond finding the cut.

Not covered: mid-session effort changes, steers (`queued_command`), a changed append, error/image/empty tool results in the writer.

## Keeping CC's records up to the first difference

Two measurements support keeping Claude Code's own session records untouched up to the first point where they differ from pi's history, and writing pi's version only after it. The writer probe's PREFIX arm (section 11) kept the cache and thinking up to its cut, with no matching beyond finding the cut. The SDK can already cut a session at a record and resume it (below), and every fork measured read back the cache up to the cut with no thinking drops, including after an abort and after a large saved tool result. Past the cut both were lost, as in any rebuild, so re-creating CC's attachments there gains nothing; CC re-adds fresh context at the tail itself (section 3). Section 11 also shows what must count as "no difference": tool_result shape and #203's `timeout` are pi-side conversion artifacts, not edits, and cutting at them would discard cache and thinking for nothing.

### The SDK already does the truncating case

An SDK probe (Haiku 5.5, binding beta on, 8 requests): a two-turn native session, then resumes. Every request reported no thinking drops. `diag/probe-session-fork.mjs` (its store-seed cases) reproduces these in first-party mode: each read equal to its ancestor (3538 and 3244, higher by the larger first-party prefix), no drops.

| Resume | Read | Expected | Thinking sent / dropped |
|---|---|---|---|
| plain (control) | 3287 | 3287 (end of turn 2) | 2 / 0 |
| `resumeSessionAt` = turn 1's last entry + `forkSession` + `resumeDropsTurn` = turn 2's prompt | 3005 | 3005 (end of turn 1) | 1 / 0 |
| `sessionStore`, `load()` = recorded entries unchanged | 3287 | 3287 | 2 / 0 |
| `sessionStore`, `load()` cut after turn 1 | 3005 | 3005 | 1 / 0 |

A second probe, now `diag/probe-session-fork.mjs`'s steer-seed cases, forked sessions after harder events; its first-party rerun matched every row (reads 3680, 3680, 4546, 3277, each equal to its ancestor). Every fork read the ancestor's cached total with no thinking drops (one sample each), and its body matched the ancestor up to the cut except `metadata.session_id` and the moved cache marker:

| Fork | Read = ancestor |
|---|---|
| after an abort mid-text, cut at the previous turn's end | 3541 |
| right after an abort mid-tool (~200 ms after `close()`) | 3541 |
| after a 93,599-character tool result CC saved to `tool-results/` | 4599 |
| two turns back, dropping a steer | 3141 |

- **`resumeSessionAt`** slices CC's chain in memory at any record id (CC source: `chunk-0z76cjt8.js:29029-29061`). With the `forkSession` option the kept records are re-recorded with the same uuids into a new file and the old file is untouched (measured), so the old directory's `tool-results/` stay where the history points. A uuid not on CC's chain is a hard error. It only truncates; it cannot substitute pi's content.
- **What a fork leaves out and keeps:** an abort leaves CC's longer text, or its own "user doesn't want to proceed" tool result, plus an interrupt marker; none of it appears in a fork cut before it. Forks copy both `prompt_snapshot` records from the kept range (section 4).
- **`resumeDropsTurn`** (CC source: `chunk-0z76cjt8.js:2016-2075`) refuses the cut if the dropped range holds anything but that one turn. It refused with a steer in the range, including a steer pi saw.
- **Uuids line up:** the uuids on streamed SDK assistant and tool-result messages equal the file's, so the bridge can map pi messages to CC records as they stream. CC uses a prompt uuid supplied via `SDKUserMessage.uuid` as the record's uuid, including for the next prompt after a fork cut at an aborted prompt.
- **`sessionStore`** (alpha) mirrored all 30 records byte-identical to CC's file, in order, flushed at each `result` and at exit; `load()` output is resumed by CC's normal code. But a store-backed resume runs in a temp config dir (credentials copied with the refresh token removed, plugins and the rest of `~/.claude` absent) that is deleted on exit, taking new `tool-results/` files with it, and CC's own record removals are not mirrored. Not suitable for every turn. Untested: `load()` returning null makes the store a pure observer of the native file.
- **`getSessionMessages`** returns message records with uuids but no attachments; its leaf choice can differ from CC's in a branched file (inferred). The `forkSession()` *function* (as opposed to the option) assigns new uuids and edits records -- avoid.
- **Abort before any complete assistant message:** aborted at the reply's first text delta, CC still wrote a partial assistant record (no stop reason) that no complete SDK message showed, and no streamed partial event carried its uuid (`probe-session-fork.mjs`, `abort-at-first-delta`; the mid-text abort agrees over 37 stream events). A session tracker that only learns uuids from complete messages cannot see that record.
- **Not exercised:** resume at a cut without fork, a pi append.

### Switching Claude Code's additions off does not remove the need

From CC source only; not checked live. `session_context` and the date come from CC's context-announcement path and are re-emitted whenever missing; environment and model are removed only by `--bare`, which disables OAuth; `client_composed: true` defers the turn-start pass rather than skipping it (the SDK doc's "skipped as a whole" looks stale for 2.1.293). One switch does work in the source: `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off` (env or setting, ahead of the server-side flag) removes every countdown, including the one in the system prompt. It would shrink what a writer must reproduce to the fixed first-turn bundle, but adds little if CC's records are kept, since the countdown records are kept with them. The model would lose only a padded 15M budget, not real context-window information; environment, date and session_context are its only source for cwd, platform, model id and today's date, since pi's projected prompt does not carry them.

## The proxy is not neutral

Setting `ANTHROPIC_BASE_URL` to the capture proxy makes CC treat the connection as not first-party (CC source: `chunk-fsnz81vy.js:1263-1289`). From a source audit, an ad hoc SDK model-switch probe, and a rerun of `noop-rebuild` and `thinking-rebuild` with the override set:

| Behavior | Behind the proxy | Bridge production | Fixed by `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` |
|---|---|---|---|
| `thinking-binding-controls` beta | not sent | sent on thinking-enabled requests | yes |
| thinking from another model | stripped by CC | sent (the API drops it, `model_binding_mismatch`) | yes |
| per-turn reminders (batching etc.) | removed next request | kept as records, extra beta | no |
| tool search | off | on by default (`tst`): a `DeferredToolPlaceholder` tool with `defer_loading`; none of the bridge's 10 MCP tools deferred (measured) | yes |
| billing header fields in `system[0]` | static | per-request (`cch`, `cc_prev_req`, `cc_prompt_id`, ...) | yes (measured) |
| system prompt | 3 blocks | 4: the main block split in two, the first part `scope: "global"` (joined, byte-identical) | yes (measured) |
| `cache-diagnosis-2026-04-07` beta | absent | present | yes (measured) |
| top-level `diagnostics` field | absent | `{previous_message_id}`, different every request | yes (measured) |
| request gzip, some headers | off | on | partly |

The bridge sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (`src/index.ts:2500`), which turns off GrowthBook, so production uses each flag's built-in default. Probes that launch CC directly without it read cached flags from `~/.claude.json` instead.

Effect on the findings: the rerun with the override (Haiku 5.5, 14 requests) reproduced sections 1 and 5 -- the rebuild read stopped at tools + system (3816, the new size of that prefix), the first change was message 0, REUSE read in full, and the rebuild dropped both earlier thinking blocks with `prefix_binding_mismatch`. REUSE read in full although the billing header and `diagnostics` change on every request, so neither is part of the cached prefix. Sections 2-4 and 6-11 are unlikely to change: the differences are produced by CC itself, identically in every arm. Section 8's Fable reminder removal is a proxy artifact.

The tooling now sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` wherever CC is routed through the proxy: `src/cache-trace.ts` for traced bridge runs, and `diag/lib/first-party.mjs` (which also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) for the probes and the runner's `--bridge` mode. Every run in this document was made without it. `diag/analyze-trace.mjs` ignores a `diagnostics` change in `previous_message_id` alone. Still open: extending the proxy contract test to compare the beta set, masked `system[0]` and a second-turn body. Kept reminders still differ; CC 2.1.308 records each API request in the session file by default (`api-request` records), which would let a native run without the proxy show the production request shape.

## Ruled out, and why

| Possible confounder | Why it is not the explanation |
|---|---|
| Thinking off in the probe | The probe runs at medium effort, with thinking on |
| One model only | Same loss and layout on Haiku 5.5, Opus 5.5, Fable 5.1 |
| Cross-arm cache pollution / arm order | Fresh seed per case, both orders agree |
| Retries warming the cache | Cache measured on a call's first attempt that reached the model; retry bodies byte-identical |
| Config or header drift | Top-level body fields, auth and betas compared on every boundary |
| Proxy changing CC's behavior | **Not ruled out in general**; see "The proxy is not neutral". The cache and rebuild findings are unlikely to be affected (the differences are CC-generated and identical across arms). |
| Cache expiry or breakpoint placement | Ancestor seconds old; every request has one message marker, on the last message; all writes 1h |
| New session id (`metadata`) | Measured neutral |
| Seed cached nothing | Reported as inconclusive, never as neutral |
| Billing header | Excluded from comparison. In first-party mode it changes every request and REUSE still reads in full (measured), so it is not part of the cached prefix |
| Hidden side requests | None besides compaction's isolated summary calls |

## Not established

- **Billing-header fields missing from rewritten sessions**: in first-party mode, every rewritten `probe-writer` arm's billing header (`system[0]`) lacks the `cc_prompt_index` and `cc_turn_index` fields CONTROL's has. Probably derived from per-turn fields on CC's native records that converted records don't carry (unchecked). No cache effect measured: WRITER-FIXED read in full without them.
- **Resume after restart with a persisted CC id**: if the read stays warm, restart loss is a missing pointer, not a rebuild problem. Needs a bridge change.
- **Fable's own reminder removal** might trigger thinking drops, for thinking produced right after it. A Fable run with the beta had its only thinking block right after a `batching_reminder_sent` and then a rebuild, so the two causes could not be separated; production keeps those reminders anyway (section 8).
- **Content never sampled**: redacted thinking; CC's `<persisted-output>` form of large results (only the MCP large-result path was exercised).
- **Mid-session effort change.**
- **Message-level single text block vs string** (an analyzer normalization rule): no clean test -- CC merged the block in the probe.
- **Probe vs production**: pi's appended system prompt and the streamed prompt are not reproduced in the probe (the lifecycle runs do go through the bridge).

Not worth running: more seeds or arm orders, longer conversations, Haiku 4.5 replications, session-id rotation, 5m TTL (never used), retry bodies.
