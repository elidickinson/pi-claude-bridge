import { calculateCost, createAssistantMessageEventStream, getModels, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import { buildSessionContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSdkMcpServer, query, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { pascalCase } from "change-case";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createSession, openSession } from "cc-session-io";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";

// --- Constants ---

const PROVIDER_ID = "claude-bridge";

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash", grep: "grep", glob: "find",
};
const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
};
const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"Skill", "TaskOutput", "TaskStop",
];

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map((model) => ({
		id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
		cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
	}));

function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	for (const id of LATEST_MODEL_IDS) {
		if (id === lower || id.includes(lower)) return id;
	}
	return input;
}

// --- Skills/settings paths ---

const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
const SKILLS_ALIAS_PROJECT = ".claude/skills";
const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

// --- Config ---

interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
}

function loadConfig(cwd: string): Config {
	const globalPath = join(homedir(), ".pi", "agent", "claude-bridge.json");
	const projectPath = join(cwd, ".pi", "claude-bridge.json");
	let global: Partial<Config> = {};
	let project: Partial<Config> = {};
	if (existsSync(globalPath)) { try { global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch {} }
	if (existsSync(projectPath)) { try { project = JSON.parse(readFileSync(projectPath, "utf-8")); } catch {} }
	return { askClaude: { ...global.askClaude, ...project.askClaude } };
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Text extraction ---

function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type === "image") { /* text-only */ }
		else { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// --- AskClaude helpers ---

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const reads = new Set<string>();
	const edits = new Set<string>();
	const commands: string[] = [];
	const other: string[] = [];

	for (const [, tc] of calls) {
		const path = extractPath(tc.rawInput);
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		if (verb === "read" || verb === "readfile") {
			if (path) reads.add(shortPath(path));
		} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
			if (path) edits.add(shortPath(path));
		} else if (verb === "bash" || verb === "terminal") {
			commands.push(path ?? "command");
		} else {
			other.push(tc.name);
		}
	}

	const parts: string[] = [];
	if (reads.size) parts.push(`read ${[...reads].join(", ")}`);
	if (edits.size) parts.push(`edited ${[...edits].join(", ")}`);
	if (commands.length) parts.push(`ran ${commands.join("; ")}`);
	if (other.length) parts.push(other.join("; "));
	return parts.join("; ");
}

// AskClaude mode presets — controls which CC tools are blocked per mode
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [],
	read: [
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
}

let sharedSession: SessionState | null = null;

const SESSION_LOG = join(homedir(), ".pi", "agent", "claude-bridge-session.log");
function sessionLog(msg: string) {
	try {
		mkdirSync(dirname(SESSION_LOG), { recursive: true });
		appendFileSync(SESSION_LOG, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

/** Convert pi messages to Anthropic API format and import into a cc-session-io session. */
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const anthropicMessages: Array<{ role: string; content: unknown }> = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({ role: "user", content: text || "[image]" });
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: unknown[] = [];
			for (const block of content) {
				if (block.type === "text") {
					blocks.push({ type: "text", text: block.text ?? "" });
				} else if (block.type === "thinking") {
					// Drop thinking blocks — signatures are bound to the original session
					// and invalid when replayed in a new session (Case 4 creates a fresh session)

				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: block.id, name: toolName, input: block.arguments ?? {} });
				}
			}
			if (blocks.length) anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: text || "", is_error: msg.isError }],
			});
		}
	}

	if (anthropicMessages.length) session.importMessages(anthropicMessages as any);
}

/** Extract the text content from the last tool result message. */
function extractLastToolResult(context: Context): { content: string; isError: boolean } | null {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			return { content: text || "", isError: msg.isError };
		}
		if (msg.role === "user") break; // stop searching at user messages
	}
	return null;
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}


interface SyncResult {
	sessionId: string | null;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt

	if (!sharedSession) {
		if (priorMessages.length === 0) {
			sessionLog(`Case 1: clean start, ${messages.length} total messages`);
			return { sessionId: null };
		}
		const session = createSession({ projectPath: cwd, ...(modelId ? { model: modelId } : {}) });
		convertAndImportMessages(session, priorMessages, customToolNameToSdk);
		session.save();
		sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
		sessionLog(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
		return { sessionId: session.sessionId };
	}

	const missed = priorMessages.slice(sharedSession.cursor);
	if (missed.length === 0) {
		sessionLog(`Case 3: no missed messages, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		return { sessionId: sharedSession.sessionId };
	}

	// Case 4: create fresh session with ALL prior messages (injecting into existing session
	// creates a branch that Claude Code doesn't follow on resume)
	const session = createSession({ projectPath: sharedSession.cwd, ...(modelId ? { model: modelId } : {}) });
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	const oldSessionId = sharedSession.sessionId;
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd: sharedSession.cwd };
	sessionLog(`Case 4: ${missed.length} missed messages, ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${oldSessionId.slice(0, 8)}), ${session.messages.length} records`);
	return { sessionId: session.sessionId };
}

// Extract skills block from pi's system prompt for forwarding to Claude Code
function extractSkillsBlock(systemPrompt: string): string | undefined {
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return systemPrompt.slice(start, end + endMarker.length).trim();
}

// --- Provider helpers: tool name mapping ---

function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;
	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, PROJECT_SKILLS_ROOT);
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, PROJECT_SKILLS_ROOT);
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, PROJECT_SKILLS_ROOT);
	}
	return pathValue;
}

function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined, allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};
	const resolvePath = (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value);
	switch (normalized) {
		case "read": return { path: resolvePath(input.file_path ?? input.path), offset: input.offset, limit: input.limit };
		case "write": return { path: resolvePath(input.file_path ?? input.path), content: input.content };
		case "edit": return { path: resolvePath(input.file_path ?? input.path), oldText: input.old_string ?? input.oldText ?? input.old_text, newText: input.new_string ?? input.newText ?? input.new_text };
		case "bash": return { command: input.command, timeout: input.timeout };
		case "grep": return { pattern: input.pattern, path: resolvePath(input.path), glob: input.glob, limit: input.head_limit ?? input.limit };
		case "find": return { pattern: input.pattern, path: resolvePath(input.path) };
		default: return input;
	}
}

// --- Provider helpers: system prompt ---

function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}

function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(PROJECT_SKILLS_ROOT)) {
			const relPath = relative(PROJECT_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	sanitized = sanitized.replace(/\bpi\b/gi, "environment");
	return sanitized;
}

// --- Provider helpers: settings ---

type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

function loadProviderSettings(): ProviderSettings {
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH);
	return { ...globalSettings, ...projectSettings };
}

function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean" ? settingsBlock["appendSystemPrompt"] : undefined;
		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every((value) => typeof value === "string" && (value === "user" || value === "project" || value === "local"))
				? (settingSourcesRaw as SettingSource[])
				: undefined;
		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;
		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch {
		return {};
	}
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

interface PendingToolCall {
	toolName: string;
	resolve: (result: string) => void;
}

/** Active query that's waiting for a tool result via the MCP bridge. */
let activeQuery: ReturnType<typeof query> | null = null;
let pendingToolCall: PendingToolCall | null = null;
let onPendingToolCall: (() => void) | null = null;

/**
 * When Mode B provides a tool result, the active query continues generating.
 * This function is set by Mode A's async block to receive the new pi stream
 * that Mode B events should be pushed to.
 */
let modeBStream: ReturnType<typeof createAssistantMessageEventStream> | null = null;
let onModeBStream: (() => void) | null = null;

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		// All pi tools become MCP tools (built-in SDK tools are disallowed)
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

function buildMcpServers(tools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown,
		handler: async () => {
			// Block until pi provides the tool result via Mode B
			return new Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>((resolve) => {
				pendingToolCall = {
					toolName: tool.name,
					resolve: (result: string) => resolve({ content: [{ type: "text", text: result }] }),
				};
				// Signal that the MCP handler is ready for Mode B
				onPendingToolCall?.();
				onPendingToolCall = null;
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

// --- Thinking budget mapping ---

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048, low: 8192, medium: 16384, high: 31999,
};

// "xhigh" is unavailable in the TUI because pi-ai's supportsXhigh() doesn't
// recognize the "claude-bridge" api type. Opus-4-6 gets shifted budgets so
// "high" uses the budget that xhigh would normally use.
const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048, low: 8192, medium: 31999, high: 63999, xhigh: 63999,
};

function mapThinkingTokens(
	reasoning?: ThinkingLevel, modelId?: string, thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) return OPUS_46_THINKING_BUDGETS[reasoning];

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;
	const customBudgets = thinkingBudgets as (Partial<Record<NonXhighThinkingLevel, number>> | undefined);
	const customBudget = customBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) return customBudget;

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Tool execution uses an MCP bridge pattern:
// 1. Claude Code calls MCP tool → handler blocks on a Promise (pendingToolCall)
// 2. We see the tool_use in stream events → push toolcall_end + done(toolUse) to pi
// 3. Pi executes the tool externally, then calls streamSimple again (Mode B)
// 4. Mode B resolves the pending Promise with the tool result
// 5. Claude Code continues generating → we push new events to Mode B's stream
// 6. The for-await loop runs continuously; only the pi-facing stream switches between calls
//
// The key constraint is that pi requires the stream to END before executing tools.
// So on tool_use we push done+end to the current stream but keep consuming the
// SDK generator. The MCP handler blocks naturally, pausing the generator until
// Mode B resolves it. Then new events flow and get pushed to Mode B's stream.

function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	// --- Mode B: tool result turn → resolve the pending MCP handler ---
	// The query is still alive from Mode A. We provide the new pi stream and resolve
	// the tool call so Claude Code continues generating into this stream.
	if (activeQuery) {
		const resolveToolCall = () => {
			const toolResult = extractLastToolResult(context);
			sessionLog(`provider: Mode B, resolving ${pendingToolCall!.toolName}, result=${(toolResult?.content ?? "").slice(0, 60)}`);

			// Give the running Mode A loop the new stream to push events to
			modeBStream = stream;
			onModeBStream?.();
			onModeBStream = null;

			// Resolve the MCP handler — Claude Code continues, new events flow
			pendingToolCall!.resolve(toolResult?.content ?? "OK");
			pendingToolCall = null;
			if (sharedSession) sharedSession.cursor = context.messages.length;
		};

		if (pendingToolCall) {
			// MCP handler already called — resolve immediately
			resolveToolCall();
		} else {
			// MCP handler not yet called (race with message_stop).
			// Wait for it asynchronously — events will flow once resolved.
			onPendingToolCall = () => resolveToolCall();
		}
		return stream;
	}

	// --- Mode A: fresh prompt → create query and consume events ---
	(async () => {
		// Clean up stale query
		if (activeQuery) { try { activeQuery.close(); } catch {} activeQuery = null; }

		const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const { sessionId: resumeSessionId } = syncSharedSession(context.messages, cwd, customToolNameToSdk, model.id);
		const prompt = extractUserPrompt(context.messages) ?? "";
		sessionLog(`provider: Mode A, ${context.messages.length} msgs, resume=${resumeSessionId?.slice(0, 8) ?? "none"}, prompt=${prompt.slice(0, 60)}`);

		const mcpServers = buildMcpServers(mcpTools);
		const providerSettings = loadProviderSettings();
		const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
		const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
		const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;
		const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
		const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
		const allowSkillAliasRewrite = Boolean(skillsAppend);

		const settingSources: SettingSource[] | undefined = appendSystemPrompt
			? undefined
			: providerSettings.settingSources ?? ["user", "project"];
		const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;

		const extraArgs: Record<string, string | null> = { model: model.id };
		if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;

		const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
			cwd,
			disallowedTools: DISALLOWED_BUILTIN_TOOLS,
			allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
			permissionMode: "bypassPermissions",
			includePartialMessages: true,
			systemPrompt: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
			},
			extraArgs,
			...(settingSources ? { settingSources } : {}),
			...(mcpServers ? { mcpServers } : {}),
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
		};

		const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
		if (maxThinkingTokens != null) queryOptions.maxThinkingTokens = maxThinkingTokens;

		let wasAborted = false;
		const sdkQuery = query({ prompt, options: queryOptions });
		activeQuery = sdkQuery;

		const requestAbort = () => { void sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} }); };
		const onAbort = () => { wasAborted = true; requestAbort(); };
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		// Current pi-facing stream. Starts as the Mode A stream.
		// Switches to Mode B's stream after each tool-use pause.
		let piStream = stream;

		// Fresh output state for each pi turn
		const makeOutput = (): AssistantMessage => ({
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});
		let output = makeOutput();
		let blocks = output.content as Array<any>;
		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let capturedSessionId: string | undefined;

		try {
			for await (const message of sdkQuery) {
				if (wasAborted) break;
				if (!started) { piStream.push({ type: "start", partial: output }); started = true; }

				switch (message.type) {
					case "stream_event": {
						sawStreamEvent = true;
						const event = (message as SDKMessage & { event: any }).event;

						if (event?.type === "message_start") {
							const usage = event.message?.usage;
							output.usage.input = usage?.input_tokens ?? 0;
							output.usage.output = usage?.output_tokens ?? 0;
							output.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
							output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "content_block_start") {
							if (event.content_block?.type === "text") {
								blocks.push({ type: "text", text: "", index: event.index });
								piStream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
							} else if (event.content_block?.type === "thinking") {
								blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
								piStream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
							} else if (event.content_block?.type === "tool_use") {
								sawToolCall = true;
								blocks.push({
									type: "toolCall", id: event.content_block.id,
									name: mapToolName(event.content_block.name, customToolNameToPi),
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "", index: event.index,
								});
								piStream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
							}
							break;
						}

						if (event?.type === "content_block_delta") {
							if (event.delta?.type === "text_delta") {
								const index = blocks.findIndex((b: any) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "text") {
									block.text += event.delta.text;
									piStream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
								}
							} else if (event.delta?.type === "thinking_delta") {
								const index = blocks.findIndex((b: any) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinking += event.delta.thinking;
									piStream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
								}
							} else if (event.delta?.type === "input_json_delta") {
								const index = blocks.findIndex((b: any) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parsePartialJson(block.partialJson, block.arguments);
									piStream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
								}
							} else if (event.delta?.type === "signature_delta") {
								const index = blocks.findIndex((b: any) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
								}
							}
							break;
						}

						if (event?.type === "content_block_stop") {
							const index = blocks.findIndex((b: any) => b.index === event.index);
							const block = blocks[index];
							if (!block) break;
							delete block.index;
							if (block.type === "text") {
								piStream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
							} else if (block.type === "thinking") {
								piStream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
							} else if (block.type === "toolCall") {
								sawToolCall = true;
								block.arguments = mapToolArgs(
									block.name, parsePartialJson(block.partialJson, block.arguments), allowSkillAliasRewrite,
								);
								delete block.partialJson;
								piStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
							}
							break;
						}

						if (event?.type === "message_delta") {
							output.stopReason = mapStopReason(event.delta?.stop_reason);
							const usage = event.usage ?? {};
							if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
							if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
							if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
							if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
							output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "message_stop" && sawToolCall) {
							// Tool call complete. Tell pi to execute it by ending this stream.
							// The query stays alive — the MCP handler will block until Mode B
							// provides the tool result, at which point new events flow and we
							// push them to Mode B's stream.
							output.stopReason = "toolUse";
							piStream.push({ type: "done", reason: "toolUse", message: output });
							piStream.end();

							if (sharedSession) sharedSession.cursor += blocks.length; // approximate

							// Wait for Mode B to provide the next stream + resolve the tool
							piStream = await new Promise<ReturnType<typeof createAssistantMessageEventStream>>((resolve) => {
								onModeBStream = () => resolve(modeBStream!);
								// If modeBStream was already set (unlikely race), resolve now
								if (modeBStream) { resolve(modeBStream); onModeBStream = null; }
							});
							modeBStream = null;

							// Reset for the next pi turn
							output = makeOutput();
							blocks = output.content as Array<any>;
							started = false;
							sawStreamEvent = false;
							sawToolCall = false;
							break;
						}

						break;
					}

					case "result": {
						if (!sawStreamEvent && message.subtype === "success") {
							output.content.push({ type: "text", text: message.result || "" });
						}
						break;
					}

					case "system": {
						if ((message as any).subtype === "init" && (message as any).session_id) {
							capturedSessionId = (message as any).session_id;
						}
						break;
					}
				}
			}

			// Update session state
			if (!wasAborted) {
				const sessionId = capturedSessionId ?? sharedSession?.sessionId;
				if (sessionId) {
					sharedSession = { sessionId, cursor: context.messages.length, cwd };
				}
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				piStream.push({ type: "error", reason: "aborted", error: output });
				piStream.end();
			} else {
				piStream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
				piStream.end();
			}
			activeQuery = null;
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			piStream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			piStream.end();
			activeQuery = null;
		} finally {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			if (activeQuery === sdkQuery) activeQuery = null;
			sdkQuery.close();
		}
	})();

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();
	const modelId = resolveModelId(options?.model ?? "opus");

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
			sessionLog(`askClaude shared: reusing provider session ${sharedSession.sessionId.slice(0, 8)}, prompt=${prompt.slice(0, 60)}`);
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, modelId);
			resumeSessionId = sync.sessionId;
			sessionLog(`askClaude shared: created session ${resumeSessionId?.slice(0, 8) ?? "none"}, ${options.context.length} context msgs, prompt=${prompt.slice(0, 60)}`);
		}
	} else {
		sessionLog(`askClaude ${options?.isolated ? "isolated" : "no-context"}: prompt=${prompt.slice(0, 60)}`);
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Thinking
	const thinkingMap: Record<string, ThinkingLevel> = {
		minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
	};
	const thinkingLevel = options?.thinking && options.thinking !== "off"
		? thinkingMap[options.thinking] : undefined;
	const maxThinkingTokens = thinkingLevel ? mapThinkingTokens(thinkingLevel, modelId) : undefined;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: modelId,
	};

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(maxThinkingTokens != null ? { maxThinkingTokens } : {}),
			systemPrompt: skillsBlock
				? { type: "preset", preset: "claude_code", append: skillsBlock }
				: undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						toolCalls.set(event.content_block.id, {
							name: event.content_block.name,
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: block.name,
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		return { responseText, stopReason: wasAborted ? "cancelled" : "stop" };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());

	// Reset shared session on pi session lifecycle events
	pi.on("session_switch", () => { sharedSession = null; });
	pi.on("session_shutdown", () => { sharedSession = null; });

	// --- Provider ---

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
	});

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode === true;
	const defaultMode = askConf?.defaultMode ?? "read";
	askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		pi.registerTool({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: Type.Object({
				prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
				mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
				model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
				thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
				isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
			}),
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== "full") tags.push(`tools=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", "…")}`;
				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated: params.isolated,
						context: params.isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					console.error("[claude-bridge] AskClaude error:", err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
