/**
 * A call marked `metadata.promptKind: "standalone"` skips prompt capture and runs as
 * its own one-turn query: the caller's system prompt verbatim, no shared session, and
 * tool calls handed back to pi instead of run.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const { globalConfigPath } = await import("../src/config.js");
// Read once at activation, so written before it.
const CLAUDE_EXECUTABLE = "/opt/claude-code/bin/claude";
mkdirSync(dirname(globalConfigPath()), { recursive: true });
writeFileSync(globalConfigPath(), JSON.stringify({ provider: { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE } }));

const { default: activate, __test } = await import("../src/index.js");
const { PI_PREAMBLE } = await import("../src/sendable.js");
const { MCP_SERVER_NAME, MCP_TOOL_PREFIX } = await import("../src/skills.js");
const { claudeCodeModelId } = await import("../src/models.js");
const { rememberSessionCwd, forgetSessionCwd } = await import("../src/session-cwd.js");
const { connectClient } = await import("./lib/mcp-client.mjs");

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];

const SESSION_ID = "standalone-session";
const SYSTEM_PROMPT = "You are a permission classifier. Answer 0 or 1.";
const standalone = { sessionId: SESSION_ID, metadata: { promptKind: "standalone" } };
const user = (content) => ({ role: "user", content, timestamp: 0 });
const decisionTool = {
	name: "classifier_decision",
	description: "Report the decision.",
	parameters: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"] },
};
const usage = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 0 };
const textReply = [
	{ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "1" }] } },
	{ type: "result", subtype: "success", is_error: false, result: "1", usage },
];

let calls;
function mockQuery(messages, { waitForClose = false } = {}) {
	return (args) => {
		let closed;
		const closedPromise = new Promise((resolve) => { closed = resolve; });
		const call = { ...args, closed: false };
		calls.push(call);
		async function* gen() {
			for (const message of messages) yield message;
			if (waitForClose) await closedPromise;
		}
		const q = gen();
		q.interrupt = async () => {};
		q.close = () => { call.closed = true; closed(); };
		return q;
	};
}

const stream = (context, options = standalone) => providerConfig.streamSimple(model, { tools: [], ...context }, options);
const turn = (context, options) => stream(context, options).result();
async function eventsOf(context) {
	const events = [];
	for await (const event of stream(context)) events.push(event);
	return events.map((event) => event.contentIndex === undefined ? event.type : `${event.type}@${event.contentIndex}`);
}

beforeEach(() => {
	calls = [];
	__test.resetSharedSession();
	__test.setQuery(mockQuery(textReply));
});
afterEach(() => __test.setQuery(null));

describe("standalone prompt route", () => {
	it("answers unrecorded prompt instead of failing capture", async () => {
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.content, [{ type: "text", text: "1" }]);
		assert.equal(calls.length, 1);
	});

	it("still fails unmarked unrecorded prompt", async () => {
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] }, { sessionId: SESSION_ID });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(calls.length, 0);
	});

	it("streams text reply events in order", async () => {
		assert.deepEqual(await eventsOf({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] }),
			["start", "text_start@0", "text_delta@0", "text_end@0", "done"]);
	});

	it("spawns in session cwd with session model and effort", async () => {
		const cwd = "/agents/standalone";
		rememberSessionCwd(SESSION_ID, cwd);
		try {
			await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] }, { ...standalone, reasoning: "high" });
		} finally {
			forgetSessionCwd(SESSION_ID);
		}
		const { options } = calls[0];
		assert.equal(options.cwd, cwd);
		assert.equal(options.model, claudeCodeModelId(model, { plan: "pro", longContextExtraUsage: false }));
		assert.equal(options.effort, __test.effortForReasoning(model, "high"));
		assert.equal(options.pathToClaudeCodeExecutable, CLAUDE_EXECUTABLE);
	});

	it("sends raw system prompt with no built-in tools or session", async () => {
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		const { prompt, options } = calls[0];
		assert.equal(prompt, "ls?");
		assert.equal(options.systemPrompt, SYSTEM_PROMPT);
		assert.deepEqual(options.tools, []);
		assert.equal(options.strictMcpConfig, true);
		assert.deepEqual(options.settingSources, []);
		assert.deepEqual(options.skills, []);
		assert.equal(options.persistSession, false);
		assert.equal(options.settings.autoMemoryEnabled, false);
		assert.equal(options.maxTurns, 1);
		assert.equal(options.env.DISABLE_AUTO_COMPACT, __test.CC_CHILD_ENV.DISABLE_AUTO_COMPACT);
		assert.ok(!("resume" in options));
		assert.ok(!("mcpServers" in options));
	});

	it("leaves shared session and query state untouched", async () => {
		const state = { sessionId: "cc-session", cursor: 4, cwd: "/tmp", piSessionId: SESSION_ID };
		__test.setSharedSession(SESSION_ID, { ...state });
		const capturesBefore = __test.promptCaptures.size;
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		assert.deepEqual(__test.getSharedSession(SESSION_ID), state);
		assert.equal(__test.getSharedSession(null) ?? null, null);
		assert.equal(__test.activeQueryContexts.size, 0);
		assert.equal(__test.promptCaptures.size, capturesBefore);
	});

	it("reports token usage", async () => {
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		assert.equal(result.usage.input, usage.input_tokens);
		assert.equal(result.usage.output, usage.output_tokens);
		assert.equal(result.usage.cacheRead, usage.cache_read_input_tokens);
	});

	it("joins multiple user messages into one prompt", async () => {
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("first"), user([{ type: "text", text: "second" }]), user("third")] });
		assert.equal(calls[0].prompt, "first\nsecond\nthird");
	});

	it("keeps images in user turn", async () => {
		const image = { type: "image", data: "aGk=", mimeType: "image/png" };
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user([{ type: "text", text: "look" }, image])] });
		const sent = [];
		for await (const message of calls[0].prompt) sent.push(message);
		assert.deepEqual(sent.map((m) => m.message.content.map((b) => b.type)), [["text", "image"]]);
	});

	it("rejects non-user message by naming shape", async () => {
		const assistant = { role: "assistant", content: [{ type: "text", text: "0" }], timestamp: 0 };
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("a"), assistant, user("b")] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /standalone prompt: expected one or more user messages.*\[user,assistant,user\]/);
		assert.equal(calls.length, 0);
	});

	it("rejects empty message list", async () => {
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /expected one or more user messages/);
		assert.equal(calls.length, 0);
	});

	it("aborts in-flight query", async () => {
		__test.setQuery(mockQuery([], { waitForClose: true }));
		const controller = new AbortController();
		const pending = turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] }, { ...standalone, signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		const result = await pending;
		assert.equal(result.stopReason, "aborted");
		assert.equal(calls[0].closed, true);
	});

	it("aborts before query starts when signal already aborted", async () => {
		__test.setQuery(mockQuery([], { waitForClose: true }));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] }, { ...standalone, signal: AbortSignal.abort() });
		assert.equal(result.stopReason, "aborted");
		assert.equal(calls[0].closed, true);
	});

	it("fails turn with no text or tool call", async () => {
		__test.setQuery(mockQuery([
			{ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "" }] } },
			{ type: "result", subtype: "success", is_error: false, result: "", usage },
		]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /returned no text or tool call/);
	});

	it("fails turn on error result", async () => {
		__test.setQuery(mockQuery([{ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded", usage }]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /529 overloaded/);
	});
});

describe("standalone prompt tools", () => {
	const toolUse = (name, id, input) => ({ type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", id, name, input }] } });
	const maxTurns = { type: "result", subtype: "error_max_turns", is_error: true, stop_reason: "tool_use", usage };

	it("returns tool_use as toolCall and closes query", async () => {
		__test.setQuery(mockQuery([toolUse(`${MCP_TOOL_PREFIX}classifier_decision`, "toolu_1", { decision: "allow" }), maxTurns]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content, [{ type: "toolCall", id: "toolu_1", name: "classifier_decision", arguments: { decision: "allow" } }]);
		assert.equal(calls[0].closed, true);
	});

	it("streams tool call events in order", async () => {
		__test.setQuery(mockQuery([toolUse(`${MCP_TOOL_PREFIX}classifier_decision`, "toolu_1", { decision: "allow" }), maxTurns]));
		assert.deepEqual(await eventsOf({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] }),
			["start", "toolcall_start@0", "toolcall_end@0", "done"]);
	});

	it("keeps text and tool call in one reply, indexed in order", async () => {
		__test.setQuery(mockQuery([
			{ type: "assistant", message: { id: "msg_3", content: [
				{ type: "text", text: "Deciding." },
				{ type: "tool_use", id: "toolu_3", name: `${MCP_TOOL_PREFIX}classifier_decision`, input: { decision: "deny" } },
			] } },
			maxTurns,
		]));
		const context = { systemPrompt: SYSTEM_PROMPT, messages: [user("rm -rf /?")], tools: [decisionTool] };
		assert.deepEqual(await eventsOf(context),
			["start", "text_start@0", "text_delta@0", "text_end@0", "toolcall_start@1", "toolcall_end@1", "done"]);
		const result = await turn(context);
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content.map((block) => block.type), ["text", "toolCall"]);
		assert.equal(result.content[0].text, "Deciding.");
	});

	it("fails tool call turn on non-max-turns error result", async () => {
		__test.setQuery(mockQuery([
			toolUse(`${MCP_TOOL_PREFIX}classifier_decision`, "toolu_4", { decision: "allow" }),
			{ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded", usage },
		]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /529 overloaded/);
	});

	it("fails tool call turn on execution error result", async () => {
		__test.setQuery(mockQuery([
			toolUse(`${MCP_TOOL_PREFIX}classifier_decision`, "toolu_5", { decision: "allow" }),
			{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["CLI crashed"], usage },
		]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /CLI crashed/);
	});

	it("answers dispatched tool call with error stub", async () => {
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		const { callTool } = await connectClient(calls[0].options.mcpServers[MCP_SERVER_NAME]);
		const reply = await callTool("classifier_decision", "toolu_1", { decision: "allow" });
		assert.equal(reply.result.isError, true);
		assert.match(reply.result.content[0].text, /Not executed/);
	});

	it("exposes caller tools over in-process MCP", async () => {
		__test.setQuery(mockQuery([toolUse(`${MCP_TOOL_PREFIX}classifier_decision`, "toolu_1", { decision: "deny" }), maxTurns]));
		await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		const { options } = calls[0];
		assert.deepEqual(Object.keys(options.mcpServers), [MCP_SERVER_NAME]);
		assert.equal(options.mcpServers[MCP_SERVER_NAME].type, "sdk");
		assert.deepEqual(options.tools, []);
	});

	it("drops call to unserved tool", async () => {
		__test.setQuery(mockQuery([toolUse("Bash", "toolu_2", { command: "ls" }), maxTurns]));
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user("ls?")], tools: [decisionTool] });
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /error_max_turns/);
		assert.ok(!result.content.some((block) => block.type === "toolCall"));
	});
});

describe("standalone prompt guard", () => {
	const refused = async (context, options = standalone) => {
		const result = await turn(context, options);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /standalone prompt: refusing to send this prompt/);
		assert.equal(calls.length, 0);
		return result.errorMessage;
	};

	it("blocks pi preamble in system prompt", async () => {
		const message = await refused({ systemPrompt: `${PI_PREAMBLE}, a coding harness.`, messages: [user("ls?")] });
		assert.match(message, /in the system prompt/);
	});

	it("blocks pi preamble in user message", async () => {
		const message = await refused({ systemPrompt: SYSTEM_PROMPT, messages: [user("context:"), user(`transcript:\n${PI_PREAMBLE}.`)] });
		assert.match(message, /in user message 2/);
	});

	it("blocks third-party trigger pair", async () => {
		const message = await refused({ systemPrompt: "See docs/custom-provider.md and docs/packages.md.", messages: [user("ls?")] });
		assert.match(message, /docs\/custom-provider\.md and docs\/packages\.md in the system prompt/);
	});

	it("allows mid-line mention of preamble", async () => {
		const result = await turn({ systemPrompt: SYSTEM_PROMPT, messages: [user(`pi says "${PI_PREAMBLE}" first.`)] });
		assert.equal(result.stopReason, "stop");
	});

	it("wins over cacheRetention none and keeps guard", async () => {
		await refused({ systemPrompt: `${PI_PREAMBLE}.`, messages: [user("ls?")] }, { ...standalone, cacheRetention: "none" });
	});
});
