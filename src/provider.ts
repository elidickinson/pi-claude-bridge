// The pi provider entry point: `streamClaudeAgentSdk`, which pi calls for every turn on a
// claude-bridge model, and everything that exists only to serve it — tool-result routing
// back to the MCP handlers a live Claude Code subprocess is parked on, the steer plumbing
// sharing that subprocess's stdin, abort teardown, and pi's onPayload/onResponse hooks.
// Per-query state is QueryContext in query-state.js, the globals it is not part of are in
// bridge-state.js, and the resume/rebuild decision is in session-sync.js because the
// AskClaude path needs that same decision. Separate from index.ts so a unit test can drive
// the whole path with a stand-in for the Agent SDK's `query` (setRunQuery), without
// registering the extension — see tests/unit-provider-hooks.mjs.

import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { deleteSession } from "cc-session-io";
import { activeQueryContexts, bridgeState, promptCaptures } from "./bridge-state.js";
import { CC_CHILD_ENV, CLAUDE_MD_EXCLUDES, claudeCodeSettings, markStartupNoticeShown } from "./config.js";
import { extractUserPrompt, extractUserPromptBlocks } from "./convert.js";
import { DEBUG, debug, diagDump, makeCliDebugOptions } from "./debug.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { claudeCodeModelId } from "./models.js";
import { projectPromptCapture } from "./prompt-capture.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { QueryContext, ctx } from "./query-state.js";
import { contextForToolResults, deliverToolResults, drainForAbort, steerBlocks } from "./tool-delivery.js";
import { syncSharedSession } from "./session-sync.js";
import { REASONING_TO_EFFORT, claimCurrentPiStream, consumeQuery, finalizeCurrentStream, markStreamComplete, newAssistantMessageEventStream } from "./stream-consumer.js";
import { buildMcpServers, resolveMcpTools } from "./tools.js";

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (bridgeState.pendingNotices.length === 0 || bridgeState.piMode !== "tui") return;
	const notices = bridgeState.pendingNotices;
	bridgeState.pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	bridgeState.piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	// Gated on the flag rather than left for debug() to discard: arguments are
	// evaluated before the call, so this serialized every tool result in full on
	// every turn even with logging off — and tool results carry file contents.
	if (DEBUG) {
		for (let r = 0; r < results.length; r++) {
			debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
		}
	}
	return results;
}


/** The Agent SDK entry point, behind a rebindable binding purely so unit tests can
 *  drive the fresh-query path without spawning Claude Code. Production never
 *  reassigns it; `__test.setQueryFn` in index.js is the only writer. */
let runQuery: typeof query = query;

/** Swap `runQuery`. Exported as a setter rather than the binding itself because an
 *  importing module binds the value of an `export let`, not the variable — the same
 *  reason bridge-state.js keeps its reassignable slots on an object. */
export function setRunQuery(fn: typeof query | null): void {
	runQuery = fn ?? query;
}

// --- Provider request hooks (onPayload / onResponse) ---
//
// These are provider-invoked in pi, not runtime-invoked: ModelRuntime.prepareRequest
// consumes `transformHeaders` and spreads the rest of StreamOptions untouched into
// what it hands the provider, so a hook fires only if the provider fires it. Skipping
// them costs no built-in pi feature, but every extension on `before_provider_request`
// / `after_provider_response` — payload inspectors, cost and observability trackers,
// gateway and policy extensions, 429 handlers — silently never runs for our models
// while running for every other provider, and pi only emits when `hasHandlers`, so
// nothing warns.
//
// `transformHeaders` / `before_provider_headers` is deliberately not implemented: the
// runtime applies it before we are called, and Claude Code is a subprocess with no
// HTTP request for headers to ride on.

/** The payload shape handed to an onPayload handler: query()'s own argument, with
 *  the prompt as this turn's content blocks rather than the live stream object. */
type ProviderPayload = { prompt: unknown; options: NonNullable<Parameters<typeof query>[0]["options"]> };

/** Run a registered onPayload handler and resolve to the options `query()` should be
 *  called with. Mirroring query()'s own argument makes an identity handler a no-op,
 *  and a non-undefined return replaces the payload, which is what StreamOptions
 *  documents.
 *
 *  Only `options` is taken from the return. The prompt we actually pass is a parked
 *  generator that this bridge writes steers and tool results into for the rest of the
 *  turn, so honouring a replaced prompt would cut Claude Code's stdin off from the
 *  tool-result queue — a silent deadlock rather than a visible error. */
async function applyPayloadHook(
	onPayload: NonNullable<SimpleStreamOptions["onPayload"]>,
	model: Model<any>,
	payload: ProviderPayload,
): Promise<NonNullable<Parameters<typeof query>[0]["options"]>> {
	const replacement = await onPayload(payload, model);
	if (replacement === undefined) return payload.options;
	const replaced = (replacement as Partial<ProviderPayload>)?.options;
	if (!replaced || typeof replaced !== "object") {
		throw new Error(
			`claude-bridge: an onPayload handler returned ${replacement === null ? "null" : typeof replacement} `
			+ `where a { prompt, options } payload was expected. Return the payload it was given, a modified copy `
			+ `of it, or undefined to send the call unchanged.`,
		);
	}
	return replaced;
}

/** Report the provider response. Claude Code is a subprocess, so there is no status
 *  line or header set to pass on: report the same synthetic 200 that pi's own non-HTTP
 *  provider reports (`providers/faux.js`). Async so that a handler throwing
 *  synchronously becomes a rejection the caller's chain can fail the turn on, rather
 *  than an exception out of a provider that must return its stream synchronously. */
async function notifyProviderResponse(
	onResponse: NonNullable<SimpleStreamOptions["onResponse"]>,
	model: Model<any>,
): Promise<void> {
	await onResponse({ status: 200, headers: {} }, model);
}

/** Fail a fresh query that never reached `query()`, because an onPayload handler
 *  threw. There is no SDK query to tear down and nothing was published to
 *  activeQueryContexts, but the pi stream was claimed several steps earlier and hangs
 *  the turn if nobody ends it. */
function failFreshQuery(c: QueryContext, promptStream: PromptStream, error: unknown): void {
	debug("provider: onPayload handler failed before the query started:", error);
	promptStream.fail(error instanceof Error ? error : new Error(String(error)));
	if (c.promptStream === promptStream) c.promptStream = null;
	if (c.turnOutput) {
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
	}
	const stream = c.currentPiStream;
	stream?.push({ type: "error", reason: "error", error: c.turnOutput! });
	markStreamComplete(stream);
	stream?.end();
	c.currentPiStream = null;
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
export function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	showStartupNoticeOnce();
	const stream = newAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (bridgeState.sharedSession && resultCtx === ctx()) bridgeState.sharedSession.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (bridgeState.sharedSession && activeQueryContexts.size === 0) bridgeState.sharedSession.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt throws, and doing that before
	// anything is claimed or reset leaves no half-built query behind — in particular
	// no stream claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, bridgeState.askClaudeToolName);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
	const systemPromptAppend = promptCapture
		? projectPromptCapture(promptCapture, {
			skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
		})
		: undefined;

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.rateLimitRejection = null;
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, bridgeState.longContextSettings);
	const syncResult = syncSharedSession(context.messages, cwd, isReentrant, customToolNameToSdk, cliModel);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: bridgeState.sharedSession ? { sessionId: bridgeState.sharedSession.sessionId.slice(0, 8), cursor: bridgeState.sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = bridgeState.providerSettings.strictMcpConfig !== false;
	const claudeExecutable = bridgeState.providerSettings.pathToClaudeCodeExecutable;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = { ...process.env, ...CC_CHILD_ENV };
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		// No allowDangerouslySkipPermissions alongside this, deliberately. The SDK
		// types document it as "must be set to true when using bypassPermissions",
		// but nothing enforces it: the two options become independent argv flags
		// with no validation, and the CLI accepts bypassPermissions on its own.
		// Verified by execution on 0.2.141 and 0.3.238 — permissions really are
		// bypassed either way (a Write ran unprompted and the file appeared). The
		// one path that does enforce the pairing is runtime escalation via
		// setPermissionMode(), which the bridge never calls. If a future SDK starts
		// enforcing it here too, this is the note that explains the failure.
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		// AskClaude keeps CC's native tools and its guidance — unaffected.
		settings: {
			...claudeCodeSettings(bridgeState.providerSettings),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
		},
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;

	// Spawning the query and publishing it — `queryCtx.activeQuery` and
	// `activeQueryContexts` — is one synchronous unit, because those two are exactly
	// what the reentrancy check at the top of this function reads: a concurrent call
	// landing between the two would see no active query and misclassify itself as a
	// fresh top-level one. This is a function only so the onPayload path below can run
	// the same unit after awaiting a handler. Nothing inside it is reordered.
	const startQuery = (opts: NonNullable<Parameters<typeof query>[0]["options"]>) => {
		const sdkQuery = runQuery({ prompt: promptStream.stream, options: opts });
		queryCtx.activeQuery = sdkQuery;
		activeQueryContexts.add(queryCtx);

		// 4. Capture context for abort handling
		const abortCtx = queryCtx;

		const requestAbort = () => {
			// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
			// Both are needed — interrupt alone lets the current API call finish.
			abortCtx.rateLimitRejection = null;
			void sdkQuery.interrupt().catch(() => {});
			try { sdkQuery.close(); } catch {}
		};
		const onAbort = () => {
			wasAborted = true;
			drainForAbort(abortCtx, promptStream);
			requestAbort();
		};
		if (options?.signal) {
			// The `aborted` check is also what recovers an abort that landed while an
			// onPayload handler was being awaited: no listener existed yet to catch it, so
			// without this the abort would be lost and the query left running. Instead the
			// query is created and then immediately torn down through the same path a
			// normal abort takes, which is what produces the aborted stream event.
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		// Background consumer — runs until query ends. onResponse goes first and is
		// awaited, as pi's own providers await theirs, so the documented "after the
		// response, before its body stream is consumed" ordering holds: nothing has
		// reached the pi stream until consumeQuery starts.
		const consumed = options?.onResponse
			? notifyProviderResponse(options.onResponse, model)
				.then(() => consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx))
			: consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx);

		consumed
			.then(async ({ capturedSessionId }) => {
				debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

				// --- Abort detection in normal completion path ---
				if (wasAborted || options?.signal?.aborted) {
					if (bridgeState.sharedSession) bridgeState.sharedSession = { ...bridgeState.sharedSession, needsRebuild: true, forceRotate: true };
					debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
					if (queryCtx.turnOutput) {
						queryCtx.turnOutput.stopReason = "aborted";
						queryCtx.turnOutput.errorMessage = "Operation aborted";
					}
					const stream = queryCtx.currentPiStream;
					stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
					markStreamComplete(stream);
					stream?.end();
					queryCtx.currentPiStream = null;
					return;
				}

				// --- Capture session ID ---
				const sessionId = capturedSessionId ?? bridgeState.sharedSession?.sessionId;
				if (syncResult.preserveSharedSession) {
					if (capturedSessionId && capturedSessionId !== bridgeState.sharedSession?.sessionId) {
						deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
						debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
					}
					debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
				} else if (sessionId) {
					const cursor = Math.max(context.messages.length, queryCtx.latestCursor, bridgeState.sharedSession?.cursor ?? 0);
					debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
					bridgeState.sharedSession = { sessionId, cursor, cwd };
				}

				if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
					debug("provider: clearing activeQuery before final stream completion");
					queryCtx.activeQuery = null;
				}
				finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
			})
			.catch((error) => {
				debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
				if ((wasAborted || options?.signal?.aborted) && bridgeState.sharedSession) {
					bridgeState.sharedSession = { ...bridgeState.sharedSession, needsRebuild: true, forceRotate: true };
				} else {
					bridgeState.sharedSession = null;
				}
				promptStream.fail(error instanceof Error ? error : new Error(String(error)));
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
					// The SDK drops its copy of the result text if any message follows the error
					// result, so prefer the cause consumeQuery recorded off the result itself.
					queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
				}
				if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
					queryCtx.releasePendingToolCalls("Query ended");
					debug("provider: clearing activeQuery before error stream completion");
					queryCtx.activeQuery = null;
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
			})
			.finally(() => {
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				// Settle any ack still parked in the generator — the CLI is gone, so
				// nothing will resume it. Clear the handle only if a later query
				// hasn't already claimed the shared context.
				promptStream.fail(new Error("query ended"));
				if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
				// A later query claiming this context sets activeQuery to its own handle;
				// null means the .then/.catch above cleared ours and nothing replaced it.
				// Testing only for `=== sdkQuery` would never fire on the non-reentrant
				// path, leaving the top-level context in the routing set forever — where a
				// later orphaned tool result matches its stale turnToolCallIds and takes
				// the delivery branch, returning a stream nothing ends.
				if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
					queryCtx.releasePendingToolCalls("Query ended");
					queryCtx.activeQuery = null;
					activeQueryContexts.delete(queryCtx);
				}
				try { sdkQuery.close(); } catch { /* the CLI is already gone; nothing to close */ }
			});
	};

	// onPayload: hand the assembled call to a registered handler before it is made.
	// The deferral is taken *only* when a handler exists. Deferring unconditionally
	// would put an await in front of the activeQuery publish on every turn, and an
	// abort landing in that window then has to be recovered by hand (the
	// `signal.aborted` check in startQuery). With no handler — the overwhelming
	// majority of calls — nothing here is awaited and the path is unchanged.
	if (options?.onPayload) {
		void applyPayloadHook(options.onPayload, model, {
			prompt: promptBlocks ?? [{ type: "text", text: promptText }],
			options: queryOptions,
		})
			.then(startQuery)
			.catch((error) => failFreshQuery(queryCtx, promptStream, error));
		return stream;
	}

	startQuery(queryOptions);
	return stream;
}
