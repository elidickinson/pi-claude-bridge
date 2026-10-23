# Plan: session sync by content digests, keeping Claude Code's records up to the first difference

Status: completed and validated. Issue #222; branch `222-cc-session-sync`, which already carries the diagnostic tooling (cache trace, capture proxy, lifecycle runner, probes) and runs SDK 0.3.308 / Claude Code 2.1.308. Measurements in `diag/CACHE-REBUILD-FINDINGS.md`; fork behavior is reproduced by `diag/probe-session-fork.mjs`. Also uses a pi-context-prune trace (`/tmp/prune-trace/`), a model-switch probe (`/tmp/model-switch-probe/`), a request-replay probe (`/tmp/replay-probe/attempt-1/`), source checks (`/tmp/plan-source-checks/`), and reviews by gpt-6-luna, qwen3.8-flash and gpt-6.1-sol (the last with a pass over related GitHub issues and PRs). Measured on Claude Code 2.1.293; the fork cases were re-run on 2.1.308 with the same results. #222 maps every related issue and PR to what fixes it; the rest of PR #136 is dispositioned in `eli/pr-triage.md` (gitignored).

## Before starting

- **Preserve the #181 immutability guards.** Finished tool-call messages must not be mutated by late abort/error cleanup: digests are taken when the bridge emits a message, so a later mutation reads as a difference.
- **Use the existing #173 steering mechanism.** It fixes #172 by keeping stdin open for queued steering and enables `--replay-user-messages`; its acknowledgement is what steer slots rely on (see Recording). A stdin write alone is not proof of consumption.
- **Claude Code 2.1.308 request-audit records.** CC 2.1.308 writes `api-request`, `api-request-shape` and `api-request-blob` records (no uuid or parent) into session files by default. The bridge now turns them off (`CLAUDE_CODE_ELEGANT_MEADOW=0` in `CC_CHILD_ENV`), but files written by earlier bridge versions, and by probes that run CC directly, still contain them. Anything that reads CC's chain or scans session files by content must skip them. CC never reads them back to build a request (source, 2.1.308).
- **Edits to CC's records reach the model** on plain resume and on fork in 2.1.308 (measured, `/tmp/replay-probe/attempt-1/`: a marker edited in the conversation records was sent, not the audit copy). Row 7's copied records are what CC sends.
- The build is staged below ("Phases") for testing, but it ships as one change; nothing is deferred.

## Why

The bridge mirrors each pi session's conversation into a Claude Code session file and resumes it each turn. Two things go wrong.

**The reuse decision is a message count.** `priorMessages.length >= cursor` plus "nothing unseen past the cursor"; content is never compared. That fails four ways, all real:

1. **A rewritten or removed message at the same count never reaches CC** (#77, #182). A context hook that redacts or replaces text leaves CC holding the original, riding the warm cache. `[recall1, user1]` and `[user1, assistant1]` have the same count.
2. **A pruned history answers with no history at all** (#30). When a session's own history shrinks below its cursor with no rewrite mark, sync takes the "clean start" path and runs the turn with zero prior context, every later turn too.
3. **Any future writer of the cursor can silently desync the session.** The only guard is a comment.
4. **An in-place rebuild can corrupt a file a parked query still appends to.** CC appends by path and recreates a missing file, so `deleteSession` + `createSession(sameId)` under a live CC process lets it append records whose parents point into the dead chain.

**Every rebuild throws away CC's records.** It deletes CC's file and writes pi's history in its place. That loses the whole cached conversation and makes the API discard every earlier thinking block (findings 1, 5), because CC's own records (context attachments, countdowns, CC's form of tool results) are not in pi's history and cannot be regenerated faithfully (findings 2, 9, 11). Three of the five rebuild triggers (abort, API error, restart) rebuild only because the bridge lost track of the CC session (finding 6).

The fix: decide by content, and on a difference keep CC's records up to it rather than replacing them. The SDK already supports most of this: `resumeSessionAt` + `forkSession` resumes a session cut at any record, re-recording the kept records with their original uuids in a new file, and the cache read and thinking survive exactly up to the cut (measured).

## Design

### Digests

Hash each pi message before the current user turn, in pi's own values (what `convertPiMessages` would replay):

- `user`: text, image data; `assistant`: text blocks, tool calls (id, name, arguments), bridge-minted thinking including signature; `toolResult`: tool id, error flag, text and image content;
- excluded: timestamps, usage, cost, stop reasons, provider metadata -- what conversion discards, so a metadata-only re-render never changes a digest;
- blocks conversion drops (thinking from another provider, unsupported types) are not hashed, except for their effect on whether conversion omits the whole message or emits a placeholder. Hash that disposition too: an assistant with `content: []` is omitted, while `[{type: "text", text: ""}]` becomes `[incompatible content omitted]`, so their digests must differ;
- tool names as pi reports them, not SDK-mapped: the provider path and AskClaude pass opposite `customToolNameToSdk` shapes;
- one digest per message (`string[]`), not a rolling hash, so covered length is the array length and a log can name the first differing index;
- fields are streamed into the hash, not joined into one JSON string (base64 images would be copied several times), and the tool id goes through the same stable stringify as everything else (raw interpolation lets an id containing a newline forge a boundary).

Comparing digests compares pi's history now with pi's history as CC received it -- never pi's content with CC's -- so CC's tool-result form, #203's `timeout`, attachments and split assistant records need no tolerance rules.

### State per pi session

```ts
interface SessionState {
  ccSessionId: string;
  cwd: string;
  model: string;       // the cliModel CC last ran this session with
  digests: string[];         // one per covered pi message, including intentional import omissions
  uuids: (string | null)[];  // recorded/resolved CC boundary; null for an intentional import omission
  cuttable: boolean[];       // a cut may follow this slot (see "Valid cuts")
  dirtyTail: boolean;        // CC's chain may extend past the recorded pi prefix
}
```

All three arrays are required, have equal lengths, and are built together by one helper from one recording/import mapping. The compare site throws if any is absent or their lengths differ. Non-null uuids must be nonempty, and a null uuid requires `cuttable = false`; every cuttable slot must have a real uuid. Null is not a substitute for an unknown live record. No fallback to a length check.

`cursor`, `latestCursor`, `needsRebuild` and `forceRotate` go away. `dirtyTail` replaces the last two: once nothing is deleted in place, "CC's file may have records past what we recorded" is the only thing they protected against.

### Recording: where digests and uuids come from

Each slot pairs a digest from pi's side with a CC boundary from the live stream or the actual import write. Streamed SDK message uuids equal the file's (measured). Covered slots form a contiguous pi prefix: an unrecorded live message leaves a gap, so later acknowledgements cannot advance coverage past it. An intentional import omission is different: the bridge knows exactly what it wrote, so the omitted message keeps its digest slot with a null uuid and is non-cuttable.

| pi message | digest from | uuid from |
|---|---|---|
| prompt | the context at query start | the bridge supplies `SDKUserMessage.uuid`; CC uses it as the record uuid (measured). Record the slot only after CC replay-acknowledges that uuid, not when the SDK pulls stdin. The bridge joins the trailing run of pi user messages into one prompt (`turnStart`, `src/index.ts:409`), so they share one record: each gets that uuid, and only the last is cuttable. A cut that lands on a prompt slot resolves, from CC's file at decision time, to the last record of the prompt's attachment run (its `@file` expansions and countdown chain off it); cutting at the countdown was measured accepted |
| assistant step | the message the bridge itself emitted (`turnOutput`), hashed at `done` | last streamed `SDKAssistantMessage` of that step |
| tool result | the context at delivery | that result's streamed tool-result `SDKUserMessage`; cuttable only once no tool call of its batch is still outstanding; CC writes one record per result, including parallel results (three results, three records and uuids in `tests/fixtures/sdk-streams/parallel-tools.jsonl`; pin it) |
| steer | the context at delivery | recorded only once CC acknowledges consuming it: with `--replay-user-messages`, CC echoes an absorbed steer with its uuid (the #173 mechanism tests absorbed and still-queued mixtures). A failed or aborted query can leave a submitted steer unconsumed, so a write alone proves nothing. CC stores a mid-turn steer as a `queued_command` attachment whose `source_uuid` is the bridge-supplied uuid; a steer consumed in a later turn has a direct user record with that uuid (both measured). Resolve either form from CC's file when a cut lands on it. An unacknowledged steer gets no slot |
| assistant whose content is not fully covered by complete `SDKAssistantMessage`s (aborted mid-block, or an immediate failure) | -- | no slot. CC can write a hidden partial assistant, and no stream event carries its uuid (measured, `abort-at-first-delta`). With no slot, the next sync finds the difference there and writes pi's version (row 7) |

- **Imported priors use the actual write mapping, not the live-message table.** Preserve pi indexes through conversion, `repairWithOrigin`, and record emission. Conversion merges parallel results and moves interleaved steers; repair can drop unmatched results or add synthetic records; a converted message can write more than one record. The bridge's import helper must return the resulting slot/boundary mapping alongside the records it writes. `importMessages` currently returns no uuids, so do not infer a one-to-one mapping from message or record counts.
- **Intentional omissions keep slots.** Empty assistants, and results that repair drops without a corresponding record, keep their digest with a null uuid and `cuttable = false`. Synthetic records have no independent pi slot but must be included in the boundaries of the prefixes they belong to. Consecutive or leading omissions are valid; later real slots can still be cuttable. If conversion and repair emit no records, `save()` creates no transcript: start a new CC session without resume, retain those slots in the query's recording, and commit state only under the normal progress/completion rules.
- The assistant row closes the old trailing-assistant gap: pi appends CC's final reply only after the provider call returns, but pi stores the bridge's own `turnOutput` object (not a copy) and adds only metadata (`durationMs`, `thinkingLevel`), so its digest and uuid are both known at completion (verified, `agent-loop.ts:457`, `agent.ts:587`; 223 stored assistants matched later provider inputs byte for byte across the lifecycle traces). No message is accepted on trust; if pi's copy differs later, that is a difference.
- Hash at `done`, not later: pi's `edit` tool rewrites the stored message's `edits` argument in place when it arrives as a JSON string or a single object (`coding-agent/src/core/tools/edit.ts:116-122`), after the session file is written. `mapToolArgs` gains the same normalization (`edits` string or single object -> array) when mapping CC's call, so pi's rewrite is a no-op and memory, file and digest agree. pi's legacy `oldText`/`newText` path returns a new object and leaves the stored message alone. Other extension tools with a mutating `prepareArguments`, or `message_end` handlers that replace a message, produce a difference (cost only).
- Assistant messages the bridge never emitted (pi's `handleRunFailure` placeholder, a provider setup error, another provider's turn) get no slot; the next sync takes row 7 from there.
- A steer that never reached CC, or never was consumed, gets no slot, so the next sync sees a difference there. That replaces `missedSteer`.
- **Replay acknowledges consumption, not an immediate disk flush.** Initial prompts and steers use replay acknowledgements. The installed SDK's interrupt/close writes an acknowledged initial prompt before the real child exits (pinned by a native contract); cuts wait for that exit whenever the writer is stopping.
- **Live slots retain their own UUID anchors.** Resolve a cut across every non-null anchor in the retained pi prefix, taking the furthest actual transcript position before extending its attachment run. Replay/result arrival order is not disk order.
- **Cuts resolve to the end of a slot's attachment run.** For prompts and tool results alike, a cut resolves from CC's file to the last record of the attachment run after the slot's record (countdowns, `@file` expansions, reminders), stopping before the next message or `queued_command`. PR #159 has this helper (`toolResultCutIn`, with transcript-flush waits).
- The recording tap runs on every `user`/`assistant` SDK message before `consumeQuery`'s live-stream guard (`src/index.ts:1598`); today the `user` case is a no-op below it.
- The end of a turn is the last streamed assistant uuid. After a turn with no tool call CC writes a `prompt_snapshot` after it that the stream doesn't show; cutting at the assistant or at the snapshot gave identical requests (measured).
- Each query keeps its own copy (`QueryContext.recorded`, replacing `latestCursor`). Completion, abort and discard synchronously snapshot it into the in-memory session state only if the state is still the object this query started from (compare-and-set on identity, so two queries resuming the same CC session cannot overwrite each other); a query that started without writable state (row 0, AskClaude) never writes. No `Math.max`, no compare. Today only discarded queries get this guard (`abandonedQueries`).
- **One live query per pi session.** A fresh query for a session that still has one parked discards it (below), so recording never races a second writer. Phase 2 asserts it.
- **A query that made no progress deletes the session file it created.** Progress means at least one complete assistant message recorded; a recorded prompt or an error placeholder does not count. A query that started a new session (rows 2, 3, 5-7) and ended without progress -- error, quota, abort -- deletes that file once its CC process has exited (not when the iterator settles: #160, and #159's `ForkProcess.exited`), and leaves the state as it was. Retry loops then leave no files behind (#103: 5,276 files, ~50 GB). A query that made progress keeps its file and commits what it recorded.
- The orphan-result cursor write (a result delivered after its query died) is deleted: the state then falls through to the decision table.
- `dirtyTail` is set synchronously, in `onAbort` rather than after `consumeQuery` settles, wherever the bridge kills or loses a CC process: abort, `discardRewrittenQuery`, a discarded abandoned query (below), a non-retryable error result, and any query that ends without a `result` message. The next row 5-7 write clears it. After an abort this always means a fork or write, never a plain resume: a plain resume after an interrupt makes CC add a synthetic "No response requested." reply and merge the interrupt marker into the next message (measured).
- **Abandoned parked queries:** a fresh query for a pi session that still has a query parked at a tool boundary discards the parked one (`discardRewrittenQuery`). pi-context-prune's `every-turn` mode replaces a tool result with a summary before it is delivered, so the parked query's result never comes; today it waits until pi exits (measured, `/tmp/prune-trace/`).

### Valid cuts

A cut may follow a slot only if the slot has a real uuid and is cuttable: the kept records must cover all replayed content of the pi prefix through that slot, including reordered messages, repairs and associated CC attachments, and no later pi content. A uuid on a non-cuttable slot is informational only. Cut resolution throws if given a null or empty uuid.

A steer is non-cuttable if any assistant content after its delivery preceded its replay acknowledgement. CC may finish a reply before starting the steer's later turn, while pi merges those replies into one assistant after the steer; retaining the earlier reply at the steer boundary would duplicate it when importing that merged assistant.

A cut must follow the last pi message sharing a CC record (coalesced prompts, parallel results), with no tool call outstanding. Cutting inside a group would keep later pi content (a redacted second message inside a shared prompt), and cutting inside a tool batch would leave a tool call without its result -- converting only the suffix then has no assistant for the result, and `repairToolPairing` drops it as orphaned (verified offline by the sol review).

Tool batches follow conversion: a new non-empty assistant supersedes the previous batch; an omitted empty assistant does not. A dangling tail stays non-cuttable even if marked error/aborted, because a host can deliver its result later.

For example, importing `[A(X,Y), R_X, steer, R_Y]` writes `A`, a merged `{R_X,R_Y}` record, then the steer. A cut after the pi slot for `R_Y` must therefore resolve through the steer's record, not stop at the result record. An omitted empty assistant between results is non-cuttable and does not close the outstanding batch.

**Parallel results are not a single parent path.** CC can parent each result to its own split tool-call record, leaving earlier results outside the final leaf's `parentUuid` path. They are still part of the selected transcript and survive native forks at the batch's last result or final assistant (pinned in `int-cc-contracts.mjs`). Informational slot uuids must resolve in the transcript; a cuttable boundary must resolve on the selected parent path. Row 7 must retain those sibling results, not just walk back from the cut's parent.

A prefix ending in an omission uses the preceding cuttable slot (or 0). This can select row 7 instead of row 6 even when the suffix writes no records; it preserves the same content. Do not invent a uuid for the omitted message just to force row 6.

### Decision at each fresh query

P = digests of pi's current priors; k = length of the common prefix of P and `state.digests`; c = the largest cuttable slot count <= k (0 if none). Checks in order; the first that matches wins.

| # | Condition | Action | Cache and thinking |
|---|---|---|---|
| 0 | "(none)" bucket (no pi session id: a host that doesn't pass one, or a reentrant query from one) | write pi's history to a new session; no state written | none to keep |
| 1 | no state, no priors | new session | n/a |
| 2 | no state, priors | write pi's history to a new session | none to keep |
| 3 | `state.model` differs from this query's model | write pi's history to a new session | none to keep |
| 4 | k = len(P) = len(digests), not dirty | plain resume | all kept |
| 5 | c = 0 (compaction, or a difference before the first cut) | write pi's history to a new session, as today | none to keep |
| 6 | c = len(P) (pi's history is a prefix of what CC has, or equal but dirty) | `resumeSessionAt` at slot c's resolved cut, `forkSession: true`, with a pre-minted `sessionId` confirmed by `init`; the target path is known even on failure before `init` | kept up to the cut (measured) |
| 7 | otherwise | write a new session: CC's chain records through slot c's resolved cut verbatim (new `sessionId` field), then pi's P[c..] converted as today | kept up to c; possibly less when c is far back (below) |

- **Row 6** covers `/tree` back (one or several turns), the forced no-op rebuild, a pruned history (#30, truncates instead of starting clean), and an abort or API error where pi kept the prompt but no assistant message. The cut lands on that prompt's record; the next prompt, with its supplied uuid, is written as its own record parented on it, and the API request merges the two into one user message, which is what pi's history says (measured, `fork-at-aborted-prompt`; the model answered both). If pi also retains an empty aborted assistant, that live message has no covered slot: row 7 keeps the same prompt prefix and omits the empty assistant during import. Abort acceptance tests must follow the actual pi history rather than require row 6 in both cases.
- `resumeDropsTurn` is not used: it refuses whenever the dropped range holds a steer, including steers pi saw, and cannot check a cut inside a turn (measured). The uuid map is the source of truth.
- **Row 7** covers redaction and other in-place edits, pi's partial reply after an abort, and turns from another provider. Past the cut the cache and thinking are lost whatever we write (thinking binds to the whole prefix), so the part after it needs no extra fidelity work (#203, tool-result shape). `@file` expansions in prompts after the cut still need `placeCarriedAttachments`; before it they are CC's own records.
- **Model switch** is row 3, checked before any reuse (measured): a resume or fork on another model loses the cache and old thinking anyway (`model_binding_mismatch`), keeps the old model's system prompt from `prompt_snapshot`, and leaves the old "powered by" note beside the new one. A written file has no `prompt_snapshot`, so CC renders the new model's prompt. Keying on `state.model` covers restarts and AskClaude, not just the `model_select` event (#42, #66(b)).
- **AskClaude** (shared mode) uses the ordinary model-change rule: with a different model it writes pi's history to a new session (row 3); with the same model it forks the session's current state at its last cuttable slot. With no state or no valid cut it writes pi's history to a new session. It never writes provider state, so the provider's own file stays as recorded. AskClaude is deprecated; add no separate cache-preservation mechanism.
- Reentrant subagents that pass their own pi session id have their own state; ones that don't fall in row 0.
- Pruning usually substitutes a summary rather than truncating (#30, #77, the pi-context-prune trace), so it mostly lands in row 7; row 6 applies only when pi's history really is a prefix.
- **Row 7's cache saving may depend on distance.** The API looks back only about 20 content blocks from a request's cache marker for an existing cache entry (Anthropic's docs; not measured here). Row 7's request carries pi's whole rewritten tail after the cut, so for a difference far back (a redaction 50 tool calls ago, distant pruning) the read may stop at tools + system as in a rebuild. Recent differences (an abort mid-reply, another provider's turn) are within reach. Thinking before the cut was measured kept only on short sessions.
- **Every change takes a new id; nothing is deleted in place.** A killed CC process can never write into a file we just made. An aborted process finished writing within ~90 ms of `close()` and never wrote into the fork (measured).
- A fork's kept records point into the *ancestor's* `tool-results/` directory; nothing is copied (measured). An ancestor stops being written once forked, so CC deletes that directory 30 days later even while the fork is live. CC also expires individual `tool-results/` files by their own mtime in active sessions (`chunk-hrmg67aa.js:623-649`), so a long-lived reference to a saved result breaks after 30 days natively too.
- **Transcript framing:** parse complete JSONL records strictly. An unparseable final line without a newline is an uncommitted append and is excluded; a malformed complete/interior record fails the turn. A required UUID lost with that fragment still fails cut resolution.
- **Missing CC file** (CC deletes a transcript and its `<id>/` directory 30 days after the file's last write, by mtime, `cc-293-deobf/chunk-hrmg67aa.js:573-597`; or manual deletion): checked by a stat at decision time; rows 4, 6 and 7 cannot run, so the state (and its persisted file) is dropped and the turn takes row 2 (write pi's history to a new session), logged. Failing the turn instead would fail every later turn of that pi session too, with no way out. Other resume errors (`error_during_execution`, exit 1 on an unknown id) fail the turn.
- Kept records include `prompt_snapshot`, so a changed system-prompt append is ignored after rows 6-7 as it already is on resume. Rows 2, 3 and 5 write none. Unchanged by this plan.

### Rewrites under a parked query (#101)

A query parked at a tool boundary keeps its own context inside the CLI, so if pi compacts or navigates the tree meanwhile, delivering the tool result into it answers off the old conversation (#101). This stays as today: `session_compact`/`session_tree` events mark the session (`historyRewrittenBySession`, `armStaleContexts`, the `Symbol.for` hook registry for worktree-spawned module instances), and the next delivery discards the parked query.

A delivery-time digest compare was considered to replace the events, and rejected on measurement. pi-context-prune's default mode (`agentic-auto` with `remindUnprunedCount`) appends a `<pruner-note>N unpruned...</pruner-note>` to whichever tool result is last and moves it on every call, so the prefix changes on every delivery after the first; a compare would discard the parked query at almost every tool call (`/tmp/prune-trace/out*/digests.txt`). Silent rewrites are instead caught at the next fresh query by the digest sync.

### Persistence (restart, errors)

Restart loss is only a missing pointer: every pi turn already runs a new CC process that resumes by id. Persist the whole state (`ccSessionId`, `cwd`, `model`, `digests`, `uuids`, `cuttable`) with a format version per pi session, so a restarted bridge takes rows 4, 6 and 7 instead of row 2. A file with another version or a missing field is rejected (logged, treated as no state), never read as a model switch. PR #205's storage path setting and test isolation are worth reusing; not its unlocked shared map.

A bridge-owned file per pi session id, `~/.pi/agent/claude-bridge/sessions/<session-key-hash>.json`, holding the latest state and read lazily on the first provider call for that id. It is written atomically only after the query's real CC child has exited, and only if the same snapshot still owns the session state. A normal `done` waits for that save; an SDK error or abort can end the stream before the deferred save runs. An unexpected IO failure is fatal, with no retries. Validate equal array lengths and nullable uuid entries; reject empty-string uuids and any null uuid on a cuttable slot. A loaded state starts with `dirtyTail = true`: CC may have appended past the last record before a crash, and the fork that follows costs nothing (measured). The files are small; no cleanup.

The session states, loaded ids and the stopping-writer registry are shared through `Symbol.for` across module reloads within a process; query and UI contexts stay local to each module instance. Simultaneous use of the same pi session id by multiple bridge processes is unsupported and out of scope. The single-live-query guard and compare-and-set operate within one process; atomic persistence prevents torn files, not competing writers. Different pi session ids retain their independent state.

`pi.appendEntry` was rejected: it is bound to the serving instance's own pi session with no way to address another (`agent-session.ts:3457-3463`), provider calls get no extension `ctx`, and subagent calls run through the parent's bridge instance, so a subagent's state would land in the parent's pi session. Entries also follow `/tree` and pi's `/fork`, which would restore digests that are only a prefix of what the named CC file now holds, or point two pi sessions at one CC file.

## Measured

Every fork read the ancestor's cached total, with no thinking drops (one sample per arm), and its body matched the ancestor up to the cut except `metadata.session_id` and the moved cache marker:

| Fork | Read = ancestor |
|---|---|
| after an abort mid-text, cut at the previous turn's end | 3541 |
| right after an abort mid-tool (~200 ms after `close()`) | 3541 |
| after a 93,599-character tool result CC saved to `tool-results/` | 4599 |
| two turns back, dropping a steer | 3141 |

- An abort leaves CC's longer text or its own "user doesn't want to proceed" tool result plus an interrupt marker; none of it appears in a fork cut before it.
- Forks copy both `prompt_snapshot` records from the kept range.
- After a fork cut at an aborted prompt, CC adopts the bridge-supplied uuid for the next prompt, parented on the kept prompt (`/tmp/abort-uuid-probe/out-1`).
- A fork of a fork, cut at the last streamed assistant uuid, read the full ancestor total (3388) with no thinking drops; every streamed uuid was a record in the file.
- An abort before any complete assistant message can still leave a CC assistant record, and no stream event carries its uuid (`abort-at-first-delta`).
- `diag/probe-session-fork.mjs` reproduced all of the above in first-party mode (15 cases, 20 requests).

pi-context-prune 2.1.0 (`/tmp/prune-trace/`, 24 requests): default mode rewrites the previous tool result on every delivery (moving note); a mid-turn `context_prune` removes earlier results and adds a summary steer; `agent-message` mode removes earlier turns' results and inserts a summary; summaries are byte-stable once written. Today the bridge REUSEs past all of these (lengths unchanged), so CC never sees the pruning.

## What it removes

- `cursor`, `latestCursor`, the trailing-assistant advance, the tool-result path's cursor writes, the orphan-result cursor write, the "shorter than cursor" clean start
- `needsRebuild`, `forceRotate` and post-abort rotation, in-place `deleteSession` + `createSession(sameId)`
- `readCarriedAttachments` (kept records carry their attachments)
- `steerMissedSession` / `missedSteer`

## What stays

- the #101 discard of a parked query and its event machinery (`historyRewrittenBySession`, `armStaleContexts`, the hook registry), now also used for abandoned parked queries
- `placeCarriedAttachments`, for prompts after a difference
- cc-session-io for the row 0, 2, 3, 5 and 7 writes and for reading CC's chain for row 7 and cut resolution
- per-session keys (`sessionStateFor`)

## Deliberately not adding

- **Ownership / isolation state** (`ownerSessionId` and the like from #136): the per-session map key is the ownership within a process.
- **Cross-process coordination for the same pi session id:** no process locks or ownership recovery; simultaneous use is unsupported.
- **Metadata in the digest:** timestamps, usage and cost would churn every re-render.
- **A rolling hash** (see Digests).
- **A delivery-time rewrite compare** (see "Rewrites under a parked query").
- **Cleanup of old CC files:** rows 3 and 5-7 leave the previous file behind, as today's rotation does; CC's own age-based pruning removes them.

## Phases

Each phase: unit tests, full unit suite + typecheck on the pi version main pins, then the lifecycle scenarios that cover it. The lifecycle runner is the acceptance test; its checks currently expect rebuild decisions and need new expectations per phase. Changelog: one short entry per phase that changes behavior.

1. **Digests + recording**, decision rows 0-5; everything else still rebuilds as today, and today's abort marks (`needsRebuild`, `forceRotate`) stay until phase 2. Uuids are recorded but not yet used. Fixes same-count rewrites (#77, #182) and removes `missedSteer`. Scenario: `redaction` rebuilds instead of going stale.
2. **Row 6** (fork truncation) + `dirtyTail` + discarding abandoned parked queries + deleting files of queries that made no progress; sessions now survive errors (#103); remove in-place delete, `needsRebuild`, `forceRotate`. Fixes #30. Gate before anything uses the uuids: a lifecycle check that every non-null recorded uuid resolves in CC's transcript, cuttable boundaries are on the selected parent path, null slots are intentional import omissions and non-cuttable, and every cuttable boundary covers exactly its pi prefix, including merged/reordered imports, `injected-retry` (retries) and `steer-parallel`. Scenarios: `noop-rebuild`, `tree-back`, `abort-continuation`, `thinking-rebuild`, `injected-error` -- for row 6 cases, read stops at the cut with no thinking drops before it. Preservation checks for abort histories that require row 7 run in phase 3.
3. **Row 7** (prefix write). Scenarios: `redaction`, `recent-redaction`, `hard-content-rebuild`, `steer-parallel`, and the row 7 cases of `abort-continuation`.
4. **Persistence.** Scenario: `restart-resume` -- full read after restart.

### Tests

Behavioral, driving real `cc-session-io` files in temp dirs; decision and recording as pure functions where possible.

- tool delivery -> completion -> next turn plain-resumes, and the recorded slots cover exactly the history (the regression that made #136 rebuild every tool-using turn)
- a resume must prove nothing was written: seed CC's file with a sentinel record and assert it survives
- same-count rewrite and same-count removal -> difference at that index
- metadata-only change -> plain resume
- imported empty assistant -> digest slot with null uuid and non-cuttable; the next unchanged turn plain-resumes rather than rewriting repeatedly
- leading/consecutive omitted assistants -> aligned slots; all-omitted priors -> new session without attempting resume of a nonexistent file
- `content: []` versus `[{type: "text", text: ""}]` -> distinct digests and omission versus placeholder records
- `[A(X,Y), R_X, empty, R_Y]` -> no cut within the batch; `R_Y` closes it
- importing `[A(X,Y), R_X, steer, R_Y]` -> the cut after `R_Y` retains both results and the reordered steer
- repair omissions and synthetic records -> slots and cut boundaries match the actual written records, not counts
- a prefix ending in an omitted message -> cut at the preceding valid slot, with no fabricated record for the omission
- cut resolution rejects null/empty uuids; persistence rejects a cuttable slot without a real uuid
- pruned history -> fork at the cut, not a clean start (#30)
- abort mid-text and mid-tool -> retain the aborted prompt prefix, using row 6 or 7 according to pi's retained assistant; old file untouched
- abort after the first delta, and after one complete block plus a partial one -> the partial assistant has no slot; next turn writes pi's version
- redacting one of two coalesced user messages, and one of two parallel tool results -> the cut falls before the shared record / the tool batch, and the redacted text is not in the written file
- a tool result as the first difference -> written after its tool call, not dropped as orphaned; also a durable-host continuation at a tool result (#174, #192)
- repeated quota errors after the prompt was recorded -> no files left behind
- a submitted steer left unacknowledged by failure/abort -> no covered slot; later acknowledgements cannot advance coverage past that gap
- persisted state from another version or missing `model` -> rejected, row 2
- a query dying between tool-call and result delivery -> next turn does not plain-resume past the dangling tool call
- steer delivered -> slot recorded; steer dropped -> difference at its index
- completion of a query whose session was replaced does not overwrite the new state (compare-and-set)
- a fresh query for a pi session with a parked query discards the parked one
- `edit` tool call with `edits` as a JSON string -> next turn plain-resumes (normalization in `mapToolArgs`)
- rows 2 and 5: the digests recorded for a written session match pi's priors, and one live turn after it resolves every non-null uuid and verifies cuttable prefix boundaries (lifecycle)
- a failed query with no new slot leaves no file; one with progress commits it
- model change -> row 3 even when histories are equal, including AskClaude; empty priors never reach a fork; AskClaude never writes state
- digest determinism; the tool-id collision shape
- `tests/int-cc-contracts.mjs`: a pin for fork truncation (cut uuid, kept uuids, new file)

Migrate: seeds built by the state helper instead of cursor literals (`unit-sync-shared-session.mjs`, `unit-cross-session-turns.mjs`), the `latestCursor` rename (`unit-querycontext.mjs`), debug-line and int anchors (`int-cache.sh`, `int-cursor-after-tools.mjs`). Port the ~10 behavior-level tests from PR #136's `unit-sync-shared-session-fingerprints.mjs` (same-count rewrite, exact reuse, unseen tail, metadata churn, root rewind, determinism); drop its owner/foreign tests (`unit-cross-session-turns.mjs` covers that) and its source-grepping style.

## Risks and open questions

- **pi-context-prune's default mode costs cache every tool-using turn:** its moving note changes the previous turn's tool results, so each sync forks at the first one (re-caching roughly the last turn's tail). Today that is free only because the pruning never reaches CC. Users can turn the note off (`remindUnprunedCount: false`).
- **A false difference is cheaper than today but not free:** it costs cache and thinking from the difference on. The digest is finer than conversion everywhere probed (spurious difference possible, stale reuse not); the tool-turn regression test is the guard.
- **CC chain selection:** row 6 fails hard if the cut uuid is not on CC's selected chain. With a new file per change the resolved cut boundaries are always on the chain of the file we name; null omission slots cannot be selected. The contract pin guards it.
- **pi `/fork`** creates a new pi session id with no bridge state, so its first turn writes a new CC session (row 2).
- **`resumeSessionAt` is documented for print/headless mode only**, which is what the SDK runs; interactive `claude --resume` ignores it.
- **Hashing cost** on screenshot-heavy histories: linear per delivery, the same cost class as pi cloning the history when a context hook is active. With Node 26.0.0, 100 image messages containing 25 MiB of base64 took a median 24.4 ms across 11 runs.
- **Unexplained, one sample:** a native continuation (no fork) after a turn without thinking read 2654 instead of 2987; not reproduced in the abort-uuid probe.
- **Request-audit records** (see "Before starting") can sit interleaved with the chain in older files. Row 7's chain read and cut resolution must skip them, and a cut always names a record by uuid, never by line. Measured on 2.1.308 with `probe-session-fork.mjs`: every fork case passed as on 2.1.293 (reads equal to ancestor, no thinking drops, uuid adoption, `prompt_snapshot` copying, same steer refusal, hidden partial assistant after an abort), with the audit records present.
- **Fork leaves the ancestor's mtime alone** (inferred from source); the `int-cc-contracts` fork pin should stat it.
