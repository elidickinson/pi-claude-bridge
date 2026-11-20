// Running Claude Code for AskClaude: the child's environment and process, debug
// logging, the bridge's provider settings, and pi messages in Claude Code's format.
//
// Everything here is copied from pi-claude-bridge (the package at this repo's
// root) and trimmed to what AskClaude uses, so the two packages share no code and
// either can change or go away without touching the other. The copies are not kept
// in sync: a fix to an original reaches AskClaude only if someone copies it over.
// Each section names the file it came from.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { EffortLevel, SDKMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Message as SessionMessage, ToolResultBlock } from "cc-session-io";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

// --- From src/cc-child.ts ---

// Applied to every Claude Code subprocess:
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers out.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: stop CC logging every API request into its session file.
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks, MCP registry or telemetry.
// - CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: a resumed session that ends at a
//   tool call reads to CC as an interrupted turn, and CC may insert a "Continue from
//   where you left off." message ahead of the prompt. Every turn counts as too old.
// - CLAUDE_CODE_SILENT_TURN_REMINDER=0: on Opus 5.5, Fable 5.1, Mythos 5.1 and Sonnet 5.5,
//   CC adds "The user hasn't heard from you in a while..." after 5 silent assistant messages.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
	CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
} as const;

// Set by Claude Code on its own child processes. When pi runs inside a Claude Code
// session they describe that session, not ours.
const PARENT_SESSION_VARS = [
	"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

/** pi's environment, minus parent-session markers when pi was started from inside
 *  Claude Code, plus the guards above. */
export function ccChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (env.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	return { ...env, ...CC_CHILD_ENV };
}

// Keep Claude Code from loading CLAUDE.md/AGENTS.md files and rules. Excludes
// rather than settingSources, which would also drop ~/.claude/settings.json, where
// Bedrock/Vertex users keep `env` and `apiKeyHelper`.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

// Pi reasoning levels → CC SDK effort levels
export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  with `is_error` on an otherwise success-shaped result; the error subtypes carry `errors`. */
export function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- From src/query-process.ts ---

// The SDK iterator can settle before Claude Code finishes flushing its file.
// The custom-spawn hook lets us observe the real child's close.
export class QueryProcess {
	private started = false;
	private child: SpawnedProcess | undefined;
	private closed = false;
	private resolveExit!: () => void;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
	constructor(private stderr?: (data: string) => void) {}
	spawn = (options: SpawnOptions): SpawnedProcess => {
		if (this.closed || this.started) throw new Error("Query process spawned after close or more than once");
		const child = spawn(options.command, options.args, {
			cwd: options.cwd, env: options.env, signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.started = true;
		this.child = child;
		child.stderr.on("data", (data: Buffer) => this.stderr?.(data.toString()));
		child.once("close", () => this.resolveExit());
		return child;
	};
	/** A query constructor can throw after spawning, before returning a handle. */
	terminate(): void {
		this.close();
		if (this.child && !this.child.killed) this.child.kill("SIGTERM");
	}
	/** Called only after closing the SDK query, which forbids a deferred spawn. */
	close(): void {
		this.closed = true;
		if (!this.started) this.resolveExit();
	}
}

// --- From src/debug.ts and src/log-paths.ts ---

// CLAUDE_BRIDGE_DEBUG=1 logs to the bridge's debug log in pi's agent dir
// (CLAUDE_BRIDGE_DEBUG_PATH overrides it), shared with the provider.
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debugLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(getAgentDir(), "claude-bridge.log");
}

export function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const logPath = debugLogPath();
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	appendFileSync(logPath, `[${new Date().toISOString()}] [${moduleInstanceId}] ${args.map(fmt).join(" ")}\n`);
}

/** With CLAUDE_BRIDGE_DEBUG=1, have the Claude Code CLI write its own debug log
 *  to cc-cli-logs/ beside the bridge log, and forward its stderr to ours. */
let nextCliDebugSeq = 1;
export function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

// --- From src/config.ts ---

export interface ProviderSettings {
	autoMemoryEnabled?: boolean;
	pathToClaudeCodeExecutable?: string;
}

/** The `provider` block of the bridge's global config (~/.pi/agent/claude-bridge.json).
 *  A missing or unparseable file reads as no settings. */
export function loadProviderSettings(): ProviderSettings {
	const path = join(getAgentDir(), "claude-bridge.json");
	if (!existsSync(path)) return {};
	try {
		return { ...JSON.parse(readFileSync(path, "utf-8")).provider };
	} catch (e) {
		console.error(`pi-claude-bridge-askclaude: failed to parse ${path}: ${e}`);
		return {};
	}
}

// --- From src/convert.ts ---

const MCP_TOOL_PREFIX = "mcp__custom-tools__";

function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// Tool results are flattened to text, except that one carrying an image keeps the
// block array shape.
function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | Array<Record<string, unknown>> {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	if (!content.some((b) => b.type === "image" && b.data && b.mimeType)) return messageContentToText(content) || "";
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

/** pi messages as Anthropic messages for cc-session-io's importMessages. A tool
 *  in `toolNames` is called by that name; any other gets its MCP name. Messages
 *  of other roles (system) are skipped. */
export function convertPiMessages(messages: PiMessage[], toolNames: ReadonlyMap<string, string>): SessionMessage[] {
	const out: SessionMessage[] = [];
	const sanitizedIds = new Map<string, string>();
	const ccToolName = (name: string) => toolNames.get(name) ?? toolNames.get(name.toLowerCase()) ?? `${MCP_TOOL_PREFIX}${name}`;
	// The user message collecting this assistant turn's tool results, and the index
	// of the assistant message it belongs to.
	let turnResults: { role: "user"; content: Array<ToolResultBlock | Record<string, unknown>> } | null = null;
	let turnAssistantIdx: number | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				out.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					}
				}
				out.push({ role: "user", content: parts.length ? parts : "[image]" } as SessionMessage);
			} else {
				out.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Only thinking Claude Code produced carries a signature Anthropic accepts.
					const sig = block.thinkingSignature;
					if (msg.provider === "claude-bridge" && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: ccToolName(block.name), input: block.arguments ?? {} });
				}
			}
			// A turn aborted before anything streamed has no content: drop it, keeping
			// turnResults so a later result of the previous turn still joins its batch.
			if (!content.length) continue;
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			turnResults = null;
			turnAssistantIdx = out.length;
			out.push({ role: "assistant", content: blocks } as SessionMessage);
		} else if (msg.role === "toolResult") {
			// pi records one message per tool result, but cc-session-io's repairToolPairing
			// pairs only results sharing the user message directly after their assistant
			// message, and replaces the rest with a stub. So every result of a turn goes into
			// one user message placed right after the assistant, ahead of any steer.
			// Claude Code never sends an empty tool result: live, it substitutes these placeholders
			// (tests/int-cc-contracts.mjs pins them), and the API rejects an empty one marked is_error.
			let content = toolResultContent(msg.content);
			if (typeof content === "string" && !content.trim()) {
				content = msg.isError ? "Command failed with no output" : `(${ccToolName(msg.toolName)} completed with no output)`;
			}
			const block = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content, ...(msg.isError ? { is_error: true } : {}) };
			if (turnResults) {
				turnResults.content.push(block);
			} else {
				turnResults = { role: "user", content: [block] };
				out.splice(turnAssistantIdx === null ? out.length : turnAssistantIdx + 1, 0, turnResults as unknown as SessionMessage);
			}
		}
	}
	return out;
}
