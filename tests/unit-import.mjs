#!/usr/bin/env node
// Unit tests for pi→Anthropic message conversion (convert.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolId, convertPiMessages } from "../src/convert.js";

/** Shorthand: convert pi messages and return just the anthropic messages. */
function convert(messages, customToolNameToSdk) {
	return convertPiMessages(messages, customToolNameToSdk).anthropicMessages;
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

	it("assistant with only empty text → placeholder", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "[incompatible content omitted]");
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
			{ role: "assistant", provider: "claude-bridge", content: [
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
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "thinking", thinking: "no sig" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content.length, 1);
		assert.equal(result[0].content[0].type, "text");
	});

	it("assistant with only thinking (non-Anthropic) → placeholder", () => {
		const msgs = [
			{ role: "assistant", provider: "deepseek", content: [
				{ type: "thinking", thinking: "deep thoughts" },
			]},
		];
		const result = convert(msgs);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "[incompatible content omitted]");
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
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			]},
		];
		const result = convert(msgs);
		assert.equal(result[0].content[0].name, "Read");
		assert.equal(result[0].content[1].name, "Bash");
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
