// Real SDK and Claude Code against a local API stub: AskClaude's shared mode
// imports pi's branch (summaries included) into a fresh session, resumes it,
// and deletes it afterward, whether or not the query succeeds.
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const mod = await import("../askclaude/src/index.js");
const handlers = {};
let tool;
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerTool: (value) => { tool = value; } });

const cwd = mkdtempSync(join(tmpdir(), "askclaude-"));
const requests = [], launches = [], env = {};
let failNext = false;
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
		response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	requests.push(body);
	if (failNext) {
		response.writeHead(400, { "content-type": "application/json" })
			.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stub failure" } }));
		return;
	}
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
	mod.__test.setQuery((params) => { launches.push(params.options); return query(params); });
});
after(async () => {
	mod.__test.setQuery(null);
	for (const key of Object.keys(env)) delete process.env[key];
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(cwd, { recursive: true, force: true });
});

const sessionFiles = () => {
	const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects");
	try { return readdirSync(projects).flatMap((dir) => readdirSync(join(projects, dir)).filter((f) => f.endsWith(".jsonl"))); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
};

/** A branch compacted past its first exchange, ending at the assistant turn that calls AskClaude. */
function compactedBranch() {
	const sm = SessionManager.inMemory(cwd);
	const text = (role, t) => (role === "user" ? { role, content: t, timestamp: 1 } : { role, content: [{ type: "text", text: t }], provider: "anthropic", model: "x", api: "anthropic-messages", stopReason: "stop", timestamp: 1 });
	sm.appendMessage(text("user", "DROPPED-MARKER question"));
	sm.appendMessage(text("assistant", "old answer"));
	const kept = sm.appendMessage(text("user", "kept question"));
	sm.appendMessage(text("assistant", "kept answer"));
	sm.appendCompaction("SUMMARY-MARKER of earlier work", kept, 1000);
	sm.appendMessage(text("user", "ask claude"));
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "AskClaude", arguments: { prompt: "delegated" } }], provider: "anthropic", model: "x", api: "anthropic-messages", stopReason: "toolUse", timestamp: 1 });
	return sm;
}

const run = (params) => tool.execute("call_1", params, undefined, undefined, { cwd, model: undefined, sessionManager: compactedBranch() });

it("shared mode resumes an import of pi's branch, summaries and skills included, then deletes it", { timeout: 120_000 }, async () => {
	const skill = { name: "probe-skill", description: "a probe", filePath: "/skills/probe/SKILL.md", baseDir: "/skills/probe", disableModelInvocation: false };
	const systemPromptOptions = { skills: [] };
	for (const fn of handlers.before_agent_start) fn({ systemPromptOptions });
	// A later extension's handler can still replace the list.
	systemPromptOptions.skills = [skill];
	const result = await run({ prompt: "delegated" });
	assert.equal(result.details.error, undefined, result.content[0].text);
	assert.equal(result.content[0].text, "ACK");
	const launch = launches.at(-1);
	assert.ok(launch.resume, "resumes the imported session");
	assert.equal(launch.persistSession, undefined);
	const sent = JSON.stringify(requests.at(-1).messages);
	assert.match(sent, /SUMMARY-MARKER/, "the compaction summary reaches Claude");
	assert.match(sent, /kept answer/);
	assert.match(sent, /"name":"mcp__custom-tools__AskClaude"/, "the pending AskClaude call is imported, its result stubbed");
	assert.doesNotMatch(sent, /DROPPED-MARKER/);
	assert.match(sent, /delegated/);
	assert.match(JSON.stringify(requests.at(-1).system), /\/skills\/probe\/SKILL\.md/);
	assert.deepEqual(sessionFiles(), []);
});

it("a failed query still deletes its imported session", { timeout: 120_000 }, async () => {
	failNext = true;
	try {
		const result = await run({ prompt: "delegated" });
		assert.equal(result.details.error, true);
		assert.match(result.content[0].text, /stub failure/);
	} finally { failNext = false; }
	assert.ok(launches.at(-1).resume);
	assert.deepEqual(sessionFiles(), []);
});

it("rejects an unknown mode before writing or launching anything", async () => {
	const before = launches.length;
	await assert.rejects(mod.__test.promptAndWait("x", "bogus", new Map(), undefined, { cwd, history: [] }), /Invalid AskClaude mode/);
	assert.equal(launches.length, before);
	assert.deepEqual(sessionFiles(), []);
});

it("isolated mode sends only the prompt and writes no session", { timeout: 120_000 }, async () => {
	const result = await run({ prompt: "alone", isolated: true, mode: "none" });
	assert.equal(result.content[0].text, "ACK");
	assert.equal(launches.at(-1).resume, undefined);
	assert.equal(launches.at(-1).persistSession, false);
	assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /SUMMARY-MARKER/);
	assert.deepEqual(sessionFiles(), []);
});

it("an empty tool result in imported history gets Claude Code's no-output placeholder", async () => {
	const { convertPiMessages } = await import("../askclaude/src/claude-code.js");
	const messages = convertPiMessages([
		{ role: "user", content: "go" },
		{ role: "assistant", provider: "openrouter", content: [
			{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
			{ type: "toolCall", id: "t2", name: "touch", arguments: {} },
		] },
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "" }], isError: true },
		{ role: "toolResult", toolCallId: "t2", toolName: "touch", content: " " },
	], new Map([["bash", "Bash"]]));
	assert.deepEqual(messages[2].content, [
		{ type: "tool_result", tool_use_id: "t1", content: "Command failed with no output", is_error: true },
		{ type: "tool_result", tool_use_id: "t2", content: "(mcp__custom-tools__touch completed with no output)" },
	]);
});
