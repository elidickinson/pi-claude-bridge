// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";
import { MCP_TOOL_PREFIX } from "./skills.js";

export const PROVIDER_ID = "claude-bridge";

// Pi tool names under Claude Code's builtin names. Only ever correct on the
// AskClaude path, where CC runs its own tools — see mapPiToolNameToSdk.
export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

/** A pi tool name as the name a rebuilt transcript has to call it by.
 *
 *  Whether a map is passed is what distinguishes the two query shapes, because
 *  they need opposite answers:
 *
 *  - **With a map — the provider path.** The query runs `tools: []`, so every
 *    tool Claude can call is a pi tool served over MCP, and its name is
 *    `mcp__custom-tools__<pi name>` by construction (resolveMcpTools). The map
 *    is consulted first only because it carries the served tool's exact casing.
 *    A name it lacks is a tool pi ran that we do not serve now — AskClaude,
 *    excluded on purpose, or an extension since disabled — and naming that after
 *    a Claude Code builtin would tell the model a builtin it cannot call is
 *    available and was already used. That is the prompt condition behind the
 *    phantom-call deadlock fixed in 122914dd, and the read direction refuses the
 *    same names for the same reason (piToolNameFor in index.ts).
 *  - **Without a map — the AskClaude path.** CC runs its own tools there, so
 *    builtin names are real, matching mapToolName in the other direction.
 */
export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	// Pi history holds pi tool names. Our own SDK prefix can only reach here by
	// feeding already-converted names back through the conversion, and prefixing
	// twice invents a tool nobody serves.
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		throw new Error(`mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`);
	}
	if (!customToolNameToSdk) return PI_TO_SDK_TOOL_NAME[normalized] ?? pascalCase(name);
	return customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// Tool results are flattened to text, which is how Claude Code stores most of
// them. Images are the exception: they have no text form, so a result carrying
// one keeps the block array shape instead (also what CC writes for screenshots).
function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | Array<Record<string, unknown>> {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
	if (!images.length) return messageContentToText(content) || "";
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			// Same marker messageContentToText leaves for unrecognized blocks, so the
			// text and image paths describe an extension's output the same way.
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

/** What convertPiMessages discarded, for the debug line in index.ts. */
export type DroppedContent = {
	thinking: number;
	abortedTurns: number;
	providers: Set<string>;
	other: Map<string, number>;
};

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
	thinkingProviderId: string = PROVIDER_ID,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; dropped: DroppedContent } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();
	// What conversion discarded. Nothing downstream can tell: a stripped thinking
	// block and a message that never carried one convert to the same thing, so
	// without this the loss is invisible in the log and in a captured request.
	const dropped: DroppedContent = { thinking: 0, abortedTurns: 0, providers: new Set(), other: new Map() };
	// The user message collecting this assistant turn's tool results, if one has
	// been emitted yet, and the index of the assistant message it belongs to. Both
	// are cleared at every assistant message — see the toolResult branch.
	let turnResults: { role: "user"; content: Array<Record<string, unknown>> } | null = null;
	let turnAssistantIdx: number | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					}
				}
				anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
			} else {
				anthropicMessages.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Only replay thinking Claude Code itself produced UNDER THIS PROFILE.
					// A signature minted by any other provider — pi's own Anthropic
					// provider, or the bridge running a different account profile — is
					// not ours to hand back, and Anthropic rejects ones it can't verify.
					const sig = block.thinkingSignature;
					if (msg.provider === thinkingProviderId && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					} else {
						dropped.thinking++;
						dropped.providers.add(msg.provider ?? "unknown");
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				} else {
					dropped.other.set(block.type, (dropped.other.get(block.type) ?? 0) + 1);
				}
			}
			// A turn the user aborted before anything streamed carries no content at
			// all. Standing a placeholder in its place invents a reply the assistant
			// never made, and because it lands early in the prefix it costs the whole
			// downstream prompt cache every time the session is rebuilt. Drop it:
			// Session.importMessages imposes no alternation, and a turn with no blocks
			// has no tool_use ids needing a synthetic result. Left before the turn
			// bookkeeping so a stray result still attaches to the last assistant
			// message actually emitted.
			//
			// Do NOT clear turnResults/turnAssistantIdx here. It looks like the tidy
			// thing to do, but an abort between two parallel results — assistant[X,Y],
			// R_X, aborted turn, R_Y — would then start a second results message for
			// R_Y. repairToolPairing consumes both pending ids at the first one, stubs
			// Y there and drops the real R_Y as unmatched, destroying the parallel
			// result this merge exists to preserve. unit-import.mjs pins the shape.
			if (!content.length) { dropped.abortedTurns++; continue; }
			// Blocks were present but every one was filtered — content really was
			// dropped here, so keep the slot and say so. Empty content is rejected by
			// the API, and dropping the message would break tool pairing.
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			turnResults = null;
			turnAssistantIdx = anthropicMessages.length;
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			// Pi records one message per tool result, and repairToolPairing only
			// pairs results that share the user message directly after their
			// assistant message. Split across messages, the second and later results
			// match no pending tool_use id: they are dropped and replaced with a
			// synthetic "[no tool result recorded]", so every rebuild silently
			// destroyed the output of parallel tool calls. Session.importMessages
			// applies the repair itself, so this cannot be opted out of by skipping
			// our own call. (Claude Code's live writer splits a turn across records
			// — one per content block, one per result — so the single-message shape
			// is repairToolPairing's requirement, not a copy of CC's own layout;
			// tests/int-cc-contracts.mjs pins both facts.)
			//
			// Collecting into the turn's first result message rather than the
			// immediately preceding one also handles a steer landing mid-execution,
			// which pi records between the results (see extractAllToolResults).
			// The results also have to sit *directly* after their assistant message:
			// repairToolPairing consumes the turn's pending ids at the first user
			// message that follows it, so a steer arriving before the first result —
			// what any steer during a slow first tool looks like — would otherwise
			// take the stubs and strand every real result behind it.
			//
			// Both hoists reorder the steer against wall-clock: Claude sees results
			// that were still running when the steer arrived. Claude Code normalizes
			// to the same order — it records a mid-turn steer as an `attachment`, and
			// reorderAttachmentsForAPI (claude-code-rip src/utils/messages.ts:1481)
			// bubbles attachments up to the nearest assistant or tool_result message
			// and re-inserts them after it. The on-disk form differs, the order does not.
			const block = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: toolResultContent(msg.content), is_error: msg.isError };
			if (turnResults) {
				turnResults.content.push(block);
			} else {
				turnResults = { role: "user", content: [block] };
				// A result with no assistant message before it is malformed history;
				// appending keeps it in order for repairToolPairing to discard.
				anthropicMessages.splice(turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1, 0, turnResults);
			}
		}
	}

	return { anthropicMessages, sanitizedIds, dropped };
}
