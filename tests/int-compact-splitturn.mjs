#!/usr/bin/env node
// Regression: split-turn /compact hangs (issue #18).
//
// pi's compact() runs two summarization provider calls concurrently via
// Promise.all when the cut point lands mid-turn (isSplitTurn):
//
//   const [historyResult, turnPrefixResult] = await Promise.all([
//       generateSummary(...),          // streamFn call #1
//       generateTurnPrefixSummary(...), // streamFn call #2, sees stale activeQuery
//   ]);
//
// Both go through the bridge's streamClaudeAgentSdk, gated on one
// module-global ctx().activeQuery slot. Call #2 sees #1's activeQuery (cleared
// in .finally, which runs after finalizeCurrentStream resumes pi's
// await stream.result() in a microtask), takes the tool-result-delivery
// branch, orphans its stream, and stream.result() hangs forever — compaction
// never completes.
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
// Expected:
//   - RED (bug present): compact RPC times out — stream.result() hangs.
//   - GREEN (bug fixed): compact returns; summary contains the literal
//     "Turn Context (split turn)" marker that compact() only emits when
//     isSplitTurn fired, proving the race path was exercised.

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

const { start, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

let finishing = false;
function finish(code, msg) {
	if (finishing) return;
	finishing = true;
	console.log(msg);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
	}
	stop().then(() => {
		rmSync(testAgentDir, { recursive: true, force: true });
		process.exit(code);
	});
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	// Two substantive turns so messagesToSummarize (prior turn) and
	// turnPrefixMessages (split turn prefix) are both non-empty — compact()
	// only runs Promise.all when both inputs have content. Without prior
	// history, it falls back to a single summary and the race never fires.
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
			`dual-summary race hung stream.result() (issue #18). Underlying: ${e.message}`
		);
	}
	console.log(`  compact returned in ${((Date.now() - compactStarted) / 1000).toFixed(1)}s`);

	if (!compactResult?.summary?.trim()) {
		throw new Error(`compact returned empty summary: ${JSON.stringify(compactResult)}`);
	}

	// Self-verification: the split-turn marker only appears when isSplitTurn
	// fired and Promise.all ran both summaries. Guards against a false green
	// where compact succeeded via a single-summary path that never exercised
	// the race.
	if (!/Turn Context \(split turn\)/.test(compactResult.summary)) {
		throw new Error(
			`compact summary lacks the "Turn Context (split turn)" marker — isSplitTurn ` +
			`did not fire, so this run did not exercise the race. Adjust keepRecentTokens ` +
			`or seed content. Summary head: ${compactResult.summary.slice(0, 200)}`
		);
	}
	console.log(`  split-turn marker present (race path exercised)`);

	console.log("Post-compact prompt...");
	const after = await promptAndWait('Reply with exactly "after-compact-ok".', TEST_TIMEOUT);
	if (!/after-compact-ok/.test(after)) {
		throw new Error(`post-compact prompt did not return expected marker. Got: ${after.slice(0, 200)}`);
	}

	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
