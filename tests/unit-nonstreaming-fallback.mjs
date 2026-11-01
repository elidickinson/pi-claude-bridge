/**
 * When a response stream stalls, Claude Code abandons it and repeats the request
 * without streaming ("Error streaming, falling back to non-streaming mode"). The
 * answer arrives one `assistant` message per content block, all under a new message
 * id, with no stream_events of its own and no message_stop for the dead stream.
 *
 * The dead stream had already set turnSawStreamEvent, so processAssistantMessage
 * skipped the fallback as "already streamed" -- or, once the first block had passed,
 * skipped the rest as repeats of it. Its tool calls never reached pi, CC waited in
 * the MCP handler for results that never came, and the turn sat on "Working" until
 * the user aborted it.
 *
 * A fallback with parallel tool calls still loses all but the first: the stream ends
 * on the first tool_use block, and nothing marks the message's last block (PR #225).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestMessage } from "../src/message-digests.js";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

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
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
}

const streamEvent = (event) => ({ type: "stream_event", event });

// A stream that got as far as a thinking block and the start of a tool call, then stalled.
const stalledStream = (id) => [
	streamEvent({ type: "message_start", message: { id } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } }),
	streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_dead", input: {} } }),
	streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
];

// One `assistant` message per block, as in tests/fixtures/sdk-streams/parallel-tools.jsonl.
const fallbackMessages = (id) => [
	{ type: "thinking", thinking: "Let me look.", signature: "sig" },
	{ type: "text", text: "Reading the log." },
	{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_a", input: { command: "ls" } },
].map((block, i) => ({ type: "assistant", parent_tool_use_id: null, uuid: `${id}-${i}`, message: { id, content: [block] } }));

describe("non-streaming fallback after a stalled stream", () => {
	it("delivers the fallback's tool call to pi and ends the stream on toolUse", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, [...stalledStream("msg_dead"), ...fallbackMessages("msg_fallback")]);

		const toolCalls = c.turnOutput.content.filter((b) => b.type === "toolCall");
		assert.deepStrictEqual(toolCalls.map((b) => b.id), ["toolu_a"]);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_a"]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
		assert.deepStrictEqual(stream.events.filter((e) => e.type === "done" || e.type === "end").map((e) => e.type), ["done", "end"]);
	});

	it("records the fallback as Claude Code's copy of the emitted message", async () => {
		const c = makeCtx();
		await consume(c, [...stalledStream("msg_dead"), ...fallbackMessages("msg_fallback")]);

		assert.deepStrictEqual(c.recording.recorded.digests, [digestMessage(c.turnOutput)]);
		assert.deepStrictEqual(c.recording.recorded.uuids, ["msg_fallback-2"]);
	});

	it("drops the dead stream's partial blocks instead of replaying them", async () => {
		const c = makeCtx();
		await consume(c, [...stalledStream("msg_dead"), ...fallbackMessages("msg_fallback")]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.type), ["thinking", "text", "toolCall"]);
		assert.strictEqual(c.turnOutput.content[0].thinking, "Let me look.");
		assert.strictEqual(c.turnOutput.content[0].thinkingSignature, "sig");
		assert.ok(!c.turnOutput.content.some((b) => b.id === "toolu_dead"));
	});

	it("drops the dead stream when Claude Code retries it as a new stream", async () => {
		const c = makeCtx();
		await consume(c, [
			...stalledStream("msg_dead"),
			streamEvent({ type: "message_start", message: { id: "msg_retry" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_retry", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.id]), [["toolCall", "toolu_retry"]]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
	});

	it("still skips the assistant message that repeats a completed stream", async () => {
		const c = makeCtx();
		await consume(c, [
			streamEvent({ type: "message_start", message: { id: "msg_1" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			{ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "hi" }] } },
			streamEvent({ type: "message_stop" }),
		]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.text), ["hi"]);
	});
});
