// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptStream } from "./prompt-stream.js";

/** `fromByte` is the transcript size before the CLI got the input, so an
 *  earlier prompt with the same text cannot be taken for it. */
export type ServedInput = { fromByte: number } & ({ kind: "prompt"; text: string } | { kind: "toolResults"; ids: string[] });

/** How the CLI's turn for an input ended: a final answer whose last transcript
 *  entry is `lastUuid`, a tool call, or anything else. */
export type ServedReply = { kind: "answer"; lastUuid: string } | { kind: "toolUse" | "failed" };

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	latestFingerprint: string | undefined = undefined;
	/** Cursor and fingerprint of the history this query's CLI holds, as of its
	 *  start or last full tool-result delivery. */
	served: { cursor: number; fingerprint: string } | undefined = undefined;
	/** The last input the CLI got for `served`; an isolated fork copies the
	 *  session up to the answer to it. Undefined when that input cannot be found
	 *  in the transcript, e.g. a steer delivered with a tool result. */
	servedInput: ServedInput | undefined = undefined;
	/** How the turn for each served input ended, kept past the next input. */
	readonly servedReplies = new WeakMap<ServedInput, ServedReply>();
	/** The uuid of the last assistant message the CLI streamed since `servedInput`,
	 *  which is also its transcript entry's uuid. */
	lastAssistantUuid: string | undefined = undefined;
	/** The CC session this query runs on, from its init message. */
	ccSessionId: string | undefined = undefined;
	/** The session outlives the query, so a fork may copy it. False for a clean
	 *  start, whose session is deleted when the query completes. */
	forkable = false;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Sole purpose is routing a delivered result
	 *  to the owning query when several queries are in flight — pairing a result
	 *  to its call is done by id from Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;
	/** Last rate-limit rejection seen on this query. Claude Code sends it just before the
	 *  failure it caused, which is the only thing tying the two together. */
	rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
	/** Highest 5% utilization bucket we notified for, so repeat rate_limit_event spam is suppressed. */
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	/** pi session this query serves, from SimpleStreamOptions.sessionId at fresh-query
	 *  setup. A bridge process serves several pi sessions at once (subagents run their
	 *  own AgentSessions), and history rewrites must only discard the rewriting
	 *  session's parked queries — this is the match key. Null when the host did not
	 *  supply an id.
	 */
	piSessionId: string | null = null;
	/** pi rewrote the history this query was built from (session_compact,
	 *  session_tree in its own pi session). Set by markRebuildForSession, consumed
	 *  by the tool-result delivery that discards the query. Not session-wide state:
	 *  it dies with the context it belongs to, so it cannot leak into later turns
	 *  the way a module flag does.
	 */
	historyStale = false;
	/** A steer never reached CC. A first query has no session mirror yet, so
	 *  completion must carry this into the mirror it creates. */
	missedSteer = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/** API message id from the last message_start, and whether its message_stop has
	 *  arrived. An `assistant` message under a different id while the stream is still
	 *  open is Claude Code's non-streaming fallback for a stalled stream. */
	turnStreamMessageId: string | undefined;
	turnStreamOpen = false;
	/** turnBlocks length at that message_start: where an abandoned attempt's blocks begin. */
	turnStreamBlockStart = 0;

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

	serve(input: ServedInput | undefined): void {
		this.servedInput = input;
		this.lastAssistantUuid = undefined;
	}

	/** Records how the turn for the current input ended; the first end wins. */
	endServedTurn(kind: "answer" | "toolUse" | "failed"): void {
		const input = this.servedInput;
		if (!input || this.servedReplies.has(input)) return;
		const lastUuid = this.lastAssistantUuid;
		this.servedReplies.set(input, kind === "answer" && lastUuid ? { kind, lastUuid } : { kind: kind === "answer" ? "failed" : kind });
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnStreamMessageId = undefined;
		this.turnStreamOpen = false;
		this.turnStreamBlockStart = 0;
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}

let _ctx = new QueryContext();

export function ctx(): QueryContext { return _ctx; }

// Test-only: replace the module-level context so test files start clean.
// Not called from production.
export function resetCtx(): void {
	_ctx = new QueryContext();
}
