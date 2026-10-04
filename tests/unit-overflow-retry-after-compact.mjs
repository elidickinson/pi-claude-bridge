/**
 * Overflow recovery after a turn dies on "Prompt is too long" (issue #154).
 *
 * The failing query ends with an error result, so it leaves activeQueryContexts
 * before pi recovers. pi then drops the error message, compacts, emits
 * session_compact and retries with agent.continue() — over a context that ends
 * at the tool result the dead query was answering. With no query left to route
 * that result to, the provider took it for an orphan after an abort and emitted
 * an empty stop, which ends pi's run: the retry never reached Claude Code.
 *
 * The rewrite mark is what tells the two apart. These drive real turn sequences
 * through the registered streamSimple with a mocked SDK query() (see setQuery),
 * as tests/unit-cross-session-turns.mjs does.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before importing the module: syncSharedSession writes CC session files.
const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-overflow-retry-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { __test } = mod;
const { setQuery, resetSharedSession, markRebuildForSession, historyRewrittenBySession, activeQueryContexts } = __test;

let providerConfig;
const handlers = {};
mod.default({
	on: (event, handler) => { handlers[event] = handler; },
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query ---
// Each call pops one script and records the prompt the query was opened with.
const calls = [];
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
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });
const tooLong = { type: "result", subtype: "success", is_error: true, result: "Prompt is too long" };

// --- pi-side message builders ---
let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: clock++ });
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });

// Served, so the bridge parks turn 1 on the tool call rather than skipping it.
const tools = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const call = (sessionId, messages) => streamSimple(model, { messages, tools }, { sessionId });
const settle = () => new Promise((r) => setTimeout(r, 20));
const CONTINUE_PROMPT = /^\[Your context was compacted\./;

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const entry = { label: script.label, resume: options.resume, prompt: undefined };
		calls.push(entry);
		const gen = (async function* () {
			const first = await prompt[Symbol.asyncIterator]().next();
			entry.prompt = first.value?.message.content.map((b) => b.text ?? `[${b.type}]`).join("");
			for (const step of script.steps) {
				if (typeof step === "function") { await step(); continue; }
				yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
});

describe("retry after an overflow compaction", () => {
	it("opens a fresh query for a retry that ends at a tool result", async () => {
		const P = "pi-overflow";
		markRebuildForSession(P, "session_compact:overflow:willRetry=true");
		assert.equal(activeQueryContexts.size, 0, "precondition: the failed query already left");

		scripts.push({ label: "retry", steps: [init("cc-retry"), result("continued")] });
		const out = await call(P, [user("compaction summary"), toolCall("toolu_1"), toolResult("toolu_1")]).result();

		assert.equal(calls.length, 1, "the retry must reach Claude Code, not end the run as an orphan");
		assert.match(calls[0].prompt, CONTINUE_PROMPT, "the turn continues from its tool result");
		assert.deepEqual(out.content, [{ type: "text", text: "continued" }]);
		assert.equal(historyRewrittenBySession.has(P), false, "the fresh query consumes the mark");
	});

	it("still ends an orphaned tool result without a query when nothing was rewritten", async () => {
		const out = await call("pi-abort", [user("go"), toolCall("toolu_1"), toolResult("toolu_1")]).result();

		assert.equal(calls.length, 0, "a genuine abort has nothing to continue");
		assert.equal(out.stopReason, "stop");
		assert.deepEqual(out.content, []);
	});

	it("does not continue on a sibling session's rewrite", async () => {
		markRebuildForSession("pi-sibling", "session_compact:threshold");

		const out = await call("pi-abort", [user("go"), toolCall("toolu_1"), toolResult("toolu_1")]).result();

		assert.equal(calls.length, 0, "another pi session's compaction says nothing about this one");
		assert.deepEqual(out.content, []);
		assert.ok(historyRewrittenBySession.has("pi-sibling"), "and leaves the sibling's mark armed");
	});

	it("survives the full sequence: error result, session_compact, retry", async () => {
		const P = "pi-overflow";
		const u1 = user("read a"), a1 = toolCall("toolu_1"), tr1 = toolResult("toolu_1");
		const g = gate();

		// Turn 1 parks on a tool call, then dies on the overflow once the result is in.
		scripts.push({ label: "turn 1", steps: [init("cc-1"), ...toolUse("toolu_1"), g.wait, tooLong] });
		await call(P, [u1]).result();
		const delivery = call(P, [u1, a1, tr1]);
		await settle();
		g.open();
		const failed = await delivery.result();
		assert.equal(failed.stopReason, "error");
		await settle();
		assert.equal(activeQueryContexts.size, 0, "precondition: the failed query left the routing set");

		// pi drops the error message, compacts, and retries via agent.continue().
		handlers.session_compact({ reason: "overflow", willRetry: true }, { sessionManager: { getSessionId: () => P } });
		scripts.push({ label: "retry", steps: [init("cc-2"), result("continued")] });
		const out = await call(P, [user("compaction summary"), a1, tr1]).result();

		assert.equal(calls.length, 2, "the retry opened a query of its own");
		assert.match(calls[1].prompt, CONTINUE_PROMPT);
		assert.equal(out.stopReason, "stop");
		assert.deepEqual(out.content, [{ type: "text", text: "continued" }]);
		assert.equal(historyRewrittenBySession.has(P), false);
	});
});
