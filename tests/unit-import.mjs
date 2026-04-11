#!/usr/bin/env node
// Unit tests for convertAndImportMessages logic.
// Extracts the pure conversion (no cc-session-io dependency) and tests edge cases.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Extracted conversion logic (mirrors index.ts convertAndImportMessages) ---

const PROVIDER_ID = "claude-bridge";
const PI_TO_SDK_TOOL_NAME = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
};

function sanitizeToolId(id, cache) {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

function mapPiToolNameToSdk(name, customToolNameToSdk) {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	// Simplified pascalCase for tests
	return name.split(/[-_\s]+/).map(w => w[0].toUpperCase() + w.slice(1)).join("");
}

function messageContentToText(content) {
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

/** Runs the same conversion as convertAndImportMessages, returns the anthropic messages array. */
function convert(messages, customToolNameToSdk) {
	const anthropicMessages = [];
	const sanitizedIds = new Map();

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
					const sig = block.thinkingSignature;
					const isAnthropicProvider = msg.provider === PROVIDER_ID || msg.api === "anthropic";
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (blocks.length) anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: text || "", is_error: msg.isError }],
			});
		}
	}
	return anthropicMessages;
}

/** Mirrors repairToolPairing in index.ts. */
function repairToolPairing(messages) {
	const result = [];
	let pending = null;
	const synthetic = (id) => ({
		type: "tool_result", tool_use_id: id, content: "[no tool result recorded]", is_error: true,
	});
	const flushPending = () => {
		if (pending && pending.size > 0) {
			result.push({ role: "user", content: [...pending].map(synthetic) });
		}
		pending = null;
	};

	for (const msg of messages) {
		if (msg.role === "assistant") {
			flushPending();
			const ids = new Set();
			if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b?.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
				}
			}
			result.push(msg);
			pending = ids.size > 0 ? ids : null;
			continue;
		}

		const blocks = Array.isArray(msg.content) ? msg.content : null;
		const hasToolResults = blocks?.some((b) => b?.type === "tool_result") ?? false;

		if (!pending && !hasToolResults) {
			result.push(msg);
			continue;
		}

		const input = blocks
			?? (typeof msg.content === "string" && msg.content ? [{ type: "text", text: msg.content }] : []);
		const provided = new Set();
		const kept = input.filter((b) => {
			if (b?.type !== "tool_result") return true;
			if (pending?.has(b.tool_use_id)) {
				provided.add(b.tool_use_id);
				return true;
			}
			return false;
		});
		if (pending) {
			const missing = [...pending].filter((id) => !provided.has(id)).map(synthetic);
			kept.unshift(...missing);
			pending = null;
		}
		if (kept.length === 0) {
			if (result.length === 0) {
				result.push({ role: "user", content: [{ type: "text", text: "[orphaned tool result removed]" }] });
			}
			continue;
		}
		result.push({ ...msg, content: kept });
	}

	flushPending();
	return result;
}

// --- Tests ---

describe("tool ID sanitization", () => {
	it("Kimi-style IDs with dots and colons", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "functions.bash:0", name: "bash", arguments: { cmd: "ls" } }] },
			{ role: "toolResult", toolCallId: "functions.bash:0", content: "file.txt" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "functions_bash_0");
		assert.equal(result[1].content[0].tool_use_id, "functions_bash_0");
	});

	it("IDs with spaces and special chars", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "tool call#1@foo", name: "bash", arguments: {} }] },
			{ role: "toolResult", toolCallId: "tool call#1@foo", content: "ok" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "tool_call_1_foo");
		assert.equal(result[1].content[0].tool_use_id, "tool_call_1_foo");
	});

	it("already-valid Anthropic IDs pass through unchanged", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_abc123-XYZ", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "toolu_abc123-XYZ", content: "data" },
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].id, "toolu_abc123-XYZ");
		assert.equal(result[1].content[0].tool_use_id, "toolu_abc123-XYZ");
	});

	it("tool_use and tool_result IDs stay paired after sanitization", () => {
		const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];
		const msgs = [];
		for (const id of ids) {
			msgs.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] });
			msgs.push({ role: "toolResult", toolCallId: id, content: "ok" });
		}
		const result = convert(msgs);
		for (let i = 0; i < ids.length; i++) {
			const useId = result[i * 2].content[0].id;
			const resultId = result[i * 2 + 1].content[0].tool_use_id;
			assert.equal(useId, resultId, `pair ${i}: tool_use=${useId} tool_result=${resultId}`);
		}
	});
});

describe("empty text block filtering", () => {
	it("assistant with empty text + toolCall → only toolCall", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "toolCall", id: "abc", name: "read", arguments: {} },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "tool_use");
	});

	it("assistant with only empty text → entire message dropped", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
		];
		assert.equal(convert(msgs).length, 0);
	});

	it("assistant with non-empty text → preserved", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "Hello world" }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "Hello world");
	});

	it("assistant with multiple text blocks, some empty", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "text", text: "real content" },
				{ type: "text", text: "" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].text, "real content");
	});
});

describe("thinking block filtering", () => {
	it("non-Anthropic provider thinking blocks dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "openrouter", content: [
				{ type: "thinking", thinking: "let me think..." },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "text");
	});

	it("Anthropic provider thinking with signature preserved", () => {
		const msgs = [
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "reasoning...", thinkingSignature: "sig123" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 2);
		assert.equal(result[0].content[0].type, "thinking");
		assert.equal(result[0].content[0].signature, "sig123");
	});

	it("Anthropic provider via api field", () => {
		const msgs = [
			{ role: "assistant", api: "anthropic", content: [
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
				{ type: "text", text: "done" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 2);
		assert.equal(result[0].content[0].type, "thinking");
	});

	it("Anthropic provider thinking WITHOUT signature → dropped", () => {
		const msgs = [
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "no sig" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "text");
	});

	it("assistant with only thinking (non-Anthropic) → entire message dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "deepseek", content: [
				{ type: "thinking", thinking: "deep thoughts" },
			]},
		];
		assert.equal(convert(msgs).length, 0);
	});
});

describe("message structure", () => {
	it("toolResult → user with tool_result content", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "result text", isError: false },
		];
		const result = convert(msgs);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].content[0].type, "tool_result");
		assert.equal(result[0].content[0].tool_use_id, "id1");
		assert.equal(result[0].content[0].content, "result text");
		assert.equal(result[0].content[0].is_error, false);
	});

	it("toolResult with isError=true", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "oh no", isError: true },
		];
		assert.equal(convert(msgs)[0].content[0].is_error, true);
	});

	it("multiple tool results in sequence", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			]},
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];
		const result = convert(msgs);
		assert.equal(result.length, 3);
		assert.equal(result[0].role, "assistant");
		assert.equal(result[0].content.length, 2);
		assert.equal(result[1].role, "user");
		assert.equal(result[1].content[0].tool_use_id, "t1");
		assert.equal(result[2].role, "user");
		assert.equal(result[2].content[0].tool_use_id, "t2");
	});

	it("mixed conversation: user → assistant(tool) → toolResult → assistant(text)", () => {
		const msgs = [
			{ role: "user", content: "read file.txt" },
			{ role: "assistant", content: [
				{ type: "toolCall", id: "call1", name: "read", arguments: { path: "file.txt" } },
			]},
			{ role: "toolResult", toolCallId: "call1", content: "hello world" },
			{ role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 4);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].content, "read file.txt");
		assert.equal(result[1].role, "assistant");
		assert.equal(result[1].content[0].type, "tool_use");
		assert.equal(result[1].content[0].name, "Read");
		assert.equal(result[2].role, "user");
		assert.equal(result[2].content[0].type, "tool_result");
		assert.equal(result[3].role, "assistant");
		assert.equal(result[3].content[0].text, "The file says hello world.");
	});

	it("user string content", () => {
		assert.equal(convert([{ role: "user", content: "hello" }])[0].content, "hello");
	});

	it("user empty string → [empty]", () => {
		assert.equal(convert([{ role: "user", content: "" }])[0].content, "[empty]");
	});

	it("user with array content containing text blocks", () => {
		const result = convert([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		assert.deepEqual(result[0].content, [{ type: "text", text: "hi" }]);
	});

	it("user with empty text blocks in array → [image] fallback", () => {
		assert.equal(convert([{ role: "user", content: [{ type: "text", text: "" }] }])[0].content, "[image]");
	});

	it("tool name mapping: pi names → SDK names", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "find", arguments: {} },
				{ type: "toolCall", id: "c", name: "bash", arguments: {} },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].name, "Read");
		assert.equal(result[0].content[1].name, "Glob");
		assert.equal(result[0].content[2].name, "Bash");
	});

	it("toolResult with array content extracts text", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			]},
		];
		assert.equal(convert(msgs)[0].content[0].content, "line 1\nline 2");
	});
});

describe("repairToolPairing", () => {
	it("leaves well-formed history semantically equivalent", () => {
		const input = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 4);
		assert.equal(out[0].content, "hello"); // string user: fast path preserves shape
		assert.equal(out[2].content[0].tool_use_id, "t1");
		assert.equal(out[2].content.length, 1); // no synthetic injection
	});

	it("strips leading orphan tool_result with no preceding assistant", () => {
		const input = [
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 2);
		assert.equal(out[0].content[0].type, "text");
		assert.match(out[0].content[0].text, /orphaned tool result/);
	});

	it("preserves text in leading user mixed with orphan tool_result", () => {
		const input = [
			{ role: "user", content: [
				{ type: "text", text: "keep me" },
				{ type: "tool_result", tool_use_id: "ghost", content: "drop" },
			]},
		];
		const out = repairToolPairing(input);
		assert.equal(out[0].content.length, 1);
		assert.equal(out[0].content[0].text, "keep me");
	});

	it("merges synthetic tool_result into following user text message", () => {
		const input = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
			{ role: "user", content: "next prompt" },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 2);
		assert.equal(out[1].content.length, 2);
		assert.equal(out[1].content[0].type, "tool_result");
		assert.equal(out[1].content[0].tool_use_id, "t1");
		assert.equal(out[1].content[0].is_error, true);
		assert.equal(out[1].content[1].type, "text");
		assert.equal(out[1].content[1].text, "next prompt");
	});

	it("fills missing tool_result in partial pair (2 tool_uses, 1 result)", () => {
		const input = [
			{ role: "assistant", content: [
				{ type: "tool_use", id: "t1", name: "Read", input: {} },
				{ type: "tool_use", id: "t2", name: "Bash", input: {} },
			]},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 2);
		assert.equal(out[1].content.length, 2);
		const ids = out[1].content.map((b) => b.tool_use_id).sort();
		assert.deepEqual(ids, ["t1", "t2"]);
		const synth = out[1].content.find((b) => b.tool_use_id === "t2");
		assert.equal(synth.is_error, true);
	});

	it("trailing assistant tool_use with no follow-up injects synthetic user", () => {
		const input = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 3);
		assert.equal(out[2].role, "user");
		assert.equal(out[2].content[0].tool_use_id, "t1");
	});

	it("consecutive assistants: flushes pending before second assistant", () => {
		const input = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
			{ role: "assistant", content: [{ type: "text", text: "oops" }] },
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 3);
		assert.equal(out[0].role, "assistant");
		assert.equal(out[1].role, "user");
		assert.equal(out[1].content[0].tool_use_id, "t1");
		assert.equal(out[2].role, "assistant");
	});

	it("orphan tool_result after unrelated assistant is stripped", () => {
		const input = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "ghost", content: "x" },
				{ type: "text", text: "real" },
			]},
		];
		const out = repairToolPairing(input);
		assert.equal(out.length, 3);
		assert.equal(out[2].content.length, 1);
		assert.equal(out[2].content[0].type, "text");
	});
});
