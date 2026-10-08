#!/usr/bin/env node
// Verifies logServedContextWindow fires on a real provider turn: after one
// bridge prompt, the debug log must contain a "served contextWindow=…"
// line emitted from consumeQuery's result handler (issue #18 diagnostics).
//
// Haiku keeps it cheap; the path is identical to opus/sonnet.

import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 120_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

const testAgentDir = mkdtempSync(join(tmpdir(), "served-window-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({}));

const harness = createRpcHarness({
	name: "served-window",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

try {
	console.log("Single bridge prompt to exercise the provider result path...");
	const text = await promptAndWait('Reply with just the word "yes".');
	if (!/yes/i.test(text)) {
		throw new Error(`unexpected reply: ${text.slice(0, 200)}`);
	}

	const debug = readFileSync(DEBUG_LOG, "utf8");
	const line = debug.split("\n").find((l) => /result: served contextWindow=/.test(l));
	if (!line) {
		throw new Error(`debug log has no "result: served contextWindow=" line.\n\nExcerpt:\n${debug.slice(-2000)}`);
	}
	console.log(`  ${line.trim()}`);

	// The line must carry both the served value and the registered value so the
	// gap is observable in one place.
	if (!/served contextWindow=\d+/.test(line)) throw new Error("missing served contextWindow number");
	if (!/registered=\d+/.test(line)) throw new Error("missing registered number");
	if (!/servedModel=/.test(line)) throw new Error("missing servedModel");

	// The bridge's invariant: pi's registered window must equal the window CC
	// actually serves, or pi's status bar and auto-compaction threshold drift
	// from reality (issue #24/#17). Account-agnostic — holds on any plan.
	const served = Number(line.match(/served contextWindow=(\d+)/)[1]);
	const registered = Number(line.match(/registered=(\d+)/)[1]);
	if (served !== registered) {
		throw new Error(`served contextWindow (${served}) != registered (${registered}); pi's compaction threshold is out of sync with the CC window.\n  ${line.trim()}`);
	}

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
}
