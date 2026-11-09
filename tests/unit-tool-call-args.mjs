// Real SDK and Claude Code against a local API stub: pi's tool calls carry
// the arguments Claude Code converted from JSON-encoded strings, so the turn's
// recording matches and the next prompt reuses the Claude Code session.
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const mod = await import("../src/index.js");
const handlers = {};
let provider;
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; } });
const model = provider.models[0];
const tools = [
	{ name: "probe", description: "probe", parameters: { type: "object", properties: {
		display: { type: "object" }, count: { type: "integer" }, enabled: { type: "boolean" }, note: { type: "string" },
	} } },
	{ name: "edit", description: "edit", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } } } },
];
const cwd = mkdtempSync(join(tmpdir(), "tool-call-args-"));
const env = {};
let requests = 0;
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
	const block = (index, content_block, delta) => [
		event("content_block_start", { index, content_block }),
		event("content_block_delta", { index, delta }),
		event("content_block_stop", { index }),
	];
	const toolUse = (index, id, name, input) => block(index, { type: "tool_use", id, name: `mcp__custom-tools__${name}`, input: {} },
		{ type: "input_json_delta", partial_json: JSON.stringify(input) });
	const first = ++requests === 1;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end([
		event("message_start", { message: { id: `msg_${requests}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		...block(0, { type: "text", text: "" }, { type: "text_delta", text: first ? "Working." : "Done." }),
		...(first ? [
			...toolUse(1, "toolu_probe", "probe", { display: '{"name": "step 1"}', count: "5", enabled: "true", note: "caf\\u00e9" }),
			...toolUse(2, "toolu_edit", "edit", { path: "a.txt", edits: '{"oldText": "a", "newText": "b"}' }),
		] : []),
		event("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
		event("message_stop", {}),
	].join(""));
});

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	for (const fn of handlers.session_start) fn({}, { cwd, sessionManager: { getSessionId: () => "pi-args" } });
});
after(async () => {
	for (const fn of handlers.session_shutdown) fn({}, { sessionManager: { getSessionId: () => "pi-args" } });
	for (const key of Object.keys(env)) delete process.env[key];
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(cwd, { recursive: true, force: true });
});

it("pi runs tools with Claude Code's converted arguments and the next prompt reuses the session", { timeout: 30_000 }, async () => {
	const call = (messages) => provider.streamSimple(model, { messages, tools }, { sessionId: "pi-args" }).result();
	const user = (content) => ({ role: "user", content, timestamp: 1 });
	const first = await call([user("call the tools")]);
	assert.deepEqual(first.content.filter((b) => b.type === "toolCall").map((b) => b.arguments), [
		{ display: { name: "step 1" }, count: 5, enabled: true, note: "café" },
		{ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
	]);
	const results = first.content.filter((b) => b.type === "toolCall")
		.map((b) => ({ role: "toolResult", toolCallId: b.id, toolName: b.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 }));
	const second = await call([user("call the tools"), first, ...results]);
	await call([user("call the tools"), first, ...results, second, user("again")]);
	const log = readFileSync(process.env.CLAUDE_BRIDGE_DEBUG_PATH, "utf8");
	assert.match(log, /syncResult: path=reuse/);
	assert.doesNotMatch(log, /recording gap/);
	assert.doesNotMatch(log, /WARNING: Claude Code's finished tool_use/);
});
