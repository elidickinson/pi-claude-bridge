#!/usr/bin/env node
// Regression: extension-provided compactions preserve cumulative file-op
// carry-forward across a second compaction.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

// Force each /compact to discard older turns instead of summarizing an empty
// prefix while preserving all recent context.
const testAgentDir = mkdtempSync(join(tmpdir(), "compact-second-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
	compaction: { keepRecentTokens: 50 },
}));

const harness = createRpcHarness({
	name: "compact-second-compact",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { start, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

function assertMentions(summary, file) {
	if (!summary.includes(file)) {
		throw new Error(`summary missing ${file}. Summary head: ${summary.slice(0, 500)}`);
	}
}

async function forceDiscardableHistory(file, marker) {
	await promptAndWait(
		`Use the read tool to read ${file}. Then reply with exactly '${marker}'.`,
		TIMEOUT,
	);
	await promptAndWait(
		"List 15 European capital cities, one per line, numbered. Nothing else.",
		TIMEOUT,
	);
}

let finishing = false;
function finish(code, msg) {
	if (finishing) return;
	finishing = true;
	console.log(msg);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
		try { console.log(`  Debug tail: ${readFileSync(DEBUG_LOG, "utf8").slice(-3000)}`); } catch {}
	}
	stop().then(() => {
		rmSync(testAgentDir, { recursive: true, force: true });
		process.exit(code);
	});
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	console.log("Round 1: force a read of file A into compacted history...");
	await forceDiscardableHistory("tests/fixtures/compact-file-a.txt", "read-a-ok");

	console.log("First /compact...");
	const first = await send({ type: "compact" }, TIMEOUT);
	if (!first?.summary?.trim()) throw new Error(`first compact returned empty summary: ${JSON.stringify(first)}`);
	assertMentions(first.summary, "tests/fixtures/compact-file-a.txt");

	console.log("Round 2: force a read of file B into compacted history...");
	await forceDiscardableHistory("tests/fixtures/compact-file-b.txt", "read-b-ok");

	console.log("Second /compact...");
	const second = await send({ type: "compact" }, TIMEOUT);
	if (!second?.summary?.trim()) throw new Error(`second compact returned empty summary: ${JSON.stringify(second)}`);
	assertMentions(second.summary, "tests/fixtures/compact-file-a.txt");
	assertMentions(second.summary, "tests/fixtures/compact-file-b.txt");

	finish(0, "PASS");
} catch (e) {
	finish(1, `FAIL: ${e.message}\n${e.stack}`);
}
