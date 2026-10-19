#!/usr/bin/env node
// Regression: split-turn /compact completes with isolated summaries (issue #18).
//
// pi runs the history and turn-prefix summaries sequentially. Each call carries
// cacheRetention:"none" and routes to the bridge's isolated summary path.
//
// Predecessor: int-compact-baseline.mjs must pass (compact path healthy).
//
// Determinism: isSplitTurn requires the cut point to land on an assistant
// message, which needs accumulated recent tokens to exceed keepRecentTokens.
// The default 20000 never triggers on a small seed. We lower it to 50 via a
// temp agent dir (PI_CODING_AGENT_DIR) whose settings.json holds the override
// as global settings — no project-trust gate, isolated from the user's real
// ~/.pi/agent. The bridge registers its own models and CC auth lives in
// ~/.claude, so an empty agent dir otherwise works.
//
// Expected: compact returns; the summary contains "Turn Context (split turn)",
// proving the split-turn path was exercised.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const COMPACT_TIMEOUT = 90_000; // compact should finish in ~10s; hang = timeout
const TEST_TIMEOUT = 180_000;

// Temp agent dir whose global settings.json forces isSplitTurn by lowering
// keepRecentTokens. Any modest assistant turn then straddles the boundary.
const testAgentDir = mkdtempSync(join(tmpdir(), "compact-splitturn-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-splitturn",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	// Two substantive turns so messagesToSummarize (prior turn) and
	// turnPrefixMessages (split turn prefix) are both non-empty, so compact()
	// produces both summaries rather than only a turn-prefix summary.
	console.log("Seed: two substantive turns...");
	await promptAndWait("List 15 European capital cities, one per line, numbered. Nothing else.");
	await promptAndWait("List 15 Asian capital cities, one per line, numbered. Nothing else.");

	console.log("Triggering /compact (forces split-turn dual-summary)...");
	const compactStarted = Date.now();
	let compactResult;
	try {
		compactResult = await send({ type: "compact" }, COMPACT_TIMEOUT);
	} catch (e) {
		throw new Error(
			`compact did not complete within ${COMPACT_TIMEOUT / 1000}s — split-turn ` +
			`summary failed (issue #18). Underlying: ${e.message}`
		);
	}
	console.log(`  compact returned in ${((Date.now() - compactStarted) / 1000).toFixed(1)}s`);

	if (!compactResult?.summary?.trim()) {
		throw new Error(`compact returned empty summary: ${JSON.stringify(compactResult)}`);
	}

	// The split-turn marker proves compact exercised the intended summary path.
	if (!/Turn Context \(split turn\)/.test(compactResult.summary)) {
		throw new Error(
			`compact summary lacks the "Turn Context (split turn)" marker — isSplitTurn ` +
			`did not fire, so this run did not exercise split-turn summaries. Adjust keepRecentTokens ` +
			`or seed content. Summary head: ${compactResult.summary.slice(0, 200)}`
		);
	}
	console.log(`  split-turn marker present`);

	console.log("Post-compact prompt...");
	const after = await promptAndWait('Reply with exactly "after-compact-ok".', TEST_TIMEOUT);
	if (!/after-compact-ok/.test(after)) {
		throw new Error(`post-compact prompt did not return expected marker. Got: ${after.slice(0, 200)}`);
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
