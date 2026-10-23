import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import { compareHistory, LiveRecording } from "../src/session-sync.js";
import { digestMessage, digestMessages } from "../src/message-digests.js";
const { __test } = await import("../src/index.js");
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-4-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user = (content) => ({ role: "user", content, timestamp: 1 });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: id }], timestamp: 1 });
const consume = (c, messages) => __test.consumeQuery((async function* () { yield* messages; })(), new Map([["mcp__custom-tools__read", "read"]]), model, () => false, c);
const fixture = JSON.parse("[" + readFileSync(new URL("./fixtures/sdk-streams/parallel-tools.jsonl", import.meta.url), "utf8").trim().split("\n").join(",") + "]");

it("pins three independently streamed result records and the last completed assistant boundary", async () => {
	const c = new QueryContext();
	const prompt = user("read three files");
	c.recording.users([prompt], 0, "prompt", true);
	c.resetTurnState(model);
	const first = c.currentPiStream = createAssistantMessageEventStream();
	const stop = fixture.findIndex((m) => m.event?.type === "message_stop");
	await consume(c, fixture.slice(0, stop + 1));
	const assistant = await first.result();
	const sdkAssistant = fixture.slice(0, stop).filter((m) => m.type === "assistant").at(-1);
	assert.deepEqual(c.recording.recorded.digests, digestMessages([prompt, assistant]));
	assert.equal(c.recording.recorded.uuids[1], sdkAssistant.uuid);
	assert.equal(c.recording.recorded.cuttable[1], false);
	const echoes = fixture.filter((m) => m.type === "user" && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result"));
	assert.equal(echoes.length, 3);
	const results = echoes.map((m) => result(m.message.content[0].tool_use_id));
	c.recording.results([prompt, assistant, ...results]);
	// There is deliberately no live UI stream here: the recording tap must run.
	await consume(c, echoes);
	assert.deepEqual(c.recording.recorded.uuids.slice(2), echoes.map((m) => m.uuid));
	assert.deepEqual(c.recording.recorded.cuttable, [true, false, false, false, true]);
	assert.deepEqual(c.recording.recorded.digests, digestMessages([prompt, assistant, ...results]));
});

it("late completed assistant echoes cover an already emitted tool step without mutating its message", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	const first = c.currentPiStream = createAssistantMessageEventStream();
	const stop = fixture.findIndex((m) => m.event?.type === "message_stop");
	const step = fixture.slice(0, stop + 1);
	await consume(c, step.filter((m) => m.type !== "assistant"));
	const output = await first.result();
	const digest = digestMessage(output);
	assert.equal(c.recording.recorded.digests.length, 0, "stream deltas alone are not durable coverage");
	await consume(c, step.filter((m) => m.type === "assistant"));
	assert.deepEqual(c.recording.recorded.digests, [digest]);
	output.durationMs = 123;
	assert.equal(digestMessage(output), digest);
});

it("a complete block plus an aborted partial block does not cover a live assistant slot", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	c.currentPiStream = createAssistantMessageEventStream();
	await consume(c, [
		{ type: "stream_event", event: { type: "message_start", message: { id: "partial" } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "complete" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "assistant", parent_tool_use_id: null, uuid: "complete", message: { id: "partial", model: model.id, content: [{ type: "text", text: "complete" }] } },
		{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial" } } },
	]);
	c.turnOutput.stopReason = "aborted";
	assert.deepEqual(c.recording.recorded.digests, []);
});

it("an unacknowledged steer blocks later results/assistants, not an imported null omission", () => {
	const live = new LiveRecording();
	const messages = [user("prompt"), user("lost"), user("acknowledged")];
	live.users(messages.slice(0, 1), 0, "prompt", true);
	live.users(messages.slice(0, 2), 1, "lost", false);
	live.users(messages, 2, "later", false);
	live.acknowledge("later");
	live.assistant("done-digest", [], "done");
	assert.deepEqual(live.recorded.digests, digestMessages(messages.slice(0, 1)));
	assert.deepEqual(live.recorded.uuids, ["prompt"]);
});

it("out-of-order parallel results cut only at the end of the complete batch", () => {
	const live = new LiveRecording();
	live.assistant("assistant", ["X", "Y"], "assistant-uuid");
	live.results([{ role: "assistant", content: [] }, result("X"), result("Y")]);
	live.result("Y", "first-record");
	live.result("X", "last-record");
	assert.deepEqual(live.recorded.uuids, ["assistant-uuid", "last-record", "first-record"]);
	assert.deepEqual(live.recorded.cuttable, [false, false, true]);
});

it("coalesced prompt users share a boundary but only the last can be cut", () => {
	const live = new LiveRecording();
	live.users([user("one"), user("two")], 0, "prompt", true);
	assert.deepEqual(live.recorded.uuids, ["prompt", "prompt"]);
	assert.deepEqual(live.recorded.cuttable, [false, true]);
	live.acknowledge("prompt");
	assert.deepEqual(live.recorded.cuttable, [false, true]);
});

it("an old buffered message cannot touch a replacement context after awaited rate-limit reporting", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	c.currentPiStream = createAssistantMessageEventStream();
	let enter, release;
	const entered = new Promise((r) => { enter = r; });
	const held = new Promise((r) => { release = r; });
	c.heldRateLimit = { status: "allowed", utilization: 0.1 };
	c.currentOnResponse = async () => { enter(); await held; };
	const sdk = (async function* () { yield { type: "assistant", parent_tool_use_id: null, uuid: "old", message: { id: "old-api", model: model.id, content: [{ type: "text", text: "old buffered text" }] } }; })();
	c.activeQuery = sdk;
	const consuming = __test.consumeQuery(sdk, new Map(), model, () => false, c);
	await entered;
	__test.discardRewrittenQuery(c);
	c.resetTurnState(model);
	c.turnOutput.content.push({ type: "text", text: "replacement" });
	c.recording = new LiveRecording();
	const replacement = c.currentPiStream = createAssistantMessageEventStream();
	release();
	await consuming;
	assert.deepEqual(c.turnOutput.content, [{ type: "text", text: "replacement" }]);
	assert.deepEqual(c.recording.recorded.digests, []);
	assert.equal(c.currentPiStream, replacement);
});

for (const laterTurn of [false, true]) it(`${laterTurn ? "later-turn" : "absorbed"} steer cuts account for assistant output before its replay`, async () => {
	const c = new QueryContext();
	const prompt = user("prompt");
	c.recording.users([prompt], 0, "prompt", true);
	const call = { role: "assistant", content: [{ type: "toolCall", id: "X", name: "read", arguments: {} }], provider: model.provider, timestamp: 1 };
	c.recording.assistant(digestMessage(call), ["X"], "call");
	const tr = result("X"), steer = user("steer");
	const context = [prompt, call, tr, steer];
	c.recording.results(context);
	c.recording.users(context, 3, "steer", false);
	c.resetTurnState(model);
	const stream = c.currentPiStream = createAssistantMessageEventStream();
	const complete = (id, text) => ({ type: "assistant", parent_tool_use_id: null, uuid: id, message: { id, model: model.id, content: [{ type: "text", text }] } });
	const replay = { type: "user", parent_tool_use_id: null, isReplay: true, uuid: "steer", message: { role: "user", content: "steer" } };
	await consume(c, [
		{ type: "user", parent_tool_use_id: null, uuid: "result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "X", content: "X" }] } },
		...(laterTurn ? [complete("before-steer", "before replay")] : []),
		replay,
		complete("after-steer", "after replay"),
	]);
	__test.finalizeCurrentStream(c);
	const output = await stream.result();
	assert.deepEqual(c.recording.recorded.digests, digestMessages([...context, output]));
	assert.equal(c.recording.recorded.cuttable[3], !laterTurn, "later-turn steer must back up before the earlier merged assistant");
	assert.equal(c.recording.recorded.cuttable[4], true);
	assert.equal(c.recording.recorded.uuids[4], "after-steer");
	assert.equal(c.recording.hasProgress, true);
});

it("result-only fallback output leaves an explicit live gap and cannot plain-resume hidden output", () => {
	const c = new QueryContext();
	c.recording.users([user("prompt")], 0, "prompt", true);
	c.resetTurnState(model);
	c.turnOutput.content.push({ type: "text", text: "result-only fallback" });
	c.currentPiStream = createAssistantMessageEventStream();
	__test.finalizeCurrentStream(c);
	assert.equal(c.recording.hasGaps, true);
	assert.equal(c.recording.hasProgress, false);
	assert.deepEqual(c.recording.recorded.uuids, ["prompt"]);
});

it("completed echoes after tool-result stream attachment only cover their original step", async () => {
	const c = new QueryContext();
	c.resetTurnState(model);
	const first = c.currentPiStream = createAssistantMessageEventStream();
	const stop = fixture.findIndex((m) => m.event?.type === "message_stop");
	const step = fixture.slice(0, stop + 1);
	await consume(c, step.filter((m) => m.type !== "assistant"));
	const output = await first.result();
	c.resetTurnState(model);
	const next = c.currentPiStream = createAssistantMessageEventStream();
	await consume(c, step.filter((m) => m.type === "assistant"));
	assert.deepEqual(c.recording.recorded.digests, [digestMessage(output)]);
	assert.deepEqual(c.turnBlocks, []);
	assert.equal(c.currentPiStream, next);
	assert.equal(c.lastAssistantMessageId, undefined);
});

it("overlapping identical user registrations cover one slot in either ack order, and repeated receipts are no-ops", () => {
	for (const order of [["a", "b"], ["b", "a"]]) {
		const live = new LiveRecording();
		const messages = [user("prompt"), user("steer")];
		live.users(messages.slice(0, 1), 0, "p", true);
		live.users(messages, 1, "a", false);
		live.users(messages, 1, "b", false);
		live.acknowledge(order[0]);
		assert.deepEqual(live.recorded.cuttable, [true, true]);
		live.acknowledge(order[1]);
		live.acknowledge(order[0]);
		assert.deepEqual(live.recorded, { digests: digestMessages(messages), uuids: ["p", order[0]], cuttable: [true, false] });
		assert.equal(compareHistory(digestMessages(messages), live.recorded).cutCount, 1, "the cut backs up before the copied run");
		assert.equal(live.hasGaps, true, "CC holds a second copy no slot represents");
		live.assistant(digestMessage(user("later")), [], "later");
		assert.equal(live.recorded.digests.length, 2, "no later slot is covered past the duplicate");
	}
});

it("a single receipt acknowledged twice records once and keeps coverage open", () => {
	const live = new LiveRecording();
	live.users([user("prompt")], 0, "p", false);
	live.acknowledge("p");
	live.acknowledge("p");
	live.assistant("answer", [], "answer-uuid");
	assert.deepEqual(live.recorded.uuids, ["p", "answer-uuid"]);
	assert.deepEqual(live.recorded.cuttable, [true, true]);
	assert.equal(live.hasGaps, false);
});

it("an old receipt never records changed content registered later at its index", () => {
	const old = [user("original")], changed = [user("CHANGED")];
	const live = new LiveRecording();
	live.users(old, 0, "a", false);
	live.users(changed, 0, "b", false);
	live.acknowledge("a");
	assert.deepEqual(live.recorded.digests, digestMessages(old));
	assert.equal(compareHistory(digestMessages(changed), live.recorded).commonPrefix, 0);
	const reverse = new LiveRecording();
	reverse.users(old, 0, "a", false);
	reverse.users(changed, 0, "b", false);
	reverse.acknowledge("b");
	assert.deepEqual(reverse.recorded.digests, [], "the new receipt cannot claim the old snapshot");
	reverse.acknowledge("a");
	assert.deepEqual(reverse.recorded.digests, [], "the old copy now duplicates consumed content");
});

it("re-registering an already covered index leaves history and pending slots untouched", () => {
	const first = [user("prompt")];
	const live = new LiveRecording();
	live.users(first, 0, "p", true);
	const recorded = structuredClone(live.recorded);
	live.users([user("REWRITTEN"), user("steer")], 0, "s", false);
	assert.deepEqual(live.recorded, recorded);
	live.acknowledge("s");
	assert.deepEqual(live.recorded, { ...recorded, cuttable: [false] }, "a receipt that re-sent covered content cannot extend coverage or keep its cut");
	assert.equal(live.hasGaps, true);
});
