#!/usr/bin/env node
// Regression test: a tool-using first turn records its complete content prefix,
// including results and the final assistant, so the next turn resumes unchanged.
// See: https://github.com/elidickinson/pi-claude-bridge/issues/4

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

test("turn 2 reuses session after tool-using turn 1 (no spurious rebuild)", { timeout: 120_000 }, async () => {
	const harness = createRpcHarness({
		name: "cursor-after-tools",
		args: ["--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	await harness.startAndWait();

	try {
		// Turn 1: force a tool call
		const text1 = await harness.promptAndWait(
			"Use the Read tool to read package.json and tell me the top-level name field. Just the name, nothing else."
		);
		assert.ok(text1, "Turn 1 should produce text");

		// Turn 2: text-only, should reuse session
		const text2 = await harness.promptAndWait(
			"What was the name you just read? Repeat it."
		);
		assert.ok(text2, "Turn 2 should produce text");

		// Check sync decisions
		const debugLog = readFileSync(harness.DEBUG_LOG, "utf8");
		const paths = [];
		for (const match of debugLog.matchAll(/syncResult: path=([a-z-]+)/g)) {
			paths.push(match[1]);
		}

		assert.ok(paths.length >= 2, `expected two fresh-query decisions, got ${paths.join(", ")}`);
		assert.strictEqual(paths[0], "clean-start");
		assert.ok(paths.slice(1).every((path) => path === "reuse"),
			`tool results and the final assistant must be covered without a fork or rewrite: ${paths.join(", ")}`);
	} finally {
		await harness.stop();
	}
});
