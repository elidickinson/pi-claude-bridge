#!/usr/bin/env node
// Switching to a different account profile mid-conversation must rebuild the
// Claude Code session under the new profile's provider id — rotated, with the
// history intact — instead of resuming a session file the new profile's config
// dir cannot see ("No conversation found").
//
// Self-contained with ONE real account: the test registers an extra profile
// with `configDir: null` (strip semantics) in a throwaway agent dir, so both
// providers resolve to the same login. That exercises registration, /model
// routing to a profile provider, and the rotated-profile rebuild against a
// live CC subprocess — NOT the env isolation between two real accounts, which
// only a second login can prove (unit tests cover the env/dir policy itself).

import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectDir } from "cc-session-io";

const TIMEOUT = 90_000;

console.log("=== profile-switch-test.mjs ===");

const CWD = mkdtempSync(join(tmpdir(), "profile-switch."));
const AGENT_DIR = mkdtempSync(join(tmpdir(), "profile-switch-agent."));
writeFileSync(join(AGENT_DIR, "claude-bridge.json"), JSON.stringify({
	provider: { profiles: [{ slug: "alt", label: "Alt", configDir: null }] },
}));

const harness = createRpcHarness({
	name: "profile-switch",
	args: ["--model", "claude-bridge/claude-haiku-4-5", "-e", process.cwd()],
	cwd: CWD,
	env: { PI_CODING_AGENT_DIR: AGENT_DIR },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait } = harness;

function fail(msg) {
	console.error(`FAIL: ${msg}`);
	console.error(`  RPC log:   ${harness.RPC_LOG}`);
	console.error(`  Debug log: ${harness.DEBUG_LOG}`);
	process.exitCode = 1;
}

await startAndWait();
try {
	console.log("Turn 1 on claude-bridge: plant a codeword...");
	const first = await promptAndWait(
		"The codeword is PINEAPPLE. Acknowledge with just the word OK.",
		TIMEOUT,
	);
	console.log(`  Response: ${first.trim().slice(0, 60)}`);

	console.log("Switching to claude-bridge-alt/claude-haiku-4-5...");
	await send({ type: "set_model", provider: "claude-bridge-alt", modelId: "claude-haiku-4-5" }, TIMEOUT);

	console.log("Turn 2 on the alt profile: recall through the rebuilt session...");
	const answer = await promptAndWait(
		"What is the codeword from earlier in this conversation? Reply with just the codeword, or NONE if you cannot see one.",
		TIMEOUT,
	);
	console.log(`  Response: ${answer.trim().slice(0, 80)}`);
	if (!/pineapple/i.test(answer)) {
		fail(`history did not survive the profile switch (got: ${answer.trim().slice(0, 120)})`);
	}

	// The switch must have gone down the rotated-profile REBUILD, not REUSE:
	// resuming the old id under another profile is exactly the cross-account
	// failure mode this feature exists to prevent.
	const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
	if (!debugLog.includes("rotated-profile")) {
		fail("debug log shows no rotated-profile rebuild — the switch resumed or preserved the old profile's session");
	}

	if (!process.exitCode) console.log("PASS");
} catch (err) {
	if (!process.exitCode) throw err;
} finally {
	await stop();
	const projectDir = getProjectDir(CWD);
	rmSync(CWD, { recursive: true, force: true });
	rmSync(AGENT_DIR, { recursive: true, force: true });
	if (projectDir.includes("profile-switch")) rmSync(projectDir, { recursive: true, force: true });
}
