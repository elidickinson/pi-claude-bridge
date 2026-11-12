// A deterministic tool set the size of a busy pi session, for probes that measure
// what tool schemas cost: pi's seven file tools, one tool with a capability nothing
// else has (so a probe can ask for it without naming it), and filler shaped like
// extension and MCP tools (about 1.2 KB of JSON each).

const text = (description) => ({ type: "string", description });

const CORE_TOOLS = [
	{ name: "read", description: "Read the contents of a file. Supports text files and images. Output is truncated to 2000 lines or 50KB; use offset and limit for large files.",
		inputSchema: { type: "object", properties: { path: text("Path to the file to read (relative or absolute)"), offset: { type: "number", description: "Line number to start reading from (1-indexed)" }, limit: { type: "number", description: "Maximum number of lines to read" } }, required: ["path"] } },
	{ name: "bash", description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.",
		inputSchema: { type: "object", properties: { command: text("Bash command to execute"), timeout: { type: "number", description: "Timeout in seconds" } }, required: ["command"] } },
	{ name: "edit", description: "Edit a file by replacing exact text. Every oldText must match exactly once, whitespace included. Use this for precise, surgical edits.",
		inputSchema: { type: "object", properties: { path: text("Path to the file to edit"), edits: { type: "array", items: { type: "object", properties: { oldText: text("Exact text to find"), newText: text("Text to replace it with") }, required: ["oldText", "newText"] } } }, required: ["path", "edits"] } },
	{ name: "write", description: "Write content to a file. Creates the file if it doesn't exist, overwrites it if it does. Creates parent directories.",
		inputSchema: { type: "object", properties: { path: text("Path to the file to write"), content: text("Content to write to the file") }, required: ["path", "content"] } },
	{ name: "grep", description: "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore.",
		inputSchema: { type: "object", properties: { pattern: text("Search pattern (regex or literal string)"), path: text("Directory or file to search"), glob: text("Filter files by glob pattern"), ignoreCase: { type: "boolean", description: "Case-insensitive search" }, limit: { type: "number", description: "Maximum number of matches" } }, required: ["pattern"] } },
	{ name: "find", description: "Search for files by glob pattern. Returns matching paths relative to the search directory. Respects .gitignore.",
		inputSchema: { type: "object", properties: { pattern: text("Glob pattern to match files"), path: text("Directory to search in"), limit: { type: "number", description: "Maximum number of results" } }, required: ["pattern"] } },
	{ name: "ls", description: "List directory contents. Entries are sorted alphabetically with '/' after directories. Includes dotfiles.",
		inputSchema: { type: "object", properties: { path: text("Directory to list"), limit: { type: "number", description: "Maximum number of entries" } } } },
];

export const CORE_TOOL_NAMES = CORE_TOOLS.map((tool) => tool.name);
export const TARGET_TOOL = "harbor_berth_lookup";
export const TARGET_VALUE = "BERTH-7Q4";

const TARGET = {
	name: TARGET_TOOL,
	description: "Look up the berth code the harbor registry assigned to a vessel. Returns the code as plain text.",
	inputSchema: { type: "object", properties: { vessel: text("Name of the vessel") }, required: ["vessel"] },
};

const DOMAINS = ["issue", "pull_request", "calendar_event", "document", "spreadsheet", "ticket", "deployment", "database_table", "invoice", "contact", "pipeline", "dashboard", "alert", "repository", "release", "wiki_page", "browser_tab", "container", "memory_note", "design_file"];
const VERBS = [
	["create", "Create a new"], ["get", "Fetch one"], ["list", "List every"],
	["update", "Update an existing"], ["delete", "Permanently delete a"], ["search", "Search for a"],
];

function filler(index) {
	const domain = DOMAINS[index % DOMAINS.length];
	const [verb, lead] = VERBS[Math.floor(index / DOMAINS.length) % VERBS.length];
	const noun = domain.replaceAll("_", " ");
	return {
		name: `${domain}_${verb}`,
		description: `${lead} ${noun} in the connected workspace. Use this when the user asks to ${verb} a ${noun}, or when a later step needs its identifier. `
			+ `Results are paginated: pass the cursor from the previous response to continue. Requires that the workspace is connected; `
			+ `returns a structured error naming the missing permission otherwise. Do not use this for bulk changes across more than fifty ${noun}s.`,
		inputSchema: {
			type: "object",
			properties: {
				workspace: text(`Identifier of the workspace that owns the ${noun}`),
				id: text(`Identifier of the ${noun}; required unless the call creates or lists`),
				query: text(`Free-text filter matched against the ${noun} title and body`),
				state: { type: "string", enum: ["open", "closed", "archived", "all"], description: `Lifecycle state to match (default "open")` },
				labels: { type: "array", items: { type: "string" }, description: "Only match entries carrying every one of these labels" },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of entries to return (default 20)" },
				cursor: text("Opaque pagination cursor returned by the previous call"),
			},
			required: ["workspace"],
		},
	};
}

/** `count` tools: the core seven first, then the target, then filler. */
export function syntheticTools(count) {
	const tools = [...CORE_TOOLS, TARGET];
	for (let i = 0; tools.length < count; i++) tools.push(filler(i));
	return tools.slice(0, count);
}
