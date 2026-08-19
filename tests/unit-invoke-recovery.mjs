/**
 * Issue #36: Claude sometimes types a tool call as literal invoke-tag text
 * instead of emitting a structured tool_use block, mostly on long 1M-context
 * sessions. When that is the turn's only action, pi sees an ordinary answer,
 * nothing is dispatched, nothing fails, and the agent quietly stalls.
 *
 * These drive the real provider path — consumeQuery over faked SDK messages —
 * because the whole bug is about what the turn ends as, and a plan the caller
 * never applies proves nothing. The parser is exercised directly only where the
 * hostile input matters more than the wiring.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import {
	coerceInvokeArgs,
	isRecoveredToolCallId,
	parseInvokeBlocks,
	recoveredToolResultPending,
} from "../src/invoke-recovery.js";

const { __test } = await import("../src/index.js");

// The leak syntax is assembled, never written literally: a source file that
// contains the raw tags gets read as a tool call by the harnesses that edit it.
const LT = "<";
const inv = (name, q = '"') => `${LT}invoke name=${q}${name}${q}>`;
const invEnd = `${LT}/invoke>`;
const param = (name, value, q = '"') => `${LT}parameter name=${q}${name}${q}>${value}${LT}/parameter>`;
const paramOpen = (name) => `${LT}parameter name="${name}">`;
const wrapOpen = `${LT}function_calls>`;
const wrapEnd = `${LT}/function_calls>`;

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

const toolMap = new Map([
	["mcp__custom-tools__bash", "bash"],
	["mcp__custom-tools__write", "write"],
	["mcp__custom-tools__read", "read"],
]);

const mcpTools = [
	{ name: "bash", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } },
	{ name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
	{ name: "read", parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } },
];

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c, mcpTools);
}

const streamEvent = (event) => ({ type: "stream_event", event });

/** One text block, then the turn ends. `stopReason` is the raw Anthropic value. */
function textTurn(text, stopReason = "end_turn") {
	return [
		streamEvent({ type: "message_start", message: {} }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: stopReason } }),
		streamEvent({ type: "message_stop" }),
	];
}

const toolCalls = (c) => c.turnOutput.content.filter((b) => b.type === "toolCall");
const texts = (c) => c.turnOutput.content.filter((b) => b.type === "text");

describe("literal invoke text with no structured tool call", () => {
	it("synthesizes the call the text describes and ends the turn on it", async () => {
		const c = makeCtx();
		// Recovery nulls currentPiStream the way the tool_use path does, so pi's
		// next call can swap in its own stream. Hold the reference to inspect it.
		const stream = c.currentPiStream;
		await consume(c, textTurn([
			"Running the suite now.",
			"",
			inv("bash"),
			param("command", "npm test"),
			invEnd,
		].join("\n")));

		const calls = toolCalls(c);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].name, "bash");
		// Same shaping a structured tool_use gets, bash's timeout default included.
		assert.deepStrictEqual(calls[0].arguments, { command: "npm test", timeout: 120 });
		assert.ok(isRecoveredToolCallId(calls[0].id), `id not recognizable: ${calls[0].id}`);

		// The turn now continues instead of stalling.
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		const done = stream.events.filter((e) => e.type === "done");
		assert.deepStrictEqual(done.map((e) => e.reason), ["toolUse"]);
		assert.strictEqual(stream.events.at(-1).type, "end");
		assert.strictEqual(c.currentPiStream, null);

		// The literal draft is gone from the answer, the prose around it is not.
		assert.deepStrictEqual(texts(c).map((b) => b.text), ["Running the suite now."]);
	});

	it("never routes the synthesized id to an MCP handler that does not exist", async () => {
		const c = makeCtx();
		await consume(c, textTurn(inv("bash") + param("command", "ls") + invEnd));

		// turnToolCallIds is what steers a delivered result to a waiting handler.
		// CC ended this turn as plain text, so no handler is parked on the id: a
		// result routed there would sit in pendingResults and wedge pi's turn.
		assert.deepStrictEqual(c.turnToolCallIds, []);
		assert.strictEqual(c.pendingToolCalls.size, 0);
	});

	it("keeps a multi-line code parameter verbatim and does not swallow its sibling", async () => {
		const script = [
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			'if [ "$LHS" -lt "$RHS" ]; then',
			'  echo "<not-a-tag> & 3 < 4"',
			"fi",
			"",
		].join("\n");
		const c = makeCtx();
		await consume(c, textTurn([
			inv("write"),
			param("content", script),
			param("file_path", "/tmp/check.sh"),
			invEnd,
		].join("\n")));

		const calls = toolCalls(c);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].arguments.content, script);
		// file_path → path is the same rename a structured call gets, and proves
		// the value search stopped at the right close tag rather than running on.
		assert.strictEqual(calls[0].arguments.path, "/tmp/check.sh");
	});

	it("recovers every sibling invoke in one text run", async () => {
		const c = makeCtx();
		await consume(c, textTurn([
			"Two steps:",
			"",
			wrapOpen,
			inv("bash"),
			param("command", "npm run build"),
			invEnd,
			inv("read"),
			param("path", "/tmp/out.log"),
			invEnd,
			wrapEnd,
		].join("\n")));

		assert.deepStrictEqual(toolCalls(c).map((b) => b.name), ["bash", "read"]);
		assert.deepStrictEqual(toolCalls(c).map((b) => b.arguments), [
			{ command: "npm run build", timeout: 120 },
			{ path: "/tmp/out.log" },
		]);
		// Distinct ids, or pi pairs both results to one call.
		assert.notStrictEqual(toolCalls(c)[0].id, toolCalls(c)[1].id);
		// The now-empty wrapper goes with them.
		assert.deepStrictEqual(texts(c).map((b) => b.text), ["Two steps:"]);
	});

	it("leaves a tool the bridge does not serve as plain text", async () => {
		const original = [
			"You could do it with:",
			"",
			inv("WebFetch"),
			param("url", "https://example.com"),
			invEnd,
		].join("\n");
		const c = makeCtx();
		await consume(c, textTurn(original));

		// Synthesizing a call nobody serves only trades a stall for a failure.
		assert.deepStrictEqual(toolCalls(c), []);
		assert.deepStrictEqual(texts(c).map((b) => b.text), [original]);
		assert.strictEqual(c.turnOutput.stopReason, "stop");
	});

	for (const [label, broken] of [
		["truncated mid-value", `${inv("bash")}\n${paramOpen("command")}npm test`],
		["parameter never closed", `${inv("bash")}${paramOpen("command")}npm test${invEnd}`],
		["invoke never closed before its sibling", `${inv("bash")}\n${inv("bash")}${paramOpen("command")}ls`],
		["opening tag only", inv("bash")],
	]) {
		it(`leaves a malformed invoke alone: ${label}`, async () => {
			const original = `Here is what I would run:\n\n${broken}`;
			const c = makeCtx();
			await consume(c, textTurn(original));

			assert.deepStrictEqual(toolCalls(c), []);
			assert.deepStrictEqual(texts(c).map((b) => b.text), [original]);
			assert.strictEqual(c.turnOutput.stopReason, "stop");
		});
	}

	it("does not synthesize from a turn cut off at max_tokens", async () => {
		// A length-capped turn can end mid-invoke, and text that merely looks
		// finished there is the one case where synthesizing runs a half-written
		// command. The stall it leaves behind is pi's to report, not ours to guess.
		const original = inv("bash") + param("command", "rm -rf /tmp/scratch") + invEnd;
		const c = makeCtx();
		await consume(c, textTurn(original, "max_tokens"));

		assert.deepStrictEqual(toolCalls(c), []);
		assert.deepStrictEqual(texts(c).map((b) => b.text), [original]);
		assert.strictEqual(c.turnOutput.stopReason, "length");
	});
});

describe("literal invoke text alongside a real structured tool call", () => {
	it("suppresses the stale draft and emits exactly one call", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, [
			streamEvent({ type: "message_start", message: {} }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: [
				"Let me check the tests.",
				"",
				inv("bash"),
				param("command", "npm test --watch"),
				invEnd,
				"",
				"Standing by.",
			].join("\n") } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_real", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"npm test"}' } }),
			streamEvent({ type: "content_block_stop", index: 1 }),
			streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
			streamEvent({ type: "message_stop" }),
		]);

		// One call, and it is Claude's own — a draft it never dispatched must not
		// become a second real side effect.
		assert.deepStrictEqual(toolCalls(c).map((b) => b.id), ["toolu_real"]);
		assert.deepStrictEqual(toolCalls(c)[0].arguments, { command: "npm test", timeout: 120 });
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_real"]);

		// The user is not shown the same command twice, and the answer around the
		// draft survives.
		assert.deepStrictEqual(texts(c).map((b) => b.text), ["Let me check the tests.\n\nStanding by."]);

		// The final message pi keeps is the one `done` carries, so the cut has to
		// be visible there.
		const done = stream.events.filter((e) => e.type === "done");
		assert.strictEqual(done.length, 1);
		assert.strictEqual(done[0].reason, "toolUse");
		assert.ok(!JSON.stringify(done[0].message.content).includes("invoke"));
	});

	it("suppresses on the assistant-message fallback path too", async () => {
		const c = makeCtx();
		await consume(c, [{
			type: "assistant",
			message: { content: [
				{ type: "text", text: `Running it.\n\n${inv("bash")}\n${param("command", "ls")}\n${invEnd}` },
				{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_real", input: { command: "ls -la" } },
			] },
		}]);

		assert.deepStrictEqual(toolCalls(c).map((b) => b.id), ["toolu_real"]);
		assert.deepStrictEqual(texts(c).map((b) => b.text), ["Running it."]);
	});

	it("leaves a draft for a different tool alone", async () => {
		// A turn that already has a structured call continues on its own. Cutting
		// unrelated text would delete an answer nothing replaced.
		const draft = `${inv("write")}\n${param("file_path", "/tmp/a")}\n${param("content", "x")}\n${invEnd}`;
		const c = makeCtx();
		await consume(c, [
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: draft } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_real", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }),
			streamEvent({ type: "content_block_stop", index: 1 }),
			streamEvent({ type: "message_stop" }),
		]);

		assert.deepStrictEqual(toolCalls(c).map((b) => b.id), ["toolu_real"]);
		assert.deepStrictEqual(texts(c).map((b) => b.text), [draft]);
	});
});

describe("parseInvokeBlocks", () => {
	it("reads namespaced tags and single quotes", () => {
		const found = parseInvokeBlocks(`${LT}ns:invoke name='bash'>${LT}ns:parameter name='command'>ls${LT}/ns:parameter>${LT}/ns:invoke>`);
		assert.deepStrictEqual(found.map((f) => [f.name, f.arguments]), [["bash", { command: "ls" }]]);
	});

	it("costs nothing on ordinary prose", () => {
		assert.deepStrictEqual(parseInvokeBlocks("No tags here, just 1 < 2 and a </div>."), []);
	});

	it("keeps an empty-bodied invoke, which is a real no-argument call", () => {
		assert.deepStrictEqual(parseInvokeBlocks(inv("ls") + invEnd).map((f) => f.arguments), [{}]);
	});
});

describe("coerceInvokeArgs", () => {
	const schema = { properties: { path: { type: "string" }, limit: { type: "number" }, all: { type: "boolean" } } };

	it("types a value the tool declares as a number", () => {
		assert.deepStrictEqual(coerceInvokeArgs({ path: "/etc/hosts", limit: "50" }, schema), { path: "/etc/hosts", limit: 50 });
	});

	it("leaves a declared string alone even when it looks like a number", () => {
		// The trap this exists to avoid: a file body of `42` written as a number.
		assert.deepStrictEqual(coerceInvokeArgs({ path: "42" }, schema), { path: "42" });
	});

	it("keeps text a declared type cannot represent, rather than mangling it", () => {
		assert.deepStrictEqual(coerceInvokeArgs({ limit: "007", all: "yes" }, schema), { limit: "007", all: "yes" });
	});

	it("passes everything through when the tool has no schema", () => {
		assert.deepStrictEqual(coerceInvokeArgs({ n: "1" }, undefined), { n: "1" });
	});
});

describe("recoveredToolResultPending", () => {
	const recovered = "toolu_recovered_deadbeef";

	it("spots a result for a call we synthesized, past an interleaved steer", () => {
		assert.strictEqual(recoveredToolResultPending([
			{ role: "user" }, { role: "assistant" },
			{ role: "toolResult", toolCallId: recovered },
			{ role: "user" },
		]), true);
	});

	it("ignores a result from Claude's own call", () => {
		assert.strictEqual(recoveredToolResultPending([
			{ role: "assistant" }, { role: "toolResult", toolCallId: "toolu_01real" },
		]), false);
	});

	it("stops at the assistant message that owns the turn", () => {
		// An older recovered result belongs to a turn pi already closed out.
		assert.strictEqual(recoveredToolResultPending([
			{ role: "toolResult", toolCallId: recovered },
			{ role: "assistant" },
			{ role: "toolResult", toolCallId: "toolu_01real" },
		]), false);
	});
});
