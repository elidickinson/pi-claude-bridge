/**
 * The isolated fork's hooks setting against the installed Claude Code, offline.
 *
 * A fork is a session the user never started, so user, project and plugin hooks
 * must not run in it (billion-context-pi #614: a user's SessionEnd plugin hook
 * ran in a live fork). The fork turns them off with forkSettings(); the main
 * query keeps them. This runs the real CLI against a loopback upstream with a
 * dummy key, in a throwaway HOME and config dir holding marker hooks that only
 * append to a file here, and checks which markers each settings variant leaves.
 * It also checks that turning hooks off leaves the request itself unchanged, so
 * the fork's prompt-cache prefix does not depend on it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { forkSettings } from "../src/isolated-fork.js";

const root = mkdtempSync(join(tmpdir(), "claude-bridge-fork-hooks-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const configDir = join(home, ".claude");
const project = join(root, "project");
const plugin = join(root, "plugin");
const markers = join(root, "markers.txt");
for (const dir of [configDir, join(project, ".claude"), join(plugin, ".claude-plugin"), join(plugin, "hooks"), join(root, "tmp")]) mkdirSync(dir, { recursive: true });

const marker = (name) => [{ hooks: [{ type: "command", command: `echo ${name} >> '${markers}'` }] }];
writeFileSync(join(configDir, "settings.json"), JSON.stringify({ hooks: { SessionStart: marker("user-start"), UserPromptSubmit: marker("user-prompt"), Stop: marker("user-stop"), SessionEnd: marker("user-end") } }));
writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionEnd: marker("project-end") } }));
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fork-hooks-marker", version: "0.0.1" }));
writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: marker("plugin-start"), SessionEnd: marker("plugin-end") } }));

const bodies = [];
const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"input_tokens":1}');
			return;
		}
		bodies.push(JSON.parse(body));
		const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
		const events = [
			{ type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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

async function run(settings) {
	writeFileSync(markers, "");
	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), 45_000);
	try {
		for await (const message of query({ prompt: "hi", options: { cwd: project, env, model: "claude-sonnet-5-5", maxTurns: 1, plugins: [{ type: "local", path: plugin }], settings, abortController } })) {
			if (message.type === "result") assert.equal(message.subtype, "success");
		}
	} finally {
		clearTimeout(timer);
	}
	// SessionEnd hooks run as the CLI exits, after the stream ends.
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	return readFileSync(markers, "utf8").split("\n").filter(Boolean).sort();
}

const mainSettings = { autoMemoryEnabled: false, includeGitInstructions: false };

test("hooks from user and project settings and from plugins run for the main query's settings and not for the fork's", { timeout: 120_000 }, async () => {
	const main = await run(mainSettings);
	assert.deepEqual(main, ["plugin-end", "plugin-start", "project-end", "user-end", "user-prompt", "user-start", "user-stop"], "every marker hook runs with the main query's settings");
	const fork = await run(forkSettings(mainSettings));
	assert.deepEqual(fork, [], "no hook runs with the fork's settings");

	assert.equal(bodies.length, 2);
	const [a, b] = bodies.map(({ metadata, ...rest }) => rest);
	assert.deepEqual(b, a, "turning hooks off changes nothing the request sends but its session metadata");
});
