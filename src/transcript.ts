/**
 * Translate pi's transcript-shaped provider input into the prompt/tools fields used by
 * the bridge's downstream consumers.
 *
 * System messages carry the base prompt and tool set plus later section patches and tool
 * deltas. pi-ai replays that state; the bridge forwards pi's own join of it
 * (getSystemMessageText) as the system prompt, in pi-ai's replay order, with no reordering
 * or text handling of its own.
 */
import {
	getCurrentSystemMessage,
	getCurrentTools,
	getSystemMessageText,
	type Context,
} from "@earendil-works/pi-ai";

/**
 * Restore the prompt and tools fields expected by the bridge and remove prompt-state
 * messages from conversation history. Contexts without system messages are returned
 * unchanged because systemless one-off calls already use the bridge-compatible shape.
 */
export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const head = getCurrentSystemMessage(context.messages);
	const tools = getCurrentTools(context.messages);
	return {
		...context,
		systemPrompt: head ? getSystemMessageText(head) || undefined : undefined,
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

/** `messages` with every prompt-state system message removed from conversation history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}