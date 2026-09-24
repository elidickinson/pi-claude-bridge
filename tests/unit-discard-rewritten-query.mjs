/**
 * Unit tests for the compaction loop at a tool boundary (issue #101).
 *
 * pi checks its compaction threshold at every turn boundary inside a run, so it
 * can rewrite the history while a Claude Code query sits parked waiting for a
 * tool result. Tool-result delivery is the one provider call that never reaches
 * syncSharedSession, so `needsRebuild` alone does not stop it: the result goes
 * into the parked query, CC answers over the pre-compaction conversation and
 * reports its full usage, and pi crosses the same threshold at the next
 * boundary. Measured in tests/int-compact-midturn-rebuild.mjs as five
 * compactions in one turn with the reported context going *up*, 76,333 → 77,289.
 *
 * The integration test is the one that proves the turn survives; these pin the
 * three things that make it possible, each of which reads as removable on its
 * own: the rewrite is recorded even before any CC session exists, the parked
 * query stops being a routing target, and it cannot reach back and overwrite
 * what replaced it.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");
const {
	activeQueryContexts, contextForToolResults, discardRewrittenQuery, getHistoryRewritten,
	getSharedSession, isQueryAbandoned, markRebuild, resetSharedSession, setSharedSession,
} = __test;

/** A query parked mid-turn: CC asked for a tool and is waiting on the answer. */
function parkedQuery(toolCallId = "call_1") {
	const events = [];
	const sdkQuery = {
		interrupt: () => { events.push("interrupt"); return Promise.resolve(); },
		close: () => { events.push("close"); },
	};
	const c = new QueryContext();
	c.activeQuery = sdkQuery;
	c.turnToolCallIds = [toolCallId];
	c.pendingToolCalls.set(toolCallId, {
		toolName: "read",
		resolve: (result) => { events.push(`release:${result.content[0].text.slice(0, 20)}`); },
	});
	c.promptStream = { fail: (error) => { events.push(`fail:${error.message}`); } };
	activeQueryContexts.add(c);
	return { c, sdkQuery, events };
}

const toolResults = [{ toolCallId: "call_1", content: [{ type: "text", text: "file contents" }] }];

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
});

describe("markRebuild", () => {
	it("records the rewrite before any Claude Code session exists", () => {
		// sharedSession is assigned when a query *completes*, so it is null for the
		// whole of a first turn — and a first turn is long enough to compact.
		assert.equal(getSharedSession(), null, "precondition: nothing has completed yet");

		markRebuild("session_compact:threshold");

		assert.equal(getHistoryRewritten(), true,
			"recorded only on the session, the first turn's parked query survives the compaction");
	});

	it("also forces the next sync down the rebuild path once a session is known", () => {
		setSharedSession({ sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false });

		markRebuild("session_tree");

		assert.equal(getHistoryRewritten(), true);
		assert.equal(getSharedSession().needsRebuild, true, "--resume would replay a history pi no longer has");
	});
});

describe("discardRewrittenQuery", () => {
	it("stops the parked query being a routing target for the turn's result", () => {
		const { c } = parkedQuery();
		assert.equal(contextForToolResults(toolResults), c, "precondition: the result routes to the parked query");

		discardRewrittenQuery(c);

		assert.equal(contextForToolResults(toolResults), undefined,
			"a result routed here would answer over the conversation pi just discarded");
		assert.equal(c.activeQuery, null);
		assert.equal(activeQueryContexts.has(c), false, "routing matches ids only against contexts in this set");
	});

	it("settles everything awaiting the subprocess before killing it", () => {
		const { c, events } = parkedQuery();

		discardRewrittenQuery(c);

		const released = events.findIndex((e) => e.startsWith("release:"));
		const killed = events.indexOf("interrupt");
		assert.ok(released !== -1, "a handler left awaiting a dead subprocess wedges pi's turn behind it");
		assert.ok(killed !== -1 && released < killed, "handlers have to be released before the CLI goes");
		assert.ok(events.includes("close"), "interrupt alone lets the current API call finish");
		assert.ok(events.some((e) => e.startsWith("fail:")), "the parked ack has nothing left to resume it");
		assert.equal(c.promptStream, null);
		assert.equal(c.pendingToolCalls.size, 0);
	});

	it("marks the query abandoned so its completion cannot overwrite the rebuild", () => {
		const { c, sdkQuery } = parkedQuery();
		assert.equal(isQueryAbandoned(sdkQuery), false);

		discardRewrittenQuery(c);

		assert.equal(isQueryAbandoned(sdkQuery), true,
			"its completion handler would otherwise capture the stale session id over the rebuilt one");
	});

	it("rotates the session id, because the rebuild follows the kill immediately", () => {
		setSharedSession({ sessionId: "abc", cursor: 3, cwd: "/tmp" });
		const { c } = parkedQuery();

		discardRewrittenQuery(c);

		// The CLI we just killed may still flush a record into the JSONL, and the
		// rebuild is the very next thing that happens — the abort path's reasoning,
		// with the race made tighter.
		assert.equal(getSharedSession().forceRotate, true);
		assert.equal(getSharedSession().needsRebuild, true);
	});

	it("is safe on a context whose query already ended", () => {
		const c = new QueryContext();
		activeQueryContexts.add(c);

		discardRewrittenQuery(c);

		assert.equal(c.activeQuery, null);
		assert.equal(activeQueryContexts.has(c), false);
	});
});
