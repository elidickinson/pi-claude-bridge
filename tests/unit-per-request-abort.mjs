/**
 * Hosts that give every provider call its own abort signal.
 *
 * pi passes one agent-level signal to every streamSimple call of a run, so it
 * fires only when the user cancels. omo (a pi-based harness) wraps each provider
 * request in its own AbortController and aborts it in a `finally` once that
 * request's stream ends, toolUse included. The bridge bound the whole Claude
 * Code query to the first call's signal, so that cleanup killed the query while
 * it sat parked at the tool boundary; the tool result then arrived with nothing
 * to deliver to, took the orphaned-result path, and came back as an empty
 * end_turn. omo retries an empty response once, got the same, and failed every
 * tool-using turn with "Model returned an empty response twice".
 *
 * These drive real turn sequences through the provider with a mocked SDK
 * query() (see setQuery) and omo-shaped signals: one per call, aborted after
 * its stream ends.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before importing the module: the bridge resolves config and CC paths at import
// time — point them at a throwaway dir so no real state is read or written.
const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-per-request-abort-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts } = __test;

const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query ---
// Each fresh query pops one script. A query records interrupt/close into its
// script's `killed` list, which is how a test sees whether the CLI was stopped.
const scripts = [];
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const reply = (id, text) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

// --- pi-side message builders (same shapes pi hands to streamSimple) ---
let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const toolCall = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse", timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });

// The tool Claude calls must be one pi serves, or the bridge drops the call as unserved.
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];

/** One provider call the way omo makes it: its own AbortController per request. */
function omoCall(sessionId, messages) {
	const controller = new AbortController();
	const stream = streamSimple(model, { messages, tools }, { sessionId, signal: controller.signal });
	return { stream, controller };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

/** First turn of session `P`: Claude calls a tool, the stream ends on toolUse,
 *  and omo aborts that request's signal as cleanup. The script's gate decides
 *  when the parked query goes on past the tool result. */
async function parkAtToolBoundary(P, script) {
	scripts.push(script);
	const first = omoCall(P, [user("read a")]);
	const parked = await first.stream.result();
	assert.equal(parked.stopReason, "toolUse", "precondition: the turn parked on its tool call");
	first.controller.abort(); // omo's finally { requestAbortController.abort() }
	await settle();
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	scripts.length = 0;
	setQuery(() => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const gen = (async function* () {
			for (const step of script.steps) {
				if (typeof step === "function") { await step(); continue; }
				yield step;
			}
		})();
		gen.interrupt = async () => { script.killed.push("interrupt"); };
		gen.close = () => { script.killed.push("close"); };
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
});

describe("per-request abort signals (omo)", () => {
	it("the cleanup abort after a toolUse stream leaves the parked query to finish the turn", async () => {
		const P = "pi-omo";
		const g = gate();
		const script = { killed: [], steps: [init("cc-1"), ...toolUse("toolu_1"), g.wait, ...reply("2", "done"), result("done")] };
		await parkAtToolBoundary(P, script);

		assert.deepEqual(script.killed, [], "a request's own cleanup is not a cancel of the query");

		const second = omoCall(P, [user("read a"), toolCall("toolu_1"), toolResult("toolu_1")]);
		await settle();
		g.open();
		const final = await second.stream.result();

		assert.equal(final.stopReason, "stop", "the turn completes instead of ending aborted or empty");
		assert.equal(textOf(final), "done", "the tool result reached the query that asked for it");
		assert.deepEqual(script.killed, []);
	});

	it("a cancel while the continuation streams still stops the query", async () => {
		const P = "pi-omo-cancel";
		const g = gate();
		const midReply = gate();
		const script = { killed: [], steps: [init("cc-2"), ...toolUse("toolu_2"), g.wait,
			ev({ type: "message_start", message: { id: "msg_cut", usage: {} } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			midReply.wait, result("never")] };
		await parkAtToolBoundary(P, script);

		const second = omoCall(P, [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")]);
		await settle();
		g.open();
		await settle();
		second.controller.abort(); // the user presses Esc while the reply streams
		midReply.open();
		const final = await second.stream.result();

		assert.equal(final.stopReason, "aborted", "the continuation's own signal still cancels the turn");
		assert.ok(script.killed.includes("close"), "the CLI was stopped");
	});

	it("a deferred abort runs when the same session moves on without the tool result", async () => {
		const P = "pi-omo-moved-on";
		const g = gate();
		const script = { killed: [], steps: [init("cc-3"), ...toolUse("toolu_3"), g.wait, result("never")] };
		await parkAtToolBoundary(P, script);
		assert.deepEqual(script.killed, [], "held while the turn might still continue");

		// The tool was cancelled; the next thing the session sends is a new prompt.
		const next = { killed: [], steps: [init("cc-3b"), ...reply("3b", "ok"), result("ok")] };
		scripts.push(next);
		const fresh = omoCall(P, [user("never mind, do something else")]);
		g.open();
		await fresh.stream.result();

		assert.ok(script.killed.includes("close"), "the parked query is stopped, not leaked");
	});

	it("another session's prompt does not run a parked query's deferred abort", async () => {
		const P = "pi-omo-parent", C = "pi-omo-child";
		const g = gate();
		const script = { killed: [], steps: [init("cc-4"), ...toolUse("toolu_4"), g.wait, ...reply("4b", "parent done"), result("parent done")] };
		await parkAtToolBoundary(P, script);

		// A subagent runs inside the parent's tool call — its own pi session.
		scripts.push({ killed: [], steps: [init("cc-4c"), ...reply("4c", "child done"), result("child done")] });
		await omoCall(C, [user("child task")]).stream.result();
		assert.deepEqual(script.killed, [], "the child's turn says nothing about the parent's tool call");

		const second = omoCall(P, [user("read a"), toolCall("toolu_4"), toolResult("toolu_4")]);
		await settle();
		g.open();
		const final = await second.stream.result();
		assert.equal(textOf(final), "parent done");
		assert.deepEqual(script.killed, []);
	});
});
