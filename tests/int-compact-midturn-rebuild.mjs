#!/usr/bin/env node
// Regression: a compaction that lands *inside* a turn must reach Claude Code (issue #101).
//
// pi checks the compaction threshold at every turn boundary of a run, not only
// between user prompts: agent-session's prepareNextTurnWithContext calls
// _compactBeforeNextAssistantResponse after the tool results are in and before
// the next assistant request. One pi turn is one Claude Code query, and that
// query holds its own context inside the CLI subprocess — so pi shrinking its
// transcript does nothing to it. The bridge then delivered the tool result into
// that still-running query, which answered off the pre-compaction context,
// reported the pre-compaction usage back to pi, and tripped the threshold again
// at the next boundary: one tool call of progress per compaction, forever.
//
// Reported twice with numbers (#101): cacheRead 123,261 → 131,271 across seven
// compactions on a 140K window, and tokensBefore 184,838 → 216,810 across
// fourteen on a 200K one. Neither ever dropped.
//
// Determinism: the compaction has to fire mid-turn, and pi also checks the
// threshold before a prompt is submitted. So auto-compaction starts *off* and is
// switched on from the test at the first tool execution of the measured turn —
// by then the turn is running and the pre-prompt check is behind us, so the next
// boundary inside the run is the one that compacts.
//
// The threshold is calibrated, not guessed: a probe run measures what one
// minimal turn through this bridge actually costs (the Claude Code preset, the
// served pi tools, the transcript), and the threshold is set that far plus a
// margin, so a seeded turn that reads two ~48KB files is over it while the
// compacted history is comfortably under.
//
// Expected:
//   - RED (bug present): the first usage Claude Code reports after the
//     compaction is the pre-compaction context, near-unchanged.
//   - GREEN (fixed): the query is discarded at the boundary and the turn
//     continues from a rebuilt session, so that usage drops to roughly the
//     compacted history, and the turn still finishes with its marker.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const CONTEXT_WINDOW = 200_000; // what pi registers for the model above
const TEST_TIMEOUT = 300_000;
const PROBE_TIMEOUT = 120_000;

// Headroom over one minimal turn. The compacted history (summary + the kept
// tail) has to land under this and the seeded history above it; the seed below
// is worth ~25K tokens, so anything in the middle separates them.
const THRESHOLD_MARGIN = 10_000;

// pi's read tool truncates at 50KB, so a file bigger than this buys nothing.
const BIG_FILE_BYTES = 48 * 1024;

const agentDir = mkdtempSync(join(tmpdir(), "compact-midturn-agent-"));
const fixtureDir = join(process.cwd(), ".test-output", "compact-midturn-fixtures");

function writeSettings(compaction) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction }));
}

/** A file of ~BIG_FILE_BYTES that no model can shorten by guessing: the words are
 *  random, so it costs real tokens and cannot be recalled from the summary. */
function writeBigFixture(name, seed) {
	mkdirSync(fixtureDir, { recursive: true });
	const path = join(fixtureDir, name);
	const lines = [];
	let rnd = seed;
	while (lines.join("\n").length < BIG_FILE_BYTES) {
		const words = [];
		for (let i = 0; i < 12; i++) {
			rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
			words.push(rnd.toString(36));
		}
		lines.push(`${lines.length + 1}: ${words.join(" ")}`);
	}
	writeFileSync(path, lines.join("\n"));
	return path;
}

/** in + cacheRead + cacheWrite off one of the bridge's `usage:` debug lines —
 *  the prompt half of the request, which is what pi's threshold reads and what
 *  a stale query keeps reporting. */
function promptTokens(line) {
	const match = /usage: in=(\d+) out=\d+ cacheRead=(\d+) cacheWrite=(\d+)/.exec(line);
	return match ? Number(match[1]) + Number(match[2]) + Number(match[3]) : null;
}

function usageLines(debugLog) {
	return readFileSync(debugLog, "utf8").split("\n").filter((line) => promptTokens(line) !== null);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// --- Probe: what does one minimal turn through this bridge cost? ---

writeSettings({ enabled: false, reserveTokens: 1000, keepRecentTokens: 50 });
const probe = createRpcHarness({
	name: "compact-midturn-probe",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: PROBE_TIMEOUT,
});
let baseTokens = 0;
await probe.startAndWait();
try {
	await probe.promptAndWait('Reply with exactly "probe-ok". Do not use tools.', PROBE_TIMEOUT);
	const measured = usageLines(probe.DEBUG_LOG).map(promptTokens);
	assert(measured.length > 0, `probe produced no usage lines — see ${probe.DEBUG_LOG}`);
	baseTokens = Math.max(...measured);
	console.log(`Probe: one minimal turn costs ${baseTokens} prompt tokens`);
} finally {
	await probe.stop();
}

const threshold = baseTokens + THRESHOLD_MARGIN;
writeSettings({
	enabled: false,
	reserveTokens: CONTEXT_WINDOW - threshold,
	keepRecentTokens: 50,
});
console.log(`Threshold for the run: ${threshold} tokens (reserveTokens=${CONTEXT_WINDOW - threshold})`);

// --- The run ---

const bigA = writeBigFixture("big-a.txt", 11);
const bigB = writeBigFixture("big-b.txt", 977);

const harness = createRpcHarness({
	name: "compact-midturn",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: TEST_TIMEOUT,
});
const { startAndWait, stop, send, promptAndWait, addListener, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	console.log("Seed: read two large files with auto-compaction off...");
	const seed = await promptAndWait(
		`Use the read tool to read ${bigA} and then ${bigB}, one at a time. ` +
		'Then reply with exactly "seed-ok" and nothing else.',
		TEST_TIMEOUT,
	);
	assert(/seed-ok/i.test(seed), `seed turn did not confirm the reads. Got: ${seed.slice(0, 300)}`);
	const seededTokens = Math.max(...usageLines(DEBUG_LOG).map(promptTokens));
	console.log(`  seeded context: ${seededTokens} prompt tokens (threshold ${threshold})`);
	assert(
		seededTokens > threshold,
		`seed did not cross the threshold (${seededTokens} <= ${threshold}), so nothing would compact mid-turn`,
	);

	// Auto-compaction goes on once the measured turn is already running, so the
	// compaction lands at a turn boundary inside it rather than before it.
	let turnRunning = false;
	let enabling;
	const compactionStarts = [];
	const compactionsInTurn = [];
	addListener((msg) => {
		if (msg.type === "tool_execution_start" && turnRunning && !enabling) {
			enabling = send({ type: "set_auto_compaction", enabled: true }, 30_000);
		}
		if (msg.type === "compaction_start") {
			compactionStarts.push(msg);
			if (turnRunning) compactionsInTurn.push(msg);
		}
	});

	console.log("Measured turn: several small tool calls, auto-compaction enabled mid-turn...");
	turnRunning = true;
	const answer = await promptAndWait(
		"Use the read tool to read these files, one at a time, waiting for each result before " +
		"starting the next: package.json, tsconfig.json, tests/fixtures/compact-file-a.txt, " +
		"tests/fixtures/compact-file-b.txt, LICENSE. Do not read anything else. " +
		'Then reply with exactly "midturn-ok" and nothing else.',
		TEST_TIMEOUT,
	);
	turnRunning = false;
	if (enabling) await enabling;

	assert(
		compactionsInTurn.length > 0,
		`no compaction fired while the turn was running (${compactionStarts.length} outside it) — ` +
		"the boundary this test is about was never reached",
	);
	console.log(`  compactions during the turn: ${compactionsInTurn.length}`);

	// The turn has to survive the compaction: discarding the query must continue
	// the turn from the rebuilt session, not end it on an orphaned tool result.
	assert(
		/midturn-ok/i.test(answer),
		`the turn did not finish after the mid-turn compaction. Got: ${answer.slice(0, 300)}`,
	);

	const lines = readFileSync(DEBUG_LOG, "utf8").split("\n");
	const compactedAt = lines.findIndex((line) => /session_compact:threshold/.test(line));
	assert(compactedAt !== -1, `debug log has no session_compact:threshold line — see ${DEBUG_LOG}`);

	const before = lines.slice(0, compactedAt).map(promptTokens).filter((n) => n !== null).at(-1);
	const after = lines.slice(compactedAt).map(promptTokens).filter((n) => n !== null)[0];
	assert(before != null, "no usage line before the compaction");
	assert(after != null, "no usage line after the compaction — the turn reported nothing further");
	console.log(`  prompt tokens before the compaction: ${before}`);
	console.log(`  prompt tokens after the compaction:  ${after}`);

	// Half is generous either way: the compacted history is a summary plus a
	// couple of small reads, while a resumed pre-compaction query reports what it
	// always did, minus nothing.
	assert(
		after < before * 0.5,
		`Claude Code kept the pre-compaction context: ${after} prompt tokens after the compaction ` +
		`against ${before} before it (want under ${Math.round(before * 0.5)}). The compaction never ` +
		`reached the running query — each further tool result re-crosses the threshold (issue #101).`,
	);

	const debugLog = lines.join("\n");
	assert(
		!/MCP handlers still waiting/.test(debugLog),
		"a tool handler was left waiting — the discarded query stranded one",
	);

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	await stop();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(fixtureDir, { recursive: true, force: true });
}
