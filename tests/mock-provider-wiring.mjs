/**
 * Mock-API tests for the flaky surfaces of the provider dispatch loop — the
 * completion path and the mid-tool boundary of streamClaudeAgentSdk itself,
 * which only run when a real (or mocked) SDK query handle is attached.
 *
 * The extracted helpers have their own tests (unit-sync-shared-session*.mjs,
 * driving reconstructCompletedSession/syncSharedSession directly); what those
 * cannot pin is the WIRING through the real dispatch entry point:
 *  - a needsRebuild marked on the shared state while the owner's query is
 *    still running must survive that query's completion (the
 *    mark-to-completion window every subagent environment hits — a /compact,
 *    a /tree, an abort, a steer-push miss all land there);
 *  - a clean same-owner completion stores the fingerprint bound to the cursor
 *    it was written beside, with no flag;
 *  - a foreign (subagent) completion preserves the owner's shared state and
 *    deletes its ephemeral session;
 *  - the fresh-query request carries what the sync decided (`resume` id) and
 *    the request-shape edits each gap pinned (snapshot:false,
 *    settings.disableAllHooks:true).
 *
 * `@anthropic-ai/claude-agent-sdk` is swapped process-wide for a fake query()
 * that spawns no subprocess and yields a scripted stream: the same replay
 * shapes as tests/fixtures/sdk-streams/*.jsonl, built inline. Recorded argv —
 * `resume`, systemPrompt settings — asserts what the provider builds without
 * a CC binary. Needs node's experimental module mocks; the package's
 * test:unit:wired script supplies the flag.
 */
import { mock, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { resetCtx } from "../src/query-state.js";
import { fingerprintProjectedPriors } from "../src/priors-fingerprint.js";

// --- SDK module mock ---------------------------------------------------------
//
// The mock's query() reads this file's state at spawn time: `scriptedNow` is
// the messages the next spawned handle yields; `queryCalls` records every
// argv-shaped invocation in spawn order; `parkGate` parks a stream
// mid-iteration so a test can land state changes (marks, aborts) on the live
// query before completing it.

const queryCalls = [];
let scriptedNow = [];
let parkGate = null;

const makeParkGate = () => {
	let release;
	const promise = new Promise((resolve) => { release = resolve; });
	return { park: { park: true }, promise, release };
};

mock.module("@anthropic-ai/claude-agent-sdk", {
	namedExports: {
		// SDK 0.3.282 sdk.d.ts:3090 query({prompt, options}): Query. The fake
		// covers the surface the bridge touches: iterate, interrupt(), close().
		query: (params) => {
			queryCalls.push(params);
			// A `useResume` marker inherits the session id the sync decided
			// (options.resume) — in reality CC --resumes that session and reports
			// its id back in system/init and result.
			const resumeId = params.options?.resume;
			async function* generate() {
				for (const raw of scriptedNow) {
					const m = raw?.useResume ? { ...raw, session_id: resumeId } : raw;
					if (m && m.park) {
						await parkGate.promise;
						continue;
					}
					yield m;
				}
			}
			const handle = generate();
			handle.interrupt = async () => undefined;
			handle.close = () => {};
			return handle;
		},
		EffortLevel: undefined,
		SettingSource: undefined,
	},
});

const { default: activate, __test } = await import("../src/index.js");

// Capture the same registration pi uses; no test-only stream accessor needed.
const piHandlers = new Map();
const registeredProviders = [];
activate({
	on: (event, handler) => piHandlers.set(event, handler),
	registerProvider: (name, config) => registeredProviders.push({ name, config }),
	registerTool: () => {},
});
/** Record `SYSTEM_PROMPT` through the bridge's real before_agent_start →
 *  agent_start boundaries, so the provider's append projection resolves. */
const captureSystemPrompt = () => {
	piHandlers.get("before_agent_start")({ systemPrompt: SYSTEM_PROMPT, systemPromptOptions: {} });
	piHandlers.get("agent_start")({}, { getSystemPrompt: () => SYSTEM_PROMPT });
};

// The registered stream fn — the same reference pi pins as streamSimple.
const streamSimple = registeredProviders[0]?.config.streamSimple;

// --- shared fixtures ---------------------------------------------------------

const ts = () => Date.now();

// SDK message shapes read off tests/fixtures/sdk-streams/text.jsonl.
const systemInit = (sessionId, extra) => ({
	type: "system", subtype: "init", session_id: sessionId,
	model: "claude-haiku-4-5", tools: [], mcp_servers: [],
	permissionMode: "bypassPermissions",
	...extra,
});
const resultMsg = (sessionId, text, extra) => ({
	type: "result", subtype: "success", is_error: false,
	session_id: sessionId,
	result: text,
	usage: {
		input_tokens: 1, output_tokens: 1,
		cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
		server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
	},
	duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
	num_turns: 1,
	...extra,
});

const MODEL = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	contextWindow: 200000, maxTokens: 32000, reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A pi-shaped system prompt without harness leakage: the capture resolver
 *  projects it, and the extraction guard does not refuse it. */
const SYSTEM_PROMPT = "Test session system prompt with no pi harness text.";

/** Drain the provider's returned event stream with a watchdog so the failure
 *  mode pinned below (a turn neither ends nor aborts) names itself rather
 *  than hanging the suite. */
async function drainBounded(stream, timeoutMs = 5000) {
	const events = [];
	let timer;
	const watchdog = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`stream not finished in ${timeoutMs}ms — turn neither ended nor aborted`)),
			timeoutMs,
		);
	});
	const consume = (async () => {
		for await (const e of stream) events.push(e);
	})();
	await Promise.race([consume, watchdog]);
	clearTimeout(timer);
	return events;
}

// --- tests -------------------------------------------------------------------

// streamClaudeAgentSdk hardcodes cwd = process.cwd(), so every CC session file
// these tests create lands under the repo's project dir inside the temp
// CLAUDE_CONFIG_DIR the beforeEach installs. `process.cwd()` is therefore both
// the realistic state cwd and the right cleanup target; tmpdir()/mkdtempSync
// are no longer needed here.

let priorClaudeConfigDir;

describe("mock SDK — provider wiring through streamClaudeAgentSdk", () => {
	beforeEach(() => {
		resetCtx();
		__test.resetSharedSession();
		// cc-session-io resolves claudeDir → env.CLAUDE_CONFIG_DIR → ~/.claude;
		// the seeded CC session files must land in a temp dir, never the real one.
		priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "mock-wiring-claude-"));
	});
	afterEach(() => {
		__test.resetSharedSession();
		rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
		if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
	});

	it("activation registers the provider stream fn used by these wiring tests", () => {
		assert.equal(registeredProviders.length, 1, "activation registers exactly one provider");
		assert.equal(registeredProviders[0].name, "claude-bridge");
		assert.equal(typeof streamSimple, "function", "activation must register the provider stream fn");
	});

	it("a fresh query spawns the fake SDK and ends the turn on a scripted text result", async () => {
		const sessionId = randomUUID();
		scriptedNow = [systemInit(sessionId), resultMsg(sessionId, "hi")];
		// The provider's append projection resolves against the capture recorded
		// through pi's real boundaries above.
		captureSystemPrompt();
		const stream = streamSimple(MODEL, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: "say hi", timestamp: ts() }],
		}, {});
		const events = await drainBounded(stream);
		assert.ok(
			events.some((e) => e.type === "text_delta"),
			"text should stream to pi",
		);
		const done = events.findLast((e) => e.type === "done" || e.type === "error");
		assert.equal(done?.type, "done", "and the turn should end");
		assert.equal(queryCalls.length, 1, "one SDK query spawned");
		const spawned = queryCalls[0];
		assert.equal(
			spawned.options?.systemPrompt?.snapshot,
			false,
			"snapshot pin, exercised through the real construction this time (unit-snapshot-flag asserts the literal; this the object)",
		);
		assert.equal(
			spawned.options?.settings?.disableAllHooks,
			true,
			"disableAllHooks pin, exercised through the real construction",
		);
	});

	// The mark-to-completion window: a /compact or /tree handler (markRebuild),
	// an abort, or a steer-push miss flips needsRebuild on the shared state
	// while the owner's query is still running; the completion handler then
	// reconstructs the state. Reconstruction must not resurrect a state the
	// mark already declared stale.
	it("a needsRebuild marked mid-query survives that owner's completion", async () => {
		const sessionId = randomUUID();
		const history = [
			{ role: "user", content: "one" },
			{ role: "assistant", content: [{ type: "text", text: "two" }] },
			{ role: "user", content: "continue" },
		];
		{
			__test.setSharedSession({
				sessionId,
				cursor: 2,
				cwd: process.cwd(),
				ownerSessionId: "pi-session-a",
				fingerprint: fingerprintProjectedPriors(history.slice(0, 2)).hash,
			});

			// The mark lands MID-QUERY: park the scripted stream at its first
			// message, mark needsRebuild the way the /compact and /tree handlers
			// do while the owner's query is live, then let the query complete.
			// No sync runs in between — that is the mark-to-completion window.
			captureSystemPrompt();
			parkGate = makeParkGate();
			scriptedNow = [parkGate.park, systemInit(sessionId), resultMsg(sessionId, "answer")];
			const stream = streamSimple(MODEL, {
				systemPrompt: SYSTEM_PROMPT,
				messages: history.map((m) => ({ ...m, timestamp: ts() })),
			}, { sessionId: "pi-session-a" });
			const drained = drainBounded(stream);
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(__test.getSharedSession()?.sessionId, sessionId, "the owner's session is still live mid-query");
			// The same handler pi's session_compact event fires.
			piHandlers.get("session_compact")({ reason: "manual", willRetry: false });
			assert.equal(__test.getSharedSession()?.needsRebuild, true, "the mark landed while the query runs");
			parkGate.release();
			await drained;

			const state = __test.getSharedSession();
			assert.equal(state?.sessionId, sessionId, "the owner's own session id survives");
			assert.equal(state?.needsRebuild, true, "the pending rebuild survived the completion write");
			assert.equal(
				state?.fingerprint,
				fingerprintProjectedPriors(history).hash,
				"the fingerprint was refreshed to the priors CC actually has (never the stale one)",
			);
		}
		// The owner's rebuilt session file must not outlive the temp
		// CLAUDE_CONFIG_DIR; afterEach removes it wholesale.
	});

	it("a clean completion without a pending mark refreshes the fingerprint and drops no flag", async () => {
		const sessionId = randomUUID();
		const history = [
			{ role: "user", content: "one" },
			{ role: "assistant", content: [{ type: "text", text: "two" }] },
			{ role: "user", content: "continue" },
		];
		{
			__test.setSharedSession({ sessionId, cursor: 2, cwd: process.cwd(), ownerSessionId: "pi-session-a" });
			captureSystemPrompt();
			scriptedNow = [systemInit(sessionId), resultMsg(sessionId, "answer")];
			const stream = streamSimple(MODEL, {
				systemPrompt: SYSTEM_PROMPT,
				messages: history.map((m) => ({ ...m, timestamp: ts() })),
			}, { sessionId: "pi-session-a" });
			await drainBounded(stream);

			const state = __test.getSharedSession();
			assert.equal(state?.sessionId, sessionId);
			assert.equal(state?.cursor, 3);
			assert.equal(
				state?.fingerprint,
				fingerprintProjectedPriors(history).hash,
				"the stored digest is bound to the cursor it was written beside",
			);
			assert.equal(state?.needsRebuild, undefined);
			assert.equal(state?.ownerSessionId, "pi-session-a");
		}
	});

	// A subagent child dispatched mid-parent-query gets an isolated ephemeral
	// session; when its query completes, the completion handler must discard the
	// ephemeral capture and leave the owner's shared state untouched (the
	// non-adoption rule inside reconstructCompletedSession itself is pinned
	// directly by unit-sync-shared-session-fingerprints).
	it("a foreign (subagent) completion preserves the shared state and discards the ephemeral session", async () => {
		let ephemeralCleanupId;
		const sessionId = randomUUID();
		try {
			const before = {
				sessionId,
				cursor: 2,
				cwd: process.cwd(),
				ownerSessionId: "pi-session-a",
				fingerprint: fingerprintProjectedPriors([
					{ role: "user", content: "one" },
					{ role: "assistant", content: [{ type: "text", text: "two" }] },
				]).hash,
			};
			__test.setSharedSession({ ...before });
			captureSystemPrompt();
			// The child carries its own prior (so sync builds it a real ephemeral
			// session importing it), spawns that ephemeral CC session, and streams
			// an answer under the ephemeral id (the useResume marker adopts it).
			scriptedNow = [systemInit(undefined, { useResume: true }), resultMsg(undefined, "child answer", { useResume: true })];
			const stream = streamSimple(MODEL, {
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{ role: "user", content: "child prior", timestamp: ts() },
					{ role: "assistant", content: [{ type: "text", text: "child mid" }], timestamp: ts() },
					{ role: "user", content: "child prompt", timestamp: ts() },
				],
			}, { sessionId: "child-pi-session" });
			await drainBounded(stream);

			assert.deepEqual(__test.getSharedSession(), before,
				"the child's completion must not touch owner, cursor or fingerprint");
			// The ephemeral session file was deleted (preserveSharedSession path).
			const ephemeralId = queryCalls.at(-1)?.options?.resume;
			assert.ok(ephemeralId, "the child's sync created an ephemeral session to resume");
			ephemeralCleanupId = ephemeralId;
			let exists = true;
			try { openSession({ sessionId: ephemeralId, projectPath: process.cwd(), claudeDir: process.env.CLAUDE_CONFIG_DIR }); } catch { exists = false; }
			assert.equal(exists, false, "the child's ephemeral CC session must be deleted, not left on disk");
		} finally {
			// Session files live under the repo's project dir in the temp
			// CLAUDE_CONFIG_DIR (dispatch cwd is hardcoded to process.cwd());
			// afterEach removes the dir wholesale — these deletes just keep a
			// failure message from reading a stale file.
			deleteSession(sessionId, process.cwd(), process.env.CLAUDE_CONFIG_DIR);
			if (typeof ephemeralCleanupId === "string") deleteSession(ephemeralCleanupId, process.cwd(), process.env.CLAUDE_CONFIG_DIR);
		}
	});
});
