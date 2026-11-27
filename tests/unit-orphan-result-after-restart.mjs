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
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSessionPath } from "cc-session-io";
import { globalConfigPath } from "../src/config.js";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts, markRebuildForSession } = mod.__test;
let providerConfig;
const pi = { on: () => {}, registerProvider: (_name, config) => { providerConfig = config; } };
mod.default(pi);
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
		const resumed = options.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === "1";
		const call = { options, resumed, stdinPrompts: [] };
		calls.push(call);
		// close() is how the bridge kills CC on abort; it ends a parked script.
		let closed = false, onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			const input = prompt[Symbol.asyncIterator]();
			let first;
			if (resumed) {
				const records = readFileSync(getSessionPath(options.resume, options.cwd, process.env.CLAUDE_CONFIG_DIR), "utf8").trim().split("\n").map(JSON.parse);
				const inlineRecord = records.at(-1);
				first = { type: "user", uuid: inlineRecord.uuid, message: inlineRecord.message };
			} else {
				first = (await input.next()).value;
				call.stdinPrompts.push(first);
			}
			// Keep draining stdin to catch a second opening prompt.
			void (async () => {
				for await (const msg of input) call.stdinPrompts.push(msg);
			})().catch(() => {});
			const content = first.message.content;
			call.prompt = typeof content === "string" ? content : content.map((b) => b.text ?? "").join("");
			const sessionId = options.sessionId ?? options.resume;
			for (const step of script.steps) {
				if (closed) return;
				if (typeof step === "function") { await step(killed); continue; }
				if (step.type === "system" && step.subtype === "init") {
					yield { ...step, session_id: sessionId };
					yield { ...first, isReplay: true, session_id: sessionId };
				} else yield step;
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
		assert.equal(calls[0].resumed, true, "Claude Code resumes the interrupted turn instead of reading a prompt (#274)");
		assert.equal(calls[0].options.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "0");
		assert.equal(calls[0].stdinPrompts.length, 0);
		assert.match(calls[0].prompt, /interrupted and resumed/);
		assert.equal(replyText(reply), "answer after restart");
	});

	it("an alternate Claude Code executable gets the continuation on stdin", async () => {
		const path = globalConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ provider: { pathToClaudeCodeExecutable: "/custom/claude" } }));
		try {
			mod.default(pi);
			scripts.push({ steps: [init("cc-alternate"), ...text("continued"), result("continued")] });
			await streamSimple(model, { messages: [user("read a"), toolCall("toolu_10"), toolResult("toolu_10")], tools: [] },
				{ sessionId: "pi-alternate" }).result();
			assert.equal(calls[0].options.pathToClaudeCodeExecutable, "/custom/claude");
			assert.equal(calls[0].resumed, false);
			assert.equal(calls[0].stdinPrompts.length, 1);
			assert.match(calls[0].prompt, /interrupted and resumed/);
		} finally {
			unlinkSync(path);
			mod.default(pi);
		}
	});

	it("an ordinary prompt never inherits the resume settings", async () => {
		scripts.push({ label: "prompt", steps: [init("cc-prompt"), ...text("hi"), result("hi")] });
		await streamSimple(model, { messages: [user("hello")], tools: [] }, { sessionId: "pi-prompt" }).result();
		assert.equal(calls[0].resumed, false);
		assert.equal(calls[0].stdinPrompts.length, 1);
		assert.equal(calls[0].options.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "1");
	});

	it("a user/extension message after an unparked tool result is written inline and resumed without a synthetic filler (#274)", async () => {
		scripts.push({ label: "inline", steps: [init("cc-inline"), ...text("continued with notice"), result("continued with notice")] });
		const reply = await streamSimple(model, {
			messages: [user("read a"), toolCall("toolu_12"), toolResult("toolu_12"), user("[budget notice: 80% used]")],
			tools: [],
		}, { sessionId: "pi-inline" }).result();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].resumed, true);
		assert.equal(calls[0].stdinPrompts.length, 0);
		assert.equal(calls[0].prompt, "[budget notice: 80% used]");
		assert.equal(replyText(reply), "continued with notice");
	});

	it("after compaction rewrote the history, tells Claude Code its context was compacted", async () => {
		// An overflow: pi compacts with no query parked, then retries from the
		// rewritten history, which ends at a tool result.
		markRebuildForSession("pi-compacted", "session_compact:overflow");
		scripts.push({ label: "rebuilt", steps: [init("cc-rebuilt"), ...text("continued"), result("continued")] });
		await streamSimple(model, { messages: [user("read a"), toolCall("toolu_7"), toolResult("toolu_7")], tools: [] },
			{ sessionId: "pi-compacted" }).result();

		assert.equal(calls.length, 1);
		assert.equal(calls[0].resumed, true);
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
