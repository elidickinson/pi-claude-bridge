import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { QueryContext } from "../src/query-state.js";
import { makePromptStream, userMessage } from "../src/prompt-stream.js";
import { createToolServer } from "../src/mcp-server.js";

const { __test } = await import("../src/index.js");
const model = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const steer = [{ type: "text", text: "Continue with the next tool." }];
const success = (fields = {}) => ({ type: "result", subtype: "success", is_error: false, result: "DONE", ...fields });
const replay = (message) => ({ ...message, isReplay: true });
const consume = (c, messages) => __test.consumeQuery((async function* () { yield* messages; })(), new Map(), model, () => false, c);

function input(t) {
	const c = new QueryContext();
	c.promptStream = makePromptStream();
	const sent = [];
	const pump = (async () => { for await (const message of c.promptStream.stream) sent.push(message); })();
	t.after(async () => { c.promptStream.end(); await pump; });
	return { c, sent, pump };
}

it("keeps input open until every queued steer is replayed and its turn completes", async (t) => {
	const { c, sent, pump } = input(t);
	await __test.deliverToolResults(c, [], steer, 1);
	const first = sent[0];
	assert.match(first.uuid, /^[0-9a-f-]{36}$/);
	await consume(c, [success(), first, success(), replay({ ...first, parent_tool_use_id: "subagent" }), success()]);

	await __test.deliverToolResults(c, [], steer, 2);
	assert.equal(c.missedSteer, false);
	assert.notEqual(sent[0].uuid, sent[1].uuid);
	await consume(c, [replay(first), success()]);
	await c.promptStream.push(userMessage("input still connected"));
	await consume(c, [replay(sent[1]), success()]);
	await pump;
	await assert.rejects(c.promptStream.push(userMessage("too late")), /closed/);
});

it("keeps input open during user replay and closes at the following result", async (t) => {
	const { c, sent, pump } = input(t);
	await __test.deliverToolResults(c, [], steer, 1);
	await consume(c, [replay(sent[0])]);
	await c.promptStream.push(userMessage("input stays open until the result"));
	await consume(c, [success()]);
	await assert.rejects(c.promptStream.push(userMessage("too late")), /closed/);
	await pump;
});

it("protects a steer before its input write is acknowledged", async (t) => {
	const c = new QueryContext();
	c.promptStream = makePromptStream();
	t.after(() => c.promptStream.end());
	const delivery = __test.deliverToolResults(c, [], steer, 1);
	const { value: message } = await c.promptStream.stream.next();
	await consume(c, [success()]);
	const next = c.promptStream.stream.next(); // acknowledges the write
	await delivery;
	const push = c.promptStream.push(userMessage("still connected"));
	const item = await next;
	const end = c.promptStream.stream.next();
	await push;
	assert.equal(item.done, false);
	await consume(c, [replay(message), success()]);
	assert.equal((await end).done, true);
});

it("does not wait for a failed steer write at completion", async (t) => {
	const { c, pump } = input(t);
	const push = c.promptStream.push;
	c.promptStream.push = async () => { throw new Error("write failed"); };
	await __test.deliverToolResults(c, [], steer, 1);
	c.promptStream.push = push;
	await consume(c, [success()]);
	await pump;
	assert.equal(c.missedSteer, true);
	assert.equal(c.pendingSteerUuids.size, 0);
	await assert.rejects(push(userMessage("too late")), /closed/);
});

for (const result of [
	success(),
	success({ is_error: true, result: "API error" }),
	{ type: "result", subtype: "error_during_execution", errors: ["failed"] },
]) {
	it(`closes on ${result.is_error === false ? "ordinary completion" : result.subtype + " failure"} without steer replays`, async (t) => {
		const { c, pump } = input(t);
		if (result.is_error !== false) await __test.deliverToolResults(c, [], steer, 1);
		await consume(c, [result]);
		await pump;
		await assert.rejects(c.promptStream.push(userMessage("too late")), /closed/);
	});
}

// Claude Code still runs a queued steer after an error result, even with stdin
// closed. Its turn must not reach pi, where its stop reason replaced the failure.
it("ends the query at an error result even with a steer queued", async (t) => {
	const { c, sent, pump } = input(t);
	c.currentPiStream = { push: () => {}, end: () => {} };
	c.resetTurnState(model);
	await __test.deliverToolResults(c, [], steer, 1);
	const error = success({ is_error: true, result: "API Error: Overloaded" });
	const later = [
		replay(sent[0]),
		{ type: "stream_event", event: { type: "message_start", message: { id: "msg_steer", usage: {} } } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
		success(),
	];
	let pulled = 0;
	const { failure } = await __test.consumeQuery((async function* () { yield error; for (const m of later) { pulled++; yield m; } })(), new Map(), model, () => false, c);
	await pump;

	assert.equal(failure?.message, error.result);
	assert.equal(pulled, 0);
	assert.equal(c.turnOutput.stopReason, "error");
	assert.equal(c.turnOutput.errorMessage, error.result);
	await assert.rejects(c.promptStream.push(userMessage("too late")), /closed/);
});

// Real SDK/CLI with localhost-only model responses. Closing input after the first
// result used to interrupt MCP calls in the later turn before they reached the server.
for (const [name, laterTurn, absorbedSteers] of [
	["later-turn steering", true, 0],
	["one absorbed steer", false, 1],
	["65 absorbed steers", false, 65],
	["queued opener plus 64 absorbed steers", true, 64],
]) {
	it(`SDK keeps MCP connected for ${name} and exits`, { timeout: 30_000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "queued-steer-"));
		mkdirSync(join(root, "config"));
		const c = new QueryContext();
		c.promptStream = makePromptStream();
		let round = 0;
		let lastRequest;
		const toolRounds = laterTurn
			? [1, ...Array.from({ length: Math.max(1, absorbedSteers) }, (_, i) => i + 3)]
			: Array.from({ length: absorbedSteers }, (_, i) => i + 1);
		const steers = [];
		const writeSteer = async () => {
			const text = `Steer ${steers.length + 1}. Continue.`;
			steers.push(text);
			await __test.deliverToolResults(c, [], [{ type: "text", text }], steers.length);
		};
		const toolResults = [];
		const requests = [];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
				res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString());
			lastRequest = body;
			requests.push(body);
			const n = ++round;
			const tool = toolRounds.includes(n);
			const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end([
				event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
				event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_${n}`, name: "mcp__custom-tools__probe", input: {} } : { type: "text", text: "" } }),
				event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "DONE" } }),
				event("content_block_stop", { index: 0 }),
				event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
				event("message_stop", {}),
			].join(""));
		});
		let sdk;
		t.after(async () => {
			c.promptStream.end();
			sdk?.close();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const tools = createToolServer("custom-tools", [{
			name: "probe", description: "Return a value", inputSchema: { type: "object", properties: {} },
			handler: async (id) => {
				if (!laterTurn || (round > 2 && absorbedSteers > 0)) await writeSteer();
				return { content: [{ type: "text", text: `VALUE-${id}` }] };
			},
		}]);
		// The CLI gets only test credentials and the loopback endpoint, never the
		// caller's API credentials, config, or remote base URL.
		const env = {
			PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "config"),
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test",
			ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", DISABLE_TELEMETRY: "1",
			DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		};
		sdk = query({ prompt: c.promptStream.stream, options: {
			cwd: root, env, tools: [], settingSources: [], model: "claude-haiku-4-5", permissionMode: "bypassPermissions",
			persistSession: false, includePartialMessages: true, mcpServers: { "custom-tools": tools },
			extraArgs: { "strict-mcp-config": null, "replay-user-messages": null },
		} });
		// A failed termination regression must not leave the CLI running after timeout.
		t.signal.addEventListener("abort", () => sdk.close(), { once: true });
		const initial = c.promptStream.push(userMessage("Call probe, then finish."));
		async function* messages() {
			for await (const message of sdk) {
				if (laterTurn && round === 2 && message.type === "stream_event" && message.event.type === "content_block_start" && message.event.content_block.type === "text") {
					await writeSteer();
				}
				if (message.type === "user" && Array.isArray(message.message.content)) {
					toolResults.push(...message.message.content.filter((block) => block.type === "tool_result"));
				}
				yield message;
			}
		}
		await __test.consumeQuery(messages(), new Map(), model, () => false, c);
		await initial;
		assert.ok(requests.length > 0, "SDK sent no requests to the localhost API stub");
		assert.deepEqual(toolResults.map((result) => result.is_error ?? false), toolRounds.map(() => false));
		assert.deepEqual(toolResults.map((result) => result.content), toolRounds.map((n) => [{ type: "text", text: `VALUE-toolu_${n}` }]));
		const finalMessages = JSON.stringify(lastRequest.messages);
		for (const text of steers) assert.ok(finalMessages.includes(text), `model received ${text}`);
	});
}
