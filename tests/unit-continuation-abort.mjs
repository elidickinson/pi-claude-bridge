/**
 * An abort during a run that continues a parked query stops the query.
 *
 * When a run ends with Claude Code's query parked at a tool boundary (pi
 * blocked the call with `terminate: true`), the next run reaches that query
 * through the tool-result branch. Only the opening run's signal was bound to
 * the query, so aborting the next run did nothing and the turn generated to
 * the end.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-continuation-abort-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const init = { type: "system", subtype: "init", session_id: "cc-continued" };
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const textStart = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a very long essay" } }),
];

let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "blocked" }], isError: true, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const settle = () => new Promise((r) => setTimeout(r, 20));

let closes;
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	closes = 0;
	// Parks at a tool call, then, once the result is in, streams text until killed.
	setQuery(({ prompt }) => {
		let onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield init;
			for (const step of toolUse("toolu_1")) yield step;
			for (const step of textStart) yield step;
			await killed;
		})();
		gen.interrupt = async () => {};
		gen.close = () => { closes++; onClose(); };
		return gen;
	});
});

afterEach(() => setQuery(null));

async function parkThenContinue(secondSignal) {
	const ask = user("read a");
	const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: "pi-continued", signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");
	return streamSimple(model, { messages: [ask, parked, toolResult("toolu_1"), user("write an essay")], tools },
		{ sessionId: "pi-continued", signal: secondSignal });
}

describe("abort on a run that continues a parked query", () => {
	it("stops the query", async () => {
		const controller = new AbortController();
		const second = await parkThenContinue(controller.signal);
		await settle();
		controller.abort();
		const reply = await Promise.race([second.result(), new Promise((r) => setTimeout(() => r("timeout"), 1000))]);

		assert.notEqual(reply, "timeout", "the abort ends the turn");
		assert.equal(reply.stopReason, "aborted");
		assert.ok(closes >= 1, "the query is closed");
	});

	it("stops the query when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const second = await parkThenContinue(controller.signal);
		const reply = await Promise.race([second.result(), new Promise((r) => setTimeout(() => r("timeout"), 1000))]);

		assert.notEqual(reply, "timeout", "the abort ends the turn");
		assert.equal(reply.stopReason, "aborted");
	});
});
