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
// the SDK began inspecting the instance, such as reading registered tools.
// The one piece of MCP protocol we drive ourselves is tools/list_changed (setTools).

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
// Like CC, branch `$ref`s into the root's `$defs`/`definitions` are followed,
// and the lost constraint is restated as a note for the tool description, so
// Claude's first call is likely to pass pi's validation against the full schema.
const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLocalRef(branch: unknown, root: Record<string, unknown>): unknown {
	if (!isRecord(branch) || typeof branch.$ref !== "string") return branch;
	const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(branch.$ref);
	const defs = match && root[match[1]];
	const target = match && isRecord(defs) ? defs[match[2]] : undefined;
	return isRecord(target) ? target : branch;
}

// A branch is named by its required keys, else by all of its keys.
function branchGroup(branch: unknown): string | null {
	if (!isRecord(branch)) return null;
	const { required, properties } = branch;
	if (Array.isArray(required) && required.length > 0 && required.every((key) => typeof key === "string")) return required.join(", ");
	const keys = isRecord(properties) ? Object.keys(properties) : [];
	return keys.length > 0 ? keys.join(", ") : null;
}

// CC's wording, so the tool reads the same as one CC normalized itself.
function combinatorNote(combinators: readonly string[], branchesOf: (key: string) => unknown[]): string {
	if (!combinators.includes("anyOf") && !combinators.includes("oneOf")) {
		return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
	}
	const key = combinators.includes("oneOf") ? "oneOf" : "anyOf";
	const rule = key === "oneOf" ? "Provide parameters for exactly one of" : "Provide parameters for at least one of";
	const groups = [...new Set(branchesOf(key).map(branchGroup).filter((group) => group !== null))];
	if (groups.length === 0) return `Input constraint: ${rule} the documented parameter groups (flattened from a JSON Schema ${key}).`;
	return `Input constraint: ${rule}: ${groups.map((group) => `(${group})`).join(" or ")}.`;
}

function flattenRootCombinators(schema: Record<string, unknown>): { schema: Record<string, unknown>; note?: string } {
	const combinators = ROOT_COMBINATORS.filter((key) => key in schema);
	if (combinators.length === 0) return { schema };

	const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema;
	const branchesOf = (key: string) => {
		const branches = schema[key];
		return Array.isArray(branches) ? branches.map((branch) => resolveLocalRef(branch, schema)) : [];
	};
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
	for (const key of combinators) for (const branch of branchesOf(key)) addProperties(branch);
	addRequired(schema);
	for (const branch of branchesOf("allOf")) addRequired(branch);

	const flat: Record<string, unknown> = { ...rest, type: "object", properties };
	if (required.length > 0) flat.required = required;
	else delete flat.required;
	return { schema: flat, note: combinatorNote(combinators, branchesOf) };
}

// How long setTools waits for Claude Code to re-list after tools/list_changed.
// A re-list normally follows within milliseconds; the cap only keeps a CC that
// ignores the notification from stranding the tool result being held for it.
const RELIST_TIMEOUT_MS = 2_000;

export function createToolServer(name: string, initialTools: McpToolDef[]) {
	const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
	let tools = initialTools;
	let byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const tool of tools) assertObjectSchema(tool);
	const relistWaiters: Array<() => void> = [];

	server.server.setRequestHandler(ListToolsRequestSchema, () => {
		// Released on the next macrotask, after this response is on the wire, so a
		// tool result held for the re-list cannot overtake it.
		for (const release of relistWaiters.splice(0)) setImmediate(release);
		return {
			tools: tools.map((tool) => {
				const { schema, note } = flattenRootCombinators(tool.inputSchema as Record<string, unknown>);
				return {
					name: tool.name,
					description: [note, tool.description].filter(Boolean).join("\n\n"),
					inputSchema: schema,
				};
			}),
		};
	});

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

	/** Replace the served tools mid-query and notify Claude Code. Resolves true once
	 *  CC has re-listed — only then will its next request carry the new set — or
	 *  false after RELIST_TIMEOUT_MS. */
	async function setTools(next: McpToolDef[]): Promise<boolean> {
		for (const tool of next) assertObjectSchema(tool);
		tools = next;
		byName = new Map(tools.map((tool) => [tool.name, tool]));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const relisted = new Promise<boolean>((resolve) => {
			relistWaiters.push(() => resolve(true));
			timer = setTimeout(() => resolve(false), RELIST_TIMEOUT_MS);
		});
		try {
			await server.server.sendToolListChanged();
			return await relisted;
		} finally {
			clearTimeout(timer);
		}
	}

	return { type: "sdk" as const, name, instance: server, setTools };
}

export type ToolServer = ReturnType<typeof createToolServer>;
