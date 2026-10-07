/**
 * The tool-result queue, end to end against production code.
 *
 * A turn's tool results reach Claude Code by two independent routes: Claude calls
 * each tool over MCP, and pi appends the results to context and re-enters the
 * provider. Either can land first, so the MCP handler and `deliverToolResults`
 * each check the other's map before parking — `pendingResults` holds a result
 * waiting for its handler, `pendingToolCalls` a handler waiting for its result.
 *
 * These drive the real handler through the real JSON-RPC layer. A hand-rolled
 * model of the state machine pairs by id by construction and therefore cannot
 * express the mispairing this design exists to prevent: handlers once took their
 * id from a positional cursor into `turnToolCallIds` (fixed in fc2efeb6), which
 * mispaired as soon as Claude's call order diverged from its emission order.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { extractAllToolResults } from "../src/extract-tool-results.js";
import { makePromptStream } from "../src/prompt-stream.js";

const { __test } = await import("../src/index.js");

// Mirrors the SDK's connectSdkMcpServer: hand the instance a transport, push
// requests into transport.onmessage, read replies out of transport.send.
async function connectClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => pending.get(msg.id)?.(msg),
	};
	await server.instance.connect(transport);

	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });

	// Claude Code stamps every tools/call with the id of the tool_use block it came from.
	const callTool = (name, toolUseId) =>
		request("tools/call", { name, arguments: {}, _meta: { "claudecode/toolUseId": toolUseId } });
	callTool.listTools = async () => (await request("tools/list", {})).result.tools.map((t) => t.name);
	return callTool;
}

const TOOLS = ["alpha", "beta", "gamma"].map((name) => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
}));

/** A live query: a real QueryContext and its real MCP server, connected the way
 *  the Agent SDK connects it. `turnToolCallIds` is populated as the stream events
 *  would, in the order Claude emitted the tool_use blocks. */
async function startQuery(turnToolCallIds) {
	const c = new QueryContext();
	c.turnToolCallIds = [...turnToolCallIds];
	const servers = __test.buildMcpServers(TOOLS, c);
	return { c, callTool: await connectClient(Object.values(servers)[0]) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const result = (toolCallId, text, isError) => ({ toolCallId, content: [{ type: "text", text }], isError });
const deliver = (c, ...results) => __test.deliverToolResults(c, results, null, 4);
const replyText = (response) => response.result.content[0].text;

describe("tool result queue", () => {
	it("hands a handler the result that arrived before it, isError included", async () => {
		const { c, callTool } = await startQuery(["toolu_1"]);

		await deliver(c, result("toolu_1", "early", true));
		assert.deepEqual([...c.pendingResults.keys()], ["toolu_1"]);

		const response = await callTool("alpha", "toolu_1");
		assert.equal(replyText(response), "early");
		assert.equal(response.result.isError, true);
		assert.equal(c.pendingResults.size, 0);
	});

	it("parks a handler that arrives before its result, then releases it", async () => {
		const { c, callTool } = await startQuery(["toolu_1"]);

		const call = callTool("alpha", "toolu_1");
		await tick();
		assert.deepEqual([...c.pendingToolCalls.keys()], ["toolu_1"]);
		assert.equal(c.pendingToolCalls.get("toolu_1").toolName, "alpha");

		await deliver(c, result("toolu_1", "late", false));
		const response = await call;
		assert.equal(replyText(response), "late");
		assert.equal(response.result.isError, false);
		assert.equal(c.pendingToolCalls.size, 0);
	});

	// The regression fc2efeb6 fixed: Claude calls the tools in one order, pi
	// delivers their results in another, and neither matches the order the
	// tool_use blocks were emitted. Only the id carried on each tools/call can
	// pair them; anything positional silently answers the wrong call.
	it("pairs parallel calls by tool_use id, not by call or delivery order", async () => {
		const { c, callTool } = await startQuery(["toolu_1", "toolu_2", "toolu_3"]);

		const third = callTool("gamma", "toolu_3");
		const first = callTool("alpha", "toolu_1");
		const second = callTool("beta", "toolu_2");
		await tick();
		assert.equal(c.pendingToolCalls.size, 3);

		await deliver(c, result("toolu_2", "r2"), result("toolu_3", "r3"), result("toolu_1", "r1"));

		assert.equal(replyText(await first), "r1");
		assert.equal(replyText(await second), "r2");
		assert.equal(replyText(await third), "r3");
		assert.equal(c.pendingToolCalls.size, 0);
		assert.equal(c.pendingResults.size, 0);
	});

	// The invariant the two maps exist to keep: an id is waiting in at most one.
	it("moves an id between the maps without ever holding it in both", async () => {
		const { c, callTool } = await startQuery(["toolu_1", "toolu_2"]);
		const assertDisjoint = () => {
			for (const id of c.pendingToolCalls.keys()) assert.ok(!c.pendingResults.has(id), `${id} is in both maps`);
		};

		const one = callTool("alpha", "toolu_1"); // parks
		await tick();
		assertDisjoint();
		await deliver(c, result("toolu_1", "r1")); // releases it rather than queueing
		assert.equal(replyText(await one), "r1");
		assert.equal(c.pendingResults.size, 0);

		await deliver(c, result("toolu_2", "r2")); // queues — no handler yet
		assert.deepEqual([...c.pendingResults.keys()], ["toolu_2"]);
		assertDisjoint();

		const two = await callTool("beta", "toolu_2"); // claims it from the queue
		assert.equal(replyText(two), "r2");
		assert.equal(c.pendingResults.size, 0);
		assert.equal(c.pendingToolCalls.size, 0);
	});

	it("leaves only the unanswered handler parked when a result never arrives", async () => {
		const { c, callTool } = await startQuery(["toolu_1", "toolu_2"]);
		const answered = callTool("alpha", "toolu_1");
		callTool("beta", "toolu_2"); // never gets a result
		await tick();

		await deliver(c, result("toolu_1", "r1"));

		assert.equal(replyText(await answered), "r1");
		assert.deepEqual([...c.pendingToolCalls.keys()], ["toolu_2"]);
	});
});

// The other way a handler leaves the queue: not answered, abandoned. Every exit
// from a query (abort, error, normal end) has to settle its handlers, because
// CC's tools/call stays open until we reply and pi's turn waits behind it.
describe("abandoning a query", () => {
	it("answers every parked handler and forgets queued results", async () => {
		const { c, callTool } = await startQuery(["toolu_1", "toolu_2", "toolu_3"]);
		const one = callTool("alpha", "toolu_1");
		const two = callTool("beta", "toolu_2");
		await tick();
		await deliver(c, result("toolu_3", "r3")); // queued, no handler ever came

		c.releasePendingToolCalls("Query ended");

		assert.equal(replyText(await one), "Query ended");
		assert.equal(replyText(await two), "Query ended");
		assert.equal(c.pendingToolCalls.size, 0);
		assert.equal(c.pendingResults.size, 0, "a result nobody claimed must not outlive its query");
	});

	// The abort race: the user aborts while delivery is parked on the steer's
	// stdin ack. failing the prompt stream is what unwedges that await — without
	// it the ack never settles, delivery never returns, and the handler it was
	// about to release waits forever on a subprocess that is already dead.
	// Timeout, not just assertions: the failure mode is a hang, and node's default
	// is to wait forever.
	it("unwedges a delivery parked on the steer ack, leaving no handler waiting", { timeout: 5000 }, async () => {
		const { c, callTool } = await startQuery(["toolu_1"]);
		const call = callTool("alpha", "toolu_1");
		await tick();

		// Real stream, no consumer: the push parks exactly as it does when the CLI
		// stops reading stdin.
		c.promptStream = makePromptStream();
		const delivery = __test.deliverToolResults(c, [result("toolu_1", "r1")], [{ type: "text", text: "stop" }], 4);
		await tick();
		assert.equal(c.pendingToolCalls.size, 1, "delivery must still be parked on the ack");

		__test.drainForAbort(c, c.promptStream);

		await delivery; // resolves rather than throwing: the steer is lost, not the turn
		assert.equal(replyText(await call), "Operation aborted");
		assert.equal(c.pendingToolCalls.size, 0);
	});
});

describe("extracting a turn's tool results from pi's context", () => {
	const assistant = (...ids) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", name: "alpha", id })) });
	const toolResult = (toolCallId, content, isError) => ({ role: "toolResult", toolCallId, content, isError });
	const texts = (results) => results.map((r) => r.content[0].text);

	it("collects only the current turn, stopping at the previous assistant message", () => {
		const { results, stopIdx } = extractAllToolResults([
			{ role: "user", content: "prompt" },
			assistant("toolu_1"),
			toolResult("toolu_1", "turn 1"),
			assistant("toolu_2", "toolu_3"),
			toolResult("toolu_2", "turn 2a"),
			toolResult("toolu_3", "turn 2b"),
		]);

		assert.deepEqual(texts(results), ["turn 2a", "turn 2b"]);
		assert.equal(stopIdx, 3);
	});

	// pi injects user messages (steer, followUp, orchestrator context) while the
	// turn's tools are still running, anywhere among the results. The walk has to
	// step over them; stopping at one strands every handler behind it.
	it("walks past user messages injected among the results, keeping isError", () => {
		const { results } = extractAllToolResults([
			{ role: "user", content: "prompt" },
			assistant("toolu_1", "toolu_2", "toolu_3"),
			{ role: "user", content: "steer before any result" },
			toolResult("toolu_1", "r1"),
			toolResult("toolu_2", "r2", true),
			{ role: "user", content: "steer between results" },
			toolResult("toolu_3", "r3"),
			{ role: "user", content: "steer after the last result" },
		]);

		assert.deepEqual(texts(results), ["r1", "r2", "r3"]);
		assert.deepEqual(results.map((r) => r.isError), [undefined, true, undefined]);
	});

	it("finds nothing when the turn's tools have not reported yet", () => {
		const noResultsYet = [
			{ role: "user", content: "prompt" },
			assistant("toolu_1", "toolu_2"),
			{ role: "user", content: "steer into the void" },
		];

		assert.equal(extractAllToolResults(noResultsYet).results.length, 0);
		assert.equal(extractAllToolResults([]).results.length, 0);
	});
});

describe("delivering an extracted turn to its handlers", () => {
	// The whole loop: scrape the turn out of pi's context and hand it to handlers
	// that are already waiting, in yet another order.
	it("releases every parked handler for a turn scraped out of context", async () => {
		const { c, callTool } = await startQuery(["toolu_1", "toolu_2"]);
		const beta = callTool("beta", "toolu_2");
		const alpha = callTool("alpha", "toolu_1");
		await tick();

		const { results } = extractAllToolResults([
			{ role: "user", content: "prompt" },
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_1" }, { type: "toolCall", id: "toolu_2" }] },
			{ role: "toolResult", toolCallId: "toolu_1", content: "read the file" },
			{ role: "user", content: "steer" },
			{ role: "toolResult", toolCallId: "toolu_2", content: "ran the command" },
		]);
		await __test.deliverToolResults(c, results, null, 5);

		assert.equal(replyText(await alpha), "read the file");
		assert.equal(replyText(await beta), "ran the command");
		assert.equal(c.pendingToolCalls.size, 0, "every handler for the turn must be released");
	});
});

// pi-web-access's web_enable activates tools from inside a tool call. The query's
// MCP server must pick them up, and the result must wait for Claude Code's
// re-list, or CC's next request goes out with the old tool set.
describe("tool set changed by a tool call", () => {
	async function startServedQuery(names) {
		const c = new QueryContext();
		const tools = TOOLS.filter((t) => names.includes(t.name));
		const servers = __test.buildMcpServers(tools, c);
		c.toolServer = Object.values(servers)[0];
		c.servedToolNames = tools.map((t) => t.name);
		c.toolNameToPi = new Map(tools.map((t) => [`mcp__custom-tools__${t.name}`, t.name]));
		return { c, callTool: await connectClient(c.toolServer) };
	}
	const contextWith = (...names) => ({ messages: [], tools: [...TOOLS, { name: "AskClaude", description: "", parameters: { type: "object", properties: {} } }].filter((t) => names.includes(t.name)) });

	it("is a no-op while pi's tool set matches what the query serves", async () => {
		const { c } = await startServedQuery(["alpha"]);
		assert.equal(__test.syncServedTools(c, contextWith("alpha")), undefined);
	});

	it("serves the new set, remaps names, and holds until Claude Code re-lists", async () => {
		const { c, callTool } = await startServedQuery(["alpha"]);
		let synced = false;
		const sync = __test.syncServedTools(c, contextWith("beta", "gamma", "AskClaude")).then(() => { synced = true; });

		assert.deepEqual([...c.toolNameToPi.keys()].sort(),
			["mcp__custom-tools__beta", "mcp__custom-tools__gamma"],
			"removed tools must drop out of the map and AskClaude must stay unserved");
		await tick();
		assert.equal(synced, false, "a result released before the re-list races CC's next request");

		assert.deepEqual(await callTool.listTools(), ["beta", "gamma"]);
		await sync;

		const beta = callTool("beta", "toolu_b");
		await tick();
		await deliver(c, result("toolu_b", "beta ran"));
		assert.equal(replyText(await beta), "beta ran");
	});
});
