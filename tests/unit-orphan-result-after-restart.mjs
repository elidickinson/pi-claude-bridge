/**
 * A tool result with no parked query is orphaned only after an abort this
 * process observed.
 *
 * A durable host (pi-durable) checkpoints a tool call, and when its process is
 * killed mid-tool and reopened, it resumes the run by handing the provider the
 * history ending at that tool result. The new process has no parked query for
 * it, exactly like the user-abort case, and the orphan branch used to end the
 * turn with an empty reply. These pin both sides: after a restart the result
 * starts a fresh query that carries the turn on; after an observed abort it is
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
const { setQuery, resetSharedSession, activeQueryContexts } = mod.__test;
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
	setQuery(({ options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume });
		// close() is how the bridge kills CC on abort; it ends a parked script.
		let closed = false, onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
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
		assert.equal(replyText(reply), "answer after restart");
	});

	it("after an abort this process observed, ends the turn without a query", async () => {
		const controller = new AbortController();
		scripts.push({ label: "parked", steps: [init("cc-aborted"), ...toolUse("toolu_2"), (killed) => killed] });
		const first = streamSimple(model, { messages: [user("read a")], tools: [] }, { sessionId: "pi-aborted", signal: controller.signal });
		await settle();
		controller.abort();
		await first.result();
		activeQueryContexts.clear();

		const reply = await streamSimple(model, { messages: [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")], tools: [] },
			{ sessionId: "pi-aborted" }).result();

		assert.equal(calls.length, 1, "no query starts for the orphaned result");
		assert.equal(replyText(reply), "", "the turn ends empty, as before");
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
