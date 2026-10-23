import { createHash } from "node:crypto";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./convert.js";

function writeString(hash: ReturnType<typeof createHash>, value: string): void {
	hash.update(`s${value.length}:`);
	hash.update(value, "utf16le");
}

function writeJson(hash: ReturnType<typeof createHash>, value: unknown, parents = new Set<object>()): void {
	if (value === null) { hash.update("null;"); return; }
	if (typeof value === "string") { writeString(hash, value); return; }
	if (typeof value === "boolean") { hash.update(value ? "b1" : "b0"); return; }
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Tool arguments must contain finite JSON numbers");
		const number = Object.is(value, -0) ? "0" : String(value);
		hash.update(`d${number.length}:${number}`);
		return;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported tool argument value: ${typeof value}`);
	if (parents.has(value)) throw new TypeError("Tool arguments must not be cyclic");
	parents.add(value);
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Tool arguments must use plain arrays");
		hash.update("a[");
		for (let index = 0; index < value.length; index++) writeJson(hash, value[index], parents);
		hash.update("]a");
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Tool arguments must use plain objects");
		hash.update("o{");
		const object = value as Record<string, unknown>;
		for (const key of Object.keys(object).sort()) {
			writeString(hash, key);
			writeJson(hash, object[key], parents);
		}
		hash.update("}o");
	}
	parents.delete(value);
}

type ContentPart = { type: string; text?: string; data?: string; mimeType?: string };
type AssistantContent = Extract<PiMessage, { role: "assistant" }>["content"][number];

function contentParts(content: unknown): ContentPart[] {
	return Array.isArray(content) ? content as ContentPart[] : [];
}

function isReplayableThinking(
	message: Extract<PiMessage, { role: "assistant" }>,
	block: AssistantContent,
): block is Extract<AssistantContent, { type: "thinking" }> {
	return block.type === "thinking" && message.provider === PROVIDER_ID && !!block.thinkingSignature;
}

function writeUser(hash: ReturnType<typeof createHash>, message: Extract<PiMessage, { role: "user" }>): void {
	if (typeof message.content === "string") {
		hash.update("user:string:");
		writeString(hash, message.content || "[empty]");
		return;
	}
	if (!Array.isArray(message.content)) {
		hash.update("user:fallback:");
		writeString(hash, "[empty]");
		return;
	}
	const content = contentParts(message.content);
	const hasParts = content.some((block) => (block.type === "text" && !!block.text)
		|| (block.type === "image" && !!block.data && !!block.mimeType));
	if (!hasParts) {
		hash.update("user:fallback:");
		writeString(hash, "[image]");
		return;
	}
	hash.update("user:blocks[");
	for (const block of content) {
		if (block.type === "text" && block.text) {
			hash.update("text:");
			writeString(hash, block.text);
		} else if (block.type === "image" && block.data && block.mimeType) {
			hash.update("image:");
			writeString(hash, block.mimeType);
			writeString(hash, block.data);
		}
	}
	hash.update("]user");
}

function writeToolResultText(
	hash: ReturnType<typeof createHash>,
	content: unknown,
): void {
	if (typeof content === "string") {
		hash.update("tool-content:text:");
		writeString(hash, content);
		return;
	}
	const blocks = contentParts(content);
	const hasText = blocks.some((block) => block.type === "text" && !!block.text);
	let length = 0;
	let count = 0;
	if (hasText) {
		for (const block of blocks) {
			if (block.type === "text" && block.text) { length += block.text.length; count++; }
			else if (block.type !== "text" && block.type !== "image") { length += `[${block.type}]`.length; count++; }
		}
		length += count - 1;
	}
	hash.update("tool-content:text:");
	hash.update(`s${length}:`);
	if (hasText) {
		let first = true;
		for (const block of blocks) {
			let part: string | undefined;
			if (block.type === "text" && block.text) part = block.text;
			else if (block.type !== "text" && block.type !== "image") part = `[${block.type}]`;
			if (part !== undefined) {
				if (!first) hash.update("\n", "utf16le");
				hash.update(part, "utf16le");
				first = false;
			}
		}
	}
}

function writeToolResultBlocks(
	hash: ReturnType<typeof createHash>,
	content: unknown,
): void {
	hash.update("tool-content:blocks[");
	for (const block of contentParts(content)) {
		if (block.type === "text" && block.text) {
			hash.update("text:");
			writeString(hash, block.text);
		} else if (block.type === "image" && block.data && block.mimeType) {
			hash.update("image:");
			writeString(hash, block.mimeType);
			writeString(hash, block.data);
		} else if (block.type !== "text" && block.type !== "image") {
			hash.update("text:");
			writeString(hash, `[${block.type}]`);
		}
	}
	hash.update("]tool-content");
}

function writeToolResult(hash: ReturnType<typeof createHash>, message: Extract<PiMessage, { role: "toolResult" }>): void {
	hash.update("toolResult:");
	writeString(hash, message.toolCallId);
	hash.update(message.isError ? "b1" : "b0");
	const content = contentParts(message.content);
	const hasImage = content.some((block) => block.type === "image" && !!block.data && !!block.mimeType);
	if (hasImage) writeToolResultBlocks(hash, content);
	else writeToolResultText(hash, message.content);
}

function writeAssistant(hash: ReturnType<typeof createHash>, message: Extract<PiMessage, { role: "assistant" }>): void {
	const content = Array.isArray(message.content) ? message.content : [];
	if (!content.length) { hash.update("assistant:omitted"); return; }
	const converted = content.some((block) => (block.type === "text" && !!block.text)
		|| block.type === "toolCall"
		|| isReplayableThinking(message, block));
	if (!converted) { hash.update("assistant:placeholder"); return; }
	hash.update("assistant:blocks[");
	for (const block of content) {
		if (block.type === "text" && block.text) {
			hash.update("text:");
			writeString(hash, block.text);
		} else if (isReplayableThinking(message, block)) {
			hash.update("thinking:");
			writeString(hash, block.thinking ?? "");
			writeString(hash, block.thinkingSignature!);
		} else if (block.type === "toolCall") {
			hash.update("toolCall:");
			writeString(hash, block.id);
			writeString(hash, block.name);
			writeJson(hash, block.arguments ?? {});
		}
	}
	hash.update("]assistant");
}

/** Hash a pi conversation message's conversion-visible content, ignoring metadata. */
export function digestMessage(message: PiMessage): string {
	const hash = createHash("sha256");
	if (message.role === "user") writeUser(hash, message);
	else if (message.role === "assistant") writeAssistant(hash, message);
	else if (message.role === "toolResult") writeToolResult(hash, message);
	else throw new TypeError("digestMessage expects a non-system conversation message");
	return hash.digest("hex");
}

/** Return one stable digest per pi conversation message. */
export function digestMessages(messages: PiMessage[]): string[] {
	return messages.map(digestMessage);
}
