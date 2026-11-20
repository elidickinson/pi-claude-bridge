// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptStream } from "./prompt-stream.js";
import { LiveRecording } from "./session-sync.js";
import type { RateLimitInfo } from "./rate-limit.js";

export function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface AssistantStep {
	content: AssistantMessage["content"];
	uuid?: string;
	seen: Set<string>;
	emitted?: { digest: string; index: number; template: AssistantMessage; ids: string[] };
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	/** onResponse from the provider call that owns currentPiStream. */
	currentOnResponse: SimpleStreamOptions["onResponse"] | undefined;
	/** Latest rate_limit_event not yet reported. CC sends it after message_stop, when a
	 *  tool call has already ended the stream, so it waits for the next call's stream. */
	heldRateLimit: RateLimitInfo | undefined;
	recording = new LiveRecording();
	/** Complete SDK blocks, keyed by API message id, survive resetTurnState and
	 * late echoes after the tool-call stream has ended. */
	assistantSteps = new Map<string, AssistantStep>();
	lastAssistantMessageId: string | undefined;
	turnAssistantIds: string[] = [];
	/** Synchronous progress capture before killing/discarding this query. */
	commitRecording: ((dirty: boolean) => void) | null = null;
	stopProcess: (() => void) | null = null;
	/** Abandoned after a history rewrite or fatal tool rejection. Its completion
	 *  must not touch the session state or pi stream. A rewrite's replacement query
	 *  has rebuilt both from the new history; a rejection has already committed its
	 *  final recording. A context runs at most one SDK query (every fresh query gets
	 *  a new one), so this marks that query abandoned too. */
	discarded = false;
	sawResult = false;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Routes a delivered result to the owning
	 *  query when several queries are in flight, and tells which of CC's tool_results
	 *  answer calls pi got — pairing a result to its call is done by id from
	 *  Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** tool_use ids Claude Code called our MCP handler for. A result for a call pi
	 *  got that is not in here is one Claude Code rejected itself. */
	dispatchedToolCalls = new Set<string>();
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;
	/** Steers written or awaiting a write, not yet incorporated into a turn. */
	pendingSteerUuids = new Set<string>();
	/** The input that opens CC's next turn: the query's prompt, then after each
	 *  result the oldest steer still pending, since CC runs queued input in order.
	 *  Cleared by that turn's first output. */
	turnOpener: string | undefined;
	/** Binds a later run's abort signal to this query. Set by the run that opened it;
	 *  a run that continues it from a tool result (e.g. after pi terminated a tool
	 *  batch and ended the opening run) has no other way to stop it. */
	bindRunSignal: ((signal: AbortSignal | undefined, runStream: AssistantMessageEventStream) => void) | null = null;
	/** Last rate-limit rejection seen on this query. Claude Code sends it just before the
	 *  failure it caused, which is the only thing tying the two together. */
	rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
	/** Highest 5% utilization bucket we notified for, so repeat rate_limit_event spam is suppressed. */
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	/** Already warned that this query billed Extra Usage with the plan limit not reached. */
	warnedUnplannedOverage = false;
	/** pi session this query serves, from SimpleStreamOptions.sessionId at fresh-query
	 *  setup. A bridge process serves several pi sessions at once (subagents run their
	 *  own AgentSessions), and history rewrites must only discard the rewriting
	 *  session's parked queries — this is the match key. Null when the host did not
	 *  supply an id.
	 */
	piSessionId: string | null = null;
	/** The SDK query's id in the cache trace (src/cache-trace.ts); undefined when
	 *  tracing is off. Routes a continuation's records to the query it feeds. */
	traceQueryId: string | undefined;
	/** pi rewrote the history this query was built from (session_compact,
	 *  session_tree in its own pi session). Set by markRebuildForSession, consumed
	 *  by the tool-result delivery that discards the query. Not session-wide state:
	 *  it dies with the context it belongs to, so it cannot leak into later turns
	 *  the way a module flag does.
	 */
	historyStale = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnEmissionRecorded = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/** API message id from the last message_start, and whether its message_stop has
	 *  arrived. An `assistant` message under a different id while the stream is still
	 *  open is Claude Code's non-streaming fallback for a stalled stream. */
	turnStreamMessageId: string | undefined;
	turnStreamOpen = false;
	/** turnBlocks length at that message_start: where an abandoned attempt's blocks begin. */
	turnStreamBlockStart = 0;
	/** API message id of the non-streaming fallback being delivered from `assistant`
	 *  messages. The SDK hands it over one block per message, all under this id. */
	turnFallbackMessageId: string | undefined;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	/** Answer every parked MCP handler with `reason` and forget the turn's queued
	 *  results. Called when the query it belongs to is going away (abort, error,
	 *  normal end). Handlers must be *resolved*, not rejected: an error reply is
	 *  still a reply, and a handler left awaiting a subprocess that is gone keeps
	 *  CC's tools/call open forever, which wedges pi's turn behind it. */
	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = newAssistantOutput(model, "", "stop");
		this.lastAssistantMessageId = undefined;
		this.turnAssistantIds = [];
		this.turnStarted = false;
		this.turnEmissionRecorded = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnStreamMessageId = undefined;
		this.turnStreamOpen = false;
		this.turnStreamBlockStart = 0;
		this.turnFallbackMessageId = undefined;
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}
