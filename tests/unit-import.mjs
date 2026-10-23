#!/usr/bin/env node
// Unit tests for pi→Anthropic message conversion (convert.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairToolPairing } from "cc-session-io";
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

	// A signature minted by another provider isn't ours to replay into Claude
	// Code's session, so it is dropped even though the message is Anthropic's.
	it("thinking from pi's own Anthropic provider is dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "anthropic", api: "anthropic-messages", content: [
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
				{ type: "text", text: "done" },
			]},
		];
		const result = convert(msgs);
		assert.deepEqual(result[0].content, [{ type: "text", text: "done" }]);
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

	// Claude Code puts every result for one assistant turn in a single user
	// message — see the parallel-tool-call tests below for why it matters.
	it("merges the results of a parallel tool call into one user message", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			]},
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];
		const result = convert(msgs);
		assert.equal(result.length, 2);
		assert.equal(result[0].content.length, 2);
		assert.equal(result[1].role, "user");
		assert.deepEqual(result[1].content.map((b) => [b.tool_use_id, b.content]),
			[["t1", "content a"], ["t2", "content b"]]);
	});

	it("does not merge results across an intervening user message", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t1", content: "a" },
			{ role: "user", content: "keep going" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t2", content: "b" },
		];
		assert.deepEqual(convert(msgs).map((m) => m.role),
			["assistant", "user", "user", "assistant", "user"]);
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

	// With a tool map the query runs `tools: []`, so no name in the transcript may
	// look like a Claude Code builtin — that is what makes the model call one it
	// cannot call. A tool missing from the map is one pi ran and we no longer
	// serve (AskClaude is excluded on purpose), not a builtin.
	it("tool name mapping: unserved pi tools keep the MCP namespace", () => {
		const served = new Map([["read", "mcp__custom-tools__read"]]);
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
				{ type: "toolCall", id: "c", name: "AskClaude", arguments: {} },
			]},
		];
		assert.deepEqual(convert(msgs, served)[0].content.map((b) => b.name),
			["mcp__custom-tools__read", "mcp__custom-tools__bash", "mcp__custom-tools__AskClaude"]);
	});

	it("tool name mapping: an SDK name in pi history is a double mapping, not a tool", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "mcp__custom-tools__bash", arguments: {} }] },
		];
		assert.throws(() => convert(msgs), /already an SDK tool name/);
		assert.throws(() => convert(msgs, new Map()), /already an SDK tool name/);
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

	// Claude Code stores screenshots as image blocks inside tool_result.content;
	// flattening to text would drop them from a rebuilt session.
	it("toolResult keeps image blocks instead of flattening to text", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		assert.deepEqual(result, [
			{ type: "text", text: "captured" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});

	// The string shape is what CC writes for text-only results; switching to
	// blocks unconditionally would diverge from it and perturb the cache key.
	it("toolResult without an image stays a flat string", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "just text" }] },
		];
		assert.equal(convert(msgs)[0].content[0].content, "just text");
	});

	it("toolResult keeps markers for blocks that are neither text nor image", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "document" },
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		assert.deepEqual(result, [
			{ type: "text", text: "[document]" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});

	it("toolResult with only an image keeps the image", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		assert.deepEqual(result, [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});
});

// Every rebuild runs the conversion through repairToolPairing — once here, once
// more inside Session.importMessages. It only pairs results that sit in the user
// message directly after their assistant message, so anything the conversion
// leaves in a later message is dropped and replaced with a synthetic
// "[no tool result recorded]" error. That silently destroyed the output of every
// parallel tool call in the rebuilt session.
describe("conversion survives repairToolPairing", () => {
	const parallelCall = (n) => {
		const ids = Array.from({ length: n }, (_, i) => `t${i}`);
		return [
			{ role: "user", content: "read them all" },
			{ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } })) },
			...ids.map((id) => ({ role: "toolResult", toolCallId: id, content: `body of ${id}` })),
		];
	};

	it("keeps every result of a parallel tool call", () => {
		const converted = convert(parallelCall(3));
		const repaired = repairToolPairing(converted);

		assert.deepEqual(repaired, converted);
		const results = repaired.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
		assert.deepEqual(results.map((b) => b.content), ["body of t0", "body of t1", "body of t2"]);
	});

	// Mid-turn steering puts a user message between the results (which is why
	// extractAllToolResults walks past them), so adjacency alone is not enough to
	// keep a parallel call together. CC writes the same turn as results-then-steer.
	it("collects results that a steer interleaved, keeping the steer after them", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: {} }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t0", content: "first" },
			{ role: "user", content: "actually, also check X" },
			{ role: "toolResult", toolCallId: "t1", content: "second" },
		];
		const repaired = repairToolPairing(convert(msgs));

		assert.deepEqual(repaired.map((m) => m.role), ["assistant", "user", "user"]);
		assert.deepEqual(repaired[1].content.map((b) => b.content), ["first", "second"]);
		assert.equal(repaired[2].content, "actually, also check X");
	});

	// A steer sent while the first tool is still running lands in pi's history
	// before any result. repairToolPairing hands the turn's stubs to the first user
	// message after the assistant, so the results have to be inserted ahead of it.
	it("collects results that a steer preceded", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: {} }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "user", content: "actually stop and check X" },
			{ role: "toolResult", toolCallId: "t0", content: "first" },
			{ role: "toolResult", toolCallId: "t1", content: "second" },
		];
		const repaired = repairToolPairing(convert(msgs));

		assert.deepEqual(repaired.map((m) => m.role), ["assistant", "user", "user"]);
		assert.deepEqual(repaired[1].content.map((b) => b.content), ["first", "second"]);
		assert.equal(repaired[2].content, "actually stop and check X");
	});

	it("leaves no synthetic result stubs behind", () => {
		const repaired = repairToolPairing(convert(parallelCall(5)));

		const stubs = repaired.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => b.type === "tool_result" && typeof b.content === "string" && b.content.includes("no tool result recorded"));
		assert.deepEqual(stubs, []);
	});
});

describe("aborted assistant turns", () => {
	it("a turn aborted before anything streamed is dropped, not fabricated", () => {
		const result = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
		]);
		assert.equal(result.length, 2);
		assert.deepEqual(result.map((m) => m.role), ["user", "user"]);
	});

	it("a turn whose blocks were all filtered still says so", () => {
		const result = convert([
			{ role: "assistant", provider: "deepseek", content: [{ type: "thinking", thinking: "deep thoughts" }] },
		]);
		assert.equal(result.length, 1);
		assert.equal(result[0].content[0].text, "[incompatible content omitted]");
	});

	// The prompt cache is keyed on exact prefix bytes, so a rebuild must reproduce
	// the sequence Claude Code already cached. An aborted turn contributes nothing
	// live, so standing a placeholder in for it on rebuild diverged at that index
	// and cost every downstream cached token. See eli/todos.md.
	it("rebuilding across an aborted turn preserves the cached prefix", () => {
		const live = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		const rebuilt = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		assert.deepEqual(rebuilt, live);
	});

	it("a result stranded after an aborted turn still lands on the real assistant", () => {
		const result = convert([
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolCallId: "t1", content: "ok" },
		]);
		assert.deepEqual(result.map((m) => m.role), ["assistant", "user"]);
		assert.equal(result[1].content[0].tool_use_id, "t1");
	});
});
