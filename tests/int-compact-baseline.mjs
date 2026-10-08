#!/usr/bin/env node
// Baseline: pi-side /compact works end-to-end through the bridge.
//
// Companion to int-compact-splitturn.mjs (the concurrency test). Establishes
// that the harness, model, and compact RPC path are healthy before asserting
// anything about concurrency. If this fails, fix the environment/harness first —
// the concurrency test is meaningless on top of a broken baseline.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const testAgentDir = mkdtempSync(join(tmpdir(), "compact-baseline-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-baseline",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	console.log("Seed: a few short turns so there is history to compact...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number. Do not use the memory system.");
	await promptAndWait("Now pick a color. Reply with just the color. Do not use the memory system.");
	await promptAndWait("Now pick a fruit. Reply with just the fruit. Do not use the memory system.");

	console.log("Triggering /compact...");
	const compactResult = await send({ type: "compact" }, TIMEOUT);

	if (!compactResult || typeof compactResult !== "object") {
		throw new Error(`compact returned non-object: ${JSON.stringify(compactResult)}`);
	}
	if (!compactResult.summary || !compactResult.summary.trim()) {
		throw new Error(`compact returned empty summary: ${JSON.stringify(compactResult)}`);
	}
	if (!compactResult.firstKeptEntryId) {
		throw new Error(`compact returned no firstKeptEntryId: ${JSON.stringify(compactResult)}`);
	}
	console.log(`  summary:        ${compactResult.summary.slice(0, 80).replace(/\n/g, " ")}...`);
	console.log(`  firstKeptEntry: ${compactResult.firstKeptEntryId.slice(0, 8)}`);
	console.log(`  tokensBefore:   ${compactResult.tokensBefore}`);

	console.log("Post-compact prompt...");
	const after = await promptAndWait('Reply with exactly "after-compact-ok".');
	if (!/after-compact-ok/.test(after)) {
		throw new Error(`post-compact prompt did not return the expected marker. Got: ${after.slice(0, 200)}`);
	}

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
