/**
 * The isolated fork's usage against the installed Claude Code, offline.
 *
 * The fork stops Claude Code once it has the captured call, but the response's
 * final output count arrives later, in its message_delta. A fork that kept the
 * count from the response's start reported 27 output tokens for a response the
 * API billed at 543. This runs the real CLI against a loopback upstream with a
 * dummy key, in a throwaway HOME and config dir, through IsolatedForks with the
 * fork's own query options, and checks that the result carries the final count,
 * that no second request was made, and that the only tool is a refusing one.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { forkSettings, IsolatedForks, ServedRequests } from "../src/isolated-fork.js";
import { createToolServer } from "../src/mcp-server.js";

const root = mkdtempSync(join(tmpdir(), "claude-bridge-fork-usage-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const configDir = join(home, ".claude");
const project = join(root, "project");
for (const dir of [configDir, project, join(root, "tmp")]) mkdirSync(dir, { recursive: true });

const bodies = [];
// Live Claude Code can run the refusing handler, and record its result, before the
// response's message_delta arrives; a pause before that event reproduces the order.
let deltaDelayMs = 0;
const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"input_tokens":1}');
			return;
		}
		bodies.push(JSON.parse(body));
		const events = [
			{ type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Pick the ranges." } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Compressing." } },
			{ type: "content_block_stop", index: 1 },
			{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_fork_1", name: "mcp__custom-tools__compress", input: {} } },
			{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"startId":"m1","endId":"m2","summary":"s"}' } },
			{ type: "content_block_stop", index: 2 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 543 } },
			{ type: "message_stop" },
		];
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const event of events) {
			if (event.type === "message_delta" && deltaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, deltaDelayMs));
			res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		}
		res.end();
	});
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
after(() => {
	upstream.closeAllConnections();
	upstream.close();
});

const env = {
	PATH: process.env.PATH,
	HOME: home,
	CLAUDE_CONFIG_DIR: configDir,
	TMPDIR: join(root, "tmp"),
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
	ANTHROPIC_API_KEY: "sk-ant-offline-dummy",
	DISABLE_TELEMETRY: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** Spawns the CLI the way the fork's own spawner does, and reports when that child has exited. */
function ownedSpawn() {
	let child;
	let exit;
	const exited = new Promise((resolve) => { exit = resolve; });
	return {
		spawn(options) {
			child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] });
			child.once("exit", () => exit());
			child.once("error", () => { if (child.pid === undefined) exit(); });
			options.signal.addEventListener("abort", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, { once: true });
			return child;
		},
		exited,
		started: () => child !== undefined,
		kill() {
			if (!child) exit();
			else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

const compressTool = { name: "compress", description: "Compress", parameters: { type: "object", properties: { startId: { type: "string" }, endId: { type: "string" }, summary: { type: "string" } } } };

async function forkAgainstCli({ delayMs }) {
	bodies.length = 0;
	deltaDelayMs = delayMs;
	const handled = [];
	const owned = ownedSpawn();
	let forkAbort;
	const served = new ServedRequests();
	served.record("pi-a", { id: "claude-sonnet-5-5" }, { systemPrompt: undefined, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [compressTool] }, undefined, project);
	const forks = new IsolatedForks(served, {
		refusal: () => undefined,
		source: () => ({ mainSessionId: "unused-main", forkPoint: async () => "unused-cut" }),
		startQuery(_served, target, prompt, abortController) {
			forkAbort = abortController;
			const mcpServers = {
				"custom-tools": createToolServer("custom-tools", [{
					name: "compress",
					description: compressTool.description,
					inputSchema: compressTool.parameters,
					handler: async (toolCallId) => {
						handled.push(toolCallId);
						return { toolCallId, isError: true, content: [{ type: "text", text: "Tool execution is disabled in this compression fork." }] };
					},
				}]),
			};
			const q = query({ prompt, options: {
				cwd: project,
				env,
				model: "claude-sonnet-5-5",
				tools: [],
				permissionMode: "bypassPermissions",
				includePartialMessages: true,
				mcpServers,
				extraArgs: { "strict-mcp-config": null },
				settings: forkSettings({ autoMemoryEnabled: false, includeGitInstructions: false }),
				sessionId: target.forkSessionId,
				abortController,
				maxTurns: 1,
				spawnClaudeCodeProcess: owned.spawn,
			} });
			return { query: q, process: { exited: owned.exited, close: () => {}, kill: owned.kill } };
		},
		sdkToolName: (name) => `mcp__custom-tools__${name}`,
		deleteSession: () => {},
		debug: () => {},
	});
	const accepted = [];
	try {
		forks.handle({ version: 1, piSessionId: "pi-a", prompt: "Compress now.", captureTool: "compress", signal: new AbortController().signal, accept: (p) => { accepted.push(p); return true; } });
		assert.equal(accepted.length, 1);
		const result = await accepted[0];
		assert.deepEqual(result, { ok: true, args: { startId: "m1", endId: "m2", summary: "s" }, usage: { input: 50, output: 543, cacheRead: 1000, cacheWrite: 20, complete: true } });

		// Every request the fork's CLI could make is in once that child has exited.
		assert.ok(owned.started(), "the fork ran its CLI through the owned spawner");
		let timer;
		const exitedInTime = await Promise.race([owned.exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
		clearTimeout(timer);
		assert.ok(exitedInTime, "the fork's CLI exited after the capture");
		assert.equal(bodies.length, 1, "the fork made exactly one model request");
		assert.ok(handled.every((id) => id === "toolu_fork_1"), "only the refusing handler could ever be reached");
		return handled;
	} finally {
		forkAbort?.abort();
		owned.kill();
	}
}

test("a fork against the real CLI reports the response's final usage, with no second request", { timeout: 120_000 }, async () => {
	const handled = await forkAgainstCli({ delayMs: 0 });
	console.log(`# refusing handler calls: ${handled.length}`);
});

test("the final usage still counts when the refused call's result comes before the response's message_delta", { timeout: 120_000 }, async () => {
	const handled = await forkAgainstCli({ delayMs: 400 });
	assert.deepEqual(handled, ["toolu_fork_1"], "the CLI ran the refusing handler before the final usage arrived");
});
