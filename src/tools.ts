// Tool name and argument mapping between pi and Claude Code, and the MCP server
// that carries pi's tools into a Claude Code subprocess.
//
// The two directions are not symmetric and the asymmetry is the whole point: the
// provider path serves every pi tool over MCP and must refuse any other name,
// while the AskClaude path lets CC run its own builtins. Keeping both directions
// in one file is what makes that pairing visible.
//
// Extracted from index.ts so tests can import it without activating the extension.

import type { Context, Tool } from "@earendil-works/pi-ai";
import { debug } from "./debug.js";
import type { McpResult } from "./extract-tool-results.js";
import { createToolServer } from "./mcp-server.js";
import type { QueryContext } from "./query-state.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";

// Claude Code's own builtin tools, for the AskClaude path where CC really runs
// them. The provider path never sees these — it starts CC with `tools: []`.
export const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// AskClaude path: CC runs its own tools, so builtin names are real.
export function mapToolName(name: string): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
export function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
export function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// Pi tool name → the name Claude Code sees for it. Every pi tool is bridged as MCP,
// so a session rebuilt with this map records `mcp__custom-tools__bash` where one
// rebuilt without it records the builtin `Bash` — a tool the child really has, and
// so a call it can be led into replaying. The provider path builds this from
// context.tools; the AskClaude path has no Context and builds it from pi's active
// tool names, which is the same set minus the AskClaude tool itself.
export function mapCustomToolNamesToSdk(toolNames: Iterable<string>, excludeToolName?: string): Map<string, string> {
	const customToolNameToSdk = new Map<string, string>();
	for (const name of toolNames) {
		if (name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${name}`;
		customToolNameToSdk.set(name, sdkName);
		customToolNameToSdk.set(name.toLowerCase(), sdkName);
	}
	return customToolNameToSdk;
}

export function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToPi = new Map<string, string>();
	const customToolNameToSdk = mapCustomToolNamesToSdk((context.tools ?? []).map((tool) => tool.name), excludeToolName);

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
export function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}
