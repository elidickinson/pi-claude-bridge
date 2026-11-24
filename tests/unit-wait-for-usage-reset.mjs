/**
 * provider.waitForUsageReset: a turn a rejected subscription window failed before
 * any output is retried once the window resets, instead of failing.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const mod = await import("../src/index.js");
const { __test } = mod;

let provider;
function activate(providerConfig) {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(join(getAgentDir(), "claude-bridge.json"), JSON.stringify({ provider: providerConfig }));
	mod.default({ on: () => {}, registerProvider: (_id, value) => { provider = value; } });
}
activate({});
const model = provider.models[0];

const NOW = 1_800_000_000_000;
const user = { role: "user", content: "hi", timestamp: 0 };
const ev = (event) => ({ type: "stream_event", event });
const rejected = (resetsAt) => [
	{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } },
	{ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 6:30pm" },
];
const answered = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
	{ type: "result", subtype: "success", is_error: false, result: "done" },
];

const toolUse = [
	ev({ type: "message_start", message: { id: "msg_tool", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];

let launches, notices, waiting;
/** Each launch replays the next script, after Claude Code's init message. A function
 *  in a script is awaited, standing in for Claude Code waiting on a tool result. */
function scriptQueries(...scripts) {
	__test.setQuery(({ options }) => {
		const script = scripts[launches++];
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume };
			for (const step of script) {
				if (typeof step === "function") await step();
				else yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
}

beforeEach(() => {
	launches = 0;
	notices = [];
	let announce;
	waiting = new Promise((resolve) => { announce = resolve; });
	__test.setPiUI({ notify: (message) => { notices.push(message); if (message.includes("waiting to retry")) announce(); } });
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
});

afterEach(() => {
	mock.timers.reset();
	__test.setQuery(null);
	__test.setPiUI(null);
	__test.resetSharedSession();
});

async function drain(stream) {
	const events = [];
	for await (const event of stream) events.push(event.type);
	return { events, output: await stream.result() };
}

describe("provider.waitForUsageReset", () => {
	it("retries the call after the window resets, showing pi no failure", async () => {
		activate({ waitForUsageReset: true });
		scriptQueries(rejected(NOW / 1000 + 600), answered);

		const turn = drain(provider.streamSimple(model, { messages: [user] }, { sessionId: "pi-wait" }));
		await waiting;
		assert.equal(launches, 1);
		mock.timers.tick(600_000 + 90_000);
		const { events, output } = await turn;

		assert.equal(launches, 2);
		assert.equal(output.stopReason, "stop", output.errorMessage);
		assert.ok(!events.includes("error"), `the rate-limited attempt never reaches pi: ${events}`);
	});

	it("retries a turn the limit hit after a tool call from its tool result", async () => {
		activate({ waitForUsageReset: true });
		let deliver;
		const delivered = new Promise((resolve) => { deliver = resolve; });
		scriptQueries([...toolUse, () => delivered, ...rejected(NOW / 1000 + 600)], answered);
		const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];

		const first = await drain(provider.streamSimple(model, { messages: [user], tools }, { sessionId: "pi-wait-tool" }));
		assert.equal(first.output.stopReason, "toolUse");
		const result = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2 };
		const turn = drain(provider.streamSimple(model, { messages: [user, first.output, result], tools }, { sessionId: "pi-wait-tool" }));
		deliver();
		await waiting;
		mock.timers.tick(600_000 + 90_000);
		const { events, output } = await turn;

		assert.equal(launches, 2);
		assert.equal(output.stopReason, "stop", output.errorMessage);
		assert.ok(!events.includes("error"), `the rate-limited attempt never reaches pi: ${events}`);
	});

	it("ends the wait when pi aborts the run", async () => {
		activate({ waitForUsageReset: true });
		scriptQueries(rejected(NOW / 1000 + 600), answered);
		const abort = new AbortController();

		const turn = drain(provider.streamSimple(model, { messages: [user] }, { sessionId: "pi-wait-abort", signal: abort.signal }));
		await waiting;
		abort.abort();
		const { output } = await turn;

		assert.equal(output.stopReason, "aborted");
		assert.equal(launches, 1);
	});

	it("fails the turn when the window resets more than a day out", async () => {
		activate({ waitForUsageReset: true });
		scriptQueries(rejected(NOW / 1000 + 2 * 86_400), answered);

		const { output } = await drain(provider.streamSimple(model, { messages: [user] }, { sessionId: "pi-wait-far" }));

		assert.equal(output.stopReason, "error");
		assert.match(output.errorMessage, /quota exceeded/);
		assert.equal(launches, 1);
	});

	it("is off by default", async () => {
		activate({});
		scriptQueries(rejected(NOW / 1000 + 600), answered);

		const { output } = await drain(provider.streamSimple(model, { messages: [user] }, { sessionId: "pi-wait-off" }));

		assert.equal(output.stopReason, "error");
		assert.equal(launches, 1);
		assert.ok(!notices.some((n) => n.includes("waiting to retry")));
	});
});
