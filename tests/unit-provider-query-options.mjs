#!/usr/bin/env node

// What a provider turn hands Claude Code: the options it starts the query with and
// the tool list its MCP server answers, read through a mocked SDK query().

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-query-options-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");

const handlers = new Map();
let providerConfig;
activate({
	on: (event, handler) => handlers.set(event, handler),
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];

const SYSTEM_PROMPT = "assembled pi prompt for the query-options test";
const READ_DESCRIPTION = "Read the contents of a file.";
const TOOLS = [
	{ name: "read", description: READ_DESCRIPTION, parameters: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "custom", description: "A tool pi has no prompt contribution for.", parameters: { type: "object", properties: {} } },
];

async function listTools(server) {
	const pending = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (msg) => pending.get(msg.id)?.(msg) };
	await server.instance.connect(transport);
	let nextId = 0;
	const request = (method, params) => new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		transport.onmessage({ jsonrpc: "2.0", id, method, params });
	});
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (await request("tools/list", {})).result.tools;
}

let options;
before(async () => {
	handlers.get("before_agent_start")({
		systemPrompt: SYSTEM_PROMPT,
		systemPromptOptions: {
			contextFiles: [], skills: [], selectedTools: ["read", "custom"],
			toolSnippets: { read: "Read file contents" },
			toolGuidelines: { read: ["Use read to examine files instead of cat or sed."] },
		},
	});
	__test.setQuery(({ options: queryOptions }) => {
		options = queryOptions;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: queryOptions.sessionId ?? queryOptions.resume };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	await providerConfig.streamSimple(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: TOOLS },
		{ sessionId: "pi-query-options" },
	).result();
	assert.ok(options, "the provider never started a query");
});
after(() => __test.setQuery(null));

describe("provider query options", () => {
	it("serves each tool with pi's snippet and guidelines in its description", async () => {
		const tools = await listTools(options.mcpServers["custom-tools"]);
		assert.deepEqual(tools.map(({ name, description }) => ({ name, description })), [
			{ name: "read", description: `Read file contents\n\n${READ_DESCRIPTION}\n\nGuidelines:\n- Use read to examine files instead of cat or sed.` },
			{ name: "custom", description: "A tool pi has no prompt contribution for." },
		]);
	});


	it("turns off the user's Claude Code hooks while keeping their settings sources", () => {
		assert.equal(options.settings.disableAllHooks, true);
		assert.deepEqual(options.settingSources, ["user"]);
	});
});
