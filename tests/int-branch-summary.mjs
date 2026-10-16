#!/usr/bin/env node
// Native pi branch summaries route through cacheRetention:"none" to an isolated
// Claude Code subprocess, without touching the live provider session.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const harness = createRpcHarness({
	name: "branch-summary",
	args: [
		"-e", "./tests/fixtures/tree-nav-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("native branch summarization", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => { await stop(); });

	/** The command returns before the summary finishes, and a slash command emits no
	 *  agent_end, so wait on the isolated summary's completion log. */
	async function waitForLog(mark, pattern, timeout = 90_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const slice = readFileSync(DEBUG_LOG, "utf8").slice(mark);
			if (pattern.test(slice)) return slice;
			await sleep(500);
		}
		return readFileSync(DEBUG_LOG, "utf8").slice(mark);
	}

	it("summarizes an abandoned branch without routing through the live provider", { timeout: TEST_TIMEOUT }, async () => {
		// Two turns so rewinding to the first leaves something worth summarizing.
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");
		await promptAndWait("Reply with exactly the word BETA and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: "/rewind-summarize" });

		const log = await waitForLog(mark, /compact summary: done textLen=[1-9]\d*/);

		assert.doesNotMatch(log, /session_before_tree: takeover/, "bridge must not take over branch summaries");
		assert.match(log, /provider: one-off summarizer call \(cacheRetention none\) routed to isolated summary/, "native summary must route via the provider marker");
		assert.match(log, /compact summary: spawn/, "isolated summary never started");
		assert.match(log, /compact summary: done textLen=[1-9]\d*/, "isolated summary produced no text");
		assert.doesNotMatch(log, /no capture for this \d+-char system prompt/, "summary consulted the live prompt resolver");
	});
});
