#!/usr/bin/env node
// Can a tool enabled mid-turn reach the model in the same Claude Code query?
//
// Pi extensions can widen the active tool set from inside a tool call
// (pi-web-access's web_enable). The bridge used to build its MCP server once per
// query, so the model never saw tools added mid-turn. This probe compares ways
// of pushing the change into a live query.
//
//   node diag/probe-mid-turn-tools.mjs <mode>
//
//   control        never change the tools — the canary is missing
//   before/after   setMcpServers under the same server name, before/after
//                  returning enable's result
//   notify         register canary on the live server (tools/list_changed), return at once
//   second         setMcpServers adding a second server that carries canary
//   bridge         src/mcp-server.ts setTools: list_changed, then hold enable's
//                  result until CC re-lists
//   bridge-nowait  setTools, but return without waiting for the re-list
//
// PROBE_TOOLS (comma list) sets the query's builtin `tools`; ENABLE_TOOL_SEARCH
// passes through. Point ANTHROPIC_BASE_URL at diag/capture-proxy.mjs to see the
// tool set each request carries.
//
// Findings, against CC 2.1.280 / SDK 0.3.280, claude-haiku-4-5, tools: []:
//   - setMcpServers under an unchanged name is a no-op (added: [], removed: []).
//   - CC does honor tools/list_changed mid-query: it re-lists, and the new tool
//     rides on every request built after the re-list.
//   - Returning the result right after the notification races that re-list:
//     bridge-nowait sent the request after enable without canary 4/4 times.
//   - Waiting for the re-list first (bridge) put canary on that very request
//     7/7 times (3 with tools: [], 4 with ToolSearch allowed). ToolSearch is not
//     needed; runs that seemed to need it were the race.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createToolServer } from "../src/mcp-server.ts";

const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5";
const mode = process.argv[2] ?? "before";
const WORD = "PERSIMMON";

const log = [];
let q;
let live;
let canaryCalled = false;

const canaryHandler = async () => {
	canaryCalled = true;
	return { content: [{ type: "text", text: `secret: ${WORD}` }] };
};
const canary = tool("canary", "Returns a secret word.", {}, canaryHandler);
const enable = tool("enable", "Enables additional tools. They are available on your next request.", {}, async () => {
	if (mode === "before") log.push(["setMcpServers", await q.setMcpServers({ probe: server(true) })]);
	if (mode === "notify") live.instance.tool("canary", "Returns a secret word.", {}, canaryHandler);
	if (mode === "second") log.push(["setMcpServers", await q.setMcpServers({ probe: live, probe2: createSdkMcpServer({ name: "probe2", tools: [canary] }) })]);
	if (mode === "after") setTimeout(async () => log.push(["setMcpServers", await q.setMcpServers({ probe: server(true) })]), 0);
	return { content: [{ type: "text", text: "Enabled: canary." }] };
});
const server = (withCanary) => createSdkMcpServer({ name: "probe", tools: withCanary ? [enable, canary] : [enable] });

const noArgs = { type: "object", properties: {} };
const bridgeEnable = { name: "enable", description: "Enables additional tools. They are available on your next request.", inputSchema: noArgs,
	handler: async () => {
		const relisted = live.setTools([bridgeEnable, bridgeCanary]);
		if (mode === "bridge") log.push(["setTools relisted", await relisted]);
		return { content: [{ type: "text", text: "Enabled: canary." }] };
	} };
const bridgeCanary = { name: "canary", description: "Returns a secret word.", inputSchema: noArgs, handler: canaryHandler };
live = mode.startsWith("bridge") ? createToolServer("probe", [bridgeEnable]) : server(false);

async function* prompt() {
	yield {
		type: "user", parent_tool_use_id: null, session_id: "",
		message: { role: "user", content: "Call the `enable` tool. Then call the `canary` tool and reply with the secret word it returns. If no canary tool exists after enabling, reply exactly MISSING. Do not use any other approach." },
	};
	await new Promise((resolve) => setTimeout(resolve, 120_000));
}

q = query({
	prompt: prompt(),
	options: {
		model: MODEL, tools: process.env.PROBE_TOOLS ? process.env.PROBE_TOOLS.split(",") : [], permissionMode: "bypassPermissions", persistSession: false,
		settingSources: [], strictMcpConfig: true, maxTurns: 6,
		mcpServers: { probe: live },
	},
});

let final = "";
for await (const m of q) {
	if (m.type === "assistant") {
		for (const b of m.message.content) {
			if (b.type === "tool_use") log.push(["tool_use", b.name]);
			if (b.type === "text") final = b.text;
		}
	}
	if (m.type === "user" && Array.isArray(m.message.content)) {
		for (const b of m.message.content) {
			if (b.type === "tool_result") log.push(["tool_result", b.is_error ? "ERROR" : "ok", JSON.stringify(b.content).slice(0, 120)]);
		}
	}
	if (m.type === "result") break;
}
q.close?.();

for (const entry of log) console.log(JSON.stringify(entry));
console.log(JSON.stringify({ mode, canaryCalled, sawWord: final.includes(WORD), final: final.slice(0, 200) }));
process.exit(0);
