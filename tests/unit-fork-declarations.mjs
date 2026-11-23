/**
 * A fresh query that follows a compaction still gets pi's tools and prompt.
 *
 * pi keeps the tool list and the system prompt in system messages, and its
 * compaction drops them from the rebuilt history. A call that continues the
 * turn after that arrives with no system message, no `tools` and no prompt, so
 * the rebuilt Claude Code query started with no MCP server at all: the model
 * could not call anything, planned its next step in thinking and ended the turn
 * with no output. Seen in Claude Code's own request snapshots (`tools: []` on
 * every rebuild that failed to act, 21 tools on every one that did).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts, markRebuildForSession } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerCommand: () => {},
});
const { streamSimple } = providerConfig;
const model = providerConfig.models[0];

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const tools = [
	{ name: "read", description: "Read a file", parameters: schema },
	{ name: "bash", description: "Run a command", parameters: schema },
];
const PROMPT = "You are the pi test prompt.";
let clock = 0;
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
const head = (toolsAdded = tools) => ({ role: "system", content: PROMPT, toolsAdded, timestamp: 0 });
const call = (id) => ({
	role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", usage: {}, timestamp: clock++,
});
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });

let launches;
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	launches = [];
	setQuery(({ options }) => {
		launches.push(options);
		const gen = (async function* () {
			// A tool-result continuation resumes without a prompt, so none is awaited.
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume };
			yield { type: "assistant", parent_tool_use_id: null, uuid: `u${launches.length}`, session_id: "s", message: { id: `msg_${launches.length}`, model: model.id, content: [{ type: "text", text: "ok" }] } };
			yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId ?? options.resume };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => setQuery(null));

/** The tool names Claude Code would list from the query's MCP server. */
async function servedTools(options) {
	const server = options.mcpServers?.["custom-tools"];
	if (!server) return [];
	const list = server.instance.server._requestHandlers.get("tools/list");
	return (await list({ method: "tools/list", params: {} }, {})).tools.map((t) => t.name);
}
const run = (context, sessionId) => streamSimple(model, context, { sessionId, signal: new AbortController().signal }).result();

describe("fresh query after a compaction", () => {
	it("serves the tools and prompt of the session's earlier requests", async () => {
		const ask = user("do the thing");
		const first = await run({ messages: [head(), ask] }, "pi-rebuilt");
		assert.equal(first.stopReason, "stop", first.errorMessage);
		assert.deepEqual(await servedTools(launches[0]), ["read", "bash"], "control: the first query has the tools");

		// pi compacted: the history is a summary plus the kept tail, with no system message.
		markRebuildForSession("pi-rebuilt", "session_compact:threshold");
		const tail = [user("[summary of earlier work]"), call("toolu_1"), toolResult("toolu_1")];
		const rebuilt = await run({ messages: tail }, "pi-rebuilt");
		assert.equal(rebuilt.stopReason, "stop", rebuilt.errorMessage);

		assert.equal(launches.length, 2);
		assert.deepEqual(await servedTools(launches[1]), ["read", "bash"], "the rebuilt query serves the same tools");
		assert.equal(launches[1].systemPrompt.append, PROMPT, "and pi's prompt");
	});

	it("takes the tools a call declares over the remembered ones", async () => {
		await run({ messages: [head(), user("one")] }, "pi-changed");
		await run({ messages: [head([tools[0]]), user("one"), call("toolu_1"), toolResult("toolu_1"), user("two")] }, "pi-changed");
		assert.deepEqual(await servedTools(launches[1]), ["read"]);
	});

	it("does not borrow another session's tools", async () => {
		await run({ messages: [head(), user("one")] }, "pi-owner");
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-stranger");
		assert.deepEqual(await servedTools(launches[1]), [], "a session that never declared tools stays without");
	});
});
