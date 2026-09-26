import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, generateBranchSummary, keyHint, type BranchSummaryResult, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { Text } from "@earendil-works/pi-tui";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, renderSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeSettings, loadConfig, markStartupNoticeShown, type Config } from "./config.js";
import {
	collectPromptSkills,
	projectPromptCapture,
	sharedPromptCaptures,
} from "./prompt-capture.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { askClaudeCallTags, askClaudeToolDescription, buildAskClaudeParams, resolveAskClaudeDefaults, resolveAskClaudeMode, type AskClaudeMode } from "./askclaude-schema.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { fingerprintProjectedPriors } from "./priors-fingerprint.js";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-bridge-diag.log");

// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery sees,
// one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to capture
// replay fixtures, so unit tests assert against message shapes Claude Code really
// emitted rather than ones we imagined.
const RECORD_STREAM_PATH = process.env.CLAUDE_BRIDGE_RECORD_STREAM;

// Applied to every Claude Code subprocess the bridge spawns — provider, AskClaude
// and the compact summary. One place, so a guard is added once rather than three
// times, and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise a project CLAUDE.md arrives twice, and the user's
// ~/.claude/CLAUDE.md — a persona written for a harness that is not the one
// running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; "**/CLAUDE.md" covers the user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
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

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// Claude Code's own builtin tools, for the AskClaude path where CC really runs
// them. The provider path never sees these — it starts CC with `tools: []`.
const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
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

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no pi TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<AskClaudeMode, string[]> = {
	full: ASKCLAUDE_ALWAYS_BLOCKED,
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
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
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Content fingerprint of the priors that built the current CC session (roles,
	// block types, contents, images, tool ids/names/args/results; timestamps,
	// usage/cost and other metadata excluded). Fingerprint-based sync relies on
	// it; it rides along with sessionId/cursor everywhere the state is replaced.
	fingerprint?: string;
	// Identity of the pi session this shared state belongs to (pi's own session
	// id, forwarded on every stream call via StreamOptions.sessionId). Same-owner
	// decisions (rewrites of the shared history vs. a foreign session arriving
	// mid-query, e.g. a subagent child routed through the pinned stream fn) are
	// made by comparing ids — NOT by "a query is active somewhere", which a
	// concurrent child's dispatch cannot be told apart from a same-owner
	// continuation. Undefined only for states created by callers with no session
	// identity (AskClaude cold start) or legacy pre-identity state; those keep
	// the conservative length-based guards.
	ownerSessionId?: string;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		return collectCarriedAttachments(previous.records);
	} catch (error) {
		// A post-abort rebuild reads a file the killed CC subprocess may have been
		// midway through writing, and cc-session-io parses each line with a bare
		// JSON.parse, so a truncated last line throws. Throwing here would turn a
		// lost attachment into a failed turn; carrying none is exactly what happened
		// before this existed, so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

let sharedSession: SessionState | null = null;

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	carried?: readonly CarriedAttachment[],
): void {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	// Placement runs against the repaired array because that is the index space
	// importMessages reads. Attachments are links in CC's uuid chain, so they have
	// to be written in order with the messages, not appended afterwards.
	const placed = carried?.length
		? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
		: undefined;
	if (placed?.skipped.length) {
		debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
	}
	if (placed?.attachments.length) {
		debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
	}
	if (repaired.length) {
		session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
	}
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

/** Positive discriminator for pi's dedicated summary prompts.
 *
 *  cacheRetention:"none" is a cache preference, not a purpose marker
 *  (@earendil-works/pi-ai 0.86.x types.d.ts:132-136) — pi may set it on ordinary
 *  inference too, so routing on the flag alone destroyed history/tools for those
 *  calls. Instead route to the isolated summary path only when a call's prompt
 *  matches one of pi 0.87.1's four summarization shapes, pinned here to the
 *  installed dist:
 *
 *  - native compaction summary + update (PI/dist/core/compaction/compaction.js:
 *    400 SUMMARIZATION_PROMPT, 432 UPDATE_SUMMARIZATION_INSTRUCTIONS, 468
 *    UPDATE_SUMMARIZATION_PROMPT) and turn-prefix (compaction.js:684
 *    TURN_PREFIX_SUMMARIZATION_PROMPT)
 *  - branch summary (PI/dist/core/compaction/branch-summarization.js:153
 *    BRANCH_SUMMARY_PROMPT)
 *  - bug report (PI/dist/core/bug-report.js:220 BUG_SUMMARY_INSTRUCTIONS)
 *
 *  The user-text markers are version-pinned literals; the shared system prompt is
 *  recognized by its exact text with the trailing-paragraph tolerance described
 *  at matchesSummarySystemPrompt. cacheRetention:"none" WITHOUT a shape match is
 *  ordinary no-cache traffic and takes the normal path with full history+tools;
 *  because the shapes above are every completeSummarization caller in the
 *  installed pi, any unrecognized no-cache call is treated the same (truthful
 *  diagnostic, no history destruction). */
const SUMMARY_SYSTEM_PROMPTS: readonly string[] = [
	// pi-ai normalizeContext folds this into the leading system message; exact prefixes.
	"You are a context summarization assistant.", // utils.js:139 SUMMARIZATION_SYSTEM_PROMPT (compaction, update, turn prefix, branch)
	"You are helping a user file a bug report about pi", // bug-report.js:217 BUG_SUMMARY_SYSTEM_PROMPT
];

function matchesSummarySystemPrompt(systemPrompt: string | undefined): boolean {
	return typeof systemPrompt === "string" && SUMMARY_SYSTEM_PROMPTS.some((prefix) => systemPrompt.startsWith(prefix));
}

const SUMMARY_PROMPT_MARKERS: readonly string[] = [
	"The messages above are a conversation to summarize.", // compaction.js:400 SUMMARIZATION_PROMPT
	"<previous-summary>", // compaction.js:468 UPDATE_SUMMARIZATION_PROMPT (previous summary folded into the user prompt)
	"The messages above are earlier context from an ongoing conversation.", // compaction.js:684 TURN_PREFIX_SUMMARIZATION_PROMPT
	"\n\n# Instructions\n", // compaction.js:752 prompt body wrapper (turn prefix)
	"Create a structured summary of this conversation branch", // branch-summarization.js:153 BRANCH_SUMMARY_PROMPT
	"Summary of that exploration:", // branch-summarization.js:148 BRANCH_SUMMARY_PREAMBLE (cumulative)
	"<conversation>", // compaction.js:546 / branch-summarization.js:211 serialize the transcript into this tag
	"Write the bug report in Markdown with these sections:", // bug-report.js:220 BUG_SUMMARY_INSTRUCTIONS
	"<user-report>", // bug-report.js:260 optional user hint tag
];

function matchesSummaryPromptText(promptText: string): boolean {
	return SUMMARY_PROMPT_MARKERS.some((marker) => promptText.includes(marker));
}

/** Definition of the discriminator, exposed for the unit test's shape pins. */
export function isDedicatedSummaryCall(context: Context): boolean {
	return matchesSummarySystemPrompt(context.systemPrompt) && matchesSummaryPromptText(extractUserPrompt(context.messages) ?? "");
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. */
function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude rate limit" rather than appending keeps the phrase in any truncated
 *  render, and avoids the `<tool> failed (exit N):` shape that pi-subagents treats as a tool
 *  failure and refuses to retry. */
function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude rate limit${kind}${resets}: ${failure}`;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	// pi delivers compaction/branch-summary requests as a transcript: the summarization
	// prompt folded into a leading system message ahead of the lone user message
	// (issue #106). toBridgeContext restores the prompt/tools fields the extraction
	// assertion below assumes; the summarization prompt still reaches CC as its systemPrompt.
	context = toBridgeContext(context);
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		// This path only runs for calls the provider already discriminated as
		// dedicated summaries (compaction summary/update, branch summary, turn
		// prefix, bug report). Callers without their system prompt re-derivable
		// from the transcript fall back to extractUserPrompt.
		const promptText = extractUserPrompt(context.messages) ?? extractIsolatedSummaryPrompt(context.messages);
		if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = process.cwd();
		const compactProviderSettings = loadConfig(cwd).provider;
		const claudeExecutable = compactProviderSettings?.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, ...CC_CHILD_ENV },
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				// The summary's own system prompt text as a bare string would be a
				// CUSTOM prompt lane query — Anthropic classifies custom prompts as
				// third-party app usage: extra usage at API rates, rejected without
				// balance (live-probed 2026-09-26, SDK 0.3.280). These summaries fire
				// automatically on compaction/tree/bug even in default append mode, so
				// they must stay on the subscription-preserving preset+append lane like
				// the main provider. The preset's instructions are designed to be
				// appended to; pi's summary system prompt is data-plus-task ("ONLY output
				// the summary, do NOT continue the conversation"), so appending it keeps
				// the same instruction content. Direct construction, not
				// projectPromptCapture's guard — the guard protects the projection built
				// from pi-harness text with extraction heuristics, while pi's own
				// verbatim summary prompt must reach CC unmodified (see README note).
				systemPrompt: {
					type: "preset" as const,
					preset: "claude_code" as const,
					append: context.systemPrompt,
					// Summary runs are one-shot with persistSession:false (no later
					// request in this conversation to go stale); snapshot:false matches
					// the main provider so a per-summary append is rendered fresh.
					snapshot: false,
				},
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

/** Seed the next compaction's file ops from the prior compaction's details.
 *  Needed because pi's native extractFileOperations skips prior-compaction details
 *  on fromHook entries (extension-written compactions), restarting the cumulative
 *  <read-files>/<modified-files> lists empty on exactly the sessions where an
 *  extension did the previous compaction. Called as a
 *  pre-mutation of event.preparation before the session_before_compact hook yields;
 *  pi's native compact() and later hooks see the mutation. Earlier hooks have
 *  already consumed preparation.fileOps; their returned summaries are unchanged. */
function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`session_before_compact: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/** Active-query completion reconstruction of the shared-session state
 *  ({sessionId, cursor, cwd}). Previously this wholesale replacement dropped a
 *  pending needsRebuild set while the query was running (pi mutating history
 *  mid-turn) — the stale state it marked quietly resurrected. The pending flag
 *  survives, and the fingerprint is refreshed to the history CC actually has
 *  (the stored digest is bound to the cursor written beside it).
 *  Extracted so unit tests pin the reconstruction contract. */
function reconstructCompletedSession(
	previous: SessionState | null,
	sessionId: string,
	cursor: number,
	cwd: string,
	nonSystemContext: ReadonlyArray<object>,
	ownerSessionId?: string,
): SessionState {
	const carriedNeedsRebuild = previous?.needsRebuild ?? false;
	const carriedFingerprint = fingerprintProjectedPriors(
		nonSystemContext.slice(0, cursor),
	).hash;
	// The completing query's identity is authoritative; an unidentified caller
	// keeps the stored owner. Never adopt a foreign completion's stored identity.
	const completedOwner = ownerSessionId !== undefined ? ownerSessionId : previous?.ownerSessionId;
	return {
		sessionId,
		cursor,
		cwd,
		fingerprint: carriedFingerprint,
		...(completedOwner !== undefined ? { ownerSessionId: completedOwner } : {}),
		...(carriedNeedsRebuild ? { needsRebuild: true } : {}),
	};
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 *
 * preserveSharedSession semantics on a null sessionId:
 *  - undefined (falsy): genuine clean start — the caller owns history; nothing
 *    was open, and the shared session state is gone (root rewind).
 *  - true: another owner ran a fresh session while the shared one stays — the
 *    completion handler discards the ephemeral session and keeps shared state.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	// Ownership identity: pi's session id for this stream call (StreamOptions
	// .sessionId — pi 0.87.1 constructs its Agent with sessionId from the session
	// manager and the agent loop forwards it on every streamSimple call).
	//  - Matching the stored state's ownerSessionId: the same conversation is
	//    calling again — a shortened-priors sync is that owner rewriting its own
	//    history and must be fully rebuilt with import (issue: #30).
	//  - Different id: a foreign session (a subagent child dispatched through the
	//    pinned stream fn while the owner's query is still live) — isolation, no
	//    matter how long its priors are; the shared session must never be
	//    rebuilt, cleared, or resumed for it.
	//  - undefined (default, e.g. AskClaude cold start) or a legacy state without
	//    a stored id: ownership is unknown — fall back to the conservative
	//    length-based guard (shorter priors = another owner, clean start).
	ownerSessionId?: string,
): SyncResult {
	// Proven foreign owner: both sides have a session id and they differ (a
	// subagent child dispatched through the pinned stream fn while the owner's
	// query is still live, or any other distinct pi session in this process).
	// Callers with no id to compare are NOT foreign — they keep the legacy
	// length-based guard below.
	const foreignOwner = sharedSession !== null
		&& sharedSession.ownerSessionId !== undefined
		&& ownerSessionId !== undefined
		&& sharedSession.ownerSessionId !== ownerSessionId;

	// System messages are pi's transcript representation of prompt and tool state, not
	// conversation history — they are never imported into a CC session, so exclude them from
	// the history space (priorMessages, cursor, missed) everywhere below (issue #106).
	const history = nonSystemMessages(messages);
	const priorMessages = history.slice(0, turnStart(history)); // everything before the current user turn

	// REUSE path (content fingerprints + explicit ownership)
	//
	// What replaced the old count-vs-cursor check: message COUNT alone cannot
	// tell a removed or rewritten prior from a matching one (issue: probe —
	// count collision [recall1,user1] vs [user1,assistant1] → false REUSE), so
	// the durability guard is now a content fingerprint of the projected priors
	// must match what built the session. Any disappearance or rewrite of a
	// prior — pi-context-prune removing a mid-history message, an extension's
	// injected pre-last-user text vanishing or changing at
	// the next request — changes the hash at the SAME count and forces rebuild
	// acceptance covered by tests/unit-sync-shared-session-fingerprints.mjs).
	//
	// Ownership: pi's session identity discriminates the shortened-context case
	// (issue #30). For the same owner (same pi session id — a steer or follow-up
	// while a query is live) a shorter priors is that owner pruning its own
	// history — full rebuild importing the retained priors. A different or
	// unstated owner with shorter priors is a RE-run of another agent's ask —
	// the subagent isolation guard below keeps the shared session intact and
	// starts fresh. "A query is active somewhere" is deliberately NOT used: a
	// concurrent subagent child's dispatch runs in the parent's module state and
	// would be indistinguishable from a same-owner continuation by that signal.
	const sameOwner = sharedSession !== null
		&& sharedSession.ownerSessionId !== undefined
		&& ownerSessionId !== undefined
		&& sharedSession.ownerSessionId === ownerSessionId;
	if (sharedSession && !sharedSession.needsRebuild && !foreignOwner) {
		// The stored fingerprint is ALWAYS the digest of the history prefix the
		// cursor points at — [0, cursor) at the last sync, optionally extended by
		// the one trailing assistant message CC records on its own after pi's
		// stream returned (and which only reaches pi's history at the NEXT sync).
		// Compare the same prefix region of the incoming priors: identical content
		// → reuse; ANY change inside the prefix (an edit, a removed or rewritten
		// injected message) with count out of the cursor → rebuild.
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		// Only two benign shapes may ride the stored session: an exact prefix
		// (nothing unseen) or exactly one trailing assistant message (the one CC
		// appends on its own after the stream returned). Multiple unseen messages
		// past the cursor mean pi's history moved while the bridge state was
		// parked — reuse here would keep the old CC session and silently drop
		// those turns from its context. Fall through to the rebuild, which
		// imports the full retained priors and realigns cursor + fingerprint.
		const reuseAllowed = missed.length === 0 || trailingAssistantOnly;
		const prefixMatched = sharedSession.fingerprint !== undefined
			? fingerprintProjectedPriors(priorMessages.slice(0, sharedSession.cursor)).hash === sharedSession.fingerprint
			// Legacy state without a fingerprint: fall back to the old count-based
			// allowance for exactly the benign trailing-assistant shape (one churn
			// max on upgrade; the first reuse/rebuild stores a fingerprint).
			: trailingAssistantOnly;
		if (reuseAllowed && priorMessages.length >= sharedSession.cursor && prefixMatched) {
			// New fingerprint bounds at the cursor we are about to store.
			const digest = fingerprintProjectedPriors(priorMessages).hash;
			// CC already recorded the trailing assistant; advance its cursor and
			// fingerprint together without importing that message again.
			sharedSession = {
				...sharedSession,
				cursor: trailingAssistantOnly ? priorMessages.length : sharedSession.cursor,
				cwd,
				fingerprint: digest,
				...(sharedSession.ownerSessionId === undefined ? { ownerSessionId } : {}),
			};
			debug(`Case 3: fingerprint match (${digest.slice(0, 12)}), ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId };
		}
		// No fingerprint match (content changed, shrank, or this state predates
		// fingerprints): fall through. Reentrant ownership proceeds to REBUILD
		// importing retained priors; any other owner with shorter priors hits the
		// isolation guard below.
	}

	// This is what keeps a subagent from taking over the parent's session: a
	// child dispatched while the parent's query is live (or a foreign session
	// arriving any other way) lands here, gets a fresh (or ephemeral-imported)
	// session, and the ephemeral session it captures is deleted once its query
	// completes (see preserveSharedSession in the completion handler). Remove
	// this branch and a subagent resumes — then overwrites — the parent's
	// session. The non-isolated AskClaude path reaches it the same way.
	//
	// It is NOT, despite an earlier comment here, the isolated compact-summary
	// path: runIsolatedSummary never calls syncSharedSession at all.
	//
	// Reachable with needsRebuild pending ONLY for the proven same owner (its
	// legitimate pending rebuild) or an unknown-ownership caller (legacy
	// behavior); a proven-foreign caller is isolated unconditionally above.
	//
	// issue #30: NOT purely length-based. Ownership is pi's session identity: a
	// proven-foreign caller (different sessionId) is isolated however long its
	// priors are — it must never rebuild, clear, or resume the shared session.
	// For callers with no identity to compare (AskClaude) the old conservative
	// length-based guard still applies (shorter priors = another owner). A
	// proven SAME owner (same sessionId) skips the guard entirely: a tool
	// continuation / steer on a live query that arrives with shortened priors
	// is that owner pruning its own history and must rebuild importing retained
	// priors.
	// A proven-foreign caller is isolated UNCONDITIONALLY — even while a
	// needsRebuild is pending. needsRebuild can be marked while the owner's
	// query is still live (steer-missed, /compact, /tree, abort), and a
	// background subagent continuation can dispatch into that window; without
	// this gate the child would take the rebuild/clear path, delete the
	// owner's live session file (or null the shared state), and adopt its own
	// ownerSessionId onto shared state. A proven SAME owner skips the guard
	// entirely so its legitimate needsRebuild rebuild still happens.
	if (sharedSession && !sameOwner
		&& (foreignOwner || (!sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor))) {
		// Real child WITH priors of its own: it still gets its own isolated
		// ephemeral session, but the priors it holds are imported into it (they
		// are that child's authoritative conversation) instead of being dropped —
		// the old behavior resumed nothing and served the turn with no history.
		if (priorMessages.length > 0) {
			const ephemeral = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, ...(modelId ? { model: modelId } : {}) });
			convertAndImportMessages(ephemeral, priorMessages, customToolNameToSdk);
			ephemeral.save();
			verifyWrittenSession(ephemeral.jsonlPath, ephemeral.sessionId, ephemeral.records.length, cwd);
			debug(`Case 1 synthetic: ephemeral isolated session ${ephemeral.sessionId.slice(0, 8)} importing ${priorMessages.length} own priors, shared session ${sharedSession.sessionId.slice(0, 8)} preserved (cursor=${sharedSession.cursor})`);
			debug(`syncResult: path=isolated-ephemeral sessionId=${ephemeral.sessionId} priors=${priorMessages.length}`);
			return { sessionId: ephemeral.sessionId, preserveSharedSession: true };
		}
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${history.length} total messages`);
		debug(`syncResult: path=clean-start`);
		// Root rewind: zero retained priors start a genuinely fresh history, so the
		// old session state (cursor, fingerprint) must not survive for the max()
		// carryover in the completion handler — a stale max(oldCursor, newLen) is
		// exactly the stale-cursor defect that made later short turns resume an unrelated
		// longer CC session.
		const clearOwnState = sameOwner
			// The pending-rebuild term is owner-gated: a foreign caller must never
			// clear shared state even when the owner left a needsRebuild pending (the
			// foreign path is unreachable here — the guard above isolates it — but
			// the gate is stated at the owner of the rule, not relied on accidentally).
			|| (sharedSession !== null && Boolean(sharedSession.needsRebuild) && !foreignOwner);
		if (sharedSession && clearOwnState) {
			// Same owner (tool continuation or a pending rebuild on this conversation)
			// arriving with an empty history: the owner root-rewound — same rebuild
			// semantics as any other pruning. Dropping the whole state clears the
			// stale cursor AND fingerprint; the completion handler replaces it from
			// capturedSessionId.
			debug(`Case 1: root rewind — clearing stale session state ${sharedSession.sessionId.slice(0, 8)} (cursor ${sharedSession.cursor}) on clean start`);
			sharedSession = null;
		}
		// Otherwise (another owner — child / AskClaude shared-resume, shared state
		// intact): preserveSharedSession so the completion handler discards the
		// ephemeral session and keeps the shared state.
		return { sessionId: null, preserveSharedSession: Boolean(sharedSession) && !clearOwnState ? true : undefined };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : [];
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	session.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd, fingerprint: fingerprintProjectedPriors(priorMessages).hash, ...(ownerSessionId !== undefined ? { ownerSessionId } : {}) };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// @internal
export const __test = {
	resetSharedSession() {
		sharedSession = null;
	},
	setSharedSession(state: SessionState | null) {
		sharedSession = state;
	},
	getSharedSession() {
		return sharedSession;
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
	},
	toBridgeContext,
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers,
	branchSummaryOutcome,
	applyMidToolChanges,
	fingerprintProjectedPriors,
	reconstructCompletedSession,
	get promptCaptures() {
		return promptCaptures;
	},
};

// --- Provider helpers: tool name mapping ---

// AskClaude path: CC runs its own tools, so builtin names are real.
function mapToolName(name: string): string {
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
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
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
function mapToolArgs(
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

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
let piMode: ExtensionContext["mode"] | null = null;
const activeQueryContexts = new Set<QueryContext>();

// Defaults that silently cost the user something (no Opus 1M on Max, no
// AskClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot. One process-wide instance, shared
// across every extension module instance: isolated subagents re-evaluate this
// module, and the pinned stream they all route through resolves against it.
const promptCaptures = sharedPromptCaptures((diagnostic) => {
	const first = diagnostic.matches[0];
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}

/** What pi's branch summary means for the navigation it was asked for.
 *
 *  Cancelling on failure matches pi's own path, which rethrows a summary error out
 *  of the navigation rather than moving without one. Separated from the event
 *  handler so this decision is testable without a Claude Code subprocess — driving
 *  `generateBranchSummary` itself would only be testing pi. */
function branchSummaryOutcome(result: BranchSummaryResult): { cancel: true } | { summary: { summary: string; details: unknown; usage?: BranchSummaryResult["usage"] } } {
	if (result.aborted) return { cancel: true };
	if (result.error) throw new Error(result.error);
	debug(`session_before_tree: takeover complete summaryLen=${result.summary?.length ?? 0}`);
	return {
		summary: {
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
			usage: result.usage,
		},
	};
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
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
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
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

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately from output tokens.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) output.usage.reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

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
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	if (c.turnOutput.stopReason === "error") {
		stream!.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream!.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		// Still open from an earlier message_start: Claude Code gave up on that
		// stream and is retrying it. Its blocks were never completed.
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") c.turnStreamOpen = false;

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

/** Remove the blocks a stream Claude Code abandoned mid-message. They never got a
 *  message_stop, so a thinking block has no signature and a tool call is one CC will
 *  never dispatch; left in, pi would run the tool and the turn would wait on a
 *  handler that never comes, or the next request would replay a broken block.
 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
 *  rejects a repeated start, so it would need a change there to drive this provider. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks
// again without streaming ("Error streaming, falling back to non-streaming mode"),
// and the answer arrives as one assistant message, under a new message id, with no
// stream_events of its own. turnSawStreamEvent is already set by the dead stream,
// so gating on it alone dropped that message: its tool calls never reached pi, CC
// sat in the MCP handler waiting for their results, and the turn hung on "Working"
// until the user aborted it.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	if (c.turnSawStreamEvent) {
		// Same id was already delivered; a new id is CC's non-streaming fallback.
		// Drop the stalled stream's partial blocks if it never stopped. Deliberately
		// deliver even if it stopped, at the risk of duplication if CC renumbers it.
		const id = assistantMsg.id;
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
	}
	c.turnToolCallIds = [];
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.promptStream?.end();
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info?.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
				// The "rate limited" notice below supersedes warnings; re-arm so the next
				// window's warnings fire even if it opens straight into allowed_warning.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
				// resetsAt is Unix seconds, not milliseconds.
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
				piUI?.notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
			} else if (info?.status === "allowed") {
				// Back under the threshold (window reset) — re-arm the warning dedupe.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
			} else if (info?.status === "allowed_warning") {
				// utilization is a fraction (0..1); allowed_warning fires once it crosses surpassedThreshold.
				const percent = Math.round((info.utilization ?? 0) * 100);
				// The SDK emits one event per request, so only re-notify when the level
				// rises past a new 5% step or the threshold changes.
				const step = Math.floor(percent / 5);
				const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
				if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
					queryCtx.lastRateLimitWarnStep = step;
					queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
					piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
				}
			}
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
					// The failure itself was recorded above the guard, along with the served
					// context window. What is left here is the success path: push the result
					// text when no assistant message already delivered it.
					if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it and the stored fingerprint covers content that was never delivered to CC.
 *  Fingerprint-based sync would catch the content mismatch at the next sync,
 *  but the explicit needsRebuild flag marks the definite case now instead of
 *  paying the divergence until then — the rebuild re-imports the message
 *  directly from pi's context. */
function steerMissedSession(text: string): void {
	if (!sharedSession) return;
	sharedSession = { ...sharedSession, needsRebuild: true };
	debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
/** Query handle shape we only use through the streaming-input setter surface
 *  (sdk.d.ts:2843 Query). Narrowly typed so tests can substitute a stub. */
interface MidToolQueryHandle {
	setModel(model?: string): Promise<void>;
	applyFlagSettings(settings: { [k: string]: unknown }): Promise<void>;
}

/** Per-context last model/effort applied to the running CC query, for the
 *  mid-tool change detection at the tool-result boundary. Implemented as a
 *  WeakMap so QueryContext stays free of streaming-minute state it does not
 *  otherwise need. */
const midToolAppliedState = new WeakMap<QueryContext, { model: string; effort?: string }>();

/** Apply mid-tool model/effort changes to a live CC query (small staged
 *  subset).
 *
 *  Pi re-supplies model and reasoning effort on every provider callback. On a
 *  tool continuation the CC subprocess is mid-turn, so a change goes through
 *  the documented setModel()/applyFlagSettings() streaming-input setters
 *  (sdk.d.ts:2887-2944 — applyFlagSettings({effortLevel}); NEVER the
 *  deprecated setMaxThinkingTokens). When the change cannot be applied — the
 *  query is not a live streaming-input handle, or the setter rejects — a
 *  WARNING lands in the debug log and the turn continues; silently dropping a
 *  model change is exactly the divergence this diagnostic exists to surface.
 *  Returns a promise so tests can await the outcome; the production caller
 *  fires it detached.
 */
async function applyMidToolChanges(
	c: QueryContext,
	desired: { model: string; effort?: string },
): Promise<void> {
	const applied = midToolAppliedState.get(c);
	if (applied && applied.model === desired.model && applied.effort === desired.effort) return;
	const q = c.activeQuery as MidToolQueryHandle | null;
	if (!q || typeof q.setModel !== "function" || typeof q.applyFlagSettings !== "function") {
		debug(`WARNING: mid-tool state change could not be applied — no live streaming-input query (model=${desired.model} effort=${desired.effort ?? "default"}); the change takes effect on the next fresh query`);
		midToolAppliedState.set(c, { ...desired });
		return;
	}
	try {
		if (!applied || applied.model !== desired.model) {
			await q.setModel(desired.model);
			debug(`provider: mid-tool setModel(${desired.model}) applied to running query`);
		}
	} catch (error) {
		debug(`WARNING: mid-tool setModel(${desired.model}) failed:`, error);
	}
	try {
		if (desired.effort && (!applied || applied.effort !== desired.effort)) {
			await q.applyFlagSettings({ effortLevel: desired.effort });
			debug(`provider: mid-tool applyFlagSettings(effortLevel=${desired.effort}) applied to running query`);
		}
	} catch (error) {
		debug(`WARNING: mid-tool applyFlagSettings(effortLevel=${desired.effort}) failed:`, error);
	}
	midToolAppliedState.set(c, { ...desired });
}

/** Mid-tool wrapper: derive the desired model/effort from pi's callback state
 *  and apply. Called detached at the tool-result boundary — delivery of tool
 *  results must not wait on CC's control plane. */
function applyMidToolQueryState(
	c: QueryContext,
	model: Model<any>,
	options: SimpleStreamOptions | undefined,
): void {
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const mapped = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
	const effort = options?.reasoning
		? mapped === undefined
			? REASONING_TO_EFFORT[options.reasoning]
			: VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined
		: undefined;
	void applyMidToolChanges(c, { model: cliModel, effort });
}

async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	showStartupNoticeOnce();
	// pi hands providers a transcript (prompt/tools folded into system messages) — fold it
	// back out to the prompt/tools fields every cursor write, syncSharedSession call and
	// prompt-capture lookup below assumes (issue #106).
	context = toBridgeContext(context);

	// Dedicated summary calls also arrive HERE, not only via isolatedStreamFn: /bug report
	// (summarizeForBugReport) routes through agent.streamFunction -> streamSimple, with no
	// takeover hook. Route on the positive purpose discriminator (pi 0.87.1 summary shapes,
	// version-pinned above) — NOT on the cacheRetention flag, which is a cache preference
	// (pi-ai types.d.ts:132-136) that ordinary no-cache inference also carries; a flag-only
	// route here destroyed history/tools for those calls. Their prompt is never recorded by
	// the capture boundaries and resolveOrDerive would throw. They go to the isolated path
	// (separate persistSession:false CC process, no session sync needed).
	if (isDedicatedSummaryCall(context)) {
		debug(`provider: dedicated summary call routed to isolated summary, msgs=${context.messages.length}, cacheRetention=${options?.cacheRetention ?? ""}`);
		return isolatedStreamFn(model, context, options);
	}
	if (options?.cacheRetention === "none") {
		// Ordinary no-cache inference (first turn, multi-turn, tool-result continuation):
		// keep the normal path with full history and tools. Logged so unrecognized future
		// shapes are visible instead of silently reclassified either way.
		debug(`provider: cacheRetention none without a known summary shape — ordinary path, msgs=${context.messages.length}`);
	}

	const stream = createAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		resultCtx.resetTurnState(model);
		// Mid-tool state changes (small staged subset): pi re-derives model
		// and effort at this turn boundary (PI/dist/core/agent-session.js:379-413
		// supplies refreshed state each turn); the running CC query used to never
		// hear about them. Apply through the documented streaming-input setters;
		// when the query cannot take them, say so truthfully instead of silently
		// dropping the change. NOT applied here: tools/prompt/history rebase
		// (full boundary rebase remains out of scope) and setMcpServers.
		applyMidToolQueryState(resultCtx, model, options);
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		if (sharedSession && resultCtx === ctx()) {
			// Cursor writes ride a fingerprint refresh — the stored fingerprint is
			// always the digest of the history prefix the cursor points at, so the
			// next sync compares content, not just counts.
			sharedSession.cursor = context.messages.length;
			sharedSession.fingerprint = fingerprintProjectedPriors(nonSystemMessages(context.messages)).hash;
		}
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (sharedSession && activeQueryContexts.size === 0) {
			sharedSession.cursor = context.messages.length;
			sharedSession.fingerprint = fingerprintProjectedPriors(nonSystemMessages(context.messages)).hash;
		}
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt throws, and doing that before
	// anything is claimed or reset leaves no half-built query behind — in particular
	// no stream claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	// Derive the key from the transcript replay (toBridgeContext), NOT from the
	// recorded keys: under a forced prompt the transcript head is projected via
	// transformContext after turn_start, so ctx.getSystemPrompt() is not the head.
	const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
	const systemPromptAppend = promptCapture
		? projectPromptCapture(promptCapture, {
			skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
		})
		: undefined;

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const cwd = process.cwd();
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	// Ownership: pi's session id rides on every stream call (StreamOptions
	// .sessionId — pi builds its Agent with sessionId from the session manager
	// and the agent loop forwards it). This — NOT "a query is active somewhere"
	// — is the same-owner signal: a subagent child dispatched while this query
	// is live carries a DIFFERENT sessionId and must be treated as a foreign
	// owner, while this session's own mid-query calls match. activeQuery only
	// routes per-query state (QueryContext); it cannot discriminate owner.
	const ownerSessionId = options?.sessionId;
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, ownerSessionId);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sharedSession ? { sessionId: sharedSession.sessionId.slice(0, 8), cursor: sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
	// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
	// ships a map for most Claude models; the table below covers models without
	// one, and the levels a map leaves unnamed. A null entry means the level is
	// unsupported on that model: no effort argument is sent, so Claude Code's own
	// default applies rather than the generic table's value. Map values are
	// provider-generic strings, so a map value is trusted only when it names a
	// level CC accepts.
	const mapped = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
	const effort = options?.reasoning
		? mapped === undefined
			? REASONING_TO_EFFORT[options.reasoning]
			: VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined
		: undefined;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = { ...process.env, ...CC_CHILD_ENV };
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on 		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		// AskClaude keeps CC's native tools and its guidance — unaffected.
		settings: {
			...claudeCodeSettings(providerSettings),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
			// Pi executes tools — the provider child runs with tools: [] — so hooks
			// configured in the same settings.json files that legitimately supply
			// env/apiKeyHelper must not fire commands inside the CC child. Managed
			// (policy) hooks stay enabled (sdk.d.ts:4133-4151); this is not a
			// complete sandbox. AskClaude keeps native tools and does not set this.
			disableAllHooks: true,
		},
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
			// SDK records the first prompt when snapshot is omitted/true and ignores
			// later append changes until compaction/new session — stale for a bridge
			// that re-invokes CC per turn. Render fresh instead.
			snapshot: false,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
	// Seed the mid-tool change detector: the query was started WITH this/effort, so
	// the first tool-continuation comparison starts from reality, not omission.
	midToolAppliedState.set(queryCtx, { model: cliModel, effort });
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			const sessionId = capturedSessionId ?? sharedSession?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== sharedSession?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, sharedSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}${sharedSession?.needsRebuild ? ", preserving pending needsRebuild" : ""}`);
				sharedSession = reconstructCompletedSession(
					sharedSession,
					sessionId,
					cursor,
					cwd,
					nonSystemMessages(context.messages),
					options?.sessionId,
				);
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if ((wasAborted || options?.signal?.aborted) && sharedSession) {
				sharedSession = { ...sharedSession, needsRebuild: true, forceRotate: true };
			} else {
				sharedSession = null;
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

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
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
		} else {
			// No provider session yet — create one from pi's context.
			// ownerSessionId: omitted, deliberately. AskClaude from a pi tool
			// execution is by construction a DIFFERENT owner from the provider's
			// conversation (it spawns its own CC process reading the shared context,
			// and its result is not replayed into the shared history), so no session
			// identity is claimed: the shortened-priors isolation guard stays armed
			// (unknown owner = conservative length-based guard) and any state this
			// sync creates carries no ownerSessionId, so the provider's next call
			// never treats it as its own without a fingerprint match. When there is
			// no shared session at all, the guard cannot matter (sync sees none).
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, cliModel);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode];

	// AskClaude uses Claude Code's native Read tool rather than Pi's MCP bridge.
	// Same resolver as the provider path: a prompt neither recorded nor derivable
	// throws here too, rather than silently sending Claude Code no skills.
	//
	// Resolved only when the answer would be used. The throw is justified by what a
	// miss would cost, so where it costs nothing — skills switched off, or no reader
	// to open a skill file with — an unrelated miss must not fail the call.
	const skillReadTool = disallowedTools.includes("Read") ? "none" : "native";
	const skillCapture = options?.appendSkills !== false && skillReadTool !== "none"
		? promptCaptures.resolveOrDerive(options?.systemPrompt)
		: undefined;
	const skillsBlock = skillCapture
		? renderSkillsBlock(collectPromptSkills(skillCapture), skillReadTool)
		: undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

	// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming every
	// skill under the ~/.claude estate. The provider path gets this for free — `tools: []`
	// removes the Skill tool and the listing with it — but AskClaude runs on CC's native
	// tools, so it has to be asked for. Pi-side skills still arrive via skillsBlock below,
	// which is meant to be the only channel.
	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ...CC_CHILD_ENV },
			permissionMode: "bypassPermissions",
			settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
			skills: [],
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			// Preset unconditionally: omitting it leaves the child on the SDK's bare default,
			// without the tool and permission guidance the bridge relies on everywhere else.
			// Whether pi has skills to append is unrelated to whether the child needs that.
			systemPrompt: { type: "preset", preset: "claude_code", append: skillsBlock },
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude"),
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
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
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
								name: mapToolName(block.name),
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
					}
					// Claude Code reports an API failure with `is_error` on a result whose
					// subtype is still "success", so without this the error text was returned
					// as Claude's answer and pi's model read a 429 as content. Throwing hands
					// it to the tool's own catch, which renders it as an error result.
					const failure = wasAborted ? undefined : resultErrorText(message);
					if (failure) throw new Error(failure);
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);
	if (registeredModels.length === 0) {
		console.error("claude-bridge: no models available from pi-ai's anthropic catalog — update @earendil-works/pi-ai (requires >=0.86.1)");
	}

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined) pendingNotices.push('Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.');
		if (config.askClaude?.enabled === undefined) pendingNotices.push("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		sharedSession = null;

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piMode = ctx.mode;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/guidelines/sections) are pi config,
	// stable across a turn; only the auto-generated tool list in the rendered prompt
	// varies. Stash them at before_agent_start so the agent_start recording below can
	// reuse them.
	// pi-owned tools are excluded from snippet/guideline restore: their text describes
	// pi's builtin/SDK tooling, which the Claude Code child does not run. Extension
	// tools are what the append projection restores.
	// Computed lazily: getAllTools needs a live session, first reached at the first
	// before_agent_start — and if it is unavailable there, nothing is filtered rather
	// than losing the record (the restores are additive text and still pass the
	// extraction guard).
	let piOwnedToolNames: Set<string> | undefined;
	const extensionOnly = <V>(map: Record<string, V> | undefined): Record<string, V> | undefined => {
		if (!map) return undefined;
		if (!piOwnedToolNames) {
			piOwnedToolNames = new Set();
			try {
				for (const tool of pi.getAllTools()) {
					if (tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk") {
						piOwnedToolNames.add(tool.name);
					}
				}
			} catch (error) {
				debug(`prompt-capture: getAllTools unavailable, not filtering tool snippets/guidelines: ${error}`);
			}
		}
		const result = Object.fromEntries(Object.entries(map).filter(([name]) => !piOwnedToolNames!.has(name)));
		return Object.keys(result).length > 0 ? result : undefined;
	};
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(source: string, systemPrompt: string | undefined, options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		contextFiles?: { path: string; content: string }[];
		skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
		selectedTools?: string[];
		promptGuidelines?: string[];
		toolSnippets?: Record<string, string>;
		toolGuidelines?: Record<string, string[]>;
		sections?: Record<string, string>;
		forceSystemPrompt?: string;
	} | undefined) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
			promptGuidelines: options?.promptGuidelines,
			toolSnippets: extensionOnly(options?.toolSnippets),
			toolGuidelines: extensionOnly(options?.toolGuidelines),
			sections: options?.sections,
			forced: options?.forceSystemPrompt ? "forceSystemPrompt" : undefined,
		}, source);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("session_shutdown", () => {
		reportLeaks("session_shutdown");
		clearSession("session_shutdown");
	});

	// Compaction ownership: yield. pi 0.87.1 runs session_before_compact handlers
	// sequentially in extension load order and the last truthy return wins, so this
	// hook returning a compaction result could overwrite an earlier extension's
	// compiled summary, and {cancel:true} on the old failure path could discard
	// that completed summary. Returning undefined lets another handler's result
	// stand when it produced one; when no handler provides a result, native
	// compaction runs
	// through the agent stream fn and is safe on a bridge model: pi's native compaction
	// summary prompt matches the dedicated-summary discriminator and the provider routes
	// it to the isolated CC summary path (streamClaudeAgentSdk below) — appended to the
	// claude_code preset there, keeping automatic summaries on the same subscription lane
	// as ordinary turns — the same fence /bug
	// summarization already goes through.
	//
	// The takeover did carry one real fix worth keeping: pi's native
	// extractFileOperations skips prior-compaction details when the session entry
	// was written by an extension (fromHook:true), so on a session whose previous
	// compaction came from an extension, the cumulative <read-files>/<modified-files> lists would restart
	// empty. Re-inject them as a pre-mutation of event.preparation before
	// yielding. Native compact() and later hooks see these sets. A handler that
	// ran earlier has already compiled its summary and cannot inherit this mutation.
	// This mutates only this dispatch's preparation, not persisted prior entries.
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: yield reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
		return undefined;
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		if (sharedSession) {
			debug(`${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event) => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => markRebuild("session_tree"));

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary. Like native compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Keep the branch-summary takeover: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: isolatedStreamFn,
			});
			return branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(
				`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, any>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		// Cast: the Provider interface passes a TranscriptContext; the bridge takes plain
		// Context models (toBridgeContext normalizes at the stream entry points).
		streamSimple: streamClaudeAgentSdk as any,
	};
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		debug(`provider: deferring registration decision to session_start (module=${moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getProvider(PROVIDER_ID)) {
				debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${moduleInstanceId})`);
				return;
			}
			debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${moduleInstanceId})`);
			pi.registerProvider(PROVIDER_ID, providerConfig);
		});
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const askDefaults = resolveAskClaudeDefaults(askConf);
	askClaudeToolName = askConf?.name ?? "AskClaude";

	if (askConf?.enabled) {
		const askClaudeParams = buildAskClaudeParams(askDefaults);
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askClaudeToolDescription(askDefaults, askConf?.description),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const tags = askClaudeCallTags(args, askDefaults);
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
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = resolveAskClaudeMode(params.mode, askDefaults);
				const isolated = params.isolated ?? askDefaults.isolated;
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
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
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
					debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
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
