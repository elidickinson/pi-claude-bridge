/**
 * A response stream cut off *inside* a tool call's input. The block got its
 * content_block_start — so its name and id are known — and then nothing: no
 * input_json_delta, no content_block_stop. Claude Code closes the message,
 * drops the incomplete block from its own conversation, and resumes the turn
 * with a meta prompt of its own ("Your response above was cut off mid-stream.
 * Resume directly from where it stops").
 *
 * The bridge used to dispatch that half-built block anyway: turnSawToolCall was
 * set at content_block_start, so message_stop ended pi's turn on toolUse with
 * whatever the arguments happened to be — `{}` when the cut left no deltas at
 * all. pi rejected the call for its missing required properties, and its error
 * result was keyed to a tool_use id Claude Code had never issued: it could
 * match no MCP handler, so it was parked in pendingResults, while Claude Code's
 * resumed call parked in a handler waiting for pi. Both sides waited, and the
 * turn sat on "Working" until the user aborted it. Measured on pi session
 * dcc919d8 / CC session 814d9826: `notify_parent` dispatched with `{}`, three
 * minutes of silence, nothing reported to the parent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
// notify_parent rather than bash: bash carries a default timeout mapToolArgs
// injects, which has nothing to do with the block lifecycle under test.
const toolMap = new Map([["mcp__custom-tools__notify_parent", "notify_parent"]]);

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

// Text complete, then a tool call that only ever started: the shape of a stream
// cut inside the tool input. `partial_json` deltas are absent entirely, which is
// what made the dispatched arguments exactly `{}`.
const cutInsideToolInput = (id) => [
	streamEvent({ type: "message_start", message: { id } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reporting both fixes now." } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_cut", input: {} } }),
	streamEvent({ type: "message_stop" }),
];

describe("a tool call whose content_block_stop never arrived", () => {
	it("is not dispatched to pi, and does not end pi's turn", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, cutInsideToolInput("msg_cut"));

		assert.ok(!c.turnOutput.content.some((b) => b.type === "toolCall"),
			`no half-built tool call may reach pi, got ${JSON.stringify(c.turnOutput.content)}`);
		assert.notStrictEqual(c.turnOutput.stopReason, "toolUse");
		// Only the unfinished block goes. The text closed, and Claude Code keeps it in
		// its own conversation too.
		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.type), ["text"]);
		assert.deepStrictEqual(c.turnToolCallIds, []);
		// Left open on purpose: Claude Code's resume is more of this same pi turn,
		// and a turn ended here has no stream for the real call to arrive on.
		assert.strictEqual(c.currentPiStream, stream);
		assert.ok(!stream.events.some((e) => e.type === "done" || e.type === "end"),
			`pi's turn must stay open for the resumed call, got ${JSON.stringify(stream.events.map((e) => e.type))}`);
	});

	it("is replaced by the resumed message's call, which ends the turn", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, [
			...cutInsideToolInput("msg_cut"),
			// The resume is a new API request, hence a new message id and a new
			// tool_use id — the reason pi's result for the dropped id could never
			// have been matched to it.
			streamEvent({ type: "message_start", message: { id: "msg_resumed" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_resumed", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"summary":"Both fixes done."}' } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		]);

		// The text that survived the cut stays ahead of it, as it does in Claude
		// Code's own conversation; only the unfinished call was dropped.
		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.id, b.arguments]),
			[["text", undefined, undefined], ["toolCall", "toolu_resumed", { summary: "Both fixes done." }]]);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_resumed"]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
		assert.strictEqual(stream.events.at(-2)?.type, "done");
		assert.strictEqual(stream.events.at(-1)?.type, "end");
	});

	it("is replaced by a resume that arrives as an assistant message instead", async () => {
		const c = makeCtx();
		await consume(c, [
			...cutInsideToolInput("msg_cut"),
			{ type: "assistant", message: { id: "msg_resumed", content: [
				{ type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_resumed", input: { summary: "Both fixes done." } },
			] } },
		]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.id, b.arguments]),
			[["text", undefined, undefined], ["toolCall", "toolu_resumed", { summary: "Both fixes done." }]]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
	});

	// The cut lands in the second of two calls. Dropping the whole message here
	// would throw away a call Claude Code kept and dispatched, which is the same
	// deadlock the other way round: CC waiting in a handler pi was never told about.
	it("leaves a sibling call that did close to be dispatched", async () => {
		const c = makeCtx();
		await consume(c, [
			streamEvent({ type: "message_start", message: { id: "msg_pair" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_first", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"summary":"First."}' } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_cut", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"summ' } }),
			streamEvent({ type: "message_stop" }),
		]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.id, b.arguments]),
			[["toolCall", "toolu_first", { summary: "First." }]]);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_first"]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
	});

	// Negative control. Without it, refusing to dispatch anything at all passes
	// every assertion above, and no tool call ever reaches pi again.
	it("still dispatches a tool call that does close, with its full arguments", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, [
			streamEvent({ type: "message_start", message: { id: "msg_whole" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reporting now." } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_whole", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"summary":' } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Both fixes done."}' } }),
			streamEvent({ type: "content_block_stop", index: 1 }),
			streamEvent({ type: "message_stop" }),
		]);

		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.type), ["text", "toolCall"]);
		assert.deepStrictEqual(c.turnOutput.content[1].arguments, { summary: "Both fixes done." });
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_whole"]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
		assert.strictEqual(stream.events.at(-2)?.type, "done");
	});
});
