/**
 * pi raises `before_provider_request` only from the `onPayload` hook it passes to a
 * provider (pi-coding-agent's sdk.js), and tracing extensions (Langfuse, LangSmith)
 * open their model-call record there. pi-ai's HTTP providers await the hook before
 * each request; the bridge did not call it, so Claude turns were never traced.
 *
 * Pins: the hook runs once per pi request (the opening prompt, each tool-result
 * continuation, one-off summaries) and before Claude Code receives the input it
 * answers; the payload carries no environment; a hook that throws or never settles
 * does not fail or hang the turn.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-on-payload-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts, isolatedStreamFn } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const init = { type: "system", subtype: "init", session_id: "cc-on-payload" };
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
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const replyText = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** What happened, in order: each onPayload call and each input Claude Code read. */
let order;

/** A fake query that records when Claude Code reads its prompt, then plays steps. */
function fakeQuery(steps) {
	setQuery(({ prompt }) => {
		const gen = (async function* () {
			const first = await prompt[Symbol.asyncIterator]().next();
			order.push(`prompt:${first.value.message.content[0].text}`);
			yield init;
			for (const step of steps) {
				if (typeof step === "function") { await step(); continue; }
				yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	order = [];
});

afterEach(() => setQuery(null));

describe("onPayload on the provider path", () => {
	it("runs before Claude Code receives the prompt, with the model and no environment", async () => {
		fakeQuery([...text("hi"), result("hi")]);
		const payloads = [];
		const onPayload = async (payload, m) => {
			await delay(20); // a slow observer still finishes first
			payloads.push({ payload, m });
			order.push("payload");
			return undefined;
		};
		const reply = await streamSimple(model, { messages: [user("say hi")], tools: [] }, { sessionId: "pi-a", onPayload }).result();

		assert.equal(replyText(reply), "hi");
		assert.deepEqual(order, ["payload", "prompt:say hi"]);
		assert.equal(payloads.length, 1);
		assert.equal(payloads[0].m, model);
		assert.ok(!("env" in payloads[0].payload), "the child environment holds secrets");
		assert.deepEqual(payloads[0].payload.prompt, [{ type: "text", text: "say hi" }]);
	});

	it("runs once more for each tool-result request, before the result is delivered", async () => {
		let resultDelivered = false;
		fakeQuery([...toolUse("toolu_1"), async () => { while (!resultDelivered) await delay(5); }, ...text("done"), result("done")]);
		const payloads = [];
		const onPayload = (payload) => {
			payloads.push(payload);
			const c = [...activeQueryContexts][0];
			order.push(`payload:${c?.pendingResults.has("toolu_1") ? "after" : "before"}-delivery`);
		};
		const ask = user("read a");
		const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: "pi-b", onPayload }).result();
		assert.equal(parked.stopReason, "toolUse");

		const next = streamSimple(model, { messages: [ask, parked, toolResult("toolu_1")], tools }, { sessionId: "pi-b", onPayload });
		const c = [...activeQueryContexts][0];
		while (!c.pendingResults.has("toolu_1")) await delay(5);
		resultDelivered = true;
		const reply = await next.result();

		assert.equal(replyText(reply), "done");
		assert.equal(payloads.length, 2, "one hook call per pi request");
		assert.deepEqual(payloads[1].toolResults, ["toolu_1"]);
		assert.deepEqual(order, ["payload:before-delivery", "prompt:read a", "payload:before-delivery"]);
	});

	it("goes ahead when the hook throws", async () => {
		fakeQuery([...text("still here"), result("still here")]);
		const onPayload = () => { throw new Error("tracer bug"); };
		const reply = await streamSimple(model, { messages: [user("go")], tools: [] }, { sessionId: "pi-c", onPayload }).result();
		assert.equal(replyText(reply), "still here");
	});

	it("goes ahead after 5 s when the hook never settles", async () => {
		fakeQuery([...text("late"), result("late")]);
		const onPayload = () => new Promise(() => {});
		const started = Date.now();
		const reply = await streamSimple(model, { messages: [user("go")], tools: [] }, { sessionId: "pi-d", onPayload }).result();
		const waited = Date.now() - started;
		assert.equal(replyText(reply), "late");
		assert.ok(waited >= 4_900 && waited < 8_000, `waited ${waited} ms`);
	});
});

describe("onPayload on the isolated path", () => {
	it("runs before the one-off query starts, without the environment", async () => {
		const payloads = [];
		setQuery(({ options }) => {
			order.push("query");
			assert.ok(options.env, "Claude Code still gets its environment");
			async function* gen() { yield { type: "result", subtype: "success", is_error: false, result: "summary" }; }
			const q = gen();
			q.interrupt = async () => {};
			q.close = () => {};
			return q;
		});
		const onPayload = async (payload) => { await delay(10); payloads.push(payload); order.push("payload"); };
		const context = { systemPrompt: "Summarise.", messages: [user("the conversation")] };
		const reply = await isolatedStreamFn(model, context, { cacheRetention: "none", onPayload }).result();

		assert.equal(reply.stopReason, "stop");
		assert.deepEqual(order, ["payload", "query"]);
		assert.ok(!("env" in payloads[0]));
		assert.equal(payloads[0].prompt, "the conversation");
	});
});

