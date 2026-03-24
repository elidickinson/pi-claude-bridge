import { calculateCost, createAssistantMessageEventStream, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse, type CreateTerminalRequest, type CreateTerminalResponse, type TerminalOutputRequest, type TerminalOutputResponse, type WaitForTerminalExitRequest, type WaitForTerminalExitResponse, type KillTerminalRequest, type KillTerminalResponse, type ReleaseTerminalRequest, type ReleaseTerminalResponse } from "@agentclientprotocol/sdk";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { relative } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";

const PROVIDER_ID = "claude-code-acp";

const BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "glob"]);
const MCP_SERVER_NAME = "pi-tools";
const MSG_TOOL = "claude-acp-tool";

let piApi: ExtensionAPI | null = null;
const cwd = process.cwd();

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));

// --- Tool partitioning ---

function partitionTools(tools?: Tool[]): { customTools: Tool[] } {
	if (!tools) return { customTools: [] };
	const customTools: Tool[] = [];
	for (const tool of tools) {
		if (!BUILTIN_TOOL_NAMES.has(tool.name.toLowerCase())) {
			customTools.push(tool);
		}
	}
	return { customTools };
}

// --- Prompt building ---

function buildPromptText(context: Context): string {
	const parts: string[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			const text = messageContentToText(message.content);
			parts.push(`USER:\n${text || "(see attached image)"}`);
			continue;
		}

		if (message.role === "assistant") {
			const text = assistantContentToText(message.content);
			if (text.length > 0) {
				parts.push(`ASSISTANT:\n${text}`);
			}
			continue;
		}

		if (message.role === "toolResult") {
			const header = `TOOL RESULT (historical ${message.toolName ?? "unknown"}):`;
			const text = messageContentToText(message.content);
			parts.push(`${header}\n${text || "(see attached image)"}`);
		}
	}

	return parts.join("\n\n") || "";
}

function messageContentToText(
	content:
		| string
		| Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const textParts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
			hasText = true;
		} else if (block.type === "image") {
			// text-only for v1
		} else {
			textParts.push(`[${block.type}]`);
		}
	}
	return hasText ? textParts.join("\n") : "";
}

function assistantContentToText(
	content:
		| string
		| Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				return `Historical tool call (non-executable): ${block.name} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

// --- HTTP bridge for custom tool calls ---

interface PendingToolCall {
	toolName: string;
	args: Record<string, unknown>;
	resolve: (result: string) => void;
}

let bridgeServer: Server | null = null;
let bridgePort: number | null = null;
let pendingToolCall: PendingToolCall | null = null;
let toolCallDetected: (() => void) | null = null;

async function ensureBridgeServer(): Promise<number> {
	if (bridgeServer && bridgePort != null) return bridgePort;

	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}

			let body = "";
			req.on("data", (chunk: Buffer) => { body += chunk; });
			req.on("end", () => {
				try {
					const { toolName, args } = JSON.parse(body);
					pendingToolCall = {
						toolName,
						args: args ?? {},
						resolve: (result: string) => {
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ result }));
						},
					};
					toolCallDetected?.();
				} catch (e) {
					res.writeHead(400);
					res.end("Bad request");
				}
			});
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			bridgeServer = server;
			bridgePort = addr.port;
			resolve(addr.port);
		});
	});
}

// --- MCP server script generation ---

let mcpServerScriptPath: string | null = null;

function generateMcpServerScript(customTools: Tool[], bridgeUrl: string): string {
	const toolSchemas = customTools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));

	// Claude Code uses ndjson (newline-delimited JSON) for MCP stdio, not Content-Length framing
	return `const http = require("http");
const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const TOOLS = ${JSON.stringify(toolSchemas)};

const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try { handleMessage(JSON.parse(line)); } catch {}
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-tools", version: "1.0.0" }
    }});
  } else if (msg.method === "notifications/initialized") {
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS }});
  } else if (msg.method === "tools/call") {
    const toolName = msg.params.name;
    const args = msg.params.arguments || {};
    const postData = JSON.stringify({ toolName, args });
    const url = new URL(BRIDGE_URL);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const { result } = JSON.parse(body);
          send({ jsonrpc: "2.0", id: msg.id, result: {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }]
          }});
        } catch (e) {
          send({ jsonrpc: "2.0", id: msg.id, result: {
            content: [{ type: "text", text: "Error: " + e.message }], isError: true
          }});
        }
      });
    });
    req.on("error", (e) => {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: "Bridge error: " + e.message }], isError: true
      }});
    });
    req.end(postData);
  }
}
`;
}

async function ensureMcpServerScript(customTools: Tool[], bridgeUrl: string): Promise<string> {
	const script = generateMcpServerScript(customTools, bridgeUrl);
	const path = join(tmpdir(), `pi-tools-mcp-${process.pid}.js`);
	await writeFile(path, script, "utf-8");
	mcpServerScriptPath = path;
	return path;
}

// --- Tool result extraction ---

function extractLastToolResult(context: Context): { toolName: string; content: string } | null {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") {
			return {
				toolName: msg.toolName,
				content: messageContentToText(msg.content),
			};
		}
		if (msg.role === "user") break;
	}
	return null;
}

// --- ACP connection management ---

interface TerminalState {
	proc: ChildProcess;
	output: string;
	exitCode?: number | null;
	signal?: string | null;
}

let acpProcess: ChildProcess | null = null;
let acpConnection: ClientSideConnection | null = null;
let sessionUpdateHandler: ((update: SessionUpdate) => void) | null = null;
let activeSessionId: string | null = null;
let activeModelId: string | null = null;
let activePromise: Promise<PromptResponse> | null = null;
let lastContextLength = 0;
let nextTerminalId = 1;
const terminals = new Map<string, TerminalState>();

function handleRequestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
	const allowOption = params.options.find(
		(o) => o.kind === "allow_once" || o.kind === "allow_always",
	);
	if (allowOption) {
		return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
	}
	return { outcome: { outcome: "cancelled" } };
}

async function handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
	const content = await readFile(params.path, "utf-8");
	if (params.line != null || params.limit != null) {
		const lines = content.split("\n");
		const start = Math.max(0, (params.line ?? 1) - 1);
		const end = params.limit != null ? start + params.limit : lines.length;
		return { content: lines.slice(start, end).join("\n") };
	}
	return { content };
}

async function handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
	await mkdir(dirname(params.path), { recursive: true });
	await writeFile(params.path, params.content, "utf-8");
	return {};
}

function handleCreateTerminal(params: CreateTerminalRequest): CreateTerminalResponse {
	const id = `term-${nextTerminalId++}`;
	const args = params.args ?? [];
	const proc = spawn(params.command, args, {
		cwd: params.cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			...(params.env
				? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
				: {}),
		},
	});

	const state: TerminalState = { proc, output: "" };
	terminals.set(id, state);

	proc.stdout?.on("data", (chunk: Buffer) => {
		state.output += chunk.toString();
		if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
			state.output = state.output.slice(-params.outputByteLimit);
		}
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		state.output += chunk.toString();
		if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
			state.output = state.output.slice(-params.outputByteLimit);
		}
	});
	proc.on("close", (code, signal) => {
		state.exitCode = code;
		state.signal = signal;
	});

	return { terminalId: id };
}

function handleTerminalOutput(params: TerminalOutputRequest): TerminalOutputResponse {
	const state = terminals.get(params.terminalId);
	if (!state) return { output: "", truncated: false };
	return {
		output: state.output,
		truncated: false,
		...(state.exitCode !== undefined || state.signal !== undefined
			? { exitStatus: { exitCode: state.exitCode, signal: state.signal } }
			: {}),
	};
}

async function handleWaitForTerminalExit(
	params: WaitForTerminalExitRequest,
): Promise<WaitForTerminalExitResponse> {
	const state = terminals.get(params.terminalId);
	if (!state) return { exitCode: 1 };
	return new Promise((resolve) => {
		state.proc.on("close", (code, signal) => {
			resolve({ exitCode: code, signal });
		});
		if (state.exitCode !== undefined || state.signal !== undefined) {
			resolve({ exitCode: state.exitCode, signal: state.signal });
		}
	});
}

function handleKillTerminal(params: KillTerminalRequest): KillTerminalResponse | void {
	const state = terminals.get(params.terminalId);
	if (state) state.proc.kill();
}

function handleReleaseTerminal(params: ReleaseTerminalRequest): ReleaseTerminalResponse | void {
	const state = terminals.get(params.terminalId);
	if (state) {
		state.proc.kill();
		terminals.delete(params.terminalId);
	}
}

function killConnection() {
	if (acpProcess) {
		acpProcess.kill();
		acpProcess = null;
	}
	for (const [, state] of terminals) {
		state.proc.kill();
	}
	terminals.clear();
	acpConnection = null;
	sessionUpdateHandler = null;
	activeSessionId = null;
	activeModelId = null;
	activePromise = null;
	lastContextLength = 0;
	nextTerminalId = 1;

	if (pendingToolCall) {
		pendingToolCall.resolve("Error: connection killed");
		pendingToolCall = null;
	}
	toolCallDetected = null;

	if (bridgeServer) {
		bridgeServer.close();
		bridgeServer = null;
		bridgePort = null;
	}

	if (mcpServerScriptPath) {
		unlink(mcpServerScriptPath).catch(() => {});
		mcpServerScriptPath = null;
	}
}

async function ensureConnection(): Promise<ClientSideConnection> {
	if (acpConnection) return acpConnection;

	const child = spawn("npx", ["-y", "@zed-industries/claude-agent-acp"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	acpProcess = child;

	child.stderr?.on("data", (chunk: Buffer) => {
		// Forward stderr so MCP server debug logs are visible
		process.stderr.write(chunk);
	});

	child.on("close", () => {
		acpProcess = null;
		killConnection();
	});

	const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
	const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
	const rawStream = ndJsonStream(input, output);

	// Intercept session/update notifications before SDK validation
	// (same workaround as claude-acp.ts — avoids Zod union parse errors)
	const filter = new TransformStream({
		transform(msg: any, controller) {
			if ("method" in msg && msg.method === "session/update" && !("id" in msg) && msg.params) {
				try {
					const update = (msg.params as SessionNotification).update;
					sessionUpdateHandler?.(update);
				} catch (e) {
					console.error("[claude-code-acp] session/update handler error:", e);
				}
				return;
			}
			controller.enqueue(msg);
		},
	});
	rawStream.readable.pipeTo(filter.writable).catch(() => {});
	const stream = { readable: filter.readable, writable: rawStream.writable };

	const connection = new ClientSideConnection(
		() => ({
			sessionUpdate: async () => {}, // handled by stream filter above
			requestPermission: async (params) => handleRequestPermission(params),
			readTextFile: async (params) => handleReadTextFile(params),
			writeTextFile: async (params) => handleWriteTextFile(params),
			createTerminal: async (params) => handleCreateTerminal(params),
			terminalOutput: async (params) => handleTerminalOutput(params),
			waitForTerminalExit: async (params) => handleWaitForTerminalExit(params),
			killTerminal: async (params) => handleKillTerminal(params),
			releaseTerminal: async (params) => handleReleaseTerminal(params),
		}),
		stream,
	);

	await connection.initialize({
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: {
			fs: { readTextFile: true, writeTextFile: true },
			terminal: true,
		},
		clientInfo: { name: "pi-claude-code-acp", version: "0.1.0" },
	});

	acpConnection = connection;
	return connection;
}

// Clean up on process exit
process.on("exit", () => killConnection());
process.on("SIGTERM", () => killConnection());

// --- Core streaming function ---

type RaceResult =
	| { kind: "done"; result: PromptResponse }
	| { kind: "toolCall" };

function waitForToolCall(): Promise<void> {
	return new Promise((resolve) => {
		toolCallDetected = resolve;
	});
}

function streamClaudeAcp(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Array<
			| { type: "text"; text: string }
			| { type: "thinking"; thinking: string }
			| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
		>;

		let started = false;
		let textBlockIndex = -1;
		let thinkingBlockIndex = -1;
		let sessionId: string | null = null;

		const pushStart = () => {
			if (!started) {
				stream.push({ type: "start", partial: output });
				started = true;
			}
		};

		const closeOpenBlocks = () => {
			if (thinkingBlockIndex !== -1) {
				const block = blocks[thinkingBlockIndex] as { type: "thinking"; thinking: string };
				stream.push({ type: "thinking_end", contentIndex: thinkingBlockIndex, content: block.thinking, partial: output });
				thinkingBlockIndex = -1;
			}
			if (textBlockIndex !== -1) {
				const block = blocks[textBlockIndex] as { type: "text"; text: string };
				stream.push({ type: "text_end", contentIndex: textBlockIndex, content: block.text, partial: output });
				textBlockIndex = -1;
			}
		};

		try {
			const connection = await ensureConnection();
			const { customTools } = partitionTools(context.tools);
			if (context.tools) {
				console.error(`[claude-code-acp] tools: [${context.tools.map(t => t.name).join(", ")}]`);
				console.error(`[claude-code-acp] custom: [${customTools.map(t => t.name).join(", ")}]`);
			}

			// --- Mode B: Resume with tool result ---
			if (activePromise && pendingToolCall) {
				sessionId = activeSessionId;
				const toolResult = extractLastToolResult(context);
				if (toolResult) {
					pendingToolCall.resolve(toolResult.content || "OK");
				} else {
					pendingToolCall.resolve("No tool result provided");
				}
				pendingToolCall = null;
				lastContextLength = context.messages.length;

			// --- Mode A: Fresh prompt ---
			} else {
				// TODO: consider prepending pi skills or other pi-specific context to
				// the first prompt. Claude Code loads its own CLAUDE.md so we don't
				// send that, but pi skills aren't visible to Claude Code.

				let promptText: string;
				if (!activeSessionId) {
					// First call — new session with full context
					const mcpServers: Array<{ command: string; args: string[]; env: Array<{ name: string; value: string }>; name: string }> = [];
					if (customTools.length > 0) {
						const port = await ensureBridgeServer();
						const bridgeUrl = `http://127.0.0.1:${port}`;
						const scriptPath = await ensureMcpServerScript(customTools, bridgeUrl);
						console.error(`[claude-code-acp] MCP server script: ${scriptPath}`);
						console.error(`[claude-code-acp] Bridge URL: ${bridgeUrl}`);
						mcpServers.push({
							command: "node",
							args: [scriptPath],
							env: [],
							name: MCP_SERVER_NAME,
						});
					}

					const _meta: Record<string, unknown> = {};
					if (customTools.length > 0) {
						_meta.claudeCode = {
							options: {
								allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
							},
						};
					}
					console.error(`[claude-code-acp] newSession mcpServers: ${JSON.stringify(mcpServers)}`);
					console.error(`[claude-code-acp] newSession _meta: ${JSON.stringify(_meta)}`);
					const session = await connection.newSession({ cwd: process.cwd(), mcpServers, _meta } as any);
					console.error(`[claude-code-acp] session created: ${session.sessionId}`);
					console.error(`[claude-code-acp] session response: ${JSON.stringify(session)}`);

					sessionId = session.sessionId;
					activeSessionId = sessionId;
					await connection.setSessionMode({ sessionId, modeId: "bypassPermissions" });
					await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
					activeModelId = model.id;
					promptText = buildPromptText(context);
					lastContextLength = context.messages.length;
				} else {
					// Continuation — ACP already has prior context, just send latest user message
					sessionId = activeSessionId;
					if (activeModelId !== model.id) {
						await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
						activeModelId = model.id;
					}
					const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
					promptText = lastUser
						? messageContentToText(lastUser.content) || ""
						: "";
					lastContextLength = context.messages.length;
				}

				activePromise = connection.prompt({
					sessionId: sessionId!,
					prompt: [{ type: "text", text: promptText }],
				});
			}

			// Wire session update handler for this call
			sessionUpdateHandler = (update: SessionUpdate) => {
				pushStart();

				switch (update.sessionUpdate) {
					case "agent_message_chunk": {
						const content = update.content;
						if (content.type === "text" && "text" in content) {
							const text = (content as { text: string }).text;
							if (textBlockIndex === -1) {
								blocks.push({ type: "text", text: "" });
								textBlockIndex = blocks.length - 1;
								stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
							}
							const block = blocks[textBlockIndex] as { type: "text"; text: string };
							block.text += text;
							stream.push({
								type: "text_delta",
								contentIndex: textBlockIndex,
								delta: text,
								partial: output,
							});
						}
						break;
					}

					case "agent_thought_chunk": {
						const content = update.content;
						if (content.type === "text" && "text" in content) {
							const text = (content as { text: string }).text;
							if (thinkingBlockIndex === -1) {
								blocks.push({ type: "thinking", thinking: "" });
								thinkingBlockIndex = blocks.length - 1;
								stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
							}
							const block = blocks[thinkingBlockIndex] as { type: "thinking"; thinking: string };
							block.thinking += text;
							stream.push({
								type: "thinking_delta",
								contentIndex: thinkingBlockIndex,
								delta: text,
								partial: output,
							});
						}
						break;
					}

					case "tool_call":
					case "tool_call_update": {
						// Custom tools go through MCP bridge (pendingToolCall).
						// Built-in tools: emit to Pi as context so other providers see what Claude did.
						const tc = update as any;
						if (tc.status === "completed" || tc.status === "failed") {
							const title = tc.title ?? "tool";
							const rawOutput = tc.rawOutput;
							const outputText = rawOutput != null
								? (typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput))
								: "";
							const loc = tc.locations?.[0]?.path;
							const tcPath = loc ? relative(cwd, loc) || loc : undefined;
							const content = outputText.length > 500
								? outputText.slice(0, 500) + "..."
								: outputText;
							piApi?.sendMessage(
								{
									customType: MSG_TOOL,
									content: content || title,
									display: true,
									details: { name: title, status: tc.status, path: tcPath, toolCallId: tc.toolCallId },
								},
								{ triggerTurn: false },
							);
						}
						break;
					}

					case "usage_update": {
						const usage = update as { used?: number; size?: number } & { sessionUpdate: string };
						if (usage.used != null) output.usage.totalTokens = usage.used;
						if (usage.used != null) output.usage.input = usage.used;
						calculateCost(model, output.usage);
						break;
					}

					default:
						break;
				}
			};

			// Set up abort handling
			const onAbort = () => {
				if (activeSessionId && acpConnection) {
					acpConnection.cancel({ sessionId: activeSessionId });
				}
				if (pendingToolCall) {
					pendingToolCall.resolve("Error: aborted");
					pendingToolCall = null;
				}
			};
			if (options?.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				// Race: prompt completion vs custom tool call via bridge
				const hasCustomTools = customTools.length > 0;
				const raceResult: RaceResult = hasCustomTools
					? await Promise.race([
						activePromise!.then((r): RaceResult => ({ kind: "done", result: r })),
						waitForToolCall().then((): RaceResult => ({ kind: "toolCall" })),
					])
					: await activePromise!.then((r): RaceResult => ({ kind: "done", result: r }));

				if (raceResult.kind === "toolCall" && pendingToolCall) {
					// Custom tool call detected — return toolUse to Pi
					closeOpenBlocks();
					pushStart();

					const tc = {
						type: "toolCall" as const,
						id: `mcp-tc-${Date.now()}`,
						name: pendingToolCall.toolName,
						arguments: pendingToolCall.args,
					};
					blocks.push(tc);
					const idx = blocks.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });

					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					// activePromise stays alive — next streamSimple call will resume
				} else {
					// Prompt completed — no pending tool call
					activePromise = null;
					closeOpenBlocks();

					if (options?.signal?.aborted) {
						output.stopReason = "aborted";
						output.errorMessage = "Operation aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
						stream.end();
						return;
					}

					const result = (raceResult as { kind: "done"; result: PromptResponse }).result;
					output.stopReason = result.stopReason === "cancelled" ? "aborted" : "stop";
					pushStart();
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end();
				}
			} finally {
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				sessionUpdateHandler = null;
				toolCallDetected = null;
			}
		} catch (error) {
			activePromise = null;
			if (!acpConnection || acpProcess === null) {
				killConnection();
			}

			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			if (!started) stream.push({ type: "start", partial: output });
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}

// --- Provider registration ---

export default function (pi: ExtensionAPI) {
	piApi = pi;

	pi.registerMessageRenderer(MSG_TOOL, (message, { expanded }, theme) => {
		const details = message.details as { name?: string; status?: string; path?: string } | undefined;
		const content = typeof message.content === "string" ? message.content : "";
		const icon = details?.status === "completed"
			? theme.fg("success", "\u2713")
			: details?.status === "failed"
				? theme.fg("error", "\u2717")
				: theme.fg("warning", "\u25C9");
		let text = `${icon} ${theme.fg("toolTitle", details?.name ?? "tool")}`;
		if (details?.path) text += ` ${theme.fg("muted", details.path)}`;
		if (expanded && content) {
			text += `\n${theme.fg("toolOutput", content)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-acp",
		apiKey: "not-used",
		api: "claude-code-acp",
		models: MODELS,
		streamSimple: streamClaudeAcp,
	});
}
