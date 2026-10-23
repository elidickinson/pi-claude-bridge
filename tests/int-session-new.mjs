#!/usr/bin/env node
// Verifies the first query after a pi-side /new starts a clean CC session.
//
// Mirrors are keyed by pi session id and retained across switches, so the
// fresh pi session has no mirror of its own. This is a regression test so the
// behavior stays wired up.

console.log("=== int-session-new.mjs ===");

import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const harness = createRpcHarness({
	name: "session-new",
	args: ["--model", BRIDGE_MODEL],
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	console.log("Turn 1: seed history...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number. Do not use the memory system.");
	console.log("Turn 2: more history...");
	await promptAndWait("Now pick a color. Reply with just the color. Do not use the memory system.");

	console.log("Triggering /new...");
	await send({ type: "new_session" });

	console.log("Turn 3: prompt after /new (should be a clean start)...");
	await promptAndWait("Hello fresh session. Reply with just 'hi'.");

	// The bridge logs `session_start:new: retaining N shared sessions` when it
	// observes the event; everything after it belongs to the fresh session.
	const fullLog = readFileSync(DEBUG_LOG, "utf8");
	const newMarker = /session_start:new: retaining \d+ shared sessions?\n/.exec(fullLog);
	if (!newMarker) {
		throw new Error("no `session_start:new: retaining` marker — bridge didn't observe /new");
	}
	const postNewLog = fullLog.slice(newMarker.index + newMarker[0].length);

	// First syncResult after /new must be clean-start (sharedSession=null,
	// no prior messages on the fresh agent state).
	const syncResults = [...postNewLog.matchAll(/syncResult: path=([a-z-]+)/g)].map((m) => m[1]);
	console.log(`  Post-/new syncResults: ${JSON.stringify(syncResults)}`);
	if (syncResults.length === 0) {
		throw new Error("no syncResult markers after /new (Turn 3 didn't reach the provider?)");
	}
	if (syncResults[0] !== "clean-start") {
		throw new Error(
			`bridge took ${syncResults[0]} path after /new — expected clean-start.\n` +
			`       the fresh pi session must not inherit the previous session's mirror.`);
	}

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	await stop();
}
