// AskClaude: a pi tool that delegates a question or task to Claude Code, which
// runs its own tools. A separate package from the pi-claude-bridge provider; the
// helpers it shares with the provider are copies, in claude-code.ts.

import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, formatSkillsForPrompt, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { query, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { createSession, deleteSession } from "cc-session-io";
import { Type } from "typebox";
import {
	CLAUDE_MD_EXCLUDES, ccChildEnv, convertPiMessages, debug, errorMessage, loadProviderSettings, makeCliDebugOptions,
	QueryProcess, REASONING_TO_EFFORT, resultErrorText, type ProviderSettings,
} from "./claude-code.js";
import { buildActionSummary, type ToolCallState } from "./ui.js";

type AskClaudeMode = "full" | "read" | "none";

// Mode presets — which CC tools are blocked per mode. Only block tools that
// can't work (no pi TUI for user interaction). Other CC tools (Agent,
// SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
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

// The pi tools whose names match a Claude Code builtin. CC runs its own tools
// here, so pi's calls to these replay under the builtin's name; every other pi
// tool gets an MCP name CC doesn't have either way.
const ASKCLAUDE_TOOL_NAMES = new Map(Object.entries({ read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep" }));

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const askClaudeParams = Type.Object({
	prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the recorded conversation history. Don't research up front, let Claude explore." }),
	mode: Type.Optional(StringEnum(["read", "full", "none"] as const, {
		description: '"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access). "full": allows writing and bash execution (careful: runs without feedback to pi).',
	})),
	model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
	isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the recorded conversation history." })),
});

const ASKCLAUDE_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. "
	+ "Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself. "
	+ "Not available when the active provider is claude-bridge.";

function callTags(args: { mode?: AskClaudeMode; model?: string; thinking?: string; isolated?: boolean }): string[] {
	const tags: string[] = [];
	if (args.mode && args.mode !== "read") tags.push(`mode=${args.mode}`);
	if (args.model) tags.push(`model=${args.model}`);
	if (args.thinking) tags.push(`thinking=${args.thinking}`);
	if (args.isolated) tags.push("isolated");
	return tags;
}

function preview(text: string): { lines: string[]; truncated: boolean } {
	const lines = text.slice(0, PREVIEW_MAX_CHARS).split("\n").slice(0, PREVIEW_MAX_LINES);
	return { lines, truncated: text.length > PREVIEW_MAX_CHARS || text.split("\n").length > PREVIEW_MAX_LINES };
}

// The SDK's query(), or a test double (see setQuery).
let queryImpl: typeof query = query;

/** Run one Claude Code query and return its answer. With `history`, CC resumes a
 *  fresh session imported from it, deleted once the child exits; without, it
 *  sees only the prompt and writes nothing. */
async function promptAndWait(
	prompt: string,
	mode: AskClaudeMode,
	toolCalls: Map<string, ToolCallState>,
	signal: AbortSignal | undefined,
	options: {
		cwd: string;
		provider?: ProviderSettings;
		skills?: Skill[];
		model?: string;
		thinking?: string;
		history?: Message[];
	},
): Promise<string> {
	const { cwd } = options;
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode];
	if (!disallowedTools) throw new Error(`Invalid AskClaude mode: ${String(mode)}`);
	const model = options.model ?? "opus";
	const effort = options.thinking && options.thinking !== "off" ? REASONING_TO_EFFORT[options.thinking] : undefined;
	// Skills are offered only when CC has a Read tool to open them with.
	const skillsBlock = disallowedTools.includes("Read") ? undefined : formatSkillsForPrompt(options.skills ?? []).trim() || undefined;
	const claudeExecutable = options.provider?.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = effort ? { "thinking-display": "summarized" } : {};

	const cliDebug = makeCliDebugOptions("askclaude");
	const childProcess = new QueryProcess(cliDebug.stderr);
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		sdkQuery?.close();
		childProcess.close();
	};

	let responseText = "";
	let sdkMessageCount = 0;
	let resultSubtype: string | undefined;
	let sessionId: string | undefined;
	try {
		// Written before the query so CC resumes it. The branch ends with the assistant
		// turn holding this call: importMessages stubs its missing result, and
		// ccChildEnv keeps CC from treating that as an interrupted turn to continue.
		if (options.history) {
			const session = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model });
			sessionId = session.sessionId;
			session.importMessages(convertPiMessages(options.history, ASKCLAUDE_TOOL_NAMES));
			session.save();
		}

		debug("askClaude:",
			`mode=${mode} model=${model} effort=${effort ?? "default"}`,
			`history=${options.history?.length ?? "isolated"} resume=${sessionId?.slice(0, 8) ?? "none"}`,
			`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`);

		sdkQuery = queryImpl({
			prompt,
			options: {
				cwd,
				env: ccChildEnv(),
				permissionMode: "bypassPermissions",
				settings: { autoMemoryEnabled: options.provider?.autoMemoryEnabled ?? false, claudeMdExcludes: CLAUDE_MD_EXCLUDES },
				// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming
				// every skill under the ~/.claude estate. Pi-side skills arrive via skillsBlock,
				// which is meant to be the only channel.
				skills: [],
				disallowedTools,
				...(effort ? { effort } : {}),
				// Preset unconditionally: omitting it leaves the child on the SDK's bare default,
				// without its tool and permission guidance.
				systemPrompt: { type: "preset", preset: "claude_code", append: skillsBlock },
				// User settings only. A repo's .claude/settings.json can carry hooks, apiKeyHelper,
				// env and plugins, which would run with no prompt; Bedrock/Vertex users keep env and
				// apiKeyHelper in ~/.claude/settings.json.
				settingSources: ["user"] as SettingSource[],
				model,
				strictMcpConfig: true,
				extraArgs,
				...(sessionId ? { resume: sessionId } : { persistSession: false }),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...cliDebug,
				spawnClaudeCodeProcess: childProcess.spawn,
			},
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }

		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;
			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
					}
					// Tool call start → track for the progress line
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, { name: event.content_block.name, status: "running" });
					}
					break;
				}
				case "assistant": {
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, { name: block.name, status: "complete", rawInput: block.input });
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
					// subtype is still "success"; returned as text, pi's model would read a
					// 429 as Claude's answer.
					const failure = wasAborted ? undefined : resultErrorText(message);
					if (failure) throw new Error(failure);
					if (!responseText && message.subtype === "success" && message.result) responseText = message.result;
					break;
				}
			}
		}
		debug("askClaude: done",
			`aborted=${wasAborted} resultSubtype=${resultSubtype ?? "none"} sdkMessages=${sdkMessageCount}`,
			`responseLen=${responseText.length} toolCalls=${toolCalls.size}`);
		return responseText;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// A query constructor can throw after spawning, leaving no handle to close.
		if (sdkQuery) sdkQuery.close();
		else childProcess.terminate();
		childProcess.close();
		await childProcess.exited;
		if (sessionId) deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
}

// @internal
export const __test = {
	setQuery(fn: typeof query | null) {
		queryImpl = fn ?? query;
	},
	promptAndWait,
};

export default function (pi: ExtensionAPI) {
	const provider = loadProviderSettings();
	// Per factory call, so each pi session keeps its own. Every run fires
	// before_agent_start before any tool executes, so it is current when used.
	// The options object, not its skills: later handlers can still replace them.
	let promptOptions: { skills: Skill[] } | undefined;
	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
	});

	pi.registerTool({
		name: "AskClaude",
		label: "Ask Claude Code",
		description: ASKCLAUDE_DESCRIPTION,
		parameters: askClaudeParams,
		renderCall(args, theme) {
			let text = theme.fg("mdLink", theme.bold("AskClaude "));
			const tags = callTags(args);
			if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
			const { lines, truncated } = preview(args.prompt);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (truncated) text += theme.fg("dim", " …");
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
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
				const { lines, truncated } = preview(body);
				if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (truncated) text += `\n${theme.fg("dim", `… (${context.keyHint("app.tools.expand", "to expand")})`)}`;
			}

			return new Text(text, 0, 0);
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			// Guard: circular delegation. Reachable even though pi only offers the tool
			// to other providers: Claude on a bridge turn sees it, and ctx.executeTool
			// can call it from anywhere.
			if (ctx.model?.baseUrl === "claude-bridge") {
				debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
				return {
					content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
					details: { error: true },
				};
			}

			const mode = params.mode ?? "read";
			const isolated = params.isolated ?? false;
			const toolCalls = new Map<string, ToolCallState>();
			const start = Date.now();

			const progressInterval = setInterval(() => {
				const elapsed = ((Date.now() - start) / 1000).toFixed(0);
				const summary = buildActionSummary(toolCalls);
				onUpdate?.({
					content: [{ type: "text", text: `${elapsed}s — ${summary || "working..."}` }],
					details: { prompt: params.prompt, executionTime: Date.now() - start },
				});
			}, 1000);

			try {
				const responseText = await promptAndWait(params.prompt, mode, toolCalls, signal, {
					cwd: ctx.cwd,
					provider,
					skills: promptOptions?.skills,
					model: params.model,
					thinking: params.thinking,
					// convertToLlm keeps compaction and branch summaries, bash executions and
					// custom messages as user messages.
					history: isolated ? undefined : convertToLlm(buildSessionContext(ctx.sessionManager.getBranch()).messages),
				});
				clearInterval(progressInterval);
				onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
				const actions = buildActionSummary(toolCalls);
				return {
					content: [{ type: "text" as const, text: actions ? `${responseText}\n\n[Claude Code actions: ${actions}]` : responseText }],
					details: { prompt: params.prompt, executionTime: Date.now() - start, actions },
				};
			} catch (err) {
				clearInterval(progressInterval);
				debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
				return {
					content: [{ type: "text" as const, text: `Error: ${errorMessage(err)}` }],
					details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
				};
			}
		},
	});
}
