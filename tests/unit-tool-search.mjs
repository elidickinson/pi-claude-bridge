/**
 * provider.toolSearch gives Claude Code its ToolSearch tool on the provider path,
 * which otherwise runs CC with `tools: []` and so sends every pi tool's schema on
 * every request. CC then sends in full only the tools the bridge marks
 * `_meta["anthropic/alwaysLoad"]` and loads the others on a ToolSearch call, which
 * it runs itself inside the same query (measured: diag/probe-tool-search.mjs).
 *
 * The marks are part of the cached prefix, so they are fixed for as long as CC's
 * own session records are kept, and recomputed when the bridge writes the session.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";
import { QueryContext } from "../src/query-state.js";
import { loadSessionState } from "../src/session-store.js";
import { DEFAULT_ALWAYS_LOAD, deferredToolNames, toolSearchSettings } from "../src/tool-search.js";

const root = process.env.CLAUDE_CONFIG_DIR;
const configPath = () => join(getAgentDir(), "claude-bridge.json");
const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

// The first activation registers the provider; later ones only reload the config.
let providerConfig;
function activateWith(provider) {
	mkdirSync(getAgentDir(), { recursive: true });
	if (provider === undefined) rmSync(configPath(), { force: true });
	else writeFileSync(configPath(), JSON.stringify({ provider }));
	activate({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; } });
}

const tool = (name) => ({ name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} } });
const TOOLS = ["read", "bash", "AskClaude", "deploy", "mem_save", "mem_search"].map(tool);
const user = (content) => ({ role: "user", content, timestamp: 1 });
const toolResult = (id, name) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 });
const call = (sessionId, messages, tools = TOOLS) => providerConfig.streamSimple(providerConfig.models[0], { messages, tools }, { sessionId });
const gate = () => { let open; const wait = new Promise((resolve) => { open = resolve; }); return { wait, open }; };

/** The served tools as Claude Code lists them, split by the always-load mark. */
async function listed(options) {
	const server = options.mcpServers["custom-tools"].instance;
	const replies = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (message) => replies.get(message.id)?.(message) };
	await server.connect(transport);
	const request = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); transport.onmessage({ jsonrpc: "2.0", id, method, params }); });
	await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	const { tools } = (await request(2, "tools/list", {})).result;
	for (const entry of tools) if (entry._meta) assert.deepEqual(entry._meta, { [ALWAYS_LOAD_META]: true }, `${entry.name} carries an unexpected _meta`);
	return {
		loaded: tools.filter((entry) => entry._meta).map((entry) => entry.name),
		unmarked: tools.filter((entry) => !("_meta" in entry)).map((entry) => entry.name),
	};
}

// The external SDK, scripted, writing the records Claude Code would write.
let scripts, calls;
function scriptedClaudeCode({ prompt, options }) {
	const script = scripts.shift() ?? {};
	const sessionId = options.sessionId ?? options.resume;
	calls.push(options);
	const path = getSessionPath(sessionId, options.cwd, root);
	if (options.forkSession) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, readFileSync(getSessionPath(options.resume, options.cwd, root), "utf8").replaceAll(options.resume, sessionId));
	}
	let parentUuid = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.uuid).at(-1)?.uuid ?? null : null;
	const record = (role, content, uuid) => {
		const builder = createSession({ projectPath: options.cwd, sessionId });
		if (role === "assistant") builder.addAssistantMessage(content);
		else builder.addUserMessage(content);
		const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid };
		parentUuid = value.uuid;
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify(value) + "\n");
		return value;
	};
	const model = providerConfig.models[0].id;
	const assistant = (content, id) => {
		const value = record("assistant", content);
		return { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id, model, content } };
	};
	const result = (content) => {
		const value = record("user", content);
		return { type: "user", parent_tool_use_id: null, uuid: value.uuid, message: value.message };
	};
	const gen = (async function* () {
		const input = prompt[Symbol.asyncIterator]();
		const initial = (await input.next()).value;
		void input.next().catch(() => {});
		record("user", initial.message.content, initial.uuid);
		yield { type: "system", subtype: "init", session_id: sessionId };
		yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: sessionId, message: initial.message };
		if (script.search) {
			// Claude Code runs ToolSearch itself: the call and its tool_reference never reach our MCP server.
			yield assistant([{ type: "tool_use", id: "toolu_search", name: "ToolSearch", input: { query: script.search } }], "msg_search");
			yield result([{ type: "tool_result", tool_use_id: "toolu_search", content: [{ type: "tool_reference", tool_name: `mcp__custom-tools__${script.search}` }] }]);
		}
		if (script.tool) {
			yield assistant([{ type: "tool_use", id: script.tool.id, name: `mcp__custom-tools__${script.tool.name}`, input: {} }], "msg_call");
			await script.tool.delivered;
			for (const c of __test.activeQueryContexts) c.dispatchedToolCalls.add(script.tool.id);
			yield result([{ type: "tool_result", tool_use_id: script.tool.id, content: "done" }]);
		}
		yield assistant([{ type: "text", text: "answer" }], `msg_final_${calls.length}`);
		yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId };
	})();
	gen.interrupt = async () => {};
	gen.close = () => {};
	return gen;
}

/** One finished pi turn that found `deploy` through ToolSearch and called it. */
async function deployTurn(sessionId) {
	const ask = user("ship it"), delivered = gate();
	scripts.push({ search: "deploy", tool: { id: "toolu_deploy", name: "deploy", delivered: delivered.wait } });
	const toolTurn = await call(sessionId, [ask]).result();
	const done = toolResult("toolu_deploy", "deploy");
	const continuation = call(sessionId, [ask, toolTurn, done]);
	delivered.open();
	return { toolTurn, history: [ask, toolTurn, done, await continuation.result()] };
}

beforeEach(() => {
	__test.resetSharedSession();
	__test.activeQueryContexts.clear();
	scripts = [];
	calls = [];
	__test.setQuery(scriptedClaudeCode);
});

afterEach(() => {
	__test.setQuery(null);
	rmSync(configPath(), { force: true });
});

describe("provider.toolSearch settings", () => {
	it("is off unless set to true", () => {
		for (const value of [undefined, false, "true", 1, {}]) assert.equal(toolSearchSettings({ toolSearch: value }), undefined);
		assert.equal(toolSearchSettings(), undefined);
	});

	it("always loads pi's file tools, its tool-reaching tools and AskClaude", () => {
		assert.deepEqual(toolSearchSettings({ toolSearch: true }), { alwaysLoad: DEFAULT_ALWAYS_LOAD });
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "tool_search", "codemode", "AskClaude"]) {
			assert.ok(DEFAULT_ALWAYS_LOAD.includes(name), name);
		}
	});

	it("adds provider.alwaysLoadTools, ignoring a malformed value instead of failing activation", () => {
		assert.deepEqual(toolSearchSettings({ toolSearch: true, alwaysLoadTools: ["deploy", 1, null, "", "mem_*"] }).alwaysLoad, [...DEFAULT_ALWAYS_LOAD, "deploy", "mem_*"]);
		assert.deepEqual(toolSearchSettings({ toolSearch: true, alwaysLoadTools: "deploy" }).alwaysLoad, DEFAULT_ALWAYS_LOAD);
	});
});

describe("which tools are deferred", () => {
	const names = TOOLS.map((entry) => entry.name);
	const settings = (alwaysLoadTools) => toolSearchSettings({ toolSearch: true, alwaysLoadTools });

	it("defers every tool outside the always-load list", () => {
		assert.deepEqual(deferredToolNames(names, [], settings()), ["deploy", "mem_save", "mem_search"]);
	});

	it("matches a configured name exactly and a `*` pattern anywhere", () => {
		assert.deepEqual(deferredToolNames(names, [], settings(["mem_*"])), ["deploy"]);
		assert.deepEqual(deferredToolNames(names, [], settings(["*_save", "dep"])), ["deploy", "mem_search"]);
		assert.deepEqual(deferredToolNames(["a.b", "axb"], [], settings(["a.*"])), ["axb"], "a pattern is not a regular expression");
	});

	it("loads a tool the history already calls", () => {
		const history = [user("ship"), { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "t1", name: "deploy", arguments: {} }] }, toolResult("t1", "deploy")];
		assert.deepEqual(deferredToolNames(names, history, settings()), ["mem_save", "mem_search"]);
	});
});

describe("the provider query", () => {
	it("leaves Claude Code without ToolSearch by default, and marks no tool", async () => {
		activateWith(undefined);
		await call("off", [user("hi")]).result();
		assert.deepEqual(calls[0].tools, []);
		assert.equal(calls[0].env.ENABLE_TOOL_SEARCH, process.env.ENABLE_TOOL_SEARCH);
		assert.deepEqual(await listed(calls[0]), { loaded: [], unmarked: TOOLS.map((entry) => entry.name) });
	});

	it("gives Claude Code ToolSearch and marks only the always-loaded tools", async () => {
		activateWith({ toolSearch: true, alwaysLoadTools: ["mem_search"] });
		await call("on", [user("hi")]).result();
		assert.deepEqual(calls[0].tools, ["ToolSearch"]);
		assert.equal(calls[0].env.ENABLE_TOOL_SEARCH, "true");
		assert.deepEqual(await listed(calls[0]), { loaded: ["read", "bash", "AskClaude", "mem_search"], unmarked: ["deploy", "mem_save"] });
	});

	it("keeps a ToolSearch call inside the pi turn and records the turn whole", async () => {
		activateWith({ toolSearch: true });
		const { toolTurn, history } = await deployTurn("search");
		assert.equal(toolTurn.stopReason, "toolUse");
		assert.deepEqual(toolTurn.content.map((block) => [block.type, block.name]), [["toolCall", "deploy"]], "pi sees its own tool call, never ToolSearch");

		// A turn recorded with a gap would cost the next one a prefix-write and the cache.
		await call("search", [...history, user("next")]).result();
		assert.equal(calls.length, 2);
		assert.equal(calls[1].resume, calls[0].sessionId);
		assert.equal(calls[1].forkSession, undefined);
		assert.equal(calls[1].sessionId, undefined);
	});

	it("keeps the marks of a reused session, whatever its history calls since", async () => {
		activateWith({ toolSearch: true });
		const { history } = await deployTurn("frozen");
		await call("frozen", [...history, user("next")]).result();
		assert.equal(calls[1].resume, calls[0].sessionId);
		// Claude Code keeps `deploy` loaded through its own tool_reference record;
		// marking it now would change the tool list and miss the cache.
		const reused = await listed(calls[1]);
		assert.deepEqual(reused, await listed(calls[0]));
		assert.deepEqual(reused.unmarked, ["deploy", "mem_save", "mem_search"]);
		assert.deepEqual(__test.getSharedSession("frozen").deferredTools, ["deploy", "mem_save", "mem_search"]);
		// A restart resumes from the saved state, which must carry the same list.
		assert.deepEqual(loadSessionState("frozen", assert.fail).deferredTools, ["deploy", "mem_save", "mem_search"]);
	});

	it("loads a tool pi adds after the session started", async () => {
		activateWith({ toolSearch: true });
		const ask = user("hi");
		const answer = await call("added", [ask]).result();
		await call("added", [ask, answer, user("next")], [...TOOLS, tool("web_fetch")]).result();
		assert.equal(calls[1].resume, calls[0].sessionId);
		assert.deepEqual((await listed(calls[1])).loaded, ["read", "bash", "AskClaude", "web_fetch"]);
	});

	it("loads the tools a rebuilt history calls, which has no tool_reference for them", async () => {
		activateWith({ toolSearch: true });
		const { history } = await deployTurn("rebuilt");
		// pi rewrote the history from its start (a compaction): none of Claude Code's
		// records are kept, so neither is the tool_reference that loaded `deploy`.
		await call("rebuilt", [user("summary of earlier work"), ...history.slice(1), user("next")]).result();
		assert.notEqual(calls[1].resume, calls[0].sessionId);
		assert.equal(calls[1].forkSession, undefined);
		assert.deepEqual(await listed(calls[1]), { loaded: ["read", "bash", "AskClaude", "deploy"], unmarked: ["mem_save", "mem_search"] });
	});

	for (const [name, before, after] of [
		["turning it on", undefined, { toolSearch: true }],
		["turning it off", { toolSearch: true }, undefined],
		["a changed always-load list", { toolSearch: true }, { toolSearch: true, alwaysLoadTools: ["deploy"] }],
	]) it(`${name} takes a full import instead of resuming the session`, async () => {
		// Claude Code keeps tool search off for a session that started without it.
		activateWith(before);
		const ask = user("hi");
		const answer = await call("toggled", [ask]).result();
		activateWith(after);
		await call("toggled", [ask, answer, user("next")]).result();
		assert.notEqual(calls[1].resume, calls[0].sessionId);
		assert.equal(calls[1].forkSession, undefined);
		assert.deepEqual(calls[1].tools, after ? ["ToolSearch"] : []);
		assert.deepEqual((await listed(calls[1])).loaded, after ? ["read", "bash", "AskClaude", ...(after.alwaysLoadTools ?? [])] : []);
	});
});

describe("a ToolSearch call on the stream", () => {
	const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
	const toolMap = new Map([["mcp__custom-tools__deploy", "deploy"]]);
	const streamEvent = (event) => ({ type: "stream_event", event });
	const toolUse = (messageId, name, id, json) => [
		streamEvent({ type: "message_start", message: { id: messageId } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name, id, input: {} } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
		streamEvent({ type: "message_stop" }),
	];

	it("stays out of pi, and the tool it loaded is called in the same turn", async () => {
		const c = new QueryContext();
		const events = [];
		c.currentPiStream = { push: (event) => events.push(event), end: () => events.push({ type: "end" }) };
		c.resetTurnState(fakeModel);
		const messages = [
			...toolUse("msg_search", "ToolSearch", "toolu_search", '{"query":"select:mcp__custom-tools__deploy"}'),
			{ type: "user", parent_tool_use_id: null, uuid: "u-search", message: { role: "user", content: [
				{ type: "tool_result", tool_use_id: "toolu_search", content: [{ type: "tool_reference", tool_name: "mcp__custom-tools__deploy" }] },
			] } },
			...toolUse("msg_call", "mcp__custom-tools__deploy", "toolu_deploy", '{"target":"prod"}'),
		];
		async function* gen() { for (const message of messages) yield message; }
		await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);

		const done = events.filter((event) => event.type === "done");
		assert.equal(done.length, 1);
		assert.equal(done[0].reason, "toolUse");
		assert.deepEqual(done[0].message.content.map((block) => [block.type, block.name, block.id]), [["toolCall", "deploy", "toolu_deploy"]]);
		assert.deepEqual(done[0].message.content[0].arguments, { target: "prod" });
		assert.deepEqual(c.turnToolCallIds, ["toolu_deploy"]);
		assert.ok(!events.some((event) => event.type === "error"), "Claude Code's own tool_result is not a rejected pi call");
	});
});
