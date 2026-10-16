#!/usr/bin/env node
// Verifies the bridge clears its sharedSession after a pi-side /new.
//
// This already works today (the bridge subscribes to `session_start` with
// reason="new" and clears sharedSession). This is a regression test so the
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

	const NEW_MARKER_LOG = readFileSync(DEBUG_LOG, "utf8").length;

	console.log("Triggering /new...");
	await send({ type: "new_session" });

	console.log("Turn 3: prompt after /new (should be a clean start)...");
	await promptAndWait("Hello fresh session. Reply with just 'hi'.");

	const fullLog = readFileSync(DEBUG_LOG, "utf8");
	const postNewLog = fullLog.slice(NEW_MARKER_LOG);

	// The bridge logs `session_start:new: clearing ... shared sessions` when it
	// observes the event. Make sure we saw it.
	if (!/session_start:new: clearing \d+ shared session/.test(postNewLog)) {
		throw new Error("no `session_start:new: clearing session` marker — bridge didn't observe /new");
	}

	// First syncResult after /new must be clean-start (sharedSession=null,
	// no prior messages on the fresh agent state).
	const syncResults = [...postNewLog.matchAll(/syncResult: path=(reuse|rebuild|clean-start)/g)].map((m) => m[1]);
	console.log(`  Post-/new syncResults: ${JSON.stringify(syncResults)}`);
	if (syncResults.length === 0) {
		throw new Error("no syncResult markers after /new (Turn 3 didn't reach the provider?)");
	}
	if (syncResults[0] !== "clean-start") {
		throw new Error(
			`bridge took ${syncResults[0]} path after /new — expected clean-start.\n` +
			`       sharedSession should be cleared by the session_start:new handler.`);
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
