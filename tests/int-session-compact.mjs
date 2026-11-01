#!/usr/bin/env node
// Compacted content must replace the old conversation in a new CC session,
// without mutating the ancestor or resuming stale pre-compact history (#8).

console.log("=== int-session-compact.mjs ===");

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionPath } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const testAgentDir = mkdtempSync(join(tmpdir(), "session-compact-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "session-compact",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	// A few substantive turns so pi has something to compact.
	console.log("Turn 1: seed history...");
	await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number. Do not use the memory system.");
	console.log("Turn 2: more history...");
	await promptAndWait("Now pick a color. Reply with just the color. Do not use the memory system.");
	console.log("Turn 3: more history...");
	await promptAndWait("Now pick a fruit. Reply with just the fruit. Do not use the memory system.");

	const beforeLog = readFileSync(DEBUG_LOG, "utf8");
	const preCompactSessionId = [...beforeLog.matchAll(/syncResult: path=[a-z-]+ sessionId=([a-f0-9-]+)/g)].at(-1)?.[1];
	assert.ok(preCompactSessionId, "no pre-compact sessionId found");
	const ancestorPath = getSessionPath(preCompactSessionId, fileURLToPath(new URL("../", import.meta.url)), process.env.CLAUDE_CONFIG_DIR);
	const ancestor = readFileSync(ancestorPath);

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
	const syncResults = [...postEventLog.matchAll(/syncResult: path=([a-z-]+)(?: sessionId=([a-f0-9-]+))?/g)]
		.map((m) => ({ path: m[1], sessionId: m[2] }));
	console.log(`  Post-event syncResults: ${JSON.stringify(syncResults)}`);

	if (syncResults.length === 0) {
		throw new Error("no syncResult markers after session_compact event (Turn 4 didn't reach the provider?)");
	}

	const first = syncResults[0];

	// First syncResult after the event must NOT reuse — pi's history has
	// shrunk and CC's session JSONL is now stale.
	if (first.path === "clean-start") {
		throw new Error(
			"first syncResult after session_compact was clean-start. The compact summarization " +
			"call landed after the event marker, so this test cannot verify Turn 4's rebuild.");
	}
	if (first.path === "reuse") {
		throw new Error(
			"bridge took REUSE path after session_compact — CC will resume the pre-compact session. " +
			"Expected REBUILD (or clean-start) so CC sees the post-compact history. " +
			"Symptom: triggers Claude Code's autocompact-thrashing (issue #8) on long sessions.");
	}

	assert.ok(["rebuild", "prefix-write", "fork"].includes(first.path), `unexpected sync path: ${first.path}`);
	assert.ok(first.sessionId, "the changed history must have a CC session id");
	assert.notEqual(first.sessionId, preCompactSessionId, "compaction must not overwrite the old transcript");
	assert.deepEqual(readFileSync(ancestorPath), ancestor, "compaction mutated the ancestor transcript");

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
