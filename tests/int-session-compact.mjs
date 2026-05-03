#!/usr/bin/env node
// Verifies the bridge rebuilds CC's session JSONL after a pi-side /compact.
//
// Bug it guards against: syncSharedSession's REUSE check uses
// `priorMessages.slice(sharedSession.cursor)`. After /compact, pi shrinks
// its messages array — slice(N) on a shorter array returns []. Without an
// explicit signal, REUSE wins and CC keeps `--resume`ing the pre-compact
// session, which then thrashes its own autocompact (issue #8).
//
// Fix: subscribe to pi's `session_compact` event and set
// sharedSession.needsRebuild = true so the next syncSharedSession call
// takes the REBUILD path.

console.log("=== int-session-compact.mjs ===");

import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const harness = createRpcHarness({
	name: "session-compact",
	args: ["--model", BRIDGE_MODEL],
	defaultTimeout: TIMEOUT,
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
	stop().then(() => process.exit(code));
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	// A few substantive turns so pi has something to compact.
	console.log("Turn 1: seed history...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number.");
	console.log("Turn 2: more history...");
	await promptAndWait("Now pick a color. Reply with just the color.");
	console.log("Turn 3: more history...");
	await promptAndWait("Now pick a fruit. Reply with just the fruit.");

	console.log("Triggering /compact...");
	await send({ type: "compact" });

	console.log("Turn 4: prompt after compact (should force REBUILD)...");
	await promptAndWait("Are you still there? Reply with just 'yes'.");

	// Split the log at the `session_compact:` marker. Reads BEFORE the
	// marker (including the summarization call pi made via our provider,
	// which legitimately uses the pre-compact session) don't matter — we
	// care about the first syncResult AFTER the event fires, which is
	// Turn 4's user prompt.
	const fullLog = readFileSync(DEBUG_LOG, "utf8");
	const compactIdx = fullLog.indexOf("session_compact:");
	if (compactIdx === -1) {
		throw new Error("no `session_compact:` debug marker — handler not subscribed?");
	}
	const postEventLog = fullLog.slice(compactIdx);

	const syncResults = [...postEventLog.matchAll(/syncResult: path=(reuse|rebuild|clean-start)/g)].map((m) => m[1]);
	console.log(`  Post-event syncResults: ${JSON.stringify(syncResults)}`);

	if (syncResults.length === 0) {
		throw new Error("no syncResult markers after session_compact event (Turn 4 didn't reach the provider?)");
	}

	// First syncResult after the event must NOT reuse — pi's history has
	// shrunk and CC's session JSONL is now stale.
	if (syncResults[0] === "reuse") {
		throw new Error(
			"bridge took REUSE path after session_compact — CC will resume the pre-compact session. " +
			"Expected REBUILD (or clean-start) so CC sees the post-compact history. " +
			"Symptom: triggers Claude Code's autocompact-thrashing (issue #8) on long sessions.");
	}

	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
