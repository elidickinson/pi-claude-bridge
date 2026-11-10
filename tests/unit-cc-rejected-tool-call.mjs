// Real SDK and Claude Code against a local API stub (issue #218): Claude Code
// rejects a tool call itself (a permissions.deny rule, a PreToolUse hook, input
// that is not JSON) without calling the bridge's MCP handler. A call rejected
// before pi is handed it fails the turn, so pi runs none of its calls; one
// rejected during or after pi's execution also fails, and the next prompt
// carries pi's result, not CC's rejection. A served name in the wrong case is
// not a rejection: it never reaches pi, and CC retries under the served name.
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonEvent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js";
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const mod = await import("../src/index.js");
const handlers = {};
let provider;
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; } });
const model = provider.models[0];
const tools = ["probe", "fast", "Shout"].map((name) => ({ name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } }));
const cwd = mkdtempSync(join(tmpdir(), "cc-rejected-tool-call-"));
const env = {};
const sessions = [];
const bodies = [];
const warnings = [];
const ui = { notify: (text, level) => { if (level === "warning") warnings.push(text); } };
/** The tool calls of each model response to come, in order: { name, json }. A response with none, or past the end, ends the turn. */
let plan = [];
let requests = 0;
// A prompt starting "again" gets a text answer; anything else the next response of `plan`.
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	bodies.push(JSON.stringify(body.messages));
	const n = ++requests;
	const calls = JSON.stringify(body.messages.findLast((m) => m.role === "user")).includes("again") ? [] : plan.shift() ?? [];
	const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
	const block = (index, content_block, delta) => [
		event("content_block_start", { index, content_block }),
		event("content_block_delta", { index, delta }),
		event("content_block_stop", { index }),
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end([
		event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		...block(0, { type: "text", text: "" }, { type: "text_delta", text: `Step ${n}.` }),
		...calls.flatMap(({ name, json = "{}" }, i) => block(i + 1, { type: "tool_use", id: `toolu_${n}_${i}`, name: `mcp__custom-tools__${name}`, input: {} }, { type: "input_json_delta", partial_json: json })),
		event("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
		event("message_stop", {}),
	].join(""));
});

before(async () => {
	mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
});
after(async () => {
	for (const sid of sessions) for (const fn of handlers.session_shutdown) fn({}, { sessionManager: { getSessionId: () => sid } });
	for (const key of Object.keys(env)) delete process.env[key];
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(cwd, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(promise) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the turn hung")), 5_000); })]); }
	finally { clearTimeout(timer); }
}
/** Waits until the debug log matches `pattern`. */
async function logged(pattern) {
	for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(20)) {
		if (pattern.test(readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8"))) return;
	}
	assert.fail(`the debug log never matched ${pattern}`);
}

/** A pi session whose Claude Code runs with these user settings and model responses. */
function session(sid, settings, responses) {
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify(settings));
	plan = responses;
	sessions.push(sid);
	for (const fn of handlers.session_start) fn({}, { cwd, ui, sessionManager: { getSessionId: () => sid } });
	const history = [{ role: "user", content: "call probe", timestamp: 1 }];
	/** One provider call. Its events are read only once it ended, the way pi's
	 *  JSON mode reads a queue it fell behind on: each toolcall_start has to still
	 *  index a tool call in the final message. */
	const call = async () => {
		const stream = provider.streamSimple(model, { messages: history, tools }, { sessionId: sid });
		const message = await settle(stream.result());
		for await (const event of stream) {
			if (event.type === "toolcall_start") toJsonEvent({ type: "message_update", assistantMessageEvent: event, message: event.partial });
		}
		history.push(message);
		return message;
	};
	const resultText = `probe ran for ${sid}`;
	const returnResults = (message) => {
		for (const b of message.content.filter((b) => b.type === "toolCall")) {
			history.push({ role: "toolResult", toolCallId: b.id, toolName: b.name, content: [{ type: "text", text: resultText }], isError: false, timestamp: 1 });
		}
	};
	/** One more prompt completes; returns the request body it sent. */
	const nextPrompt = async () => {
		for (const fn of handlers.agent_start) await fn({ type: "agent_start" }, { getSystemPrompt: () => "", sessionManager: { getSessionId: () => sid } });
		history.push({ role: "user", content: `again ${sid}`, timestamp: 1 });
		assert.equal((await call()).stopReason, "stop");
		return bodies.findLast((b) => b.includes(`again ${sid}`));
	};
	return { call, returnResults, nextPrompt, resultText };
}

function blockingHook(name, sleepSeconds) {
	const script = join(process.env.CLAUDE_CONFIG_DIR, `${name}.sh`);
	writeFileSync(script, `#!/bin/sh\ncat >/dev/null\nsleep ${sleepSeconds}\necho 'blocked by test hook' >&2\nexit 2\n`);
	chmodSync(script, 0o755);
	return { hooks: { PreToolUse: [{ matcher: "mcp__custom-tools__probe", hooks: [{ type: "command", command: script }] }] } };
}

it("a call a permissions.deny rule rejects before pi gets it fails the turn", { timeout: 60_000 }, async () => {
	const s = session("pi-deny", { permissions: { deny: ["mcp__custom-tools__probe"] } }, [[{ name: "probe" }]]);
	const message = await s.call();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage, /"probe" before pi started running it.*Permission to use mcp__custom-tools__probe has been denied/);
	await s.nextPrompt();
});

it("a rejected call with a valid sibling leaves no unanswered tool calls in the next request", { timeout: 60_000 }, async () => {
	const s = session("pi-denied-batch", { permissions: { deny: ["mcp__custom-tools__probe"] } }, [[{ name: "probe" }, { name: "fast" }]]);
	assert.equal((await s.call()).stopReason, "error");
	const messages = JSON.parse(await s.nextPrompt());
	const pending = new Set();
	for (const message of messages) {
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "tool_use") pending.add(block.id);
			if (block.type === "tool_result") assert.ok(pending.delete(block.tool_use_id), `unmatched tool result ${block.tool_use_id}`);
		}
	}
	assert.deepEqual([...pending], [], "the next request contains unanswered tool calls");
});

it("input that is not JSON fails the turn before pi runs any of the message's calls", { timeout: 60_000 }, async () => {
	const s = session("pi-bad-json", {}, [[{ name: "probe", json: '{"path": "C:\\pi\\x"}' }, { name: "fast" }]]);
	const message = await s.call();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage, /"probe" before pi started running it.*InputValidationError/);
	await s.nextPrompt();
});

it("a served name in the wrong case never reaches pi, and the retry under the exact name does", { timeout: 60_000 }, async () => {
	const s = session("pi-wrong-case", {}, [[{ name: "shout" }], [{ name: "Shout" }]]);
	const message = await s.call();
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content.filter((b) => b.type === "toolCall").map((b) => [b.name, b.id]), [["Shout", `toolu_${requests}_0`]]);
	assert.ok(bodies.at(-1).includes("No such tool available: mcp__custom-tools__shout"), "Claude Code did not reject the wrong-case name");
	s.returnResults(message);
	assert.equal((await s.call()).stopReason, "stop");
	assert.ok((await s.nextPrompt()).includes(s.resultText), "pi's result for Shout is missing from the next request");
});

/** The hook cases: pi ran probe, so the next request holds pi's result, not CC's rejection. */
async function assertNextRequestHasPiResult(s) {
	const body = await s.nextPrompt();
	assert.ok(body.includes(s.resultText), "pi's result for probe is missing from the next request");
	assert.ok(!body.includes("blocked by test hook"), "Claude Code's rejection reached the next request");
}

it("a hook rejecting a tool pi is still running fails the turn, while the model moves on to another tool", { timeout: 60_000 }, async () => {
	const s = session("pi-hook", blockingHook("block", 0), [[{ name: "probe" }], [{ name: "fast" }]]);
	const first = await s.call();
	assert.equal(first.stopReason, "toolUse");
	const [{ id }] = first.content.filter((b) => b.type === "toolCall");
	await logged(new RegExp(`rejected tool call \\[${id}\\] while pi runs it`));
	s.returnResults(first);
	const message = await s.call();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage, /"probe" after pi had started running it.*blocked by test hook/);
	await assertNextRequestHasPiResult(s);
	await s.nextPrompt();
	const syncs = readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8").match(/syncResult: path=\S+(?=.*piSession=pi-hook$)/gm);
	assert.equal(syncs.at(-1), "syncResult: path=reuse", "the recovered turn was not recorded for reuse");
});

it("a rejection does not fail the next user prompt when pi ends without a tool-result continuation", { timeout: 60_000 }, async () => {
	const s = session("pi-ended-tool", blockingHook("ended-tool", 0), [[{ name: "probe" }]]);
	const first = await s.call();
	assert.equal(first.stopReason, "toolUse");
	const [{ id }] = first.content.filter((b) => b.type === "toolCall");
	await logged(new RegExp(`rejected tool call \\[${id}\\] while pi runs it`));
	s.returnResults(first);
	// A terminating tool ends pi's run here, without another provider call.
	await assertNextRequestHasPiResult(s);
});

it("a hook rejecting a tool pi already finished fails the turn, and the next request carries pi's result", { timeout: 60_000 }, async () => {
	const s = session("pi-slow-hook", blockingHook("slow-block", 1), [[{ name: "probe" }]]);
	const first = await s.call();
	assert.equal(first.stopReason, "toolUse");
	s.returnResults(first);
	const message = await s.call();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage, /"probe" after pi ran it.*blocked by test hook/);
	assert.equal(warnings.length, 0);
	await assertNextRequestHasPiResult(s);
});
