# Cache trace

Finds prompt-cache failures by checking every API request against two contracts, without knowing in advance which field breaks:

1. **Preservation.** When pi's history only grew (or did not change), the part of a request its ancestor already sent must not change on the wire. Checked on a normalized view (billing header, moving `cache_control`, one-text-block-vs-string at message level); raw differences are kept alongside.
2. **Propagation.** pi's effective history -- what the bridge was actually handed, after extension transforms -- must reach the request Claude Code sends, however warm the cache is.

Each transition between two requests also reports what the cache did against what the ancestor is known to have cached (`cacheRead + cacheWrite`), the bridge's session decision, and whether the evidence is good enough to conclude anything. Differences are grouped by where they sit and what kind they are (e.g. `user>tool_result.content type-or-shape array->string`), never by issue.

## Pieces

- `src/cache-trace.ts` -- opt-in recorder in the bridge: provider inputs, session decisions and query lifecycle, linked by id, plus copies of Claude Code session files before a rebuild deletes or abandons them.
- `diag/capture-proxy.mjs` -- streaming recording proxy; ties each request to the bridge query that sent it.
- `diag/analyze-trace.mjs` -- the checks above, over a capture (and optionally a trace).
- `diag/lifecycle-runner.mjs` -- short scripted sequences (rebuild, abort, steer, injected errors, restart, redaction, tree navigation, compaction) through real pi and Claude Code, each analyzed and checked for actually reaching the state it set out to test.
- `diag/probe-session-fork.mjs` -- cuts native Claude Code sessions at a record and resumes them through the Agent SDK (`resumeSessionAt` + `forkSession`, `sessionStore`), including after aborts, a steer and a saved tool result, and checks the cache read and thinking up to the cut (paid, outside the sandbox).

## Recording a real session

Opt-in, local only. **Raw mode records whole conversations**: prompts, replies, thinking, tool output, file contents, and Claude Code's own context (environment, account details it injects). Files are owner-only and nothing is uploaded; treat the directories like the conversation itself. Expect disk use roughly proportional to (turns x conversation size): every provider call stores its full input.

```
node diag/capture-proxy.mjs --port 8787 --out ~/cc-trace/capture &
CLAUDE_BRIDGE_TRACE_DIR=~/cc-trace/trace \
CLAUDE_BRIDGE_TRACE_RAW=1 \
CLAUDE_BRIDGE_TRACE_PROXY=http://127.0.0.1:8787 \
  pi --model claude-bridge/...
node diag/analyze-trace.mjs --capture ~/cc-trace/capture --trace ~/cc-trace/trace
```

- Without `CLAUDE_BRIDGE_TRACE_RAW=1` only digests and block shapes are recorded: differences can still be found and grouped, but propagation cannot be checked and no session files are copied.
- Routing requires that `ANTHROPIC_BASE_URL` is not already set; the recorder refuses rather than override a configured gateway. Pointing Claude Code at the proxy may itself change what it sends, so compare traced runs with traced runs.
- If the recorder cannot write (disk full, permissions), the next turn fails before a query starts, with a notice; a turn already running is not disturbed. Limits: `CLAUDE_BRIDGE_TRACE_MAX_ARTIFACT_BYTES` (64 MiB) and `CLAUDE_BRIDGE_TRACE_MAX_RUN_BYTES` (2 GiB); anything over them is left out and marked, never truncated.

`analyze-trace.mjs` also takes a bare capture (old or new format) or `--probe DIR` for `probe-cache-mutations.mjs` output. Without a trace, ancestry is a guess and every transition is marked unattributed.

## Lifecycle runner

```
node diag/lifecycle-runner.mjs [--scenario noop-rebuild,abort-continuation,...] [--out DIR] [--bridge OTHER_CHECKOUT]
```

Paid (a few Haiku 5.5 turns per scenario, medium thinking) and must run outside the sandbox. A scenario that does not reach its intended state is reported NOT EXERCISED, never as a pass. `--bridge` runs another checkout -- e.g. a revision before a fix -- to confirm the scenario can tell the difference; one without the recorder leaves only the proxy's evidence.

## Findings

Observed 2026-10-21 with Claude Code 2.1.293, Agent SDK 0.3.293, pi 1.3.0; Haiku 5.5 at medium effort unless noted. Mutation-probe cases ran on a fresh seed per case, once with each arm first; lifecycle scenarios once each.

- **Every rebuild loses the cached conversation.** A no-op rebuild (pi's history unchanged) changes the request from message 0, so the cache read stops at the tools + system prompt and everything after it misses. With 1, 5 and 11 prior turns (11, 35, 71 messages) the read stayed at 3500 tokens while the loss grew with the conversation (884, 1564, 2584). The same happens after tree navigation, a restart, an API error and an aborted continuation. All differences sit inside the cached region, seconds after the ancestor, well within its 1h TTL. A rotated rebuild's new session id (`metadata.user_id`) is not a factor: the same records resumed under a new id read back the whole prefix.
- **The cause is Claude Code's context attachment records, which a rebuild does not carry.** CC sends each record's stored `rendered` text: on Haiku 5.5, Opus 5.5 and Fable 5.1 `session_context` in the first user message, environment, model, `total_tokens` and date in a system message after it, and a `total_tokens` countdown after every tool result and later prompt. Dropping `session_context` stops the read before the conversation; dropping `environment` stops it after the first user message. On resume CC re-adds missing context after the new prompt and leaves an empty system message in the old slot. A fix has to copy every record verbatim, in place; `prompt_snapshot` holds the system prompt and tools, and copying it would freeze them.
- **Tool-result shape and key order are cache-neutral on Haiku 5.5** (array vs string content, reordered keys), in both arm orders. On Haiku 4.5 with thinking off, CC merged the countdown into the tool result as a second block; the probe there turned that two-block result into one joined string and lost 150-160 tokens, which is the dropped block rather than the shape.
- **Same-length in-process context changes do not reach Claude Code** (Haiku 4.5 and 5.5). An extension `context` transform that redacts text without changing message count takes REUSE, and Claude Code keeps answering from the original text.
- **pi's stored tool arguments can differ from what Claude Code sent (#203).** The bridge's `mapToolArgs` adds `timeout: 120` to `bash` calls when it maps Claude Code's call for pi, so pi stores it; Claude Code's history has the call without it. A rebuild writes pi's version, a second break inside the cached region independent of the attachments.
- **A rebuild makes the API discard earlier thinking.** The bridge sends thinking blocks back byte-identical, but the API binds each to the context it was produced in; with the `thinking-binding-controls-2026-08-01` beta the rebuilt request reports `thinking_dropped / prefix_binding_mismatch` for every block. Claude Code sends that beta itself on thinking requests to a first-party endpoint, so the drop is reported in normal use too.
- **Claude Code retries a 529 itself**, even with `x-should-retry: false`; pi never sees the error. A non-retryable error drops the bridge's session mirror, so the next turn rebuilds (with the loss above).
- **Steers** reach Claude Code inside the tool result they were drained with on Haiku 4.5, and as a system message right after the tool results on Haiku 5.5.
- **#199/#200**: before the fix, aborting a run that continued a parked query let the request stream to completion; after it, the request is cut off upstream.
