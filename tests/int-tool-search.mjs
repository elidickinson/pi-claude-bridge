#!/usr/bin/env node
// provider.toolSearch through a real pi and a real Claude Code: an extension tool
// that Claude Code defers is found with ToolSearch and run by pi in the same turn,
// and the next turn resumes the same Claude Code session (the ToolSearch exchange
// pi never sees must not read as a history difference, which would cost the cache).
//
// Haiku keeps it cheap; the path is identical to opus/sonnet.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/deferred-tools-extension.ts");

const testAgentDir = mkdtempSync(join(tmpdir(), "tool-search-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({}));
writeFileSync(join(testAgentDir, "claude-bridge.json"), JSON.stringify({ provider: { toolSearch: true } }));

const harness = createRpcHarness({
	name: "tool-search",
	args: ["--model", BRIDGE_MODEL, "-e", FIXTURE],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	console.log("Turn 1: the answer needs a deferred tool...");
	const first = await promptAndWait("Use your tools to look up the berth code the harbor registry assigned to the vessel named Aurora, then reply with only that code.");
	if (!first.includes("BERTH-7Q4")) throw new Error(`turn 1 did not report the tool's value: ${first.slice(0, 200)}`);

	let debug = readFileSync(DEBUG_LOG, "utf8");
	const launch = debug.split("\n").find((line) => /provider: fresh query model=/.test(line));
	const deferred = Number(launch?.match(/ deferred=(\d+)/)?.[1]);
	console.log(`  ${launch?.trim().slice(0, 160)}`);
	if (!(deferred >= 4)) throw new Error(`the fixture's 4 tools were not deferred (deferred=${deferred})`);
	if (!/skipping tool_use for unserved tool ToolSearch/.test(debug)) {
		throw new Error("Claude reached the deferred tool without a ToolSearch call, so the test proved nothing about one");
	}

	console.log("Turn 2: the same Claude Code session, the tool still loaded...");
	const second = await promptAndWait("Look up the vessel named Borealis the same way and reply with only the code.");
	if (!second.includes("BERTH-7Q4")) throw new Error(`turn 2 did not report the tool's value: ${second.slice(0, 200)}`);

	debug = readFileSync(DEBUG_LOG, "utf8");
	const syncs = debug.split("\n").filter((line) => /syncResult: path=/.test(line)).map((line) => line.match(/path=([a-z-]+)/)[1]);
	console.log(`  sync paths: ${syncs.join(", ")}`);
	if (syncs.at(-1) !== "reuse") throw new Error(`turn 2 did not resume turn 1's session: ${syncs.join(", ")}`);
	if (/recording gap/.test(debug)) throw new Error("a turn holding a ToolSearch call was recorded with a gap");

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
