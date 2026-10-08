// In-process MCP server that exposes pi tools to Claude Code.
//
// Pi declares tool parameters as TypeBox objects, which are already JSON
// Schema at runtime — the same thing MCP puts on the wire. This serves them
// verbatim instead of going through the SDK's `createSdkMcpServer`, which only
// accepts Zod and therefore forces a JSON Schema → Zod → JSON Schema round
// trip. That round trip is lossy below the top level: nested objects collapse
// to open records and `anyOf`/`const` vanish, so Claude saw only the first
// level of any tool with a nested schema — including the builtin `edit`.
// The one exception is a top-level combinator, flattened below because Claude
// Code drops a tool whose schema has one.
//
// Handlers go on the underlying protocol server rather than through
// `McpServer.registerTool`, which is the Zod-only path. Skipping registerTool
// also skips its argument validation, which is what we want: pi validates and
// executes tools itself, and the arguments MCP sees are discarded. A rejection
// there would only prevent the handler from running, stranding the call.
//
// This rests on the Agent SDK treating what we hand it as an opaque JSON-RPC
// endpoint: `connectSdkMcpServer` in sdk.mjs calls `instance.connect(transport)`
// and nothing else, so none of McpServer's higher-level machinery is required.
// The `McpServer` wrapper is kept only because the SDK's `mcpServers` option is
// typed against that class. If this breaks after an SDK update, check whether
// the SDK began inspecting the instance — reading registered tools, or expecting
// tools/list_changed notifications we never send.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "./extract-tool-results.js";

// Claude Code stamps every tools/call with the id of the tool_use block it came
// from. That is the only reliable way to pair a call with its result: call order
// is not guaranteed to match the order the tool_use blocks were emitted, so
// counting calls mispairs results as soon as the two diverge.
//
// This is a Claude Code extension, not part of the MCP spec — CC sets it in
// `src/services/mcp/client.ts` (see reference-code/claude-code-rip). If CC ever
// stops sending it, every tool call fails with the error below rather than
// silently pairing results to the wrong call, which is the intended tradeoff.
const TOOL_USE_ID_META = "claudecode/toolUseId";

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (toolCallId: string) => Promise<McpResult>;
}

// MCP requires an object schema. Pi types tool parameters as any TypeBox schema,
// so a scalar or array one typechecks but cannot go on the wire — that is a bug
// in the tool, and reporting it at startup names the culprit. Degrading it to
// "takes no arguments" instead would surface much later as Claude calling the
// tool with no arguments and pi's own validation rejecting them.
function assertObjectSchema(tool: McpToolDef): void {
	const schema = tool.inputSchema as Record<string, unknown> | undefined;
	if (!schema || schema.type !== "object") {
		throw new Error(`${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`);
	}
}

// Claude Code drops an MCP tool outright when its input schema has a top-level
// anyOf/oneOf/allOf ("its input schema uses top-level anyOf, which the Anthropic
// API does not accept"; CC's own normalizer for this is gated off for our
// server). The tool is still in our served-name map, so a call Claude makes to it
// anyway is forwarded to pi and runs there while CC answers "No such tool
// available" and retries under a fresh id — the tool runs twice, or the retry's
// handler waits forever. Advertise a flat object instead, built the way CC's
// normalizer does: root properties win over branch ones, root `required` stays,
// and allOf requirements join it (anyOf/oneOf ones hold only for one branch).
// Nothing is lost: pi still validates arguments against the full schema.
const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenRootCombinators(schema: Record<string, unknown>): Record<string, unknown> {
	const combinators = ROOT_COMBINATORS.filter((key) => key in schema);
	if (combinators.length === 0) return schema;

	const { anyOf: _anyOf, oneOf: _oneOf, allOf, ...rest } = schema;
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	const addProperties = (source: unknown) => {
		if (!isRecord(source) || !isRecord(source.properties)) return;
		for (const [key, value] of Object.entries(source.properties)) if (!(key in properties)) properties[key] = value;
	};
	const addRequired = (source: unknown) => {
		if (!isRecord(source) || !Array.isArray(source.required)) return;
		for (const key of source.required) if (typeof key === "string" && !required.includes(key)) required.push(key);
	};

	addProperties(schema);
	for (const key of combinators) {
		const branches = schema[key];
		if (Array.isArray(branches)) for (const branch of branches) addProperties(branch);
	}
	addRequired(schema);
	if (Array.isArray(allOf)) for (const branch of allOf) addRequired(branch);

	const flat: Record<string, unknown> = { ...rest, type: "object", properties };
	if (required.length > 0) flat.required = required;
	else delete flat.required;
	return flat;
}

export function createToolServer(name: string, tools: McpToolDef[]) {
	const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const tool of tools) assertObjectSchema(tool);

	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: flattenRootCombinators(tool.inputSchema as Record<string, unknown>),
		})),
	}));

	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
		const toolCallId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolCallId !== "string") {
			throw new Error(`${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`);
		}
		// Narrowed deliberately: McpResult also carries `toolCallId`, which is our
		// own bookkeeping for pairing and not part of MCP's CallToolResult.
		const { content, isError } = await tool.handler(toolCallId);
		return { content, isError };
	});

	return { type: "sdk" as const, name, instance: server };
}
