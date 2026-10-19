// Standalone prompts: one-turn side calls another extension makes through the session
// model (a permission classifier, a title generator), marked with
// `metadata.promptKind: "standalone"`. Their system prompt never passed a capture
// boundary, so it goes to Claude Code verbatim instead of projected onto the
// claude_code preset. No shared session, no QueryContext: pi's agent turn is untouched.
//
// Tools are advertised but never run. With `maxTurns: 1` Claude Code dispatches the
// turn's tool calls to a stub handler and then stops before a second model call, so
// the stub's result never reaches the model; the calls go back to pi as toolCall blocks.

import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { messageContentToText } from "./convert.js";
import { createToolServer } from "./mcp-server.js";
import { assertSendable, type PromptPart } from "./sendable.js";
import { userMessage } from "./prompt-stream.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { updateUsage } from "./usage.js";

const STANDALONE_PROMPT_KIND = "standalone";

const NOT_EXECUTED = "Not executed: this tool call is returned to the caller.";

export function isStandalonePrompt(options?: SimpleStreamOptions): boolean {
	return options?.metadata?.promptKind === STANDALONE_PROMPT_KIND;
}

/** What the route borrows from index.ts. `spawnOptions` carries the per-call fields
 *  index.ts owns (cwd, env, model, effort, executable, debug). */
export type StandaloneDeps = {
	query: typeof query;
	spawnOptions: Options;
	/** The user turn as content blocks when it carries images, else as text. */
	prompt: (messages: Context["messages"]) => string | ContentBlockParam[];
	newOutput: (stopReason: AssistantMessage["stopReason"], errorMessage?: string) => AssistantMessage;
	resultError: (message: SDKMessage) => string | undefined;
	debug: (...args: unknown[]) => void;
};

export async function runStandalone(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	deps: StandaloneDeps,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const messages = userTurn(context);
		assertSendable(promptParts(context.systemPrompt, messages), "standalone prompt", []);
		const prompt = deps.prompt(messages);
		const tools = context.tools ?? [];
		const piNameFor = new Map(tools.map((tool) => [`${MCP_TOOL_PREFIX}${tool.name}`, tool.name]));
		const mcpServers = tools.length
			? {
				[MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.parameters,
					handler: async (toolCallId: string) => ({ toolCallId, content: [{ type: "text" as const, text: NOT_EXECUTED }], isError: true }),
				}))),
			}
			: undefined;
		deps.debug(`standalone: spawn model=${model.id} msgs=${messages.length} tools=${tools.length} systemPromptLen=${context.systemPrompt?.length ?? 0}`);

		sdkQuery = deps.query({
			prompt: typeof prompt === "string" ? prompt : (async function* () { yield userMessage(prompt); })(),
			options: {
				...deps.spawnOptions,
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt ?? "",
				permissionMode: "bypassPermissions",
				maxTurns: 1,
				...(mcpServers ? { mcpServers } : {}),
			},
		});
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const output = deps.newOutput("stop");
		let errorText: string | undefined;
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "text" && block.text) {
						output.content.push({ type: "text", text: block.text });
					} else if (block.type === "tool_use") {
						const name = piNameFor.get(block.name);
						if (name) output.content.push({ type: "toolCall", id: block.id, name, arguments: (block.input ?? {}) as ToolCall["arguments"] });
						else deps.debug(`standalone: skipping tool_use for unserved tool ${block.name}`);
					}
				}
			} else if (message.type === "result") {
				updateUsage(output, message.usage, model);
				const sawToolCall = output.content.some((block) => block.type === "toolCall");
				// maxTurns stops the query right after the tool calls dispatch, which is the success case here.
				if (!(sawToolCall && message.subtype === "error_max_turns")) errorText = deps.resultError(message);
				if (sawToolCall) output.stopReason = "toolUse";
				// The SDK throws after an error result, so stop at the first one.
				break;
			}
		}

		if (wasAborted) {
			deps.debug("standalone: aborted");
			stream.push({ type: "error", reason: "aborted", error: deps.newOutput("aborted", "Operation aborted") });
		} else if (errorText || output.content.length === 0) {
			const msg = errorText ?? "Claude Code returned no text or tool call";
			deps.debug(`standalone: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: { ...output, stopReason: "error", errorMessage: msg } });
		} else {
			deps.debug(`standalone: done stopReason=${output.stopReason} blocks=${output.content.length}`);
			pushReply(stream, output);
		}
		stream.end();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		deps.debug("standalone: threw; pushing terminal error", err);
		stream.push({ type: "error", reason: wasAborted ? "aborted" : "error", error: deps.newOutput(wasAborted ? "aborted" : "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

/** The messages as one user turn. Anything else is a conversation, which belongs on
 *  the captured agent path. */
function userTurn(context: Context): UserMessage[] {
	const roles = context.messages.map((message) => message.role);
	if (roles.length === 0 || roles.some((role) => role !== "user")) {
		throw new Error(
			`standalone prompt: expected one or more user messages and nothing else, got [${roles.join(",")}]`,
		);
	}
	return context.messages as UserMessage[];
}

function promptParts(systemPrompt: string | undefined, messages: UserMessage[]): PromptPart[] {
	const parts: PromptPart[] = systemPrompt ? [{ label: "the system prompt", text: systemPrompt }] : [];
	messages.forEach((message, index) => {
		parts.push({ label: `user message ${index + 1}`, text: messageContentToText(message.content) });
	});
	return parts;
}

function pushReply(stream: AssistantMessageEventStream, output: AssistantMessage): void {
	stream.push({ type: "start", partial: output });
	output.content.forEach((block, contentIndex) => {
		if (block.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: (block as TextContent).text, partial: output });
			stream.push({ type: "text_end", contentIndex, content: (block as TextContent).text, partial: output });
		} else if (block.type === "toolCall") {
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
	});
	stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
}
