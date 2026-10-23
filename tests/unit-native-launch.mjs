// Real SDK and Claude Code against a local API stub: every sync row's
// generated launch flags must be ones the native CLI accepts.
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { digestMessages } from "../src/message-digests.js";
const mod = await import("../src/index.js");
const { __test } = mod;
const handlers = {};
let provider;
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; }, registerTool: () => {} });
const model = provider.models.find((m) => m.id.includes("haiku")) ?? provider.models[0];
const user = (content) => ({ role: "user", content, timestamp: 1 });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: model.provider, timestamp: 1 });
const cwd = mkdtempSync(join(tmpdir(), "native-launch-"));
const requests = [], launches = [], env = {};
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	requests.push(JSON.stringify(body.messages));
	const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end([
		event("message_start", { message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ACK" } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
		event("message_stop", {}),
	].join(""));
});

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	for (const id of ["pi-native", "pi-ask"]) for (const fn of handlers.session_start) fn({}, { cwd, sessionManager: { getSessionId: () => id } });
	__test.resetSharedSession();
	__test.setQuery((params) => { launches.push(params.options); return query(params); });
});
after(async () => {
	__test.setQuery(null);
	__test.resetSharedSession();
	for (const key of Object.keys(env)) delete process.env[key];
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(cwd, { recursive: true, force: true });
});

async function turn(messages) {
	const output = await provider.streamSimple(model, { messages, tools: [] }, { sessionId: "pi-native" }).result();
	assert.equal(output.stopReason, "stop", output.errorMessage);
	assert.deepEqual(output.content.filter((b) => b.type === "text").map((b) => b.text), ["ACK"]);
	return output;
}

it("native Claude Code accepts import, restart fork, prefix-write and AskClaude import launches", { timeout: 120_000 }, async () => {
	const prior = [user("first question"), say("first answer")];
	const second = await turn([...prior, user("second")]);
	assert.equal(launches[0].sessionId, undefined, "row 2 resumes its written import");
	assert.ok(launches[0].resume);
	assert.match(requests.at(-1), /first answer/);

	const saved = __test.getSharedSession("pi-native");
	assert.deepEqual(saved.digests, digestMessages([...prior, user("second"), second]), "CC's replay acknowledged the prompt");
	assert.equal(saved.dirtyTail, false);
	__test.forgetSessionMemory();
	const third = await turn([...prior, user("second"), second, user("third")]);
	assert.equal(launches[1].forkSession, true, "a restart forks the persisted pointer");
	assert.equal(launches[1].resume, saved.ccSessionId);
	assert.ok(launches[1].sessionId);

	await turn([user("REDACTED question"), say("first answer"), user("second"), second, user("third"), third, user("fourth")]);
	assert.equal(launches[2].sessionId, undefined, "row 7 resumes its written prefix");
	assert.equal(launches[2].forkSession, undefined);
	assert.match(requests.at(-1), /REDACTED question/);

	const answer = await __test.promptAndWait("delegated", "none", new Map(), undefined, { model: model.id, appendSkills: false, context: prior, piSessionId: "pi-ask" });
	assert.equal(answer.responseText, "ACK");
	assert.equal(launches[3].sessionId, undefined, "AskClaude's import resumes its written id");
	assert.ok(launches[3].resume);
	assert.equal(__test.getSharedSession("pi-ask"), null);
});
