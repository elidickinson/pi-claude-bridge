/**
 * The watchdog on MCP handlers waiting for a tool call pi never received.
 *
 * Claude Code dispatches every tool call of a message and waits in the bridge's MCP
 * handler for each result. Results come only from pi running the calls it was handed,
 * so a call that reached Claude Code but not pi (a parallel call dropped after a
 * non-streaming fallback is one way; there could be others) leaves its handler
 * waiting forever and the turn sits on "Working" until a person notices. The handler now checks, a few minutes after it parks,
 * that pi has the call, and fails the turn when it does not. A call pi does have is
 * left alone for as long as its tool runs.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";
import { diagLogPath } from "../src/log-paths.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([
	["mcp__custom-tools__bash", "bash"],
	["mcp__custom-tools__MonitorCreate", "MonitorCreate"],
]);
const piTools = ["bash", "MonitorCreate"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
const TIMEOUT = 40;

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

/** A context as streamClaudeAgentSdk leaves it mid-query, with a Claude Code query to kill. */
function makeCtx() {
	const c = new QueryContext();
	c.lostCallTimeoutMs = TIMEOUT;
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	const killed = [];
	c.activeQuery = { interrupt: async () => { killed.push("interrupt"); }, close: () => { killed.push("close"); } };
	c.promptStream = { fail: () => {} };
	__test.activeQueryContexts.add(c);
	return { c, killed, handlers: Object.fromEntries(__test.toMcpToolDefs(piTools, c).map((d) => [d.name, d.handler])) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settles to "pending" unless `promise` settled within `ms`. */
async function settled(promise, ms = TIMEOUT * 4) {
	return Promise.race([promise.then((v) => ({ value: v })), sleep(ms).then(() => "pending")]);
}

const block = (id, b) => ({ type: "assistant", message: { id, stop_reason: "tool_use", content: [b] } });
const toolUse = (name, id) => ({ type: "tool_use", name: `mcp__custom-tools__${name}`, id, input: { command: "x" } });
const result = (toolCallId) => ({ toolCallId, content: [{ type: "text", text: "ok" }] });

/** consumeQuery over a fallback that holds only `bash`: a message whose
 *  second tool call never reaches pi. Parks afterwards, like Claude Code waiting on its handlers. */
async function pieceOfAParallelCall(c) {
	let release;
	const parked = new Promise((resolve) => { release = resolve; });
	async function* gen() {
		yield block("msg_fb", { type: "thinking", thinking: "Both.", signature: "sig" });
		yield block("msg_fb", toolUse("bash", "toolu_bash"));
		await parked;
	}
	const done = __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
	const first = c.currentPiStream;
	const deadline = Date.now() + 3000;
	while (!first.events.some((e) => e.type === "end")) {
		if (Date.now() > deadline) assert.fail("pi's stream never ended on the tool call");
		await sleep(5);
	}
	return { release, done };
}

beforeEach(() => {
	__test.resetSharedSession();
	__test.setPiUI(null);
	__test.setSharedSession(null, { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false });
});

describe("a handler waiting on a tool call pi never received", () => {
	it("fails the turn pi is waiting on, once the timeout passes", async () => {
		const { c, killed, handlers } = makeCtx();
		const query = await pieceOfAParallelCall(c);
		const bash = handlers.bash("toolu_bash");
		const monitor = handlers.MonitorCreate("toolu_monitor");

		// pi ran bash and calls the provider again with its result, then waits on a new stream.
		const next = fakeStream();
		c.currentPiStream = next;
		c.resetTurnState(fakeModel);
		await __test.deliverToolResults(c, [result("toolu_bash")], null, 4);
		assert.deepStrictEqual(await settled(bash), { value: result("toolu_bash") });
		assert.strictEqual(await settled(monitor, 10), "pending", "must not fail before the timeout");

		await until(() => next.events.some((e) => e.type === "end"), "the watchdog to end pi's stream");
		const error = next.events.find((e) => e.type === "error");
		assert.strictEqual(error?.reason, "error");
		assert.match(error.error.errorMessage, /MonitorCreate \[toolu_monitor\]/);
		assert.match(error.error.errorMessage, /never received/);
		assert.strictEqual(c.currentPiStream, null);
		// The orphaned handler is released, and the Claude Code process behind it killed.
		assert.ok((await settled(monitor)).value, "the lost call's handler must settle");
		assert.deepStrictEqual(killed, ["interrupt", "close"]);
		assert.strictEqual(c.activeQuery, null);
		assert.ok(!__test.activeQueryContexts.has(c));
		assert.strictEqual(__test.getSharedSession(null).needsRebuild, true);
		query.release();
		await query.done;
	});

	it("records the loss in the diagnostics log and tells the user", async () => {
		const notices = [];
		__test.setPiUI({ notify: (text, level) => notices.push([text, level]) });
		const { c, handlers } = makeCtx();
		const next = fakeStream();
		c.currentPiStream = next;
		const monitor = handlers.MonitorCreate("toolu_monitor");

		await settled(monitor);

		assert.strictEqual(notices.length, 1);
		assert.strictEqual(notices[0][1], "error");
		assert.match(notices[0][0], /toolu_monitor/);
		const entries = readFileSync(diagLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const entry = entries.findLast((e) => e.label === "lost_tool_call");
		assert.strictEqual(entry?.toolCallId, "toolu_monitor");
		assert.strictEqual(entry.toolName, "MonitorCreate");
		assert.strictEqual(entry.streamOpen, true);
	});

	it("ends the query even when pi is still running the calls it did get", async () => {
		const { c, killed, handlers } = makeCtx();
		c.currentPiStream = null; // pi has the stream's tool calls and is executing them
		const monitor = handlers.MonitorCreate("toolu_monitor");

		assert.ok((await settled(monitor)).value);
		assert.deepStrictEqual(killed, ["interrupt", "close"]);
		assert.strictEqual(c.activeQuery, null);
		// pi's results will find no parked query and resume from its own history.
		assert.strictEqual(__test.getSharedSession(null).needsRebuild, true);
	});
});

describe("a handler waiting on a tool call pi has", () => {
	it("is left alone however long the tool runs", async () => {
		const { c, killed, handlers } = makeCtx();
		const query = await pieceOfAParallelCall(c);
		const stream = c.currentPiStream;
		const bash = handlers.bash("toolu_bash");

		assert.strictEqual(await settled(bash, TIMEOUT * 6), "pending");
		assert.deepStrictEqual(killed, []);
		assert.strictEqual(stream, null);
		assert.ok(c.activeQuery);
		// Its result still resolves it, long after the timeout.
		await __test.deliverToolResults(c, [result("toolu_bash")], null, 4);
		assert.deepStrictEqual(await settled(bash), { value: result("toolu_bash") });
		query.release();
		await query.done;
	});

	it("is left alone while the stream carrying it is still being built", async () => {
		const { c, killed, handlers } = makeCtx();
		const stream = c.currentPiStream;
		// Claude Code starts a tool the moment its block closes, minutes before the
		// message ends when a later block is long.
		c.turnBlocks.push({ type: "toolCall", id: "toolu_streaming", name: "bash", arguments: {} });
		const bash = handlers.bash("toolu_streaming");

		assert.strictEqual(await settled(bash, TIMEOUT * 6), "pending");
		assert.deepStrictEqual(killed, []);
		assert.strictEqual(c.currentPiStream, stream);
		assert.deepStrictEqual(stream.events, []);
	});

	it("is checked again, and failed if the call has since been dropped", async () => {
		const { c, handlers } = makeCtx();
		const stream = c.currentPiStream;
		c.turnBlocks.push({ type: "toolCall", id: "toolu_dropped", name: "bash", arguments: {} });
		const bash = handlers.bash("toolu_dropped");
		assert.strictEqual(await settled(bash, TIMEOUT * 1.5), "pending");

		c.turnBlocks.length = 0; // the stream was abandoned and its blocks dropped
		await until(() => stream.events.some((e) => e.type === "error"), "the second check to fail the turn");

		assert.match(stream.events.find((e) => e.type === "error").error.errorMessage, /toolu_dropped/);
		assert.ok((await settled(bash)).value);
	});

	it("is not failed after its result arrived in time", async () => {
		const { c, killed, handlers } = makeCtx();
		const stream = c.currentPiStream;
		const monitor = handlers.MonitorCreate("toolu_monitor");

		await __test.deliverToolResults(c, [result("toolu_monitor")], null, 4);
		assert.deepStrictEqual(await settled(monitor), { value: result("toolu_monitor") });
		await sleep(TIMEOUT * 4);

		assert.deepStrictEqual(killed, []);
		assert.deepStrictEqual(stream.events, []);
	});
});

async function until(predicate, what, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(5);
	}
}
