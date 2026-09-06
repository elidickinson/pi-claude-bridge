#!/usr/bin/env node
// The turn after an abort must not resume or rewrite-in-place the session the
// killed Claude Code child was using.
//
// `forceRotate` exists for exactly this: syncSharedSession preserves the session
// UUID (deleteSession + createSession at the same path) unless there is "a
// concurrent writer we shouldn't race". An aborted child is that writer. But the
// flag is set in the query's `.then`, which runs when the SDK consumer unwinds —
// not when pi acknowledges the abort. If the next turn's sync wins that race it
// sees a clean `sharedSession`, takes REUSE or the preserved rebuild, and hands
// the dying child's own JSONL to the next query.
//
// The assertion is on ordering, not on the model forgetting: whether a raced
// rewrite actually loses history depends on how far the child got with its own
// writes, so the loss is intermittent while the ordering violation is the defect.
// The recall check is reported, never asserted, so a pass is never mistaken for
// proof that the ordering was safe.
//
// Whether the race is *lost* depends on how fast the SDK consumer unwinds, so
// this guard is version-sensitive: on the lockfile's Agent SDK 0.2.141 it passes
// even with the marking removed, while on 0.3.261 the unfixed provider failed it
// 5/5. Do not read a pass on an old SDK as the guard being unnecessary.
//
// Requires: CC logged in (or ANTHROPIC_API_KEY). Uses Haiku, three short turns.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const LINE = /^\[([^\]]+)\]\s*\[[^\]]+\]\s*(.*)$/;

/** Bridge log lines that matter here, as [Date, text], oldest first. */
function timeline(debugLog) {
	return readFileSync(debugLog, "utf8")
		.split("\n")
		.map((l) => l.match(LINE))
		.filter(Boolean)
		.map((m) => [new Date(m[1]), m[2]])
		.filter(([, text]) => /syncResult:|abort detected|consumeQuery completed/.test(text));
}

const render = (entries) => entries.map(([at, text]) => `  ${at.toISOString()} ${text}`).join("\n");

test("the sync after an abort rotates instead of reusing the aborted session", { timeout: 180_000 }, async () => {
	const token = `NAMU_${randomUUID().slice(0, 8)}`;
	const harness = createRpcHarness({
		name: "abort-then-next-turn",
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	await harness.startAndWait();
	try {
		// Turn 1: something in history worth losing.
		const first = await harness.promptAndWait(`Remember the token ${token} for this conversation. Reply READY. Do not use any tool.`);
		assert.match(first, /READY/i, "first turn should have answered");

		// Turn 2: abort with a tool call in flight — the state where CC keeps
		// writing after pi has moved on.
		const idle = harness.waitForEvent("agent_end", 60_000);
		await harness.send({ type: "prompt", message: "Call SlowTool with seconds=60." });
		await harness.waitForEvent("tool_execution_start", 60_000);
		const abortedAt = new Date();
		await harness.send({ type: "abort" });
		await idle;

		// Turn 3: immediately, which is what puts the next sync in the race.
		const answer = await harness.promptAndWait("What is the token? Reply with only the token. Do not use any tool.");

		const entries = timeline(harness.DEBUG_LOG);
		const since = entries.filter(([at]) => at >= abortedAt);
		const nextSync = since.find(([, text]) => text.startsWith("syncResult:"));
		assert.ok(nextSync, `no sync ran after the abort:\n${render(entries)}`);

		if (!answer.includes(token)) console.error(`NOTE: the conversation also lost its history — expected ${token}, got: ${answer.slice(0, 200)}`);

		// clean-start is fine: nothing to race. reuse and preserved are not, and
		// whether the abort was marked before or after says which one it was.
		const marking = since.find(([, text]) => text.includes("abort detected"));
		const raced = marking && marking[0] > nextSync[0]
			? `The abort was marked ${marking[0] - nextSync[0]}ms after that sync, so forceRotate could not apply to it.`
			: "";
		assert.doesNotMatch(
			nextSync[1],
			/path=reuse|preserved/,
			`The turn after an abort resumed or rewrote the aborted child's session. ${raced}\n${render(since)}`,
		);
	} finally {
		await harness.stop();
	}
});
