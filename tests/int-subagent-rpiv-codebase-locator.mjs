#!/usr/bin/env node
// Reproduction/regression for rpiv-pi codebase-locator subagents hanging while
// claude-bridge has a parent Claude Code query active.
//
// This intentionally bypasses /skill:discover and invokes the same underlying
// mechanism directly: @tintinweb/pi-subagents Agent tool + rpiv-pi's pinned
// codebase-locator agent definition from @juicesharp/rpiv-pi v0.6.0.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";
const TEST_TIMEOUT = 240_000;
// Load pi-subagents straight from npm via pi's `-e npm:` source, pinned to a
// version that passes modelRuntime to createAgentSession (pi 0.80.8 dropped the
// modelRegistry option); older versions fail "No API key found for claude-bridge".
const SUBAGENTS_SOURCE = "npm:@tintinweb/pi-subagents@0.14.3";
const RPIV_LOCATOR_FIXTURE = resolve(DIR, "tests/fixtures/rpiv-pi-v0.6.0-agents/codebase-locator.md");
const REENTRANT_MARKER = /provider: active query user-only call treated as reentrant fresh query/g;
const STUCK_MARKER = /MCP handlers still waiting after delivering 0 results|tool handler\(s\) still waiting|currentPiStream overwritten/;
assert.ok(existsSync(RPIV_LOCATOR_FIXTURE), `missing rpiv codebase-locator fixture: ${RPIV_LOCATOR_FIXTURE}`);

const testAgentDir = mkdtempSync(join(tmpdir(), "subagent-rpiv-locator-dir-"));
const testProjectDir = mkdtempSync(join(tmpdir(), "subagent-rpiv-locator-project-"));
mkdirSync(join(testProjectDir, ".pi", "agents"), { recursive: true });
mkdirSync(join(testProjectDir, "src"), { recursive: true });
cpSync(RPIV_LOCATOR_FIXTURE, join(testProjectDir, ".pi", "agents", "codebase-locator.md"));
writeFileSync(join(testProjectDir, "package.json"), JSON.stringify({ name: "subagent-rpiv-locator-fixture", private: true }, null, 2));
writeFileSync(join(testProjectDir, "src", "rpiv_locator.ts"), "export const RPIV_LOCATOR_SENTINEL = 'rpiv-codebase-locator';\n");

const harness = createRpcHarness({
	name: "subagent-rpiv-codebase-locator",
	args: ["-e", SUBAGENTS_SOURCE, "--model", BRIDGE_MODEL],
	cwd: testProjectDir,
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, waitForEvent, waitForMatch, collectText, DEBUG_LOG, RPC_LOG } = harness;

function debugLog() {
	try { return readFileSync(DEBUG_LOG, "utf8"); } catch { return ""; }
}

function reentrantCount() {
	return [...debugLog().matchAll(REENTRANT_MARKER)].length;
}

async function waitForReentrantCountAbove(count, label) {
	const deadline = Date.now() + TEST_TIMEOUT;
	while (Date.now() < deadline) {
		const current = reentrantCount();
		if (current > count) return current;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${label}: timed out waiting for reentrant subagent query (count stayed ${count})`);
}

async function runAgentPrompt({ background, expectedMarker }) {
	const beforeReentrant = reentrantCount();
	const collector = collectText();
	await send({
		type: "prompt",
		message: `Use the Agent tool exactly once.

Call it with:
- subagent_type: codebase-locator
- description: rpiv locator
- model: ${BRIDGE_MODEL}
- max_turns: 8
- run_in_background: ${background ? "true" : "false"}
- prompt: Find files related to RPIV_LOCATOR_SENTINEL in this repository. Return only file paths and matching line anchors. Do not ask questions.

After the Agent tool returns, do not use more tools. ${background ? "Write 80 short numbered lines about keeping background work separate, then" : "Then"} reply exactly ${expectedMarker}.`,
	}, TEST_TIMEOUT);

	await waitForMatch(
		(msg) => msg.type === "tool_execution_start" && JSON.stringify(msg).includes("Agent"),
		`${background ? "background" : "foreground"} Agent tool_execution_start`,
		TEST_TIMEOUT,
	);
	await waitForEvent("agent_end", TEST_TIMEOUT);
	const text = collector.stop();
	assert.match(
		text,
		new RegExp(expectedMarker),
		`parent did not report ${background ? "background" : "foreground"} Agent completion. Text: ${text.slice(0, 500)}`,
	);
	await waitForReentrantCountAbove(beforeReentrant, background ? "background Agent" : "foreground Agent");
}

await startAndWait();

try {
	await runAgentPrompt({ background: false, expectedMarker: "PARENT-SAW-FOREGROUND-RPIV-CODEBASE-LOCATOR" });
	await runAgentPrompt({ background: true, expectedMarker: "PARENT-STARTED-BACKGROUND-RPIV-CODEBASE-LOCATOR" });

	const log = debugLog();
	assert.match(log, /mcp handler: Agent \[toolu_/, "debug log never showed the parent Agent MCP handler");
	assert.doesNotMatch(log, STUCK_MARKER, "debug log contains stuck-handler/stream-overwrite signature");

	console.log("PASS");
} catch (err) {
	process.exitCode = 1;
	console.log(`FAIL: ${err.message}\n${err.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try { console.log(`  Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-6000)}`); } catch {}
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
	rmSync(testProjectDir, { recursive: true, force: true });
}
