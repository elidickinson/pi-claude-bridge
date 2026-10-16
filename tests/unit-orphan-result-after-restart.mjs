/**
 * A tool result with no parked query is orphaned only when pi delivers it on
 * an aborted signal, as it does after an abort during a tool call.
 *
 * A durable host (pi-durable) checkpoints a tool call, and when its process is
 * killed mid-tool and reopened, it resumes the run by handing the provider the
 * history ending at that tool result. The new process has no parked query for
 * it, exactly like the user-abort case, and the orphan branch used to end the
 * turn with an empty reply. These pin both sides: after a restart the result
 * starts a fresh query that carries the turn on; on an aborted signal it is
 * still dropped with an end_turn.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-orphan-restart-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts, markRebuildForSession } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const calls = [];
const scripts = [];
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
const text = (t) => [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });

let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolCall = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse", timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const settle = () => new Promise((r) => setTimeout(r, 20));
const replyText = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const call = { label: script.label, resume: options.resume };
		calls.push(call);
		// close() is how the bridge kills CC on abort; it ends a parked script.
		let closed = false, onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			call.prompt = (await prompt[Symbol.asyncIterator]().next()).value.message.content[0].text;
			for (const step of script.steps) {
				if (closed) return;
				if (typeof step === "function") { await step(killed); continue; }
				yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { closed = true; onClose(); };
		return gen;
	});
});

afterEach(() => setQuery(null));

describe("tool result with no parked query", () => {
	it("after a restart, starts a fresh query that answers the turn", async () => {
		// A new process: the history ends at a checkpointed tool result, and no
		// query of this process ever parked on it or was aborted.
		scripts.push({ label: "resumed", steps: [init("cc-resumed"), ...text("answer after restart"), result("answer after restart")] });
		const reply = await streamSimple(model, { messages: [user("read a"), toolCall("toolu_1"), toolResult("toolu_1")], tools: [] },
			{ sessionId: "pi-restarted" }).result();

		assert.equal(calls.length, 1, "the result carries the turn into a fresh query");
		assert.match(calls[0].prompt, /interrupted and resumed/);
		assert.equal(replyText(reply), "answer after restart");
	});

	it("after compaction rewrote the history, tells Claude Code its context was compacted", async () => {
		// An overflow: pi compacts with no query parked, then retries from the
		// rewritten history, which ends at a tool result.
		markRebuildForSession("pi-compacted", "session_compact:overflow");
		scripts.push({ label: "rebuilt", steps: [init("cc-rebuilt"), ...text("continued"), result("continued")] });
		await streamSimple(model, { messages: [user("read a"), toolCall("toolu_7"), toolResult("toolu_7")], tools: [] },
			{ sessionId: "pi-compacted" }).result();

		assert.equal(calls.length, 1);
		assert.match(calls[0].prompt, /context was compacted/);
	});

	it("after an abort, ends the turn without a query", async () => {
		const controller = new AbortController();
		scripts.push({ label: "parked", steps: [init("cc-aborted"), ...toolUse("toolu_2"), (killed) => killed] });
		const first = streamSimple(model, { messages: [user("read a")], tools: [] }, { sessionId: "pi-aborted", signal: controller.signal });
		await settle();
		controller.abort();
		await first.result();
		activeQueryContexts.clear();

		// pi calls back with the run's signal, which the abort left aborted.
		const reply = await streamSimple(model, { messages: [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")], tools: [] },
			{ sessionId: "pi-aborted", signal: controller.signal }).result();

		assert.equal(calls.length, 1, "no query starts for the orphaned result");
		assert.equal(replyText(reply), "", "the turn ends empty, as before");
	});

	it("a session aborted earlier still resumes a later retry ending at a tool result", async () => {
		const controller = new AbortController();
		scripts.push({ label: "parked", steps: [init("cc-earlier"), ...toolUse("toolu_5"), (killed) => killed] });
		const first = streamSimple(model, { messages: [user("read a")], tools: [] }, { sessionId: "pi-retry", signal: controller.signal });
		await settle();
		controller.abort();
		await first.result();
		activeQueryContexts.clear();

		// A later run (fresh signal) retries after an overflow or quota error, with
		// history ending at a tool result no query is parked on.
		scripts.push({ label: "retry", steps: [init("cc-retry"), ...text("resumed"), result("resumed")] });
		const reply = await streamSimple(model, { messages: [user("read b"), toolCall("toolu_6"), toolResult("toolu_6")], tools: [] },
			{ sessionId: "pi-retry", signal: new AbortController().signal }).result();

		assert.equal(calls.length, 2, "the retry starts a fresh query");
		assert.equal(replyText(reply), "resumed");
	});

	it("a parked query that fails resumes on pi's retry, even after an earlier abort (#192)", async () => {
		const controller = new AbortController();
		scripts.push({ label: "aborted", steps: [init("cc-old"), ...toolUse("toolu_8"), (killed) => killed] });
		const first = streamSimple(model, { messages: [user("read a")], tools: [] }, { sessionId: "pi-failed", signal: controller.signal });
		await settle();
		controller.abort();
		await first.result();

		// The query parks on a tool call, then fails (a quota error) once its result arrives.
		let fail;
		const failure = new Promise((r) => { fail = r; });
		scripts.push({ label: "failing", steps: [init("cc-failing"), ...toolUse("toolu_9"), async () => { await failure; throw new Error("rate limit (five_hour)"); }] });
		const ask = user("read b");
		const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
		const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: "pi-failed", signal: new AbortController().signal }).result();
		assert.equal(parked.stopReason, "toolUse");
		const history = [ask, parked, toolResult("toolu_9")];
		const failing = streamSimple(model, { messages: history, tools }, { sessionId: "pi-failed", signal: new AbortController().signal });
		fail();
		assert.equal((await failing.result()).stopReason, "error");
		await settle();

		// pi retries the same history on a fresh signal.
		scripts.push({ label: "retry", steps: [init("cc-retry"), ...text("answer after retry"), result("answer after retry")] });
		const reply = await streamSimple(model, { messages: history, tools }, { sessionId: "pi-failed", signal: new AbortController().signal }).result();

		assert.equal(calls.length, 3, "the retry starts a fresh query");
		assert.equal(replyText(reply), "answer after retry");
	});

	it("an abort in one session does not orphan another session's resumed result", async () => {
		const controller = new AbortController();
		scripts.push({ label: "parked", steps: [init("cc-other"), ...toolUse("toolu_3"), (killed) => killed] });
		const first = streamSimple(model, { messages: [user("read a")], tools: [] }, { sessionId: "pi-other", signal: controller.signal });
		await settle();
		controller.abort();
		await first.result();
		activeQueryContexts.clear();

		scripts.push({ label: "resumed", steps: [init("cc-mine"), ...text("mine"), result("mine")] });
		const reply = await streamSimple(model, { messages: [user("read a"), toolCall("toolu_4"), toolResult("toolu_4")], tools: [] },
			{ sessionId: "pi-mine" }).result();

		assert.equal(calls.length, 2);
		assert.equal(replyText(reply), "mine");
	});
});
