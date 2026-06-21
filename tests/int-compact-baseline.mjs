#!/usr/bin/env node
// Baseline: pi-side /compact works end-to-end through the bridge.
//
// Companion to int-compact-during-tools.mjs. Establishes that the harness,
// model, and compact RPC path are healthy before asserting anything about
// concurrency. If this fails, fix the environment/harness first — the
// concurrency test is meaningless on top of a broken baseline.

import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const harness = createRpcHarness({
	name: "compact-baseline",
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
	console.log("Seed: a few short turns so there is history to compact...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number.");
	await promptAndWait("Now pick a color. Reply with just the color.");
	await promptAndWait("Now pick a fruit. Reply with just the fruit.");

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

	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
