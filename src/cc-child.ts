// What every Claude Code subprocess the bridge spawns shares: its environment,
// the context-file excludes, the effort mapping and how its failures read.

import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Applied to every Claude Code subprocess the bridge spawns — provider and compact
// summary. One place, so a guard is added once rather than twice, and so a missing
// one is visible. The AskClaude package has its own copy (askclaude/src/claude-code.ts).
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: stop CC (2.1.308+) logging every API request
//   into its session file (`api-request`, `api-request-shape`, `api-request-blob`
//   records). CC never reads them back to build a request; they only make the
//   file about a third larger.
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks, MCP registry or
//   telemetry. Set here, not on pi's process.env, so it doesn't leak into every
//   command pi runs.
// - CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: a resumed session that ends at
//   a tool result (after a terminating tool, or a discarded parked query) reads to CC
//   as an interrupted turn, and behind a server flag CC inserts a "Continue from where
//   you left off." user message ahead of pi's prompt. pi supplies every prompt, so
//   every turn counts as too old to resume.
// - CLAUDE_CODE_SILENT_TURN_REMINDER=0: on Opus 5.5, Fable 5.1, Mythos 5.1 and
//   Sonnet 5.5, CC adds "The user hasn't heard from you in a while..." after 5
//   assistant messages with no visible text. pi decides what the model is told; the
//   message is not in pi's history and the user never sees it.
// - CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH=16384: CC cuts MCP tool descriptions
//   mid-sentence at 4096 chars (16384 for tools loaded through tool search), so long
//   pi tools lost their tail; pi's own providers send them whole. 16384 is CC's own
//   larger limit and still stops a runaway description.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
	CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
	CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "16384",
} as const;

// Set by Claude Code on its own child processes (eXe(), its session-env list and
// hook env in 2.1.308), or exported by that parent. When pi runs inside a Claude Code
// session they describe that session, not ours: the SDK stamps its own entrypoint and
// version only when they're unset, and CC's Bash tool runs CLAUDE_ENV_FILE's script.
// AI_AGENT is left alone: pi overwrites it with "pi" at startup.
const PARENT_SESSION_VARS = [
	"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

// The bridge reads and writes Claude Code's session files through pi's own values of
// these, so a child pointed elsewhere would resume a session the bridge never wrote.
const SESSION_STORAGE_VARS = ["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE"];

// Environment for every Claude Code subprocess. Config (ANTHROPIC_*, CLAUDE_CONFIG_DIR,
// CLAUDE_CODE_USE_BEDROCK, ...) always passes through; parent-session markers are
// dropped only when CLAUDECODE says pi was started from inside Claude Code. `overrides`
// is pi's per-request provider env (a stored credential's `env`, or the caller's), which
// takes precedence over process.env; an empty value removes the variable, since pi's
// auth.json only allows strings. CC_CHILD_ENV goes last so its guards always hold.
export function ccChildEnv(overrides: Record<string, string> = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const storage = Object.keys(overrides).filter((name) => SESSION_STORAGE_VARS.includes(name.toUpperCase()));
	if (storage.length) throw new Error(`claude-bridge: provider env can't set ${storage.join(", ")}; the bridge reads Claude Code's session files through pi's own values`);
	const env: NodeJS.ProcessEnv = { ...parent };
	if (parent.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	for (const [name, value] of Object.entries(overrides)) {
		if (value === "") delete env[name];
		else env[name] = value;
	}
	return { ...env, ...CC_CHILD_ENV };
}

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise project CLAUDE.md/AGENTS.md files arrive twice, and
// ~/.claude/CLAUDE.md — a user persona written for a harness that is not the
// one running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; the filename globs cover user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

// Pi reasoning levels → CC SDK effort levels
export const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. */
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
