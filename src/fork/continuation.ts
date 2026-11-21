// Issue #274: writing a second user prompt after a tool result makes Claude Code
// insert a synthetic "No response requested." answer. Resume the interrupted
// turn instead, and write the prompt only if Claude Code produces no output.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import type { QueryContext } from "../query-state.js";
import { ccChildEnv } from "../cc-child.js";
import { debug } from "../debug.js";

const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";
const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";
const CONTINUATION_FALLBACK_MS = 30_000;

interface Continuation {
	active: boolean;
	prompt: string | undefined;
}

// Weak ownership keeps fork-only state off upstream's QueryContext, including
// across extension reloads: the query's original callbacks keep their module.
const outputSeen = new WeakSet<QueryContext>();

export function observeContinuationOutput(message: SDKMessage, query: QueryContext): void {
	if (message.type === "assistant" || message.type === "stream_event" || message.type === "result") outputSeen.add(query);
}

/** Reuse keeps CC's later tail; resumeSessionAt marks a rewind. Neither permits
 *  interrupted-turn resume, so write a prefix ending exactly at the tool result. */
export function continuationSyncRow(row: number, cutCount: number, continuation: boolean): number {
	return continuation && (row === 4 || row === 6) ? cutCount ? 7 : 5 : row;
}

/** Use the provider's own extractors, preserving image and malformed-input rules. */
export function prepareContinuationPrompt(
	messages: Context["messages"], rewritten: boolean, unparked: boolean,
	blocks: (messages: Context["messages"]) => ContentBlockParam[] | null,
	text: (messages: Context["messages"]) => string | null,
): { promptBlocks: ContentBlockParam[] | null; promptText: string; continuation: Continuation } {
	const promptBlocks = blocks(messages);
	let promptText = text(messages) ?? "";
	const continuePrompt = promptText || promptBlocks ? undefined
		: rewritten ? CONTINUE_AFTER_REWRITE_PROMPT : unparked ? CONTINUE_AFTER_RESUME_PROMPT : undefined;
	const prompt = messages.at(-1)?.role === "toolResult" ? continuePrompt : undefined;
	if (continuePrompt) {
		promptText = continuePrompt;
		debug(`provider: ${rewritten ? "continuing the turn after a rewritten history" : "resuming the turn at a tool result with no parked query"}, ${messages.length} msgs`);
	}
	return { promptBlocks, promptText, continuation: { active: prompt !== undefined, prompt } };
}

export function pushContinuationPrompt(query: QueryContext, continuation: Continuation, pushPrompt: () => void): void {
	if (!continuation.active) return pushPrompt();
	// CC may judge the turn complete and wait for stdin instead of resuming it.
	setTimeout(() => {
		if (query.discarded || outputSeen.has(query)) return;
		debug("provider: Claude Code did not resume the interrupted turn, writing the continue prompt");
		pushPrompt();
	}, CONTINUATION_FALLBACK_MS).unref?.();
}

export function continuationPromptEnv(overrides: Record<string, string> | undefined, continuation: Continuation): NodeJS.ProcessEnv {
	return ccChildEnv({ ...overrides, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: continuation.active ? "1" : "", CLAUDE_CODE_RESUME_PROMPT: continuation.prompt ?? "" });
}

export function continuationChildEnv(env: NodeJS.ProcessEnv, continuation: Continuation): NodeJS.ProcessEnv {
	return continuation.active ? { ...env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "0" } : env;
}
