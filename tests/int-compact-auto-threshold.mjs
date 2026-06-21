#!/usr/bin/env node
// Regression: real auto-threshold compaction exercises the bridge takeover.
//
// Unlike the manual /compact tests, this goes through pi's pre-prompt
// AgentSession._checkCompaction() path and observes threshold compaction events.
// keepRecentTokens=50 intentionally forces the split-turn dual-summary path that
// used to hang through streamClaudeAgentSdk.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const COMPACT_TIMEOUT = 120_000;
const TEST_TIMEOUT = 240_000;

const testAgentDir = mkdtempSync(join(tmpdir(), "compact-auto-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { enabled: false, reserveTokens: 198000, keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-auto-threshold",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { start, stop, send, promptAndWait, waitForMatch, DEBUG_LOG, RPC_LOG } = harness;

let finishing = false;
function finish(code, msg) {
	if (finishing) return;
	finishing = true;
	console.log(msg);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
		try { console.log(`  Debug tail: ${readFileSync(DEBUG_LOG, "utf8").slice(-4000)}`); } catch {}
	}
	stop().then(() => {
		rmSync(testAgentDir, { recursive: true, force: true });
		process.exit(code);
	});
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertReadFile(details, suffix) {
	const readFiles = details?.readFiles;
	assert(Array.isArray(readFiles), `readFiles missing/invalid in details: ${JSON.stringify(details)}`);
	assert(
		readFiles.some((file) => String(file).endsWith(suffix)),
		`readFiles missing ${suffix}. Got: ${JSON.stringify(readFiles)}`,
	);
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	console.log("Seed turn A: force file A read while auto-compaction is disabled...");
	const seedA = await promptAndWait(
		'Use the read tool to read tests/fixtures/compact-file-a.txt. Then reply with exactly "read-a-ok".',
		TEST_TIMEOUT,
	);
	assert(/read-a-ok/i.test(seedA), `seed A did not confirm read. Got: ${seedA.slice(0, 200)}`);

	console.log("Seed turn B: force file B read and a larger assistant response...");
	const seedB = await promptAndWait(
		'Use the read tool to read tests/fixtures/compact-file-b.txt. Do not write or edit files. Then reply in chat with 120 numbered lines about European capital cities. Include the exact phrase "AUTO-COMPACT-SPLIT-SEED" on line 60.',
		TEST_TIMEOUT,
	);
	assert(
		/AUTO-COMPACT-SPLIT-SEED/.test(seedB),
		`seed B did not include split seed marker. Got tail: ${seedB.slice(-500)}`,
	);

	const thresholdStarts = [];
	const thresholdEnds = [];
	let disableAutoPromise;
	harness.addListener((msg) => {
		if (msg.type === "compaction_start" && msg.reason === "threshold") {
			thresholdStarts.push(msg);
			if (!disableAutoPromise) {
				disableAutoPromise = send({ type: "set_auto_compaction", enabled: false }, 30_000).catch((err) => {
					throw new Error(`failed to disable auto-compaction after threshold start: ${err.message}`);
				});
			}
		} else if (msg.type === "compaction_end" && msg.reason === "threshold") {
			thresholdEnds.push(msg);
		}
	});

	const startPromise = waitForMatch(
		(msg) => msg.type === "compaction_start" && msg.reason === "threshold",
		"threshold compaction_start",
		COMPACT_TIMEOUT,
	);
	const endPromise = waitForMatch(
		(msg) => msg.type === "compaction_end" && msg.reason === "threshold",
		"threshold compaction_end",
		COMPACT_TIMEOUT,
	);

	console.log("Enable auto-compaction and submit a normal prompt (not RPC compact)...");
	await send({ type: "set_auto_compaction", enabled: true }, 30_000);
	const answerPromise = promptAndWait(
		'Do not use tools. Reply on the first line with exactly "auto-compact-continued". If you know the earlier file A path, put it on a second line; otherwise leave the second line blank.',
		TEST_TIMEOUT,
	);

	await startPromise;
	if (disableAutoPromise) await disableAutoPromise;
	const endEvent = await endPromise;
	const answer = await answerPromise;

	assert(thresholdStarts.length === 1, `expected exactly one threshold compaction_start, got ${thresholdStarts.length}`);
	assert(thresholdEnds.length === 1, `expected exactly one threshold compaction_end, got ${thresholdEnds.length}`);
	assert(endEvent.aborted === false, `threshold compaction aborted: ${JSON.stringify(endEvent)}`);
	assert(endEvent.result?.summary?.trim(), `threshold compaction returned empty summary: ${JSON.stringify(endEvent)}`);
	assert(endEvent.result?.firstKeptEntryId, `threshold compaction returned no firstKeptEntryId: ${JSON.stringify(endEvent)}`);
	assert((endEvent.result?.tokensBefore ?? 0) > 0, `threshold compaction returned invalid tokensBefore: ${JSON.stringify(endEvent)}`);
	assert(
		/Turn Context \(split turn\)/.test(endEvent.result.summary),
		`threshold compaction summary lacks split-turn marker. Summary head: ${endEvent.result.summary.slice(0, 500)}`,
	);
	assertReadFile(endEvent.result.details, "compact-file-a.txt");
	assertReadFile(endEvent.result.details, "compact-file-b.txt");

	assert(answer.trim(), "post-compact prompt reached agent_end but returned empty text");
	assert(
		/auto-compact-continued/i.test(answer),
		`post-compact prompt did not return continuation marker. Got: ${answer.slice(0, 300)}`,
	);
	if (/tests\/fixtures\/compact-file-a\.txt/.test(answer)) {
		console.log("  post-compact answer echoed file A path");
	}

	// Give any accidental second threshold compaction a chance to surface. The
	// disable-on-start RPC is load-bearing because the huge reserve would otherwise
	// keep triggering threshold compaction after the continuation answer.
	await new Promise((r) => setTimeout(r, 1500));
	assert(thresholdStarts.length === 1, `second threshold compaction_start fired (${thresholdStarts.length} total)`);
	assert(thresholdEnds.length === 1, `second threshold compaction_end fired (${thresholdEnds.length} total)`);

	const debugLog = readFileSync(DEBUG_LOG, "utf8");
	assert(/session_before_compact: takeover/.test(debugLog), "debug log missing compact takeover marker");
	assert(
		/session_before_compact: takeover complete summaryLen=/.test(debugLog),
		"debug log missing compact takeover completion marker",
	);
	const compactSpawns = [...debugLog.matchAll(/compact summary: spawn/g)].length;
	assert(compactSpawns >= 2, `expected at least 2 isolated compact summary spawns, got ${compactSpawns}`);
	assert(!/currentPiStream overwritten/.test(debugLog), "debug log reported currentPiStream overwrite");

	console.log(`  summary:      ${endEvent.result.summary.slice(0, 80).replace(/\n/g, " ")}...`);
	console.log(`  tokensBefore: ${endEvent.result.tokensBefore}`);
	console.log(`  readFiles:    ${JSON.stringify(endEvent.result.details.readFiles)}`);
	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
