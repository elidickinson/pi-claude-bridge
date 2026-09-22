#!/usr/bin/env node
// A permission reviewer's call, mid-turn, end to end against a real Claude Code subprocess.
//
// A reviewer (pi-auto-review) takes the bridge's registered streamSimple from pi's model
// registry and calls it with its own rubric, one user message and no tools — while the
// conversation's own query is parked on the tool call under review. On the main lane
// that call reads as a reentrant query of the active session, its prompt never resolves
// against pi's captures, and it never returns a verdict. It has to take the isolated
// one-shot path, and the parent turn has to finish untouched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 180_000;

const harness = createRpcHarness({
	name: "reviewer-one-shot",
	args: [
		"-e", "./tests/fixtures/reviewer-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("reviewer one-shot", () => {
	const { startAndWait, stop, promptAndWait, DEBUG_LOG, LOGDIR } = harness;
	const RESULT_PATH = `${LOGDIR}/reviewer-result.json`;

	before(async () => {
		rmSync(RESULT_PATH, { force: true });
		await startAndWait();
	});
	after(async () => { await stop(); });

	async function waitForResult(path, timeout = 150_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
			await sleep(500);
		}
		throw new Error(`the reviewer call never produced a result at ${path}`);
	}

	it("serves a mid-turn reviewer call on the isolated path and the parent turn finishes", { timeout: TEST_TIMEOUT }, async () => {
		const mark = statSync(DEBUG_LOG).size;
		const reply = await promptAndWait(
			`Call the run_review tool with path ${RESULT_PATH}, then reply with exactly the word EPSILON.`,
		);
		const result = await waitForResult(RESULT_PATH);
		const log = readFileSync(DEBUG_LOG, "utf8").slice(mark);

		assert.equal(result.threw, undefined, `the reviewer call threw: ${result.threw}`);
		assert.equal(result.errorMessage, undefined, `the reviewer call failed: ${result.errorMessage}`);
		assert.match(String(result.text), /ALLOW/, `no verdict came back: ${JSON.stringify(result)}`);
		assert.match(log, /provider: foreign one-shot \(\d+-char system prompt, no tools\) routed to isolated path, activeQuery=true/,
			"the reviewer call did not take the isolated one-shot path mid-turn");
		assert.match(log, /one-shot: spawn model=claude-haiku-4-5/, "the one-shot did not spawn on the caller's model");
		assert.doesNotMatch(log, /active query user-only call treated as reentrant fresh query/,
			"the reviewer call was folded into the active session");
		assert.match(reply, /EPSILON/, `the parent turn did not finish:\n${log.slice(-1500)}`);
	});
});
