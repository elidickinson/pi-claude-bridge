/**
 * When a response stream stalls, Claude Code abandons it and repeats the request
 * without streaming ("Error streaming, falling back to non-streaming mode"). The
 * answer arrives as one `assistant` message under a new message id, with no
 * stream_events of its own and no message_stop for the dead stream.
 *
 * The dead stream had already set turnSawStreamEvent, so processAssistantMessage
 * skipped the fallback as "already streamed". Its tool calls never reached pi, CC
 * waited in the MCP handler for results that never came, and the turn sat on
 * "Working" until the user aborted it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

const fallbackMessage = (id) => ({
	type: "assistant",
	message: { id, content: [
		{ type: "thinking", thinking: "Let me look at both.", signature: "sig" },
		{ type: "text", text: "Reading the log." },
		{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_a", input: { command: "ls" } },
		{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_b", input: { command: "pwd" } },
	] },
});

describe("non-streaming fallback after a stalled stream", () => {
	it("delivers the fallback's tool calls to pi and ends the stream on toolUse", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, [...stalledStream("msg_dead"), fallbackMessage("msg_fallback")]);

		const toolCalls = c.turnOutput.content.filter((b) => b.type === "toolCall");
		assert.deepStrictEqual(toolCalls.map((b) => b.id), ["toolu_a", "toolu_b"]);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_a", "toolu_b"]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
		assert.deepStrictEqual(stream.events.at(-2)?.type, "done");
		assert.deepStrictEqual(stream.events.at(-1)?.type, "end");
	});

	it("drops the dead stream's partial blocks instead of replaying them", async () => {
		const c = makeCtx();
		await consume(c, [...stalledStream("msg_dead"), fallbackMessage("msg_fallback")]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.type), ["thinking", "text", "toolCall", "toolCall"]);
		assert.strictEqual(c.turnOutput.content[0].thinking, "Let me look at both.");
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
