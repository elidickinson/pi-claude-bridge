/**
 * Integration tests for AskClaude background mode.
 * Uses pi in RPC mode with the bridge extension and an alt (non-Claude) model.
 *
 * Background mode fires AskClaude in a detached Promise and returns to the model
 * immediately. When the task completes, pi.sendMessage delivers the result as a
 * custom `ask-claude-bg-result` message with triggerTurn:true / deliverAs:followUp.
 *
 * IMPORTANT: pi's agent loop polls its followUp queue right before emitting
 * agent_end (see packages/agent/src/agent-loop.ts). Any followUp enqueued while
 * the turn is still streaming is drained into the SAME agent_end — so multiple
 * bg completions during a turn produce one agent_end, not N. These tests assert
 * on the custom messages carried in agent_end.messages, not on event counts or
 * assistant text (the outer model may only acknowledge a followUp in thinking).
 *
 * No pure unit tests: the background logic is tightly coupled to pi.sendMessage
 * and the async task lifecycle, which can't be usefully exercised without the
 * full RPC harness.
 *
 * Debug output (set on child pi via CLAUDE_BRIDGE_DEBUG*) lands in DEBUG_LOG,
 * RPC I/O and pi stderr in RPC_LOG. Both paths are printed on suite teardown.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const ALT_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");
const ALT_PROVIDER = process.env.CLAUDE_BRIDGE_TESTING_ALT_PROVIDER;

const RETURN_TIMEOUT = 10_000; // first turn must finish within this — proves non-blocking
const BG_TIMEOUT = 90_000;     // each followUp turn must fire within this

const harness = createRpcHarness({
	name: "bg-askclaude",
	args: ALT_PROVIDER ? ["--model", ALT_MODEL, "--provider", ALT_PROVIDER] : ["--model", ALT_MODEL],
	defaultTimeout: BG_TIMEOUT,
});

const { DIR, start, stop, send, addListener, DEBUG_LOG, RPC_LOG } = harness;

describe("AskClaude background integration", () => {
	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	afterEach(() => {
		harness.clearListeners();
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log:   ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- helpers ---

	function waitForEvent(type, timeout) {
		return harness.waitForEvent(type, timeout);
	}

	// Collects assistant text deltas until stopped.
	function collectText() {
		return harness.collectText();
	}

	// Consumes agent_end events until `predicate(bgResults)` returns true, where
	// bgResults is the accumulated list of `ask-claude-bg-result` custom messages
	// seen so far (across however many agent_ends occurred). We inspect custom
	// messages directly — not assistant text — because:
	//   1. pi merges multiple sendMessage-followUps into ONE agent_end via the
	//      agent loop's getFollowUpMessages poll, so counting events is unreliable;
	//   2. the outer model may acknowledge a followUp only in a thinking block,
	//      producing no visible text_delta.
	// Custom message content is deterministic and carries the full bg-task body.
	// Scans an agent_end message payload for AskClaude tool results and returns the
	// first backgroundId found. Used to capture the bg id the outer model just created
	// so later tests can refer to it by id.
	function extractBgId(agentEnd) {
		for (const m of agentEnd.messages ?? []) {
			if (m.role === "toolResult" && m.details?.backgroundId) return m.details.backgroundId;
		}
		return null;
	}

	// Scans an agent_end for a toolResult of the given tool name and returns its text.
	function extractToolResultText(agentEnd, toolName) {
		for (const m of agentEnd.messages ?? []) {
			if (m.role === "toolResult" && m.toolName === toolName) {
				return m.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
			}
		}
		return null;
	}

	// Waits for an agent_end in which `predicate(agentEnd)` returns a truthy value,
	// and resolves with that value. Use for one-shot "find something in the next turn"
	// queries that don't care about accumulation across multiple turns.
	function waitForAgentEndMatching(predicate, totalTimeout) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(new Error(`Timeout waiting for matching agent_end`));
			}, totalTimeout);
			const remove = harness.addListener((msg) => {
				if (msg.type !== "agent_end") return;
				const match = predicate(msg);
				if (match) {
					clearTimeout(timer);
					remove();
					resolve(match);
				}
			});
		});
	}

	function waitForBgResults(predicate, totalTimeout) {
		const results = [];
		let agentEndCount = 0;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(new Error(`Timeout waiting for bg results (saw ${results.length} in ${agentEndCount} agent_ends: ${results.map((r) => r.content.slice(0, 80)).join(" | ")})`));
			}, totalTimeout);
			const remove = harness.addListener((msg) => {
				if (msg.type !== "agent_end") return;
				agentEndCount++;
				for (const m of msg.messages ?? []) {
					if (m.role === "custom" && m.customType === "ask-claude-bg-result") results.push(m);
				}
				if (predicate(results)) {
					clearTimeout(timer);
					remove();
					resolve({ results, agentEndCount });
				}
			});
		});
	}

	// --- tests ---

	it("returns immediately without blocking", { timeout: RETURN_TIMEOUT + 5000 }, async () => {
		// Inner prompt runs `sleep 300` so the bg task can't possibly finish in time —
		// if the tool call blocked on it, RETURN_TIMEOUT would expire. No bg result can
		// be batched into this turn, so the first agent_end is a pure first-turn event.
		const collector = collectText();
		const start = Date.now();
		await send({
			type: "prompt",
			// mode="full" is required so the inner CC actually runs bash — without it
			// the outer model may pick mode="read", the inner refuses to run `sleep`,
			// and the bg task completes in ~10s and leaks into later tests.
			message: `Use the AskClaude tool with background=true, mode="full", and prompt="Run bash command: sleep 300". Then say exactly: STARTED`,
		});
		await waitForEvent("agent_end", RETURN_TIMEOUT);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < RETURN_TIMEOUT, `turn took ${elapsed}ms — expected < ${RETURN_TIMEOUT}ms (tool should not block)`);
		assert.match(collector.stop().toLowerCase(), /started/);
	});

	it("concurrent background results both delivered as followUps", { timeout: BG_TIMEOUT + 10_000 }, async () => {
		// Two background tasks launched in one turn. pi may batch their followUps into
		// the initial agent_end or into a second one — either is correct. We just need
		// both custom-message bodies to eventually appear.
		const waitDone = waitForBgResults(
			(rs) => rs.some((r) => /BG1DONE/.test(r.content)) && rs.some((r) => /BG2DONE/.test(r.content)),
			BG_TIMEOUT,
		);
		await send({
			type: "prompt",
			message: `Call AskClaude twice with background=true and mode="none": first with prompt="Reply with exactly: BG1DONE", then with prompt="Reply with exactly: BG2DONE". Then say BOTH_STARTED.`,
		});
		const { results } = await waitDone;
		assert.ok(results.every((r) => !/failed/i.test(r.content)), `unexpected failure in bg results: ${JSON.stringify(results.map((r) => r.content))}`);
	});

	it("bg result delivered after parent turn → triggers a new turn", { timeout: 60_000 }, async () => {
		// The headline background-mode guarantee: when a task completes AFTER the parent
		// turn has already ended, pi.sendMessage must take the `agent.prompt()` branch
		// and start a brand-new agent turn. In the other tests the inner tasks finish
		// so fast that their followUps batch into the initial agent_end — the post-turn
		// trigger path is never exercised. Here the inner task runs `sleep 6` so it
		// outlasts the parent turn, forcing a separate second agent_end.
		const waitDone = waitForBgResults(
			(rs) => rs.some((r) => /BGSLOW/.test(r.content)),
			BG_TIMEOUT,
		);
		await send({
			type: "prompt",
			message: `Use AskClaude with background=true and mode="full" and prompt="Run bash: sleep 6 && echo BGSLOW". Then say exactly: PARENTDONE`,
		});
		const { agentEndCount } = await waitDone;
		assert.ok(agentEndCount >= 2, `expected BGSLOW in a separate agent_end, but everything arrived in ${agentEndCount} agent_end(s) — post-turn trigger path not exercised`);
	});

	it("error in background task delivered as followUp", { timeout: BG_TIMEOUT + 10_000 }, async () => {
		// Invalid model ID → SDK query fails fast → error delivered as custom followUp.
		// The error may land in the initial turn's agent_end (if bg task errors before
		// the loop's followUp poll) or a separate one.
		const waitErr = waitForBgResults(
			(rs) => rs.some((r) => /failed/i.test(r.content) && /nonexistent/i.test(r.content)),
			BG_TIMEOUT,
		);
		await send({
			type: "prompt",
			message: `Use AskClaude with background=true and model="nonexistent-model-xyz-404" and prompt="hello". Then say BGSTARTED.`,
		});
		await waitErr;
	});

	it("AskClaudeStatus lists a running background task", { timeout: 30_000 }, async () => {
		// Start a fresh bg task, capture its id from the AskClaude toolResult, then ask
		// the model to call AskClaudeStatus and verify the listing contains our id and
		// the "running" status marker.
		const capture = waitForAgentEndMatching((e) => extractBgId(e), RETURN_TIMEOUT);
		await send({
			type: "prompt",
			message: `Use AskClaude with background=true, mode="full", prompt="Run bash: sleep 300". Then say STATUS_T1_READY.`,
		});
		const bgId = await capture;

		const waitStatus = waitForAgentEndMatching((e) => extractToolResultText(e, "AskClaudeStatus"), BG_TIMEOUT);
		await send({
			type: "prompt",
			message: `Call the AskClaudeStatus tool with no arguments to list all background tasks. Then say STATUS_LISTED.`,
		});
		const statusText = await waitStatus;
		assert.match(statusText, new RegExp(bgId), `status output missing ${bgId}: ${statusText.slice(0, 400)}`);
		assert.match(statusText, /running/, `status output missing "running" marker: ${statusText.slice(0, 400)}`);
	});

	it("AskClaudeAbort terminates a running background task", { timeout: 60_000 }, async () => {
		// Start a fresh bg task, tell the model to abort it by id. Verify:
		//  1. the AskClaudeAbort toolResult confirms the abort signal was sent
		//  2. a bg-result followUp arrives for OUR bgId, far sooner than sleep 300 would
		//     naturally complete (proves the abort actually interrupted the inner query)
		const capture = waitForAgentEndMatching((e) => extractBgId(e), RETURN_TIMEOUT);
		await send({
			type: "prompt",
			message: `Use AskClaude with background=true, mode="full", prompt="Run bash: sleep 300". Then say ABT_STARTED.`,
		});
		const bgId = await capture;
		const bgStart = Date.now();

		// Start listening for the bg-result BEFORE sending the abort prompt so we don't
		// miss it if it arrives fast.
		const waitAborted = waitForBgResults(
			(rs) => rs.some((r) => r.content.includes(bgId)),
			BG_TIMEOUT,
		);
		const waitAbortCall = waitForAgentEndMatching((e) => extractToolResultText(e, "AskClaudeAbort"), BG_TIMEOUT);

		await send({
			type: "prompt",
			message: `Call AskClaudeAbort with id="${bgId}". Then say ABORT_REQUESTED.`,
		});
		const abortText = await waitAbortCall;
		assert.match(abortText, /Abort signal sent/i, `abort tool did not confirm: ${abortText.slice(0, 300)}`);

		const { results } = await waitAborted;
		const ours = results.find((r) => r.content.includes(bgId));
		assert.ok(ours, `no bg-result received for ${bgId}`);
		const elapsed = Date.now() - bgStart;
		assert.ok(elapsed < 30_000, `bg task took ${elapsed}ms to finish after abort — likely ran to completion instead of aborting`);
	});
});
