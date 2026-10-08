#!/usr/bin/env node

/**
 * Branch summarization (rewind / fork-at-point with "summarize") must not reach
 * the provider.
 *
 * Unlike compaction, pi runs it through the *agent's* stream function
 * (agent-session passes `streamFn: this.agent.streamFunction`), so on a bridge
 * model it arrives at streamClaudeAgentSdk carrying pi's internal summarization
 * prompt — which no `before_agent_start` ever recorded, and which the
 * prompt-capture resolver therefore refuses. Taking the event over is what keeps
 * that from happening; these pin the guard, not the summary itself, which would
 * need a Claude Code subprocess.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../src/index.js");

const treeEvent = (preparation) => ({ preparation, signal: new AbortController().signal });
const preparation = { targetId: "abcdef1234", entriesToSummarize: [{}], userWantsSummary: true };

describe("branch summarization takeover", () => {
	it("is registered at all", () => {
		assert.ok(
			activateWithMockPi().has("session_before_tree"),
			"without this handler pi summarizes through the agent stream function, which reaches the provider",
		);
	});

	it("leaves other providers alone", async () => {
		const handler = activateWithMockPi().get("session_before_tree");
		const result = await handler(treeEvent(preparation), { model: { baseUrl: "https://api.openai.com/v1" } });
		assert.equal(result, undefined, "only claude-bridge models route through Claude Code");
	});

	it("declines when pi is not summarizing", async () => {
		const handler = activateWithMockPi().get("session_before_tree");
		const ctx = { model: { baseUrl: "claude-bridge" } };

		assert.equal(await handler(treeEvent({ ...preparation, userWantsSummary: false }), ctx), undefined);
		assert.equal(await handler(treeEvent({ ...preparation, entriesToSummarize: [] }), ctx), undefined);
	});
});

// The takeover's own decision, separated from generateBranchSummary so it can be
// driven without a Claude Code subprocess. Driving pi's summarizer would be testing pi.
describe("branch summary outcome", () => {
	it("hands pi the summary and the file lists it records natively", () => {
		const outcome = __test.branchSummaryOutcome({
			summary: "the branch did X",
			usage: { input: 10, output: 2 },
			readFiles: ["/a.ts"],
			modifiedFiles: ["/b.ts"],
		});

		assert.equal(outcome.summary.summary, "the branch did X");
		assert.deepEqual(outcome.summary.details, { readFiles: ["/a.ts"], modifiedFiles: ["/b.ts"] });
		assert.deepEqual(outcome.summary.usage, { input: 10, output: 2 });
	});

	it("still yields a well-formed summary when the file lists are absent", () => {
		const outcome = __test.branchSummaryOutcome({ summary: "terse" });
		assert.deepEqual(outcome.summary.details, { readFiles: [], modifiedFiles: [] });
	});

	it("cancels the navigation on abort rather than moving without a summary", () => {
		assert.deepEqual(__test.branchSummaryOutcome({ aborted: true }), { cancel: true });
	});

	it("throws on a summary error, which the handler turns into a cancel", () => {
		assert.throws(() => __test.branchSummaryOutcome({ error: "model refused" }), /model refused/);
	});
});
