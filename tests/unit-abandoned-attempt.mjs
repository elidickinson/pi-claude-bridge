/**
 * When an API attempt fails mid-stream (e.g. "Connection dropped (ECONNRESET)") and
 * Claude Code retries it, CC closes the dead stream itself before the retry: a
 * content_block_stop for the block left open, then a message_stop carrying
 * `abandoned_blocks: { api_message_id, from_block_index }` (blocks from that index on
 * were never completed). CC records nothing for those blocks, and none for the
 * message at all when from_block_index is 0.
 *
 * The bridge saw an ordinary closed stream: the dead attempt's empty, unsigned
 * thinking block stayed in pi's message ahead of the retry's blocks, and its message
 * id stayed among the turn's API ids. No CC record covers either, so the recording
 * ended with a gap, the session was marked dirtyTail, and the next query rebuilt
 * it with a large prompt-cache write.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import { compareHistory } from "../src/session-sync.js";
import { digestMessages } from "../src/message-digests.js";

const { __test } = await import("../src/index.js");

const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-opus-5-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);
const user = (content) => ({ role: "user", content, timestamp: 1 });
const ev = (event, extra = {}) => ({ type: "stream_event", parent_tool_use_id: null, event, ...extra });
const assistant = (id, uuid, block) => ({ type: "assistant", parent_tool_use_id: null, uuid, message: { id, model: model.id, content: [block] } });

/** The dead attempt as CC delivers it: opened a thinking block, then the connection
 *  dropped and CC closed the stream itself, naming it abandoned. */
const abandonedAttempt = (id, fromBlockIndex = 0) => [
	ev({ type: "message_start", message: { id } }, { api_message_id: id }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { api_message_id: id }),
	ev({ type: "content_block_stop", index: 0 }, { api_message_id: id }),
	ev({ type: "message_stop" }, { api_message_id: id, abandoned_blocks: { api_message_id: id, from_block_index: fromBlockIndex } }),
	{ type: "system", subtype: "api_retry", attempt: 1, error: "Connection dropped (ECONNRESET)" },
];

/** The retry: a signed thinking block and a tool call, each recorded by CC. */
const retry = (id, { recordToolUse = true } = {}) => [
	ev({ type: "message_start", message: { id } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
	assistant(id, `${id}-0`, { type: "thinking", thinking: "Let me look.", signature: "sig" }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_retry", input: {} } }),
	ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
	...(recordToolUse ? [assistant(id, `${id}-1`, { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_retry", input: { command: "ls" } })] : []),
	ev({ type: "content_block_stop", index: 1 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
	ev({ type: "message_stop" }),
];

async function runTurn(messages) {
	const c = new QueryContext();
	const prompt = user("list the files");
	c.recording.users([prompt], 0, "prompt", true);
	c.resetTurnState(model);
	const stream = c.currentPiStream = createAssistantMessageEventStream();
	await __test.consumeQuery((async function* () { yield* messages; })(), toolMap, model, () => false, c);
	__test.finalizeCurrentStream(c); // as the provider does once the query ends; a no-op after a tool-use stop
	return { c, prompt, output: await stream.result() };
}

/** Whether the next query would take row 4 (reuse) on this history: pi's priors equal
 *  the recorded digests and the recording left no gap (dirtyTail). */
const reusable = (c, history) => !c.recording.hasGaps && compareHistory(digestMessages(history), c.recording.recorded).equal;

it("an attempt CC abandoned before any block completed leaves no block and no recording gap", async () => {
	const { c, prompt, output } = await runTurn([...abandonedAttempt("msg_dead"), ...retry("msg_retry")]);

	assert.deepEqual(output.content.map((b) => [b.type, b.thinkingSignature ?? b.id]), [["thinking", "sig"], ["toolCall", "toolu_retry"]]);
	assert.deepEqual(c.turnAssistantIds, ["msg_retry"]);
	assert.equal(c.recording.hasGaps, false);
	assert.deepEqual(c.recording.recorded.uuids, ["prompt", "msg_retry-1"]);
	assert.ok(reusable(c, [prompt, output]), "the next query must reuse the session");
});

it("an attempt abandoned after a completed block drops only the blocks from from_block_index on", async () => {
	const id = "msg_partial";
	const { c, output } = await runTurn([
		ev({ type: "message_start", message: { id } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } }),
		assistant(id, `${id}-0`, { type: "text", text: "Checking." }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }),
		ev({ type: "content_block_stop", index: 1 }, { api_message_id: id }),
		ev({ type: "message_stop" }, { api_message_id: id, abandoned_blocks: { api_message_id: id, from_block_index: 1 } }),
	]);

	assert.deepEqual(output.content.map((b) => [b.type, b.text]), [["text", "Checking."]]);
	assert.deepEqual(c.turnAssistantIds, [id], "CC holds a record of the completed block, so the id stays");
	assert.equal(c.recording.hasGaps, false);
});

it("abandoned_blocks naming another message leaves the current stream alone", async () => {
	const { output } = await runTurn([
		ev({ type: "message_start", message: { id: "msg_live" } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
		assistant("msg_live", "msg_live-0", { type: "text", text: "hi" }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "message_stop" }, { abandoned_blocks: { api_message_id: "msg_other", from_block_index: 0 } }),
	]);
	assert.deepEqual(output.content.map((b) => b.text), ["hi"]);
});

it("a retry CC did not fully record still leaves a gap that marks the session dirty", async () => {
	const { c, prompt, output } = await runTurn([...abandonedAttempt("msg_dead"), ...retry("msg_retry", { recordToolUse: false })]);

	assert.deepEqual(output.content.map((b) => b.type), ["thinking", "toolCall"]);
	assert.equal(c.recording.hasGaps, true, "pi holds a tool call CC has no record of");
	assert.equal(reusable(c, [prompt, output]), false);
});

it("an abandoned tool call is never run: no toolCall, no tool-use stop, no gap", async () => {
	const dead = "msg_dead_tool";
	const { c, prompt, output } = await runTurn([
		ev({ type: "message_start", message: { id: dead } }, { api_message_id: dead }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_dead", input: {} } }, { api_message_id: dead }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"rm' } }, { api_message_id: dead }),
		ev({ type: "content_block_stop", index: 0 }, { api_message_id: dead }),
		ev({ type: "message_stop" }, { api_message_id: dead, abandoned_blocks: { api_message_id: dead, from_block_index: 0 } }),
		{ type: "system", subtype: "api_retry", attempt: 1, error: "Connection dropped (ECONNRESET)" },
		ev({ type: "message_start", message: { id: "msg_retry" } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
		assistant("msg_retry", "msg_retry-0", { type: "text", text: "Done." }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
		ev({ type: "message_stop" }),
	]);

	assert.ok(!output.content.some((b) => b.type === "toolCall"), "the dead attempt's tool call must not reach pi");
	assert.notEqual(output.stopReason, "toolUse");
	assert.deepEqual(output.content.map((b) => b.text), ["Done."]);
	assert.deepEqual(c.turnAssistantIds, ["msg_retry"]);
	assert.ok(!c.recording.recorded.uuids.some((u) => String(u).includes(dead)));
	assert.equal(c.recording.hasGaps, false);
	assert.ok(reusable(c, [prompt, output]), "the next query must reuse the session");
});
