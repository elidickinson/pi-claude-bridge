/**
 * A context transform can rewrite the history while a Claude Code query is
 * parked at a tool boundary. Tool-result delivery never calls
 * syncSharedSession, so the session mirror would otherwise keep the old
 * conversation. Compare the incoming conversation before delivery against the
 * digest recorded at query start, let the query finish its turn, and rebuild
 * the mirror at the next fresh query.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-transform-cc-"));
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
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

const calls = [];
const scripts = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => toolUseMany([id]);
const toolUseMany = (ids) => [
	ev({ type: "message_start", message: { id: `msg_${ids.join("_")}`, usage: {} } }),
	...ids.flatMap((id, i) => [
		ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
		ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
		ev({ type: "content_block_stop", index: i }),
	]),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const textStart = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parked" } }),
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
const toolCall = (id) => toolCallMany([id]);
const toolCallMany = (ids) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: "a" } })),
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

describe("context transform while a query is parked", () => {
	it("keeps the parked query through a rewrite and rebuilds after the turn", async () => {
		let releaseReply;
		const resultDelivered = new Promise((r) => { releaseReply = r; });
		scripts.push({ label: "parked", steps: [init("cc-old"), ...toolUse("call_1"), () => resultDelivered, ...text("answered"), result("answered")] });
		const first = streamSimple(model, { messages: [user("Original question")], tools }, { sessionId: "pi-acp" });
		await settle();
		const firstReply = await first.result();
		assert.equal(firstReply.stopReason, "toolUse", "precondition: the query stayed parked at the tool call");
		assert.equal(activeQueryContexts.size, 1, "precondition: one live context owns the call");

		// Discarding the query here would resume a rebuilt session ending in this
		// tool result, which Claude Code answers with "No response requested."
		const rewritten = [user("Rewritten summary"), toolCall("call_1"), toolResult("call_1")];
		const second = streamSimple(model, { messages: rewritten, tools }, { sessionId: "pi-acp" });
		releaseReply();
		const reply = await second.result();
		assert.equal(calls.length, 1, "the parked query keeps the turn");
		assert.equal(replyText(reply), "answered", "the turn completes on the parked query");
		await settle();
		assert.equal(mod.__test.getSharedSession("pi-acp")?.needsRebuild, true, "the mirror rebuilds at the next fresh query");

		scripts.push({ label: "next", steps: [init("cc-next"), ...text("next"), result("next")] });
		const answered = { ...toolCall("x"), content: [{ type: "text", text: "answered" }], stopReason: "stop" };
		await streamSimple(model, { messages: [...rewritten, answered, user("Next question")], tools }, { sessionId: "pi-acp" }).result();
		assert.equal(calls.length, 2, "the next prompt starts a fresh query");
		assert.equal(calls[1].prompt, "Next question", "the fresh query carries the real prompt, not a continuation marker");
		assert.ok(calls[1].resume, "the fresh query resumes the rebuilt session");
		assert.notEqual(mod.__test.getSharedSession("pi-acp")?.needsRebuild, true, "the rebuild consumed the mark");
	});

	it("does not treat an earlier tool result as a context rewrite", async () => {
		scripts.push({ label: "parked", steps: [init("cc-old"), ...toolUse("call_1"), ...textStart, (killed) => killed] });
		scripts.push({ label: "fallback", steps: [init("cc-new"), ...text("fallback"), result("fallback")] });

		const first = streamSimple(model, {
			messages: [
				user("Original question"),
				toolCall("call_0"),
				toolResult("call_0"),
				user("Next question"),
			],
			tools,
		}, { sessionId: "pi-acp" });
		await settle();
		const firstReply = await first.result();
		assert.equal(firstReply.stopReason, "toolUse", "precondition: the query stayed parked");

		await streamSimple(model, {
			messages: [
				user("Original question"),
				toolCall("call_0"),
				toolResult("call_0"),
				user("Next question"),
				toolCall("call_1"),
				toolResult("call_1"),
			],
			tools,
		}, { sessionId: "pi-acp" });
		await settle();

		assert.equal(calls.length, 1, "an older tool result is part of the query snapshot, not a rewrite");
		assert.equal(activeQueryContexts.size, 1, "the parked query still owns the turn");
	});

	it("keeps the start snapshot across multiple tool results in one parked turn", async () => {
		scripts.push({ label: "parked", steps: [init("cc-old"), ...toolUseMany(["call_1", "call_2"]), ...textStart, (killed) => killed] });
		scripts.push({ label: "fallback", steps: [init("cc-new"), ...text("fallback"), result("fallback")] });

		const first = streamSimple(model, { messages: [user("Question")], tools }, { sessionId: "pi-acp" });
		await settle();
		const firstReply = await first.result();
		assert.equal(firstReply.stopReason, "toolUse", "precondition: the query stayed parked");

		const history = [
			user("Question"),
			toolCallMany(["call_1", "call_2"]),
			toolResult("call_1"),
			toolResult("call_2"),
		];
		await streamSimple(model, { messages: history.slice(0, 3), tools }, { sessionId: "pi-acp" });
		await settle();
		assert.equal(calls.length, 1, "the first result stays on the parked query");

		await streamSimple(model, { messages: history, tools }, { sessionId: "pi-acp" });
		await settle();
		assert.equal(calls.length, 1, "the second result must not be compared against the delivered context");
	});

	it("does not treat the query's own earlier tool round as a rewrite", async () => {
		let releaseRound2;
		const round1Delivered = new Promise((r) => { releaseRound2 = r; });
		scripts.push({ label: "parked", steps: [init("cc-old"), ...toolUse("call_1"), () => round1Delivered, ...toolUse("call_2"), ...textStart, (killed) => killed] });
		scripts.push({ label: "fallback", steps: [init("cc-new"), ...text("fallback"), result("fallback")] });

		const first = streamSimple(model, { messages: [user("Question")], tools }, { sessionId: "pi-acp" });
		await settle();
		assert.equal((await first.result()).stopReason, "toolUse", "precondition: the query parked on round 1");

		const history = [user("Question"), toolCall("call_1"), toolResult("call_1"), toolCall("call_2"), toolResult("call_2")];
		const second = streamSimple(model, { messages: history.slice(0, 3), tools }, { sessionId: "pi-acp" });
		releaseRound2();
		await settle();
		assert.equal((await second.result()).stopReason, "toolUse", "precondition: the query parked on round 2");
		assert.equal(calls.length, 1, "round 1 stays on the parked query");

		// Round 2's delivery carries round 1's call and result, which this query
		// produced after its start snapshot: they are not a rewrite.
		await streamSimple(model, { messages: history, tools }, { sessionId: "pi-acp" });
		await settle();
		assert.equal(calls.length, 1, "round 2 must not discard the query and rebuild");
		assert.equal(activeQueryContexts.size, 1, "the parked query still owns the turn");
	});
});
