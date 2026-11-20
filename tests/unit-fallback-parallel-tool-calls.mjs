/**
 * A non-streaming fallback that carries more than one tool call.
 *
 * When a response stream stalls before any tool call has finished, Claude Code
 * discards it and asks again without streaming. The answer is one API message, but
 * the SDK yields it the way it yields a streamed one: one `assistant` message per
 * content block, all under the same message id, back to back, with no stream_events
 * and no message_stop to say the last block has gone by. Recorded against CC 2.1.309
 * with diag/probe-nonstreaming-fallback.mjs; the dead stream before it ends with a
 * content_block_stop and a message_stop CC fabricates, and no message_delta.
 *
 * processAssistantMessage ended pi's turn on the first tool_use. consumeQuery drops
 * everything that arrives once there is no stream, so every later tool call of the
 * same message was lost, while Claude Code had dispatched all of them and waited in
 * the MCP handlers for results: pi ran one tool, the others never existed for it,
 * and the turn sat on "Working" until a person noticed (a real incident: bash and
 * MonitorCreate in one message, 227 minutes). unit-nonstreaming-fallback.mjs feeds
 * the whole message as one `assistant` message, which is not a shape CC emits.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([
	["mcp__custom-tools__bash", "bash"],
	["mcp__custom-tools__MonitorCreate", "MonitorCreate"],
]);

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

/** Feeds `messages` through consumeQuery, then parks like CC does once it has
 *  dispatched its tool calls: nothing more arrives until pi answers, and pi cannot
 *  answer until its stream has ended. `release()` lets the query finish. */
function startQuery(c, messages) {
	let release;
	const parked = new Promise((resolve) => { release = resolve; });
	async function* gen() {
		for (const m of messages) yield m;
		await parked;
	}
	const done = __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
	return { release, done };
}

async function until(predicate, what, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const streamEvent = (event) => ({ type: "stream_event", event });
const block = (id, b) => ({ type: "assistant", message: { id, stop_reason: "tool_use", content: [b] } });
const toolUse = (name, id, input) => ({ type: "tool_use", name: `mcp__custom-tools__${name}`, id, input });

// The stream that stalled: a thinking block opened, then silence until Claude Code's
// watchdog gave up and closed it — a content_block_stop and a message_stop, with no
// message_delta between, so no stop_reason.
const deadStream = [
	streamEvent({ type: "message_start", message: { id: "msg_dead" } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Both, in" } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_stop" }),
];

// The non-streaming answer, one block per message.
const fallbackBlocks = [
	block("msg_fallback", { type: "thinking", thinking: "Both, in parallel.", signature: "sig" }),
	block("msg_fallback", toolUse("bash", "toolu_bash", { command: "ls" })),
	block("msg_fallback", toolUse("MonitorCreate", "toolu_monitor", { command: "tail -f log" })),
];

describe("non-streaming fallback delivered one block per assistant message", () => {
	it("hands pi every tool call of the message, not just the first", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		const query = startQuery(c, [...deadStream, ...fallbackBlocks]);

		await until(() => stream.events.some((e) => e.type === "end"), "pi's stream to end");
		const done = stream.events.find((e) => e.type === "done");

		assert.deepStrictEqual(done.message.content.filter((b) => b.type === "toolCall").map((b) => b.id), ["toolu_bash", "toolu_monitor"]);
		assert.strictEqual(done.reason, "toolUse");
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
		assert.strictEqual(c.currentPiStream, null);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_bash", "toolu_monitor"]);
		query.release();
		await query.done;
	});

	it("emits toolcall_start and toolcall_end for each call before the stream ends", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		const query = startQuery(c, [...deadStream, ...fallbackBlocks]);

		await until(() => stream.events.some((e) => e.type === "end"), "pi's stream to end");
		const kinds = stream.events.filter((e) => e.type.startsWith("toolcall_")).map((e) => e.type);

		assert.deepStrictEqual(kinds, ["toolcall_start", "toolcall_end", "toolcall_start", "toolcall_end"]);
		assert.deepStrictEqual(stream.events.slice(-2).map((e) => e.type), ["done", "end"]);
		query.release();
		await query.done;
	});

	it("does the same when no stream preceded the fallback", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		const query = startQuery(c, fallbackBlocks);

		await until(() => stream.events.some((e) => e.type === "end"), "pi's stream to end");

		assert.deepStrictEqual(c.turnOutput.content.filter((b) => b.type === "toolCall").map((b) => b.id), ["toolu_bash", "toolu_monitor"]);
		query.release();
		await query.done;
	});

	it("ends the turn on toolUse when the query ends right behind the last block", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		async function* gen() { yield* [...deadStream, ...fallbackBlocks]; }
		await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);

		assert.strictEqual(stream.events.find((e) => e.type === "done")?.reason, "toolUse");
		assert.deepStrictEqual(c.turnOutput.content.filter((b) => b.type === "toolCall").map((b) => b.id), ["toolu_bash", "toolu_monitor"]);
	});

	// An error result inside the settle window ends the query: the calls Claude Code
	// dispatched will never be answered, so ending pi's turn on toolUse would hide the
	// failure and send pi to run tools for a query that no longer exists.
	it("leaves the turn to fail when an error result arrives before the fallback settles", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		const failed = { type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" };
		async function* gen() { yield* [...deadStream, ...fallbackBlocks, failed]; }
		const { failure } = await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);

		assert.strictEqual(failure?.message, "API Error: 529 overloaded");
		assert.strictEqual(stream.events.find((e) => e.type === "done"), undefined);
		assert.strictEqual(c.currentPiStream, stream);
		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, "API Error: 529 overloaded");
	});

	it("still ends a single-call fallback on toolUse", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		const query = startQuery(c, [fallbackBlocks[0], fallbackBlocks[1]]);

		await until(() => stream.events.some((e) => e.type === "end"), "pi's stream to end");

		assert.strictEqual(stream.events.find((e) => e.type === "done")?.reason, "toolUse");
		assert.deepStrictEqual(c.turnOutput.content.filter((b) => b.type === "toolCall").map((b) => b.id), ["toolu_bash"]);
		query.release();
		await query.done;
	});
});
