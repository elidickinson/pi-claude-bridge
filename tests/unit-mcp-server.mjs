/**
 * What the bridge puts on the MCP wire: tool schemas must survive verbatim
 * (including below the top level), and tool calls must be paired with Claude's
 * own tool_use id.
 *
 * Drives the MCP server the same way the Agent SDK does — `instance.connect()`
 * with a transport, then raw JSON-RPC — so the assertions cover what Claude
 * actually receives rather than an intermediate representation.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createToolServer } from "../src/mcp-server.js";

const NESTED_TOOL_SCHEMA = {
	type: "object",
	properties: {
		question: { type: "string", description: "Question to ask" },
		options: {
			type: "array",
			description: "Choices to offer",
			items: {
				type: "object",
				properties: {
					label: { type: "string", description: "Short label" },
					detail: { type: "string" },
				},
				required: ["label"],
			},
		},
		config: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["single", "multi"] },
				retries: { type: "integer" },
			},
			required: ["mode"],
		},
		either: { anyOf: [{ type: "string" }, { type: "number" }] },
	},
	required: ["question", "options"],
};

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

	// Claude Code identifies the call it is making via _meta on every tools/call.
	const callTool = (name, toolUseId, args = {}) =>
		request("tools/call", {
			name,
			arguments: args,
			...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { request, callTool };
}

describe("MCP tool schema advertisement", () => {
	let listed;

	// A non-object schema typechecks (pi types parameters as any TypeBox schema)
	// but cannot go on the wire. Advertising it as "no arguments" instead would
	// surface much later as pi rejecting the arguments Claude did not send.
	it("rejects a non-object parameter schema at construction, naming the tool", () => {
		assert.throws(
			() => createToolServer("custom-tools", [
				{ name: "bad_tool", description: "", inputSchema: { type: "string" }, handler: async () => ({ content: [] }) },
			]),
			/bad_tool: MCP tool parameters must be an object schema/,
		);
	});

	before(async () => {
		const server = createToolServer("custom-tools", [
			{
				name: "ask_user_question",
				description: "Ask the user a question",
				inputSchema: NESTED_TOOL_SCHEMA,
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
		]);
		const { request } = await connectClient(server);
		listed = (await request("tools/list", {})).result.tools[0].inputSchema;
	});

	it("preserves top-level properties and required", () => {
		assert.deepStrictEqual(Object.keys(listed.properties).sort(), ["config", "either", "options", "question"]);
		assert.deepStrictEqual(listed.required, ["question", "options"]);
		assert.strictEqual(listed.properties.question.description, "Question to ask");
	});

	it("preserves object properties nested in an array", () => {
		const item = listed.properties.options.items;
		assert.deepStrictEqual(Object.keys(item.properties).sort(), ["detail", "label"]);
		assert.deepStrictEqual(item.required, ["label"]);
		assert.strictEqual(item.properties.label.description, "Short label");
	});

	it("preserves nested object properties, enums and required", () => {
		const config = listed.properties.config;
		assert.deepStrictEqual(Object.keys(config.properties).sort(), ["mode", "retries"]);
		assert.deepStrictEqual(config.required, ["mode"]);
		assert.deepStrictEqual(config.properties.mode.enum, ["single", "multi"]);
		assert.strictEqual(config.properties.retries.type, "integer");
	});

	it("preserves anyOf branches", () => {
		assert.deepStrictEqual(listed.properties.either.anyOf, [{ type: "string" }, { type: "number" }]);
	});
});

// Claude Code drops any MCP tool whose input schema has a top-level
// anyOf/oneOf/allOf ("its input schema uses top-level anyOf, which the Anthropic
// API does not accept"). The bridge still maps the tool as served, so a call to it
// reached pi and ran there while CC answered "No such tool available" and retried
// under a fresh id: the tool ran twice, or the retry's handler waited forever.
// Pi validates arguments against the full schema itself, so the bridge only needs
// to advertise a flat object schema that CC accepts.
describe("MCP tool schema with top-level combinators", () => {
	async function listSchema(inputSchema) {
		const server = createToolServer("custom-tools", [
			{ name: "union_tool", description: "d", inputSchema, handler: async () => ({ content: [] }) },
		]);
		const { request } = await connectClient(server);
		return (await request("tools/list", {})).result.tools[0].inputSchema;
	}

	it("flattens a top-level anyOf into one object schema CC accepts", async () => {
		const listed = await listSchema({
			type: "object",
			additionalProperties: false,
			required: ["operation"],
			properties: { operation: { type: "string", enum: ["start", "status"] }, input: { type: "string" } },
			anyOf: [
				{ type: "object", properties: { operation: { type: "string", enum: ["start"] }, baseRef: { type: "string" } } },
				{ type: "object", properties: { operation: { type: "string", enum: ["status"] } }, required: ["input"] },
			],
		});

		for (const key of ["anyOf", "oneOf", "allOf"]) assert.ok(!(key in listed), `top-level ${key} must not reach CC`);
		assert.strictEqual(listed.type, "object");
		assert.strictEqual(listed.additionalProperties, false);
		assert.deepStrictEqual(Object.keys(listed.properties).sort(), ["baseRef", "input", "operation"]);
		assert.deepStrictEqual(listed.properties.operation.enum, ["start", "status"], "root declaration wins over a branch");
		assert.deepStrictEqual(listed.required, ["operation"], "a branch-only requirement is not universal");
	});

	it("keeps allOf requirements, which apply to every call", async () => {
		const listed = await listSchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
			allOf: [{ type: "object", properties: { b: { type: "number" } }, required: ["b"] }],
		});

		assert.ok(!("allOf" in listed));
		assert.deepStrictEqual(Object.keys(listed.properties).sort(), ["a", "b"]);
		assert.deepStrictEqual(listed.required, ["a", "b"]);
	});
});

describe("MCP tool invocation", () => {
	// Two tools, so a handler picked by position rather than by name/id is visible.
	const twoTools = (record) => [
		{
			name: "alpha",
			description: "a",
			inputSchema: { type: "object", properties: {} },
			handler: async (toolCallId) => {
				record.push(["alpha", toolCallId]);
				return { content: [{ type: "text", text: "from alpha" }] };
			},
		},
		{
			name: "beta",
			description: "b",
			inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
			handler: async (toolCallId) => {
				record.push(["beta", toolCallId]);
				return { content: [{ type: "text", text: "from beta" }], isError: true };
			},
		},
	];

	it("routes tools/call to the matching handler", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		const beta = await callTool("beta", "toolu_b", { x: "hi" });
		assert.deepStrictEqual(calls, [["beta", "toolu_b"]]);
		assert.strictEqual(beta.result.content[0].text, "from beta");
		assert.strictEqual(beta.result.isError, true);
	});

	// Claude sends the authoritative tool_use id on every call. Inferring it from
	// call order instead silently pairs a result with the wrong call whenever the
	// order diverges — e.g. parallel tool calls, or a call that never arrives.
	it("hands the handler Claude's tool_use id, not one inferred from call order", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		await callTool("beta", "toolu_second", { x: "hi" });
		await callTool("alpha", "toolu_first");

		assert.deepStrictEqual(calls, [["beta", "toolu_second"], ["alpha", "toolu_first"]]);
	});

	it("fails loudly when the tool_use id is absent rather than mispairing", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		const res = await callTool("alpha", null);
		const message = res.error?.message ?? JSON.stringify(res.result);
		assert.match(message, /toolUseId/i);
		assert.deepStrictEqual(calls, [], "handler must not run without an id to pair its result to");
	});

	// toolCallId is internal bookkeeping for pairing results; it is not part of
	// MCP's CallToolResult and has no business on the wire.
	it("does not leak internal fields into the tool result", async () => {
		const { callTool } = await connectClient(
			createToolServer("custom-tools", [
				{
					name: "alpha",
					description: "a",
					inputSchema: { type: "object", properties: {} },
					handler: async (toolCallId) => ({
						content: [{ type: "text", text: "ok" }],
						isError: false,
						toolCallId,
					}),
				},
			]),
		);

		const res = await callTool("alpha", "toolu_x");
		assert.deepStrictEqual(Object.keys(res.result).sort(), ["content", "isError"]);
	});

	// A schema-validation rejection would skip the handler entirely, desyncing
	// the result pairing.
	it("invokes the handler even when arguments do not match the schema", async () => {
		let called = false;
		const { callTool } = await connectClient(
			createToolServer("custom-tools", [
				{
					name: "strict",
					description: "s",
					inputSchema: {
						type: "object",
						properties: { count: { type: "number" } },
						required: ["count"],
						additionalProperties: false,
					},
					handler: async () => {
						called = true;
						return { content: [{ type: "text", text: "ran" }] };
					},
				},
			]),
		);

		const res = await callTool("strict", "toolu_y", { count: "not-a-number", extra: 1 });
		assert.ok(called, "handler must run — pi validates and executes tools, not the MCP layer");
		assert.strictEqual(res.result.content[0].text, "ran");
	});
});
