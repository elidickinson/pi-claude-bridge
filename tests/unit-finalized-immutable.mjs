/**
 * Query teardown never rewrites a turn pi already has (issue #181).
 *
 * A turn that ends on a tool call returns its assistant message to pi while
 * Claude Code's query stays parked. pi records that object by reference, so
 * failing it from a later abort, SDK exception or error result changed pi's
 * live copy to aborted/error while the session file kept toolUse. A later
 * Codex/Responses conversion then dropped the failed assistant and kept its
 * tool result, leaving a function_call_output with no function_call.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, getSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const toolUse = [
	ev({ type: "message_start", message: { id: "msg_tool", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const textStart = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
];
const errorResult = { type: "result", subtype: "success", is_error: true, result: "API Error: Overloaded" };
// Claude Code runs a steer it had queued even after an error result.
const steerTurn = [
	{ type: "user", parent_tool_use_id: null, isReplay: true, uuid: "steer", message: { role: "user", content: "steer" } },
	ev({ type: "message_start", message: { id: "msg_steer", usage: {} } }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	{ type: "result", subtype: "success", is_error: false, result: "done" },
];
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

// Streams `steps`, parks until released (by close() or `release`), then runs `after`.
// `parked` resolves once `steps` are consumed; `settled` once teardown has finished.
let release, parked, settled;
function parkingQuery(steps, after = async function* () {}) {
	let park, settle;
	parked = new Promise((r) => { park = r; });
	settled = new Promise((r) => { settle = r; });
	setQuery(({ prompt }) => {
		const gate = new Promise((r) => { release = r; });
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: "cc-finalized" };
			yield* steps;
			park();
			await gate;
			yield* after();
		})();
		gen.interrupt = async () => {};
		// Teardown closes the query last, after unregistering it; an abort also
		// closes it earlier, while it is still registered.
		gen.close = () => {
			release();
			if (activeQueryContexts.size === 0) settle();
		};
		return gen;
	});
}

const lateFailures = {
	"an abort": { end: (controller) => controller.abort(), stopReason: "aborted" },
	"an SDK exception": { after: async function* () { throw new Error("CLI exited"); }, end: () => release(), stopReason: "error" },
	"an error result": { after: async function* () { yield errorResult; yield* steerTurn; }, end: () => release(), stopReason: "error" },
};

let session = 0;
function run(steps, failure, messages = [{ role: "user", content: "go", timestamp: 1 }]) {
	parkingQuery(steps, failure.after);
	const controller = new AbortController();
	const piSessionId = `pi-finalized-${session++}`;
	const stream = streamSimple(model, { messages, tools }, { sessionId: piSessionId, signal: controller.signal });
	return { stream, controller, piSessionId };
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
});

afterEach(() => setQuery(null));

describe("a turn finalized on a tool call", () => {
	for (const [name, failure] of Object.entries(lateFailures)) {
		it(`is unchanged after ${name}`, async () => {
			const { stream, controller } = run(toolUse, failure);
			const done = await stream.result();
			assert.equal(done.stopReason, "toolUse");
			const snapshot = structuredClone(done);

			failure.end(controller);
			await settled;

			assert.deepStrictEqual(done, snapshot);
		});
	}
});

describe("a turn still streaming", () => {
	for (const [name, failure] of Object.entries(lateFailures)) {
		it(`reports ${name}`, async () => {
			const { stream, controller } = run(textStart, failure);
			await parked;

			failure.end(controller);
			const reply = await stream.result();
			await settled;

			assert.equal(reply.stopReason, failure.stopReason);
			assert.ok(reply.errorMessage);
		});
	}
});

it("drops the session mirror at an error result, so a queued steer is rebuilt", async () => {
	const messages = [
		{ role: "user", content: "previous prompt", timestamp: 1 },
		{
			role: "assistant", content: [{ type: "text", text: "previous answer" }],
			api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 2,
		},
		{ role: "user", content: "go", timestamp: 3 },
	];
	const { stream, piSessionId } = run(textStart, lateFailures["an error result"], messages);
	await parked;
	assert.ok(getSharedSession(piSessionId), "prior history created a mirror before the query failed");

	release();
	await stream.result();
	await settled;

	assert.equal(getSharedSession(piSessionId), null);
});
