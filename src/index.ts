import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { isToolCallEventType, VERSION as PI_VERSION, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { createSession, deleteSession, getSessionPath } from "cc-session-io";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname } from "path";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { QueryProcess } from "./query-process.js";
import { readTranscript, recordedToolResults, resolveRecordingCut, savePrefixSession } from "./session-transcript.js";
import { debugLogPath, diagLogPath } from "./log-paths.js";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings, withModelsAheadOfCatalog } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { digestMessage, digestMessages } from "./message-digests.js";
import { compareHistory, copyRecording, importHistory, LiveRecording, type Recording, type SessionState } from "./session-sync.js";
import { deleteSessionState, loadSessionState, saveSessionState } from "./session-store.js";
import { newAssistantOutput, QueryContext, type AssistantStep } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeSettings, globalConfigPath, loadConfig, markStartupNoticeShown, type Config } from "./config.js";
import {
	collectToolPrompts,
	projectPromptCapture,
	sharedPromptCaptures,
	type PromptCapture,
} from "./prompt-capture.js";
import { collectCarriedAttachments } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { describeTool, toolPromptsFrom, type ToolPrompts } from "./tool-prompts.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession, sessionCwdFor, summarySessionFor } from "./session-cwd.js";
import { updateUsage, type SdkUsage } from "./usage.js";
import { rateLimitResponse } from "./rate-limit.js";
import { recordHeadlessReading } from "./usage-ledger.js";
import { BRIDGE_VERSION, packageVersion, setTraceNotifier, traceAssertReady, traceEvent, traceId, traceInput, traceQueryStart, traceSignalId, traceSnapshot, traceStrict } from "./cache-trace.js";
import { DEBUG, debug, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { CC_CHILD_ENV, ccChildEnv, CLAUDE_MD_EXCLUDES, errorMessage, REASONING_TO_EFFORT, resultErrorText } from "./cc-child.js";

/** Unconditional diagnostic dump — for "should never happen" paths. Creates pi's agent
 *  dir itself: callers run inside streamSimple, where a missing dir must not throw. */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	const logPath = diagLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	appendFileSync(logPath, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${logPath})`);
}

// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const MODELS = buildModels(withModelsAheadOfCatalog(getModels("anthropic")));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

// --- Session persistence ---

/** Mirror of the CC conversation one pi session's turns are running on. One
 *  entry per pi session: a bridge process serves several sessions at once
 *  (pi-subagents children run their own AgentSessions), and a single shared
 *  slot forced them to fight over it — a length-matching foreign sync could
 *  REUSE or rebuild another session's CC file, and the completion capture was
 *  last-writer-wins (a foreground child in the parent's first turn permanently
 *  reassigned the parent's conversation). Keyed lookup removes the fight: each
 *  session's reads, writes and teardown marks touch only its own mirror.
 *
 *  One registry per process, shared by every module instance (Symbol.for, like
 *  MARK_REBUILD_HOOKS_KEY): a /reload or worktree instance must see the newest
 *  in-memory state, compare-and-set against the same objects, and wait on the
 *  same stopping children, or an old instance's post-exit save could overwrite
 *  a newer pointer. */
const SESSION_REGISTRY_KEY = Symbol.for("claude-bridge:sessionRegistry");
interface SessionRegistry {
	states: Map<string, SessionState>;
	/** Keys whose persisted state has been read once; memory is authoritative after. */
	loaded: Set<string>;
	/** Real pi session ids this process has read or written state for. */
	known: Set<string>;
	writers: Map<string, Promise<void>>;
}
const sessionRegistry: SessionRegistry = ((globalThis as Record<symbol, unknown>)[SESSION_REGISTRY_KEY] as SessionRegistry | undefined)
	?? { states: new Map(), loaded: new Set(), known: new Set(), writers: new Map() };
(globalThis as Record<symbol, unknown>)[SESSION_REGISTRY_KEY] = sessionRegistry;
const sharedSessions = sessionRegistry.states;
const loadedSessionStates = sessionRegistry.loaded;
const knownSessionIds = sessionRegistry.known;

/** The mirror for `piSessionId`, or null when this session has none yet. A pi
 *  session reads its persisted pointer on first use (restart, /reload).
 *  Unattributed calls (a host that omits options.sessionId) cannot safely share a
 *  mirror, so they have none and always import independently. */
function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	if (piSessionId == null) return null;
	if (!loadedSessionStates.has(piSessionId)) {
		knownSessionIds.add(piSessionId);
		const stored = loadSessionState(piSessionId, (message) => diagDump("session_state_rejected", { piSessionId, message }));
		loadedSessionStates.add(piSessionId);
		if (stored) sharedSessions.set(piSessionId, stored);
	}
	return sharedSessions.get(piSessionId) ?? null;
}

/** A pi fork or clone starts from its parent's state, dirty, so its first turn
 *  forks the parent's CC session instead of importing pi's history. Memory only:
 *  the parent's own pointer is saved only once its child exits. */
function inheritSessionState(parentFile: string, piSessionId: string): void {
	let text: string;
	try { text = readFileSync(parentFile, "utf8"); }
	catch (error) {
		// pi writes a session file at its first message, so a parent without one has no state.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const header = JSON.parse(text.split("\n", 1)[0]);
	if (header?.type !== "session" || typeof header.id !== "string") throw new Error(`no session header in ${parentFile}`);
	const parent = sessionStateFor(header.id);
	if (!parent) return;
	setSessionStateFor(piSessionId, { ...parent, ...copyRecording(parent), dirtyTail: true });
	debug(`session_start:fork: inherited ${parent.ccSessionId} from piSession=${header.id} ${sessionTag(piSessionId)}`);
}

/** Replace (or plant) the mirror for `piSessionId`. */
function setSessionStateFor(piSessionId: string, state: SessionState | null): void {
	knownSessionIds.add(piSessionId);
	loadedSessionStates.add(piSessionId);
	if (state === null) sharedSessions.delete(piSessionId);
	else sharedSessions.set(piSessionId, state);
}

// pi replaced one of its sessions' history (compact, tree) rather than appending
// to it. Copied onto that session's parked queries (armStaleContexts), whose
// historyStale the tool-result path checks — the one provider call that never
// reaches syncSharedSession — so a query parked at a tool boundary is discarded
// rather than resumed (issue #101). Keyed by pi session id, not process-global: a bridge
// process serves several pi sessions at once (subagents run their own
// AgentSessions and can compact mid-run while the parent is parked), and
// marking across that boundary kills healthy queries (or, worse, rebuilds the
// parent around a compaction that never touched it).
const historyRewrittenBySession = new Set<string>();

/** Handlers that arm rewrite staleness, one per module instance. Worktree-
 *  spawned subagents can load this module fresh (pi's loader cache is keyed on
 *  cwd, and a worktree cwd clears it), while the serving instance — whose
 *  streamSimple the pi sessions actually call — is whoever registered first.
 *  A fresh instance must forward its session's rewrites to the serving one.
 *  Symbol.for: one registry per process, like SHARED_CAPTURES_KEY below. */
const MARK_REBUILD_HOOKS_KEY = Symbol.for("claude-bridge:markRebuildHooks");
type MarkRebuildHook = (piSession: string | null, event: string) => void;
const markRebuildHooks: Set<MarkRebuildHook> =
	((globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] as Set<MarkRebuildHook> | undefined) ?? new Set();
(globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] = markRebuildHooks;

/** pi mutated its messages array out from under us: force the next
 *  syncSharedSession down REBUILD, and arm the discard above. `piSession`
 *  is never null from an event handler (each pi session has its own runner);
 *  a null one marks nothing, since an unattributed caller has no mirror. */
function markRebuildForSession(piSession: string | null, event: string): void {
	// The rewriting session's own mirror: the rewrite changed the history it was
	// built from, so its next sync must REBUILD rather than REUSE. Every other
	// session's mirror stays untouched — its conversation was never rewritten.
	const state = piSession != null ? sharedSessions.get(piSession) : undefined;
	if (!state) {
		debug(`${event}: history rewritten, no session to mark yet ${sessionTag(piSession)}`);
	} else {
		state.dirtyTail = true;
		debug(`${event}: marking dirtyTail on session ${state.ccSessionId.slice(0, 8)} ${sessionTag(piSession)}`);
	}
	// Arming parked contexts cannot wait for delivery: the entry checks
	// `resultCtx.historyStale`, and a rewrite usually lands *while* the query is
	// parked (compaction runs inside pi's turn loop, not between provider calls).
	if (piSession) historyRewrittenBySession.add(piSession);
	armStaleContexts();
}

/** Copy each armed session's mark onto the parked queries built from it. */
function armStaleContexts(): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
	}
}

// This instance enlists. Session ids reaching any hook equal options.sessionId
// on the serving instance's provider calls, so forwarding is safe: only the
// owning instance's contexts and SessionState match the key.
markRebuildHooks.add(markRebuildForSession);

/** Event handlers call this: it fans the rewrite out to every module instance
 *  in the process, of which exactly one is serving provider traffic for any
 *  given pi session. */
function sponsorMarkRebuildForSession(piSession: string | null, event: string): void {
	for (const hook of markRebuildHooks) hook(piSession, event);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const results = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	if (DEBUG) {
		debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs`);
		debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
		for (let r = 0; r < results.length; r++) {
			debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
		}
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude quota exceeded — rate limit" rather than appending keeps both phrases
 *  in any truncated render, and avoids the `<tool> failed (exit N):` shape that pi-subagents
 *  treats as a tool failure and refuses to retry. "quota exceeded" is on pi-ai's non-retryable
 *  list, which wins over its retryable "rate limit" pattern, so pi hands the rejected window
 *  straight to fallback instead of retrying a limit that resets in hours (issue #183). */
function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

/** Reports to the call that owns the open stream, before its next event, as pi's own
 *  providers do. A failing consumer must not end the turn it is observing. */
async function reportHeldRateLimit(c: QueryContext, model: Model<any>): Promise<void> {
	const info = c.heldRateLimit;
	if (!info || !c.currentPiStream || !c.currentOnResponse) return;
	c.heldRateLimit = undefined;
	try {
		await c.currentOnResponse(rateLimitResponse(info), model);
	} catch (error) {
		debug("rate limit: onResponse failed", error);
	}
}

/** `context` must already be in bridge shape (toBridgeContext). */
function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions, traceCallId?: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream, traceCallId);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	traceCallId?: string,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const traceQueryId = traceId("summary");
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractUserPrompt(context.messages);
		if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId);
		const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		// Honour the caller's reasoning level, same mapping as the provider path.
		const effort = effortForReasoning(model, options?.reasoning);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"} promptLen=${promptText.length}`);

		sdkQuery = queryImpl({
			prompt: promptText,
			options: {
				cwd,
				env: traceQueryStart(traceQueryId, { kind: "isolated-summary", callId: traceCallId, model: cliModel }, ccChildEnv(options?.env)),
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(effort ? { effort } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let resultUsage: SdkUsage | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") {
					finalText = message.result || assistantText;
					resultUsage = message.usage;
				}
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			endStream(stream, { type: "error", reason: "aborted", error: output });
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			endStream(stream, { type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		const output = newAssistantOutput(model, text, "stop");
		if (resultUsage) recordUsage(output, resultUsage, model, options?.sessionId ?? null);
		endStream(stream, { type: "done", reason: "stop", message: output });
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		endStream(stream, { type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		if (sdkQuery) traceEvent("query-end", { queryId: traceQueryId, aborted: wasAborted });
		try { sdkQuery?.close(); } catch {}
	}
}

interface SyncResult {
	sessionId: string | null;
	targetSessionId: string;
	created: boolean;
	forkAt?: string;
	recorded: Recording;
	/** Identity token, retained until progress/completion commits this query. */
	state: SessionState | null;
}

// Children that are stopping or finishing, registered before their state is
// committed. Readers of their file wait for actual child exit, never just SDK
// iterator settlement. A healthy parked query is absent: it only appends past
// every committed cut, so a reader never waits on it. Process-wide (see
// SESSION_REGISTRY_KEY).
const sessionWriters = sessionRegistry.writers;
async function waitForSessionWriter(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
	const exited = sessionId ? sessionWriters.get(sessionId) : undefined;
	if (!exited) return;
	signal?.throwIfAborted();
	if (!signal) return exited;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void exited.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}
function prefixRecording(recorded: Recording, count: number): Recording {
	return { digests: recorded.digests.slice(0, count), uuids: recorded.uuids.slice(0, count), cuttable: recorded.cuttable.slice(0, count) };
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${debugLogPath()}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	if (!DEBUG) return;
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Compare pi's values, then retain CC's own records up to the last valid cut.
// `promptDigest` is the provider's system prompt append; a change takes a full
// import, the only path on which CC records a new one.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk: Map<string, string>,
	modelId: string,
	piSessionId: string | null,
	traceCallId: string | undefined,
	promptDigest: string,
): SyncResult {
	let state = sessionStateFor(piSessionId);
	const before = state;
	const history = nonSystemMessages(messages);
	const priors = history.slice(0, turnStart(history));
	const compared = state ? compareHistory(digestMessages(priors), state) : { commonPrefix: 0, cutCount: 0, equal: false };
	let missingFile = false;
	if (state) {
		try { statSync(getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR)); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missingFile = true;
			debug(`sync: missing transcript ${state.ccSessionId} in recorded cwd=${state.cwd}; importing pi history`);
			setSessionStateFor(piSessionId!, null);
			deleteSessionState(piSessionId!);
			state = null;
		}
	}
	const cwdChanged = Boolean(state && safeRealpath(state.cwd) !== safeRealpath(cwd));
	const promptChanged = Boolean(state && state.promptDigest !== promptDigest);
	if (promptChanged) debug(`sync: system prompt append changed; importing pi history ${sessionTag(piSessionId)}`);
	const row = piSessionId == null ? 0 : !state ? (priors.length ? 2 : 1) : state.model !== modelId || promptChanged ? 3
		: cwdChanged ? 5
		: compared.equal && !state.dirtyTail ? 4 : !compared.cutCount ? 5 : compared.cutCount === priors.length ? 6 : 7;
	const reason = piSessionId == null ? "unattributed-history" : missingFile ? "missing-transcript" : !state ? "no-state"
		: state.model !== modelId ? "model-changed" : promptChanged ? "prompt-changed" : cwdChanged ? "cwd-changed"
		: row === 4 ? "equal-digests" : state.dirtyTail && compared.equal ? "dirty-tail" : "history-difference";
	const decision = (path: string, after: string) => {
		traceStrict("decision", {
			callId: traceCallId, piSessionId: piSessionId ?? null, row, path, reason,
			commonPrefix: compared.commonPrefix, cutCount: compared.cutCount,
			ccSessionBefore: before?.ccSessionId ?? null, ccSessionAfter: after, priors: priors.length,
			dirtyTail: Boolean(state?.dirtyTail), missingFile, cwdChanged, cwd, mirrorCwd: before?.cwd ?? null,
		});
		debug(`syncResult: path=${path} sessionId=${after} from=${before?.ccSessionId ?? "none"} priors=${priors.length} commonPrefix=${compared.commonPrefix} cutCount=${compared.cutCount} row=${row} ${sessionTag(piSessionId)}`);
	};
	if (row === 4) {
		decision("reuse", state!.ccSessionId);
		return { sessionId: state!.ccSessionId, targetSessionId: state!.ccSessionId, created: false, recorded: copyRecording(state!), state };
	}
	if (state) traceSnapshot({ callId: traceCallId, ccSession: state.ccSessionId, cwd: state.cwd, reason: "rebuild-rotate", writer: "no-known-writer" }, true);
	const session = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: modelId });
	const targetSessionId = session.sessionId;
	let recorded: Recording;
	let records = 0;
	if (row === 6 || row === 7) {
		const transcript = readTranscript(state!);
		const cut = resolveRecordingCut(transcript, state!, compared.cutCount);
		recorded = prefixRecording(state!, compared.cutCount);
		if (row === 6) {
			decision("fork", targetSessionId);
			return { sessionId: state!.ccSessionId, targetSessionId, created: true, forkAt: cut.uuid, recorded, state };
		}
		const rest = priors.slice(compared.cutCount);
		const replaced = transcript.slice(cut.index + 1);
		const suffix = importHistory(session, rest, customToolNameToSdk, collectCarriedAttachments(replaced), recordedToolResults(replaced, state!.digests, rest));
		recorded = { digests: [...recorded.digests, ...suffix.digests], uuids: [...recorded.uuids, ...suffix.uuids], cuttable: [...recorded.cuttable, ...suffix.cuttable] };
		records = savePrefixSession(session, transcript.slice(0, cut.index + 1), cut.uuid);
	} else {
		// Nothing is kept, but the old transcript's @file expansions and tool results
		// still belong to messages pi kept unchanged.
		const transcript = state ? readTranscript(state) : [];
		recorded = importHistory(session, priors, customToolNameToSdk, collectCarriedAttachments(transcript), recordedToolResults(transcript, state?.digests ?? [], priors));
		session.save();
		records = session.records.length;
	}
	if (records) verifyWrittenSession(session.jsonlPath, targetSessionId, records, cwd);
	decision(row === 7 ? "prefix-write" : records ? "rebuild" : "clean-start", targetSessionId);
	traceEvent("rebuild-written", { callId: traceCallId, piSessionId: piSessionId ?? null, ccSessionAfter: targetSessionId, records });
	debugSessionPaths(targetSessionId.slice(0, 8), cwd, session.jsonlPath);
	return { sessionId: records ? targetSessionId : null, targetSessionId, created: true, recorded, state };
}

// The SDK's query(), or a test double (see setQuery).
let queryImpl: typeof query = query;

// @internal
export const __test = {
	setQuery(fn: typeof query | null) {
		queryImpl = fn ?? query;
	},
	resetSharedSession(piSessionId?: string) {
		// No id: full reset (the pre-map semantics — tests start from a blank slate),
		// including the persisted pointers of ids this process used, and only those.
		if (piSessionId === undefined) {
			for (const id of knownSessionIds) deleteSessionState(id);
			knownSessionIds.clear();
			sharedSessions.clear();
			loadedSessionStates.clear();
		} else {
			setSessionStateFor(piSessionId, null);
			deleteSessionState(piSessionId);
		}
		historyRewrittenBySession.clear();
	},
	/** A restart: drop memory, keep every persisted pointer. */
	forgetSessionMemory() {
		sharedSessions.clear();
		loadedSessionStates.clear();
	},
	markRebuildForSession,
	historyRewrittenBySession,
	armStaleContexts,
	discardRewrittenQuery,
	contextForToolResults,
	get activeQueryContexts() {
		return activeQueryContexts;
	},
	setSharedSession(piSessionId: string, state: SessionState | null) {
		setSessionStateFor(piSessionId, state);
	},
	getSharedSession(piSessionId: string) {
		return sessionStateFor(piSessionId);
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
	},
	resetAskClaudeWarning() {
		askClaudeWarningShown = false;
	},
	toBridgeContext,
	isolatedStreamFn,
	effortForReasoning,
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	ccChildEnv,
	buildMcpServers,
	get promptCaptures() {
		return promptCaptures;
	},
};

// --- Provider helpers: tool name mapping ---

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	if (toolName.toLowerCase() === "edit") {
		const single = (value: unknown): boolean => Boolean(value && typeof value === "object"
			&& typeof (value as Record<string, unknown>).oldText === "string" && typeof (value as Record<string, unknown>).newText === "string");
		if (typeof result.edits === "string") {
			try {
				const parsed: unknown = JSON.parse(result.edits);
				if (Array.isArray(parsed)) result.edits = parsed;
				else if (single(parsed)) result.edits = [parsed];
			} catch { /* Invalid JSON is left for pi's argument validation. */ }
		} else if (single(result.edits)) result.edits = [result.edits];
	}
	return result;
}

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
setTraceNotifier((message) => {
	debug(message);
	piUI?.notify(message, "error");
});
let piMode: ExtensionContext["mode"] | null = null;
const activeQueryContexts = new Set<QueryContext>();

// Defaults that silently cost the user something (no Opus 1M on Max) are
// announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];
// Whoever had the old askClaude setting on lost the tool on upgrade. Warned at most once
// per module instance, which pi's per-session reruns of the factory below share.
let askClaudeWarningShown = false;

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot. One process-wide instance, shared
// across every extension module instance: isolated subagents re-evaluate this
// module, and the pinned stream they all route through resolves against it.
const promptCaptures = sharedPromptCaptures((diagnostic) => {
	const first = diagnostic.matches[0];
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

/** Close every query a shutting-down pi session still holds, keeping its progress
 *  for a later resume. Scoped to that session: subagents run in the parent's
 *  process and shut down while the parent's query is still live.
 *
 *  A live query here is expected: a tool that returns `terminate: true` ends pi's
 *  run with Claude Code still parked on its result, and that child would keep the
 *  process alive after pi is done (issue #210). A context with no query is a leak
 *  that costs something real: it routes a later orphaned tool result into the
 *  delivery path and returns a stream nobody ends. That leak was present on every
 *  single happy-path run and no test noticed, because nothing asserted that
 *  anything ends clean — so assert it where the real sessions are, and let
 *  diag/audit-warnings.mjs scan for it. */
function closeSessionQueries(piSessionId: string): void {
	for (const c of [...activeQueryContexts]) {
		if (c.piSessionId !== piSessionId) continue;
		debug(
			`${c.activeQuery ? "session_shutdown: closing parked query" : "WARNING: session_shutdown left a context with no query"} — `
			+ `pendingToolCalls=${c.pendingToolCalls.size} promptStream=${c.promptStream !== null}`,
		);
		discardRewrittenQuery(c);
	}
}

/** The parked query of this pi session that these results answer. Tool-call ids
 *  repeat across sessions whenever one copies another's history (a fork, a worker
 *  seeded from its host), so an id alone could deliver one session's turn into
 *  another's Claude Code query. */
function contextForToolResults(results: McpResult[], piSessionId: string | null): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.piSessionId !== piSessionId) continue;
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools = context.tools ?? [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();
	for (const tool of mcpTools) {
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext, toolPrompts: ToolPrompts): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: describeTool(tool.description, toolPrompts[tool.name]),
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Usage helpers ---

// One process serves several pi sessions at once (in-process subagents), so log
// lines diag/audit-cache.mjs pairs on carry the pi session they belong to.
function sessionTag(piSessionId: string | null | undefined): string {
	return `piSession=${piSessionId ?? "none"}`;
}

// The counter mapping lives in usage.ts; the debug line is this side's job, so every
// call site logs the same way rather than three times over.
function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>, piSessionId: string | null): void {
	const { cachePct, reasoning } = updateUsage(output, usage, model);
	const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id} ${sessionTag(piSessionId)}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	if (!DEBUG) return;
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
// ships a map for most Claude models; the table above covers models without
// one, and the levels a map leaves unnamed. A null entry means the level is
// unsupported on that model: no effort argument is sent, so Claude Code's own
// default applies rather than the generic table's value. Map values are
// provider-generic strings, so a map value is trusted only when it names a
// level CC accepts.
function effortForReasoning(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Completed SDK echoes are recorded even while no UI stream is attached.
// Each fresh query owns a separate context, including during discard/exit.

const completedStreams = new WeakSet<object>();

/** Push a stream's terminal event and end it. Marked complete before end():
 *  claimCurrentPiStream's stale-stream warning and bindRunSignal read the mark. */
function endStream(stream: AssistantMessageEventStream, event: AssistantMessageEvent): void {
	stream.push(event);
	completedStreams.add(stream);
	stream.end();
}

/** End the context's current pi stream with `event` and detach it. The caller
 *  must have checked that there is one. */
function endCurrentPiStream(c: QueryContext, event: AssistantMessageEvent): void {
	endStream(c.currentPiStream!, event);
	c.currentPiStream = null;
}

/** The turn stopped on a tool call: end pi's stream so pi runs the tool. */
function endToolUseTurn(c: QueryContext): void {
	c.turnOutput!.stopReason = "toolUse";
	recordAssistantEmission(c);
	endCurrentPiStream(c, { type: "done", reason: "toolUse", message: c.turnOutput! });
}

/** Append a complete text block to the turn and stream it to pi. */
function pushTextBlock(c: QueryContext, text: string): void {
	ensureTurnStarted(c);
	c.turnBlocks.push({ type: "text", text });
	const idx = c.turnBlocks.length - 1;
	c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
	c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: c.turnOutput });
	c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: c.turnOutput });
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
	c.currentOnResponse = options?.onResponse;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

/** Snapshot only messages actually emitted with done. SDK completed blocks
 * can arrive before or after done; equality proves the whole step is covered. */
function recordAssistantEmission(c: QueryContext): void {
	const output = c.turnOutput;
	if (!output || output.stopReason === "error" || output.stopReason === "aborted" || c.turnEmissionRecorded) return;
	c.turnEmissionRecorded = true;
	const id = c.turnStreamMessageId ?? c.lastAssistantMessageId;
	if (!id) {
		c.recording.gap();
		debug("recording gap: emitted assistant has no completed SDK message id");
		return;
	}
	let step = c.assistantSteps.get(id);
	if (!step) c.assistantSteps.set(id, step = { content: [], seen: new Set() });
	if (!step.emitted) {
		const digest = digestMessage(output);
		const toolCalls = output.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		const ids = c.turnAssistantIds.length ? [...c.turnAssistantIds] : [id];
		step.emitted = { digest, index: c.recording.assistant(digest, toolCalls, undefined, output.content.length > 0), template: { ...output, content: [] }, ids };
		for (const apiId of ids) {
			const part = c.assistantSteps.get(apiId);
			if (part) part.emitted = step.emitted;
		}
	}
	completeAssistantRecording(c, step);
}

function completeAssistantRecording(c: QueryContext, step: AssistantStep): void {
	if (!step.emitted) return;
	const parts = step.emitted.ids.map((id) => c.assistantSteps.get(id));
	const last = parts.at(-1);
	if (parts.every((part) => part?.uuid) && last?.uuid
		&& digestMessage({ ...step.emitted.template, content: parts.flatMap((part) => part!.content) }) === step.emitted.digest) {
		c.recording.completeAssistant(step.emitted.index, last.uuid);
	} else debug(`recording gap: emitted assistant is not fully covered by completed SDK messages (${step.emitted.ids.join(",")})`);
}

/** CC took this input into a turn: record it, and drop it from the steers that
 * keep stdin open. Stdin still stays open until that turn's result, since its
 * MCP calls need it. Returns whether it was still pending. */
function incorporate(c: QueryContext, uuid: string): boolean {
	const recorded = c.recording.acknowledge(uuid);
	return c.pendingSteerUuids.delete(uuid) || recorded;
}

/** Recording precedes the UI guard: echoes after a tool boundary still belong
 * to the emitted step, not to whatever stream is currently attached. */
function tapRecording(message: SDKMessage, names: Map<string, string>, c: QueryContext): void {
	if ((message.type === "assistant" && message.parent_tool_use_id === null && message.message.model !== "<synthetic>")
		|| (message.type === "stream_event" && message.parent_tool_use_id === null && ["content_block_start", "content_block_delta"].includes(message.event.type))) {
		c.recording.assistantObserved();
		// CC persists a turn's opening input before calling the API but never
		// replays one holding its own tags (e.g. <task-notification>), so the turn's
		// first output incorporates it.
		if (c.turnOpener && incorporate(c, c.turnOpener)) debug(`recording: turn opener ${c.turnOpener} was never replayed; its first output acknowledges it`);
		c.turnOpener = undefined;
	}
	if (message.type === "result") c.turnOpener = c.pendingSteerUuids.values().next().value;
	if (message.type === "user" && message.parent_tool_use_id === null && message.uuid) {
		if ("isReplay" in message && message.isReplay === true) incorporate(c, message.uuid);
		if (Array.isArray(message.message.content)) for (const block of message.message.content) {
			if (block.type === "tool_result") c.recording.result(block.tool_use_id, message.uuid);
		}
	}
	if (message.type !== "assistant" || message.parent_tool_use_id !== null || message.message.model === "<synthetic>" || message.aborted) return;
	const id = message.message.id;
	let step = c.assistantSteps.get(id);
	if (!step) c.assistantSteps.set(id, step = { content: [], seen: new Set() });
	if (step.seen.has(message.uuid)) return;
	step.seen.add(message.uuid);
	if (!step.emitted) c.lastAssistantMessageId = id;
	for (const block of message.message.content) {
		if (block.type === "text" && block.text) step.content.push({ type: "text", text: block.text });
		else if (block.type === "thinking") step.content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
		else if (block.type === "tool_use") {
			const name = piToolNameFor(block.name, names);
			if (name) step.content.push({ type: "toolCall", id: block.id, name, arguments: mapToolArgs(name, block.input as Record<string, unknown>) } as AssistantMessage["content"][number]);
		}
	}
	step.uuid = message.uuid;
	completeAssistantRecording(c, step);
}

function finalizeCurrentStream(c: QueryContext): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	if (c.turnOutput.stopReason === "error") {
		endCurrentPiStream(c, { type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = c.turnOutput.stopReason === "length" ? "length" : "stop";
		recordAssistantEmission(c);
		endCurrentPiStream(c, { type: "done", reason, message: c.turnOutput });
	}
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		// Still open from an earlier message_start: Claude Code gave up on that
		// stream and is retrying it. Its blocks were never completed.
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		if (c.turnStreamMessageId && !c.turnAssistantIds.includes(c.turnStreamMessageId)) c.turnAssistantIds.push(c.turnStreamMessageId);
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model, c.piSessionId);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) recordUsage(c.turnOutput, event.usage, model, c.piSessionId);
		return;
	}

	if (event?.type === "message_stop") {
		dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
		c.turnStreamOpen = false;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		endToolUseTurn(c);
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

/** Remove the blocks of the message that just stopped which never got their own
 *  content_block_stop, because the stream was cut inside them. A tool call left
 *  that way carries whatever JSON survived the cut — `{}` when no delta landed at
 *  all — under an id Claude Code drops from its own conversation before resuming
 *  the turn, so it will never dispatch that id and nothing could answer a result
 *  keyed to it; pi would reject the call, and its result would sit unmatched while
 *  the resumed call waited in a handler. A thinking block left that way has no
 *  signature.
 *
 *  Per block rather than per message: Claude Code keeps the blocks that did
 *  complete, tool calls included, and one it dispatched while pi was never told is
 *  the same deadlock the other way round. Nothing here ends the pi turn — with no
 *  finished tool call left the resume is more of this same turn, and a turn ended
 *  here would leave the real call with no stream to arrive on. */
function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
	const dropped: string[] = [];
	for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
		// `index` is deleted at content_block_stop, so it marks a block that never closed.
		if (c.turnBlocks[i].index === undefined) continue;
		dropped.push(`${c.turnBlocks[i].type}${c.turnBlocks[i].id ? `[${c.turnBlocks[i].id}]` : ""}`);
		c.turnBlocks.splice(i, 1);
	}
	if (!dropped.length) return;
	debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.reverse().join(",")}`);
	c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
}

/** Remove the blocks a stream Claude Code abandoned mid-message. Their own
 *  content_block_stop never came, so a thinking block has no signature and a tool
 *  call is one CC will never dispatch; left in, pi would run the tool and the turn
 *  would wait on a handler that never comes, or the next request would replay a
 *  broken block.
 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
 *  rejects a repeated start, so it would need a change there to drive this provider. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	c.turnAssistantIds = c.turnAssistantIds.filter((id) => id !== c.turnStreamMessageId);
	debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks
// again without streaming ("Error streaming, falling back to non-streaming mode"),
// and the answer arrives one assistant message per content block, all under a new
// message id, with no stream_events of its own. turnSawStreamEvent is already set
// by the dead stream, so gating on it alone dropped that message: its tool calls
// never reached pi, CC sat in the MCP handler waiting for their results, and the
// turn hung on "Working" until the user aborted it.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	// Claude Code reports API failures and its own quota/context notices as a
	// `<synthetic>` assistant message: a report, not model output. Streaming its text
	// pins the turn's output before the failure it describes, and a consumer that only
	// fails over before output commits (pi-model-fallback-alias) then cannot reach the
	// next provider. Keep the wording on the failed turn — the error event carries it —
	// but emit no events, so the turn still reads as a call that produced no output.
	// Issue #162.
	if (assistantMsg.model === "<synthetic>") {
		// The report can follow a stalled stream whose non-streaming retry also failed;
		// drop the abandoned partial blocks (unsigned thinking, a tool call CC will never
		// dispatch) the way the fallback path below would.
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c, "synthetic failure report");
		debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
			else debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model, c.piSessionId);
		return;
	}
	const id = assistantMsg.id;
	if (c.turnSawStreamEvent && (!id || id !== c.turnFallbackMessageId)) {
		// Same id was already delivered; a new id is CC's non-streaming fallback.
		// Drop the stalled stream's partial blocks if it never stopped. Deliberately
		// deliver even if it stopped, at the risk of duplication if CC renumbers it.
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
		c.turnFallbackMessageId = id;
	}
	// Later blocks of the same id continue the message rather than starting it over.
	if (id !== c.turnStreamMessageId) {
		c.turnStreamMessageId = id;
		if (id && !c.turnAssistantIds.includes(id)) c.turnAssistantIds.push(id);
		c.turnToolCallIds = [];
	}
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			pushTextBlock(c, block.text);
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model, c.piSessionId);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) endToolUseTurn(c);
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string; failure?: Error }> {
	const { traceQueryId } = queryCtx;
	let capturedSessionId: string | undefined;
	let failure: Error | undefined;

	for await (const message of sdkQuery) {
		// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery
		// sees, one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to
		// capture replay fixtures, so unit tests assert against message shapes Claude
		// Code really emitted rather than ones we imagined.
		const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;
		if (recordStreamPath) appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`);
		if (wasAborted() || queryCtx.discarded) break;
		tapRecording(message, customToolNameToPi, queryCtx);
		await reportHeldRateLimit(queryCtx, model);
		if (wasAborted() || queryCtx.discarded) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. Handle lifecycle
		// messages before that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary
		//   logged nothing. It fails turnOutput only while the turn's stream is
		//   open; once ended, turnOutput is the message pi already recorded.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		if (message.type === "stream_event" && (message as any).event?.type === "message_start") {
			const started = (message as any).event.message;
			traceEvent("api-message", { queryId: traceQueryId, apiMessageId: started?.id ?? null, model: started?.model ?? null, usage: started?.usage ?? null });
		}
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.sawResult = true;
			traceEvent("query-result", { queryId: traceQueryId, subtype: message.subtype, isError: (message as any).is_error ?? null, ccSession: message.session_id, numTurns: (message as any).num_turns ?? null, usage: (message as any).usage ?? null });
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			// A result ends a turn, not necessarily the query: steers not yet replayed
			// can still start a later turn.
			if (resultError !== undefined || queryCtx.pendingSteerUuids.size === 0) queryCtx.promptStream?.end();
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput && queryCtx.currentPiStream) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
				// The failure ends the query. Closing stdin does not: Claude Code still
				// runs a steer it had queued, and that turn's stop reason would overwrite
				// this one. The caller commits and tears the query down as a failed one.
				failure = new Error(resultError);
				break;
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info) {
				queryCtx.heldRateLimit = info;
				recordHeadlessReading(info, message.session_id, (error) => debug("usage ledger: append failed", error));
			}
			await reportHeldRateLimit(queryCtx, model);
			if (wasAborted() || queryCtx.discarded) break;
			if (info?.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
				// The "rate limit reached" notice below supersedes warnings; re-arm so the next
				// window's warnings fire even if it opens straight into allowed_warning.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
				// resetsAt is Unix seconds, not milliseconds.
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : undefined;
				// isUsingOverage: the plan limit is hit but Extra Usage is serving (and billing) requests.
				piUI?.notify(info.isUsingOverage
					? `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — requests are now billed to Extra Usage${resetsAt ? ` until ${resetsAt}` : ""}`
					: `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt ?? "unknown"}`, "warning");
			} else if (info?.status === "allowed") {
				// Back under the threshold (window reset) — re-arm the warning dedupe.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
			} else if (info?.status === "allowed_warning") {
				// utilization is a fraction (0..1); allowed_warning fires once it crosses surpassedThreshold.
				const percent = Math.round((info.utilization ?? 0) * 100);
				// The SDK emits one event per request, so only re-notify when the level
				// rises past a new 5% step or the threshold changes.
				const step = Math.floor(percent / 5);
				const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
				if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
					queryCtx.lastRateLimitWarnStep = step;
					queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
					piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
				}
			}
			continue;
		}
		if (message.type === "system" && message.subtype === "init") {
			capturedSessionId = message.session_id;
			traceEvent("query-init", { queryId: traceQueryId, ccSession: capturedSessionId, claudeCodeVersion: message.claude_code_version });
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				// A completed echo can trail tool-result delivery. Record it for
				// its original step, never render it again into the new pi stream.
				if (!queryCtx.assistantSteps.get(message.message.id)?.emitted) processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
				// The failure itself was recorded above the guard, along with the served
				// context window. What is left here is the success path: push the result
				// text when no assistant message already delivered it.
				if (resultError === undefined && !queryCtx.turnSawStreamEvent && !queryCtx.turnStarted && message.subtype === "success") {
					pushTextBlock(queryCtx, message.result || "");
				}
				break;
			}
			case "system":
				break;
			case "user":
				// Prompt/tool-result echoes have no content events to emit. With
				// replay-user-messages, queued steers also arrive as user replays;
				// their lifecycle acknowledgement is handled above the stream guard.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId, failure };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
	messages?: Context["messages"],
): Promise<void> {
	if (messages) c.recording.results(messages);
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
		} else {
			const uuid = randomUUID();
			// Register before awaiting stdin: a result can arrive during the write.
			c.pendingSteerUuids.add(uuid);
			if (messages) c.recording.users(messages, turnStart(messages), uuid, false);
			try {
				await c.promptStream.push({ ...userMessage(steer, "next"), uuid });
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// No replay acknowledgement means no coverage slot. The next sync
				// imports the steer from pi instead of trusting this write.
				c.pendingSteerUuids.delete(uuid);
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			if (DEBUG) debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** The prompt a continuation query is opened with: the pi turn goes on, but its
 *  last message is a tool result rather than a prompt, and query() cannot resume
 *  a session without one. */
const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";

/** The prompt a resumed tool result is opened with: no query of this process
 *  was parked on it (a restart, a crash, a stall), so the turn goes on from
 *  history that ends at the result. */
const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

/** Drop a Claude Code query parked at a tool boundary whose conversation pi has
 *  since rewritten (/compact, tree navigation).
 *
 *  Delivering the turn's tool result into that query hands Claude Code the
 *  context pi just shrank: one pi turn is one CC query, and the query keeps its
 *  own context inside the CLI whatever pi does to its transcript. It answers off
 *  the pre-compaction conversation, reports the pre-compaction usage back, and pi
 *  crosses the same threshold at the next boundary — measured as one compaction
 *  per tool call with usage never dropping (issue #101). Dirty-tail marking
 *  alone does not prevent it: tool-result delivery never runs session sync.
 *
 *  The caller then takes the fresh-query path, where REBUILD imports pi's
 *  rewritten history — this tool result included, since it is already in that
 *  history — so the turn continues instead of ending here. Nothing is lost by
 *  killing the subprocess: pi owns the only copy of the conversation that counts. */
function discardRewrittenQuery(c: QueryContext): void {
	// A failed commit reaches the caller, but never leaves the query parked.
	try { c.commitRecording?.(true); }
	finally { dropParkedQuery(c); }
}

function dropParkedQuery(c: QueryContext): void {
	c.discarded = true;
	c.activeQuery = null;
	activeQueryContexts.delete(c);
	c.turnToolCallIds = [];
	c.promptStream?.fail(new Error("conversation rewritten"));
	c.promptStream = null;
	c.releasePendingToolCalls("Context changed; this query was discarded.");
	// Null when no query is running (a context discarded before launch).
	c.stopProcess?.();
	if (c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage = "Conversation replaced";
		endCurrentPiStream(c, { type: "error", reason: "error", error: c.turnOutput });
	}
	if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
	debug("provider: discarded parked query; its recorded prefix remains available for a fork");
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	showStartupNoticeOnce();
	// pi hands providers a transcript (prompt/tools folded into system messages) — fold it
	// back out to the prompt/tools fields every syncSharedSession call and
	// prompt-capture lookup below assumes (issue #106).
	const traceCallId = traceId("call");
	const sourceContext = context;
	context = toBridgeContext(context);
	traceInput(traceCallId, sourceContext, context, model, options);

	// Pi's compaction, branch-summary and bug-report calls use cacheRetention:"none"
	// in completeSummarization. Their prompts bypass the capture boundaries, so route
	// them to an isolated persistSession:false CC process without session sync.
	if (options?.cacheRetention === "none") {
		debug(`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`);
		traceEvent("route", { callId: traceCallId, route: "isolated-summary" });
		return isolatedStreamFn(model, context, options, traceCallId);
	}

	const stream = createAssistantMessageEventStream();
	// Report a failure before any query exists on the stream, as pi-ai's provider
	// contract expects, rather than as a synchronous exception.
	const failBeforeQuery = (err: unknown) => {
		const output = newAssistantOutput(model, "", "error", errorMessage(err));
		queueMicrotask(() => endStream(stream, { type: "error", reason: "error", error: output }));
		traceEvent("route", { callId: traceCallId, route: "failed-before-query", error: errorMessage(err) });
		return stream;
	};

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeContexts=${activeQueryContexts.size}, lastMsgRole=${lastMsgRole}`);

	let activeQuery = activeQueryContexts.size > 0;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults, options?.sessionId ?? null) : undefined;

	// pi rewrote its history while this query sat parked at a tool boundary, so the
	// query answers about a conversation that no longer exists. Discard it and let
	// this tool result carry the turn into a fresh query over the rewritten history.
	// The staleness mark is per pi session: a subagent's compaction (its own
	// AgentSession, sharing this process) must not discard the parent's parked
	// query, and vice versa. Extensions can also edit the selected history without
	// a rewrite event; compare the live prefix before feeding this query a result.
	let divergence: ReturnType<LiveRecording["divergence"]>;
	try {
		divergence = resultCtx && !resultCtx.historyStale ? resultCtx.recording.divergence(nonSystemMessages(context.messages)) : undefined;
	} catch (error) {
		// A history that can't be checked can't continue the query either.
		traceEvent("route", { callId: traceCallId, route: "discard-rewritten", queryId: resultCtx!.traceQueryId, reason: "digest-error" });
		try { discardRewrittenQuery(resultCtx!); }
		catch (discardError) { return failBeforeQuery(discardError); }
		return failBeforeQuery(error);
	}
	const rewrittenUnderQuery = Boolean(resultCtx && (resultCtx.historyStale || divergence !== undefined));
	if (resultCtx && rewrittenUnderQuery) {
		traceEvent("route", {
			callId: traceCallId, route: "discard-rewritten", queryId: resultCtx.traceQueryId,
			reason: resultCtx.historyStale ? "rewrite-event" : "history-diverged", divergence,
		});
		try { discardRewrittenQuery(resultCtx); }
		catch (error) { return failBeforeQuery(error); }
		resultCtx = undefined;
		// Recomputed, not cleared: a reentrant subagent may still hold a query of its own.
		activeQuery = activeQueryContexts.size > 0;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx, options);
		resultCtx.resetTurnState(model);
		resultCtx.bindRunSignal?.(options?.signal, stream);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		traceEvent("route", { callId: traceCallId, route: "tool-result", queryId: resultCtx.traceQueryId, signal: traceSignalId(options?.signal), results: allResults.map((r) => r.toolCallId), steer: Boolean(steer) });
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length, context.messages);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message. The discard
	// branch above already siphoned off the stale-query case, which goes on to a
	// rebuild instead — that one has somewhere to deliver the result to.
	// Only when this call's own signal is aborted: after an abort during a tool
	// call, pi calls back with the run's (already aborted) signal. A result that
	// arrives otherwise -- after a restart (a durable host resuming a run), a
	// crash, a stall, or an overflow/quota retry -- has no parked query either, and
	// falls through to the fresh-query path, which resumes the CC session and
	// delivers it.
	const lastMsg = context.messages[context.messages.length - 1];
	const unparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
	if (unparkedToolResult && options?.signal?.aborted) {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		traceEvent("route", { callId: traceCallId, route: "orphan-after-abort" });
		// No query owns this result, so there is no context to reset: resetTurnState
		// on a live parent's context would replace its turnOutput mid-stream,
		// stranding the blocks it had already emitted.
		const message = newAssistantOutput(model, "", "stop");
		queueMicrotask(() => endStream(stream, { type: "done", reason: "stop", message }));
		return stream;
	}

	// A fresh request replaces a parked query of this same pi session. Its
	// synchronous progress commit happens before sync takes a state identity.
	try {
		if (options?.sessionId) for (const parked of [...activeQueryContexts]) {
			if (parked.piSessionId === options.sessionId) discardRewrittenQuery(parked);
		}
	} catch (error) { return failBeforeQuery(error); }

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = new QueryContext();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt fails this query before anything
	// is claimed or reset, leaving no half-built query behind — in particular no stream
	// claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	// Derive the key from the transcript replay (toBridgeContext), NOT from the
	// recorded keys: under a forced prompt the transcript head is projected via
	// transformContext after turn_start, so ctx.getSystemPrompt() is not the head.
	let promptCapture: PromptCapture | undefined;
	let systemPromptAppend: string | undefined;
	try {
		traceAssertReady();
		promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
		systemPromptAppend = promptCapture
			? projectPromptCapture(promptCapture, {
				hasReadTool: mcpTools.some((tool) => tool.name === "read"),
			})
			: undefined;
	} catch (err) {
		// resolveOrDerive and projectPromptCapture throw to stop a turn that would lose
		// its instructions or leak pi's harness text. Report it on the stream, as pi-ai's
		// provider contract expects, so any caller — not only pi's agent loop, which
		// catches a throw — sees a failed turn rather than a synchronous exception.
		diagDump("prompt_capture_unresolved", {
			promptChars: context.systemPrompt?.length ?? 0,
			knownKeys: promptCaptures.size,
			reentrantUserQuery: isReentrantUserQuery,
			error: errorMessage(err),
		});
		return failBeforeQuery(err);
	}

	queryCtx.piSessionId = options?.sessionId ?? null;
	queryCtx.resetTurnState(model);
	claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
	activeQueryContexts.add(queryCtx);
	let createdBeforeLaunch: { id: string; cwd: string } | undefined;
	void (async () => {
		await waitForSessionWriter(sessionStateFor(queryCtx.piSessionId)?.ccSessionId, options?.signal);
		if (queryCtx.discarded) return;

		const traceQueryId = queryCtx.traceQueryId = traceId("query");

		const cwd = sessionCwdFor(options?.sessionId);
		// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
		// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
		const cliModel = claudeCodeModelId(model, longContextSettings);
		// Which pi session this query serves — the attribution key for history
		// rewrites (session_compact / session_tree) and for SessionState above.
		const piSessionId = options?.sessionId ?? null;
		// Read before the consume below: with no query parked (an overflow retried
		// after compaction), the session's mark is the only sign of the rewrite.
		const historyRewritten = rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId));
		const promptDigest = createHash("sha256").update(systemPromptAppend ?? "").digest("hex");
		const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId, traceCallId, promptDigest);
		if (syncResult.created) createdBeforeLaunch = { id: syncResult.targetSessionId, cwd };
		// This query starts from the history pi has now: consume this session's
		// armed rewrite — a sibling pi session's stays armed for its own queries.
		if (piSessionId) historyRewrittenBySession.delete(piSessionId);
		const { sessionId: resumeSessionId } = syncResult;
		const recording = queryCtx.recording = new LiveRecording(syncResult.recorded, nonSystemMessages(context.messages));
		const promptBlocks = extractUserPromptBlocks(context.messages);
		let promptText = extractUserPrompt(context.messages) ?? "";

		// A turn continuing past a rewrite ends at its tool result, not at a
		// prompt, so say what happened rather than falling into the empty-prompt
		// recovery below — that one is for a shape we do not expect, and this is one
		// we do. The rebuilt session already ends with the tool result, placed after
		// the tool call it answers.
		if (historyRewritten && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_REWRITE_PROMPT;
			debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
		}
		if (unparkedToolResult && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_RESUME_PROMPT;
			debug(`provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
		}

		// Guard: empty prompt means the last context message isn't a user message.
		// This should never happen with per-query state — dump diagnostics if it does.
		if (!promptText && !promptBlocks) {
			diagDump("empty_prompt", {
				contextLength: context.messages.length,
				lastMsgRole: lastMsg?.role,
				isReentrant,
				activeQueryContexts: activeQueryContexts.size,
				activeQueryExists: queryCtx.activeQuery !== null,
				sharedSession: sessionStateFor(piSessionId),
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
		const promptUuid = randomUUID();
		// A durable tool-result continuation has no user slot. Its synthetic
		// instruction belongs to the following assistant's boundary, not the
		// imported prior result: cuts before that assistant stop before the prompt.
		// Like a steer, the prompt is recorded only on CC's replay acknowledgement
		// or, when CC never replays it, on the query's first output (tapRecording):
		// a stdin write does not prove CC persisted its record.
		recording.users(context.messages, turnStart(context.messages), promptUuid, false, false);
		queryCtx.turnOpener = promptUuid;
		void promptStream.push({ ...userMessage(promptBlocks ?? [{ type: "text", text: promptText }]), uuid: promptUuid })
			.catch((error) => debug(`provider: initial prompt push rejected:`, error));
		queryCtx.promptStream = promptStream;
		const mcpServers = buildMcpServers(mcpTools, queryCtx, promptCapture ? collectToolPrompts(promptCapture) : {});

		// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
		// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
		// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
		// programmatically and ignore filesystem MCP entries.
		const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
		const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

		const effort = effortForReasoning(model, options?.reasoning);

		const extraArgs: Record<string, string | null> = { "replay-user-messages": null };
		// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
		// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
		if (effort) extraArgs["thinking-display"] = "summarized";

		// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
		// when the user is logged into Anthropic). These are a separate code path from
		// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources.
		// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
		// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
		// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
		// /compact via session_compact (see handler in default export). Letting CC
		// also autocompact would double-flush the prompt cache and races pi's
		// threshold with CC's, including CC's anti-thrashing guard (issue #8).
		// Manual /compact in CC still works (we never invoke it).
		const childEnv = traceQueryStart(traceQueryId, {
			kind: "provider", callId: traceCallId, piSessionId, reentrant: isReentrant, resume: resumeSessionId ?? null,
			model: cliModel, effort: effort ?? null, servedToolNames: Object.fromEntries(customToolNameToSdk), mcpTools: mcpTools.map((t) => t.name),
			signal: traceSignalId(options?.signal), digests: { systemPromptAppend },
		}, ccChildEnv(options?.env));
		const cliDebug = makeCliDebugOptions("provider");
		const childProcess = new QueryProcess(cliDebug.stderr);
		const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
			cwd,
			env: childEnv,
			tools: [],
			permissionMode: "bypassPermissions",
			includePartialMessages: true,
			// User settings only. A repo's .claude/settings.json and settings.local.json can
			// carry hooks, apiKeyHelper, env and plugins, and Claude Code trusts the workspace
			// when it isn't interactive, so they would run with no prompt. ~/.claude/settings.json
			// still loads: Bedrock/Vertex users keep env and apiKeyHelper there.
			settingSources: ["user"] as SettingSource[],
			// includeGitInstructions:false drops the gitStatus block from the preset.
			// That block is the trailing suffix of the cached system block, and a
			// git-state transition (new file, staging, commit) rewrites it — busting
			// the prompt cache for the whole conversation from there on (see
			// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
			// hit on every transition. Cost here is nil: the setting also strips
			// CC's git-workflow guidance from its Bash tool prompt, but the provider
			// path runs CC with `tools: []`, so those definitions never ship.
			settings: {
				...claudeCodeSettings(providerSettings),
				claudeMdExcludes: CLAUDE_MD_EXCLUDES,
				includeGitInstructions: false,
				// The user's Claude Code hooks are written for Claude Code sessions, and their
				// output would land in pi's conversation as if pi had sent it.
				disableAllHooks: true,
				// A user's output style is persona text written for standalone Claude Code; pi owns the persona here.
				outputStyle: "default",
			},
			systemPrompt: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
			},
			model: cliModel,
			strictMcpConfig: strictMcpConfigEnabled,
			extraArgs,
			...(effort ? { effort } : {}),
			...(mcpServers ? { mcpServers } : {}),
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(syncResult.forkAt ? { forkSession: true, resumeSessionAt: syncResult.forkAt } : {}),
			// --session-id names a fresh launch or a fork's target; a prewritten
			// import resumes its own id, and CC rejects --session-id beside it.
			...(syncResult.created && (!resumeSessionId || syncResult.forkAt) ? { sessionId: syncResult.targetSessionId } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...cliDebug,
			spawnClaudeCodeProcess: childProcess.spawn,
		};

		debug("provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
			`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled} ${sessionTag(queryCtx.piSessionId)}`,
			`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

		// 3. Start SDK query and claim it for this context
		let wasAborted = false;
		const stopWriting = () => { sessionWriters.set(syncResult.targetSessionId, childProcess.exited); };
		// Only while the slot is still ours: a later query may already have claimed it.
		const releaseWriter = () => {
			if (sessionWriters.get(syncResult.targetSessionId) === childProcess.exited) sessionWriters.delete(syncResult.targetSessionId);
		};
		let sdkQuery: ReturnType<typeof query>;
		try { sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions }); }
		catch (error) {
			stopWriting();
			childProcess.terminate();
			await childProcess.exited;
			releaseWriter();
			// The outer catch deletes the session this sync created (createdBeforeLaunch).
			throw error;
		}
		createdBeforeLaunch = undefined;
		let expectedState = syncResult.state;
		/** The latest snapshot this query committed and has not saved yet. */
		let unsaved: SessionState | null = null;
		// Every commit ends this query's writing (abort, discard, failure, completion),
		// so later readers of its file wait for the child to exit. Memory is
		// authoritative at once; the file is saved after exit (persistRecording).
		const commitRecording = (dirty: boolean) => {
			stopWriting();
			// Costs the next turn a prefix-write; diag/audit-cache.mjs fails on it.
			if (!dirty && (recording.hasGaps || (syncResult.created && !recording.hasProgress))) debug(`recording: clean end left messages unrecorded ${sessionTag(piSessionId)}`);
			if (piSessionId == null || sessionStateFor(piSessionId) !== expectedState || (syncResult.created && !recording.hasProgress)) return;
			const state: SessionState = { ...copyRecording(recording.recorded), ccSessionId: syncResult.targetSessionId, cwd, model: cliModel, promptDigest,
				dirtyTail: dirty || queryCtx.historyStale || recording.hasGaps };
			setSessionStateFor(piSessionId, state);
			expectedState = unsaved = state;
			traceEvent("session-recorded", { queryId: traceQueryId, piSessionId, ...state });
		};
		// A replayed uuid can precede its record on disk, so a pointer saved before
		// exit could outlive a crash naming records that never land. Save once per
		// snapshot, after the child exits, and only while it is still the current one.
		const persistRecording = async () => {
			sdkQuery.close();
			childProcess.close();
			await childProcess.exited;
			const state = unsaved;
			unsaved = null;
			if (state && sharedSessions.get(piSessionId!) === state) saveSessionState(piSessionId!, state);
		};
		queryCtx.commitRecording = commitRecording;
		queryCtx.activeQuery = sdkQuery;

		// 4. Capture context for abort handling
		const abortCtx = queryCtx;

		const requestAbort = () => {
			stopWriting();
			// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
			// Both are needed — interrupt alone lets the current API call finish.
			void sdkQuery.interrupt().catch(() => {});
			try { sdkQuery.close(); } catch {}
			childProcess.close();
		};
		queryCtx.stopProcess = requestAbort;
		const onAbort = () => {
			if (wasAborted) return;
			wasAborted = true;
			// The final snapshot for an aborted query; a failed commit still tears it
			// down, then surfaces.
			try { commitRecording(true); }
			finally {
				activeQueryContexts.delete(abortCtx);
				abortCtx.turnToolCallIds = [];
				traceEvent("query-abort", { queryId: traceQueryId });
				drainForAbort(abortCtx, promptStream);
				requestAbort();
			}
		};
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		// A later run continuing this query from a tool result brings its own signal;
		// only the latest one is bound, and it is unbound when the query ends. Its abort
		// counts only while that run's stream is live: hosts that abort each request's
		// signal after it ends would otherwise kill the query parked at the next tool call.
		let unbindRunSignal = () => {};
		const bindRunSignal = (signal: AbortSignal | undefined, runStream: AssistantMessageEventStream) => {
			unbindRunSignal();
			unbindRunSignal = () => {};
			if (!signal || signal === options?.signal) return;
			const onRunAbort = () => {
				traceEvent("run-signal-abort", { queryId: traceQueryId, signal: traceSignalId(signal), runStreamEnded: completedStreams.has(runStream as object) });
				if (!completedStreams.has(runStream as object)) onAbort();
			};
			if (signal.aborted) return onRunAbort();
			signal.addEventListener("abort", onRunAbort, { once: true });
			unbindRunSignal = () => signal.removeEventListener("abort", onRunAbort);
		};
		queryCtx.bindRunSignal = bindRunSignal;

		// Ends the live pi stream with a query failure.
		const failStream = (error: unknown) => {
			queryCtx.activeQuery = null;
			activeQueryContexts.delete(queryCtx);
			traceEvent("query-end", { queryId: traceQueryId, outcome: wasAborted ? "aborted" : "error", error: errorMessage(error) });
			if (queryCtx.turnOutput && queryCtx.currentPiStream) {
				queryCtx.turnOutput.stopReason = wasAborted ? "aborted" : "error";
				queryCtx.turnOutput.errorMessage ??= errorMessage(error);
				endCurrentPiStream(queryCtx, { type: "error", reason: wasAborted ? "aborted" : "error", error: queryCtx.turnOutput });
			}
		};
		// A query failure (SDK rejection, error result, abort). onAbort already
		// committed an aborted query's final snapshot. Its save follows child exit
		// in the finally below; a failure there is fatal, never retried.
		const failQuery = (error: unknown) => {
			if (queryCtx.discarded) return;
			try { if (!wasAborted) commitRecording(true); }
			finally { failStream(error); }
		};

		// Background consumer — its recording and CAS token belong to this query.
		void consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
			.then(async ({ capturedSessionId, failure }) => {
				if (queryCtx.discarded) return;
				if (capturedSessionId && capturedSessionId !== syncResult.targetSessionId) {
					// A protocol violation is fatal and commits nothing, but the turn still ends.
					const error = new Error(`Claude Code initialized unexpected session ${capturedSessionId}; expected ${syncResult.targetSessionId}`);
					failStream(error);
					throw error;
				}
				if (failure) return failQuery(failure);
				if (wasAborted || options?.signal?.aborted) return failQuery(new Error("Operation aborted"));
				if (queryCtx.currentPiStream) recordAssistantEmission(queryCtx);
				commitRecording(!queryCtx.sawResult);
				// Completion waits for the save, so a failed one ends the turn with it.
				try { await persistRecording(); }
				catch (error) {
					failStream(error);
					throw error;
				}
				if (wasAborted) return failQuery(new Error("Operation aborted"));
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
				finalizeCurrentStream(queryCtx);
				traceEvent("query-end", { queryId: traceQueryId, outcome: "complete", ccSession: syncResult.targetSessionId });
			}, failQuery)
			.finally(async () => {
				options?.signal?.removeEventListener("abort", onAbort);
				unbindRunSignal();
				queryCtx.bindRunSignal = null;
				queryCtx.commitRecording = null;
				queryCtx.stopProcess = null;
				promptStream.fail(new Error("query ended"));
				queryCtx.promptStream = null;
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
				stopWriting();
				try { await persistRecording(); }
				finally {
					if (syncResult.created && !recording.hasProgress) deleteSession(syncResult.targetSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					releaseWriter();
				}
			});

	})().catch((error) => {
		if (createdBeforeLaunch) deleteSession(createdBeforeLaunch.id, createdBeforeLaunch.cwd, process.env.CLAUDE_CONFIG_DIR);
		queryCtx.promptStream?.fail(error instanceof Error ? error : new Error(errorMessage(error)));
		queryCtx.promptStream = null;
		if (queryCtx.discarded) return;
		activeQueryContexts.delete(queryCtx);
		const output = newAssistantOutput(model, "", options?.signal?.aborted ? "aborted" : "error", errorMessage(error));
		endStream(stream, { type: "error", reason: output.stopReason as "error" | "aborted", error: output });
		queryCtx.currentPiStream = null;
	});
	return stream;
}

// --- Extension registration ---

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	debug(`bridge: version=${BRIDGE_VERSION} sdk=${packageVersion("@anthropic-ai/claude-agent-sdk")} pi=${PI_VERSION}`);
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);
	if (registeredModels.length === 0) {
		console.error("claude-bridge: no models available from pi-ai's anthropic catalog — update @earendil-works/pi-ai (requires >=0.86.1)");
	}

	if (!config.startupNoticeShown && config.provider?.plan === undefined) {
		pendingNotices.push('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
	}

	// Pi session lifecycle events: drop the stream registration
	const clearSession = (event: string) => {
		// Mirrors and rewrite marks stay: each is keyed by its own pi session id,
		// so switching sessions or another session's shutdown erases none of them.
		debug(`${event}: retaining ${sharedSessions.size} shared session${sharedSessions.size === 1 ? "" : "s"}`);

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piMode = ctx.mode;
		rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
		if (event.reason === "fork" && event.previousSessionFile) inheritSessionState(event.previousSessionFile, ctx.sessionManager.getSessionId());
		// At session start, not the first bridge query: AskClaude users run other providers.
		// Last, so a host API that throws here can't skip the session bookkeeping above.
		if (config.askClaude?.enabled === true && !askClaudeWarningShown) {
			askClaudeWarningShown = true;
			// Optional calls: hosts that load pi extensions (oh-my-pi) may not implement every API.
			if (!pi.getAllTools?.().some((tool) => tool.name === "AskClaude")) {
				ctx.ui?.notify?.(`claude-bridge: AskClaude is now a separate package. Install it with \`pi install npm:pi-claude-bridge-askclaude\`, or remove "askClaude" from ${globalConfigPath()}.`, "warning");
			}
		}
	});
	pi.on("session_before_compact", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	pi.on("session_before_tree", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/sections) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(source: string, systemPrompt: string | undefined, options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		contextFiles?: { path: string; content: string }[];
		skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
		sections?: Record<string, string>;
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		toolGuidelines?: Record<string, string[]>;
	} | undefined) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
			sections: options?.sections,
			toolPrompts: toolPromptsFrom(options?.toolSnippets, options?.toolGuidelines),
		}, source);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		forgetSessionCwd(ctx.sessionManager.getSessionId());
		closeSessionQueries(ctx.sessionManager.getSessionId());
		clearSession("session_shutdown");
	});

	// Pi and summary extensions own compaction and branch summaries; native calls use the
	// isolated provider path. Observe the completed rewrite below, not its owner.

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) mutate pi's messages array. Digest sync sees the new
	// content at the next fresh query; parked queries must be discarded now.
	// /compact in particular triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), `session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", (_event, ctx) => sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"));

	// Claude Code models expect bash to time out (CC's default is 120s); pi's bash has none.
	// Set it on the execution copy pi hands tool_call handlers, not in the stored call, so
	// pi's history keeps the arguments CC sent and a rebuild matches CC's records (#203).
	// A `background: true` call (added by an extension) doesn't block the turn, so it gets no default.
	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("bash", event) && event.input.timeout == null && ctx.model?.provider === PROVIDER_ID
			&& (event.input as { background?: unknown }).background !== true) {
			event.input.timeout = 120;
		}
	});

	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, any>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		// Cast: the Provider interface passes a TranscriptContext; the bridge takes plain
		// Context models (toBridgeContext normalizes at the stream entry points).
		streamSimple: streamClaudeAgentSdk as any,
	};
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		debug(`provider: deferring registration decision to session_start (module=${moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getProvider(PROVIDER_ID)) {
				debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${moduleInstanceId})`);
				return;
			}
			debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${moduleInstanceId})`);
			pi.registerProvider(PROVIDER_ID, providerConfig);
		});
	}
}
