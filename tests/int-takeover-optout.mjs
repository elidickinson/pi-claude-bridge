#!/usr/bin/env node
// compaction.takeover / branchSummary.takeover, end to end against real pi.
//
// The bridge answers `session_before_compact` and `session_before_tree` for every
// bridge model. Both flags let another extension own those summaries instead. What
// needs proving is that standing down actually yields: the runner keeps the *last*
// truthy handler result, and the bridge is loaded before the extension here, so a
// takeover that still ran would produce a summary that gets overwritten — paying for
// a discarded call — and a takeover that failed would return `cancel` and short-circuit
// the emit before the other handler was ever reached.
//
// The two flags are not symmetrical, and the third case pins that down. Compaction
// falls through safely with or without another handler. Branch summaries do not:
// they run through the agent's stream function, so pi's summarization prompt reaches
// the provider unrecorded and `resolveOrDerive` throws. Turning that flag off is only
// sound when something else answers the event.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { BRANCH_SENTINEL, COMPACTION_SENTINEL } from "./fixtures/summary-override-extension.js";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

/** Agent dir carrying the bridge config under test. `getAgentDir()` honours
 *  PI_CODING_AGENT_DIR, so this is how claude-bridge.json gets injected without
 *  touching the developer's real one. keepRecentTokens is small so a handful of
 *  short turns is enough for prepareCompaction to have something to cut. */
function agentDir(name, bridgeConfig) {
	const dir = mkdtempSync(join(tmpdir(), `takeover-${name}-`));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));
	writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify(bridgeConfig));
	return dir;
}

function markerPath(name) {
	const path = join(mkdtempSync(join(tmpdir(), `takeover-marker-${name}-`)), "marker.log");
	writeFileSync(path, "");
	return path;
}

function cleanup(...paths) {
	for (const path of paths) rmSync(path, { recursive: true, force: true });
}

function readMarker(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** A slash command returns before navigation finishes and emits no agent_end, so
 *  poll the artifact the work leaves behind rather than racing it. */
async function waitFor(read, pattern, timeout = 90_000) {
	const deadline = Date.now() + timeout;
	let last = "";
	while (Date.now() < deadline) {
		last = read();
		if (pattern.test(last)) return last;
		await sleep(500);
	}
	return last;
}

describe("compaction.takeover: false hands compaction to another extension", () => {
	const dir = agentDir("compact", { compaction: { takeover: false } });
	const marker = markerPath("compact");
	const harness = createRpcHarness({
		name: "takeover-optout-compact",
		args: ["-e", "./tests/fixtures/summary-override-extension.ts", "--model", BRIDGE_MODEL],
		env: { PI_CODING_AGENT_DIR: dir, SUMMARY_OVERRIDE_MARKER: marker },
		defaultTimeout: TIMEOUT,
	});
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => {
		await stop();
		cleanup(dir, dirname(marker));
	});

	it("uses the extension's summary and never runs its own", { timeout: TIMEOUT }, async () => {
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");
		await promptAndWait("Reply with exactly the word BETA and nothing else.");

		const result = await send({ type: "compact" }, TIMEOUT);

		assert.equal(
			result.summary,
			COMPACTION_SENTINEL,
			`compaction did not come from the extension: ${JSON.stringify(result.summary)?.slice(0, 300)}`,
		);
		assert.ok(result.firstKeptEntryId, "extension compaction lost firstKeptEntryId");

		// Persisted, not merely returned from the handler.
		const marks = await waitFor(() => readMarker(marker), /compacted /);
		assert.match(marks, /before_compact reason=manual/, `the extension's handler never ran:\n${marks}`);
		assert.match(
			marks,
			new RegExp(`compacted fromExtension=true summary="${COMPACTION_SENTINEL}"`),
			`the extension's summary is not what landed in the session:\n${marks}`,
		);

		const log = readFileSync(DEBUG_LOG, "utf8");
		assert.match(log, /session_before_compact: takeover disabled, deferring reason=manual/, "the bridge never logged standing down");
		// The whole point of the flag: no discarded summarization.
		assert.doesNotMatch(log, /session_before_compact: takeover complete/, "the bridge summarized anyway, and that work was thrown away");
	});
});

describe("branchSummary.takeover: false hands branch summarization to another extension", () => {
	const dir = agentDir("branch", { branchSummary: { takeover: false } });
	const marker = markerPath("branch");
	const harness = createRpcHarness({
		name: "takeover-optout-branch",
		args: [
			"-e", "./tests/fixtures/tree-nav-extension.ts",
			"-e", "./tests/fixtures/summary-override-extension.ts",
			"--model", BRIDGE_MODEL,
		],
		env: { PI_CODING_AGENT_DIR: dir, SUMMARY_OVERRIDE_MARKER: marker },
		defaultTimeout: TIMEOUT,
	});
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => {
		await stop();
		cleanup(dir, dirname(marker));
	});

	it("uses the extension's summary and never runs its own", { timeout: TIMEOUT }, async () => {
		// Two turns, so rewinding to the first leaves a branch worth summarizing.
		await promptAndWait("Reply with exactly the word GAMMA and nothing else.");
		await promptAndWait("Reply with exactly the word DELTA and nothing else.");

		await send({ type: "prompt", message: "/rewind-summarize" });

		const marks = await waitFor(() => readMarker(marker), /navigated /);
		assert.match(marks, /before_tree entries=\d+/, `the extension's handler never ran:\n${marks}`);
		assert.match(
			marks,
			new RegExp(`navigated fromExtension=true summary="${BRANCH_SENTINEL}"`),
			`the extension's summary is not what landed on the branch entry:\n${marks}`,
		);

		const log = readFileSync(DEBUG_LOG, "utf8");
		assert.match(log, /session_before_tree: takeover disabled, deferring/, "the bridge never logged standing down");
		assert.doesNotMatch(log, /session_before_tree: takeover complete/, "the bridge summarized anyway, and that work was thrown away");
	});
});

describe("branchSummary.takeover: false with nothing else answering", () => {
	const dir = agentDir("orphan", { branchSummary: { takeover: false } });
	const marker = markerPath("orphan");
	const harness = createRpcHarness({
		name: "takeover-optout-orphan",
		args: [
			"-e", "./tests/fixtures/tree-nav-extension.ts",
			"-e", "./tests/fixtures/summary-override-extension.ts",
			"--model", BRIDGE_MODEL,
		],
		// probe mode: the fixture records the outcome but answers neither event.
		env: { PI_CODING_AGENT_DIR: dir, SUMMARY_OVERRIDE_MARKER: marker, SUMMARY_OVERRIDE_MODE: "probe" },
		defaultTimeout: TIMEOUT,
	});
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => {
		await stop();
		cleanup(dir, dirname(marker));
	});

	// Documents the asymmetry the README warns about, and the reason the flag is not
	// simply "restore pi's native behaviour". Falling through reaches the provider
	// with a system prompt no before_agent_start recorded, so `resolveOrDerive`
	// refuses it rather than silently sending Claude Code no context files or skills.
	// That refusal is deliberate (e1677f5); this pins the consequence.
	it("refuses the summary, because falling through cannot work on a bridge model", { timeout: TIMEOUT }, async () => {
		await promptAndWait("Reply with exactly the word EPSILON and nothing else.");
		await promptAndWait("Reply with exactly the word ZETA and nothing else.");

		// RPC_LOG is appended across runs, so slice from here.
		const debugMark = statSync(DEBUG_LOG).size;
		const rpcMark = statSync(RPC_LOG).size;
		await send({ type: "prompt", message: "/rewind-summarize" });

		const log = await waitFor(
			() => readFileSync(DEBUG_LOG, "utf8").slice(debugMark),
			/session_before_tree: takeover disabled, deferring/,
		);
		assert.match(log, /session_before_tree: takeover disabled, deferring/, `the bridge never stood down:\n${log.slice(-1500)}`);

		// The refusal itself, rather than an empty marker that would also match a
		// navigation that simply never started.
		const rpc = await waitFor(
			() => readFileSync(RPC_LOG, "utf8").slice(rpcMark),
			/no capture for this \d+-char system prompt/,
		);
		assert.match(
			rpc,
			/no capture for this \d+-char system prompt/,
			`expected the prompt resolver to refuse pi's branch-summary prompt:\n${rpc.slice(-1500)}`,
		);

		// And nothing was written to the branch either way.
		const marks = readMarker(marker);
		assert.doesNotMatch(
			marks,
			/navigated fromExtension=\w+ summary="[^"]/,
			`a branch summary was produced with no handler to produce it:\n${marks}`,
		);
	});
});
