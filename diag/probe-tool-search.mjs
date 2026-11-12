#!/usr/bin/env node
// Does Claude Code defer the bridge's MCP tools behind its ToolSearch tool, and
// what does that save? Live probes against the installed CC/SDK, read off the
// request bodies diag/capture-proxy.mjs records.
//
// The provider path runs CC with `tools: []`, which also removes ToolSearch, so
// CC sends every pi tool's schema on every request. Phases:
//
//   baseline  tools: [], N tools, no _meta                    (today)
//   search    tools: ["ToolSearch"], _meta alwaysLoad on a core set; the prompt
//             needs a deferred tool, so one run shows discovery and the call
//   resume    search, then a second query resuming the same session
//   fork      search, then resumeSessionAt + forkSession at the first turn's end
//   rebuild   a session file written from scratch (as the bridge imports pi's
//             history) whose history already calls a deferred tool
//   heldoff   baseline turn, then resume with ToolSearch (a session upgraded in place)
//   activate  a tool joins the served set, always-loaded, between two turns of one
//             session (activate-fork: the second turn forks)
//
//   node --import tsx diag/probe-tool-search.mjs [--phase baseline,search] [--tools 113]
//        [--model claude-haiku-5-5] [--env NAME=VALUE] [--keep]
//
// Prints one JSON row per captured request that carried tools.
//
// Measured 2026-11-12, CC 2.1.321, claude-haiku-5-5, 113 tools (139.6 KB served):
//
//   baseline  114 tools sent, none of ours deferred, 142,051 bytes of `tools`,
//             53,302 prompt tokens on the first request
//   search    9 tools sent (ToolSearch, the 7 marked, CC's placeholder), 4,862
//             bytes, 6,537 prompt tokens; ToolSearch then the target in one query,
//             3 requests where the baseline needs 2. Same on claude-sonnet-5-5[1m]
//             and with 12 tools: there is no size threshold in this mode.
//   resume, fork   the loaded tool is sent again (defer_loading plus the
//             tool_reference in CC's records); no second search
//   rebuild   no tool_reference, so the target is not in `tools`; the model still
//             called it by the name in its history and CC dispatched the call
//   heldoff   the resumed session sends all 113 tools: CC decides once per session
//   activate  the added tool arrives as a tool_addition on resume (cache kept),
//             in `tools` on a fork (cache miss)

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession } from "cc-session-io";
import { ccChildEnv } from "../src/cc-child.ts";
import { FIRST_PARTY_ENV } from "./lib/first-party.mjs";
import { CORE_TOOL_NAMES, TARGET_TOOL, TARGET_VALUE, syntheticTools } from "./lib/synthetic-tools.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const PHASES = flag("phase", "baseline,search").split(",");
const TOOL_COUNT = Number(flag("tools", 113));
const MODEL = flag("model", "claude-haiku-5-5");
const KEEP = args.includes("--keep");
/** `--env NAME=VALUE`, repeatable: set on the Claude Code child, after the bridge's own. */
const EXTRA_ENV = Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []));
const ALWAYS_LOAD_META = "anthropic/alwaysLoad";
const SERVER = "custom-tools";
const PREFIX = `mcp__${SERVER}__`;
const ASK = "Use your tools to look up the berth code the harbor registry assigned to the vessel named Aurora, then reply with only that code.";

function toolServer(tools, calls, alwaysLoad) {
	const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => alwaysLoad?.has(tool.name) ? { ...tool, _meta: { [ALWAYS_LOAD_META]: true } } : tool),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push({ name: request.params.name, args: request.params.arguments });
		return { content: [{ type: "text", text: request.params.name === TARGET_TOOL ? TARGET_VALUE : `${request.params.name}-VALUE` }] };
	});
	return { [SERVER]: { type: "sdk", name: SERVER, instance: server } };
}

async function startProxy(out) {
	const proxy = spawn(process.execPath, ["diag/capture-proxy.mjs", "--port", "0", "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	const url = await new Promise((resolve) => proxy.stderr.on("data", (d) => { log += d; const m = log.match(/capture proxy on (http:\S+)/); if (m) resolve(m[1]); }));
	return { url, stop: async () => { const exited = once(proxy, "exit"); proxy.kill("SIGTERM"); await exited; } };
}

/** One query shaped like the provider path (src/index.ts queryOptions). */
async function turn({ proxyUrl, route, cwd, search, tools, prompt, extra = {}, env = {}, alsoLoad = [] }) {
	const calls = [];
	const mcpServers = toolServer(tools, calls, search ? new Set([...CORE_TOOL_NAMES, ...alsoLoad]) : undefined);
	const q = query({
		prompt,
		options: {
			cwd,
			model: MODEL,
			tools: search ? ["ToolSearch"] : [],
			permissionMode: "bypassPermissions",
			settingSources: [],
			settings: { autoMemoryEnabled: false, includeGitInstructions: false, outputStyle: "default" },
			systemPrompt: { type: "preset", preset: "claude_code" },
			strictMcpConfig: true,
			mcpServers,
			maxTurns: 6,
			env: { ...ccChildEnv(), ...FIRST_PARTY_ENV, ANTHROPIC_BASE_URL: `${proxyUrl}/q/${route}`, ...EXTRA_ENV, ...env },
			...extra,
		},
	});
	const out = { route, calls, toolUses: [], assistantUuids: [], text: "", sessionId: null, initTools: null, result: null };
	for await (const message of q) {
		if (message.type === "system" && message.subtype === "init") { out.sessionId = message.session_id; out.initTools = message.tools.length; }
		if (message.type === "assistant") {
			out.assistantUuids.push(message.uuid);
			for (const block of message.message?.content ?? []) {
				if (block.type === "tool_use") out.toolUses.push(block.name);
				if (block.type === "text") out.text += block.text;
			}
		}
		if (message.type === "result") out.result = { subtype: message.subtype, is_error: message.is_error, turns: message.num_turns };
	}
	return out;
}

const blockTypes = (messages) => {
	const counts = {};
	const visit = (block) => {
		if (!block || typeof block !== "object") return;
		counts[block.type] = (counts[block.type] ?? 0) + 1;
		if (Array.isArray(block.content)) block.content.forEach(visit);
	};
	for (const message of messages ?? []) if (Array.isArray(message.content)) message.content.forEach(visit);
	return counts;
};

/** One row per captured request that carried tools. */
function report(out) {
	const index = readFileSync(join(out, "index.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const rows = [];
	for (const file of readdirSync(out).filter((name) => /^req-\d+\.json$/.test(name)).sort()) {
		const body = JSON.parse(readFileSync(join(out, file), "utf8"));
		if (!Array.isArray(body.tools) || body.tools.length === 0) continue;
		const n = Number(file.match(/\d+/)[0]);
		const row = index.find((entry) => entry.n === n) ?? {};
		const deferred = body.tools.filter((tool) => tool.defer_loading === true);
		const loaded = body.tools.filter((tool) => tool.defer_loading !== true);
		const usage = row.usage ?? null;
		rows.push({
			n, route: row.route ?? null, model: body.model,
			tools: body.tools.length, deferred: deferred.length,
			toolBytes: JSON.stringify(body.tools).length,
			loadedBytes: JSON.stringify(loaded).length,
			loadedNames: loaded.length <= 16 ? loaded.map((tool) => tool.name ?? tool.type) : `${loaded.length} tools`,
			messages: body.messages?.length ?? 0,
			blocks: blockTypes(body.messages),
			promptTokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : null,
			cacheRead: usage?.cacheRead ?? null,
			betas: row.betas ?? null,
			status: row.status ?? null,
		});
	}
	return rows;
}

/** A session file the way the bridge writes one from pi's history: the user asked,
 *  the assistant called the (deferred) target tool directly, the result came back. */
function writeRebuiltSession(cwd) {
	const session = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	session.addUserMessage(ASK);
	session.addAssistantMessage([{ type: "tool_use", id, name: `${PREFIX}${TARGET_TOOL}`, input: { vessel: "Aurora" } }]);
	session.addUserMessage([{ type: "tool_result", tool_use_id: id, content: TARGET_VALUE }]);
	session.addAssistantMessage([{ type: "text", text: TARGET_VALUE }]);
	session.save();
	return session.sessionId;
}

const FOLLOW_UP = "Look the same vessel up again with the same tool and reply with only the code.";
const summary = (label, run) => console.log(JSON.stringify({ phase: label, session: run.sessionId?.slice(0, 8), initTools: run.initTools, toolUses: run.toolUses, calls: run.calls, text: run.text.slice(0, 120), result: run.result }));

const out = mkdtempSync(join(tmpdir(), "cc-tool-search-"));
const cwd = mkdtempSync(join(tmpdir(), "cc-tool-search-cwd-"));
const proxy = await startProxy(out);
const tools = syntheticTools(TOOL_COUNT);
const base = { proxyUrl: proxy.url, cwd, tools, prompt: ASK };
console.log(JSON.stringify({ model: MODEL, tools: tools.length, core: CORE_TOOL_NAMES.length, servedBytes: JSON.stringify(tools).length }));
try {
	for (const phase of PHASES) {
		if (phase === "baseline") summary(phase, await turn({ ...base, route: "baseline", search: false }));
		if (phase === "search") summary(phase, await turn({ ...base, route: "search", search: true }));
		if (phase === "resume") {
			const first = await turn({ ...base, route: "resume-1", search: true });
			summary("resume-1", first);
			summary("resume-2", await turn({ ...base, route: "resume-2", search: true, prompt: FOLLOW_UP, extra: { resume: first.sessionId } }));
		}
		if (phase === "fork") {
			const first = await turn({ ...base, route: "fork-1", search: true });
			summary("fork-1", first);
			summary("fork-2", await turn({ ...base, route: "fork-2", search: true, prompt: FOLLOW_UP,
				extra: { resume: first.sessionId, forkSession: true, resumeSessionAt: first.assistantUuids.at(-1), sessionId: randomUUID() } }));
		}
		if (phase === "rebuild") {
			const sessionId = writeRebuiltSession(cwd);
			summary("rebuild", await turn({ ...base, route: "rebuild", search: true, prompt: FOLLOW_UP, extra: { resume: sessionId } }));
		}
		if (phase === "activate" || phase === "activate-fork") {
			// The target joins the served set between two turns, marked always-loaded.
			const first = await turn({ ...base, route: `${phase}-1`, search: true, tools: tools.filter((tool) => tool.name !== TARGET_TOOL), prompt: "Reply with exactly: OK" });
			summary(`${phase}-1`, first);
			const fork = phase === "activate-fork" ? { forkSession: true, resumeSessionAt: first.assistantUuids.at(-1), sessionId: randomUUID() } : {};
			summary(`${phase}-2`, await turn({ ...base, route: `${phase}-2`, search: true, alsoLoad: [TARGET_TOOL], extra: { resume: first.sessionId, ...fork } }));
		}
		if (phase === "heldoff") {
			const first = await turn({ ...base, route: "heldoff-1", search: false });
			summary("heldoff-1", first);
			summary("heldoff-2", await turn({ ...base, route: "heldoff-2", search: true, prompt: FOLLOW_UP, extra: { resume: first.sessionId } }));
		}
	}
} finally {
	await proxy.stop();
}
for (const row of report(out)) console.log(JSON.stringify(row));
if (KEEP) console.error(`captures kept in ${out} (they hold the conversation)`);
else rmSync(out, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
