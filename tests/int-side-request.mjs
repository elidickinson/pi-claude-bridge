#!/usr/bin/env node
// Side requests, end to end against a real Claude Code subprocess.
//
// An extension that drives its own `agentLoop` is served by pi-ai's default stream
// function, which resolves the api id in pi-ai's own registry — not in pi's model
// runtime, where `pi.registerProvider` put the provider. Unregistered there, such a
// call threw, and because `agentLoop` never catches its own rejection, pi exited.
//
// Serving one is more than not throwing: it has its own system prompt, its own tool
// and a conversation of its own, and it runs beside a live session whose Claude Code
// session it must not disturb. Only a real subprocess shows all of that.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 180_000;

const harness = createRpcHarness({
	name: "side-request",
	args: [
		"-e", "./tests/fixtures/side-request-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("side requests", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, LOGDIR } = harness;
	const RESULT_PATH = `${LOGDIR}/side-request-result.json`;

	const OVERLAP_PATH = `${LOGDIR}/side-request-overlap.json`;

	before(async () => {
		rmSync(RESULT_PATH, { force: true });
		rmSync(OVERLAP_PATH, { force: true });
		await startAndWait();
	});
	after(async () => { await stop(); });

	/** The command returns before the loop finishes and a slash command emits no
	 *  agent_end, so wait on the file the fixture writes. */
	async function waitForResult(path, timeout = 150_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
			await sleep(500);
		}
		throw new Error(`the side request never produced a result at ${path}`);
	}

	it("serves a self-contained loop without disturbing the conversation", { timeout: TEST_TIMEOUT }, async () => {
		// A real turn first, so there is a shared session for the side request to spoil.
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: `/side-request ${RESULT_PATH}` });
		const result = await waitForResult(RESULT_PATH);
		const log = () => readFileSync(DEBUG_LOG, "utf8").slice(mark);

		assert.equal(result.threw, undefined, `a throw here reaches a caller that cannot handle one: ${result.threw}`);
		assert.equal(result.errorMessage, undefined, `the side request failed: ${result.errorMessage}`);
		// Tool calling and the turn that follows the result both have to work: the loop
		// executes the tool itself and calls back with the result appended.
		assert.deepEqual(result.recorded, ["GAMMA"], `Claude Code did not run the caller's tool: ${JSON.stringify(result)}`);
		assert.match(log(), /provider: fresh side request/, "the request did not take the side-request path");
		assert.doesNotMatch(
			log(),
			/no capture for this \d+-char system prompt/,
			"the caller's own prompt was put to the prompt-capture resolver, which cannot account for it",
		);

		// The conversation's own session must be untouched: it is still aligned with
		// pi's history, so the next real turn resumes it rather than rebuilding.
		const beforeNextTurn = statSync(DEBUG_LOG).size;
		await promptAndWait("Reply with exactly the word BETA and nothing else.");
		const nextTurn = readFileSync(DEBUG_LOG, "utf8").slice(beforeNextTurn);
		assert.match(
			nextTurn,
			/syncResult: path=reuse/,
			`the side request cost the next turn its session:\n${nextTurn.slice(-1500)}`,
		);
	});

	// Consolidation does not wait for the conversation to go idle, so the case that
	// matters is a side request starting while a turn is still in flight: two Claude
	// Code queries alive at once, each having to keep hold of its own tool results.
	it("runs alongside a turn that is still in flight", { timeout: TEST_TIMEOUT }, async () => {
		const mark = statSync(DEBUG_LOG).size;
		const reply = await promptAndWait(
			`Call the run_side_request tool with path ${OVERLAP_PATH}, then reply with exactly the word EPSILON.`,
		);
		const result = await waitForResult(OVERLAP_PATH);
		const log = readFileSync(DEBUG_LOG, "utf8").slice(mark);

		assert.equal(result.threw, undefined, `the nested side request threw: ${result.threw}`);
		assert.deepEqual(result.recorded, ["DELTA"], `the nested side request produced nothing: ${JSON.stringify(result)}`);
		// The parent turn has to survive it: its own tool result still has to come back,
		// which it only does if the side request never claimed the parent's context.
		assert.match(reply, /EPSILON/, `the parent turn did not finish:\n${log.slice(-1500)}`);
	});
});
