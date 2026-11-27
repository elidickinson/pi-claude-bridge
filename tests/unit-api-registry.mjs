#!/usr/bin/env node

// pi-ai's compat complete() with a claude-bridge model: the route tools such as
// session_query take. It throws "No API provider registered for api: claude-bridge"
// unless the bridge's api is in pi-ai's api registry. Real SDK and Claude Code
// against a local API stub.
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { complete } from "@earendil-works/pi-ai/compat";

const mod = await import("../src/index.js");
const { __test } = mod;
let model;
mod.default({ on: () => {}, registerProvider: (id, value) => { model = { ...(value.models.find((m) => m.id.includes("haiku")) ?? value.models[0]), api: value.api, provider: id }; } });

const env = {};
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end([
		event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "REGISTRY-OK" } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
		event("message_stop", {}),
	].join(""));
});

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	__test.resetSharedSession();
	__test.setQuery((params) => query(params));
});
after(async () => {
	__test.setQuery(null);
	__test.resetSharedSession();
	for (const key of Object.keys(env)) delete process.env[key];
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

it("complete() through pi-ai's api registry reaches the bridge and returns its answer", { timeout: 120_000 }, async () => {
	const output = await complete(model, { systemPrompt: "Answer briefly.", messages: [{ role: "user", content: [{ type: "text", text: "say the token" }], timestamp: 1 }] }, { sessionId: "api-registry-test" });
	assert.equal(output.stopReason, "stop", output.errorMessage);
	assert.deepEqual(output.content.filter((b) => b.type === "text").map((b) => b.text), ["REGISTRY-OK"]);
});
