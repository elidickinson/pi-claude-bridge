// Provider-level: the system prompt actually handed to Claude Code. By default CC's preset
// goes in front with pi's whole prompt appended; provider.systemPromptPreset: false sends
// pi's prompt alone as a plain string. Runs real Claude Code against a local API stub (offline, no network).
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const mod = await import("../src/index.js");
const { __test } = mod;
const { buildSystemPrompt, buildSystemPromptState } =
	await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);

const cwd = mkdtempSync(join(tmpdir(), "sp-provider-cwd-"));
const agentDir = mkdtempSync(join(tmpdir(), "sp-provider-agent-"));
const handlers = {};
let provider;
function activate() {
	for (const key of Object.keys(handlers)) delete handlers[key];
	mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; } });
}
const model = () => provider.models.find((m) => m.id.includes("haiku")) ?? provider.models[0];
const head = (opts) => { const state = buildSystemPromptState(opts); return { role: "system", content: state.content, sections: state.sections, timestamp: 0 }; };
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: model().provider, timestamp: 1 });
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const sentSystemText = () => (requestSystems.at(-1) ?? []).map((b) => b.text ?? "").join("\n");

const launches = [], requestSystems = [], env = {};
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	requestSystems.push(body.system);
	const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end([
		event("message_start", { message: { id: `msg_${launches.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ACK" } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
		event("message_stop", {}),
	].join(""));
});

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", PI_CODING_AGENT_DIR: agentDir, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	__test.setQuery((params) => { launches.push(params.options); return query(params); });
});
after(async () => {
	__test.setQuery(null);
	__test.resetSharedSession();
	for (const key of Object.keys(env)) delete process.env[key];
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function writeConfig(providerConfig) {
	writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: providerConfig }));
}
async function startTurn(sessionId, messages) {
	const ctx = { cwd, mode: "tui", ui: { notify: () => {} }, sessionManager: { getSessionId: () => sessionId }, modelRegistry: { getProvider: () => true }, getAllTools: () => [] };
	for (const fn of handlers.session_start) fn({}, ctx);
	const output = await provider.streamSimple(model(), { messages, tools: [] }, { sessionId }).result();
	assert.equal(output.stopReason, "stop", output.errorMessage);
	return output;
}

it("default puts CC's preset in front with pi's prompt appended", { timeout: 120_000 }, async () => {
	writeConfig({});
	activate();
	__test.resetSharedSession();
	await startTurn("sp-default", [head({ cwd }), user("hello")]);
	assert.deepEqual(launches.at(-1).systemPrompt, { type: "preset", preset: "claude_code", append: buildSystemPrompt({ cwd }) });
	const sent = sentSystemText();
	assert.ok(sent.includes(buildSystemPrompt({ cwd })), "CC sends pi's prompt as the preset's append");
	assert.ok(sent.includes("You are Claude Code"), "the CC preset is present");
});

it("systemPromptPreset false sends pi's whole prompt as a plain string", { timeout: 120_000 }, async () => {
	writeConfig({ systemPromptPreset: false });
	activate();
	__test.resetSharedSession();
	await startTurn("sp-plain", [head({ cwd }), user("hello")]);
	const systemPrompt = launches.at(-1).systemPrompt;
	assert.equal(typeof systemPrompt, "string", "off is a plain string, not a preset");
	assert.equal(systemPrompt, buildSystemPrompt({ cwd }));
	const sent = sentSystemText();
	assert.ok(sent.includes(buildSystemPrompt({ cwd })), "CC sends pi's prompt verbatim");
	assert.ok(!sent.includes("You are Claude Code"), "no CC preset when off");
});

it("switching the preset changes the digest and re-imports the session", { timeout: 120_000 }, async () => {
	writeConfig({});
	activate();
	__test.resetSharedSession();
	const history = [head({ cwd }), user("one")];
	await startTurn("sp-switch", history);
	const first = __test.getSharedSession("sp-switch");
	// Control: the same preset again reuses the CC session.
	await startTurn("sp-switch", [...history, say("ACK"), user("two")]);
	const reused = __test.getSharedSession("sp-switch");
	assert.equal(reused.ccSessionId, first.ccSessionId, "an unchanged prompt reuses the CC session");
	// Switching the preset changes the digest and full-imports into a new session.
	writeConfig({ systemPromptPreset: false });
	activate();
	await startTurn("sp-switch", [...history, say("ACK"), user("two"), say("ACK"), user("three")]);
	const switched = __test.getSharedSession("sp-switch");
	assert.notEqual(switched.promptDigest, first.promptDigest, "the preset setting is part of the digest");
	assert.notEqual(switched.ccSessionId, first.ccSessionId, "a changed prompt takes a full import into a new CC session");
	assert.equal(launches.at(-1).forkSession, undefined, "a prompt change is a full import, not a fork");
	assert.equal(launches.at(-1).resume, switched.ccSessionId, "the full import resumes the new CC session");
});