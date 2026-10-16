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
 * three things that make it possible: the rewrite is recorded, attributed to
 * the pi session that rewrote (a subagent's own AgentSession compacts while the
 * parent sits parked on the Agent tool result — cross-session marks would kill
 * the parent's healthy query), the parked query stops being a routing target,
 * and it cannot reach back and overwrite what replaced it.
 *
 * Session mirrors are per pi session (a Map keyed by options.sessionId), so
 * markRebuildForSession arms and discards only the rewriting session's queries,
 * and its teardown marks touch only that session's mirror.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");
const {
	activeQueryContexts, armStaleContexts, contextForToolResults, discardRewrittenQuery,
	historyRewrittenBySession, isQueryAbandoned, markRebuildForSession,
	getSharedSession, resetSharedSession, setSharedSession,
} = __test;

/** A query parked mid-turn: CC asked for a tool and is waiting on the answer. */
function parkedQuery(toolCallId = "call_1", piSessionId = "pi-parent") {
	const events = [];
	const sdkQuery = {
		interrupt: () => { events.push("interrupt"); return Promise.resolve(); },
		close: () => { events.push("close"); },
	};
	const c = new QueryContext();
	c.activeQuery = sdkQuery;
	c.piSessionId = piSessionId;
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
	historyRewrittenBySession.clear();
});

describe("markRebuildForSession", () => {
	it("records the rewrite before any Claude Code session exists", () => {
		// The mirror is assigned when a query *completes*, so a session can have
		// none for a whole first turn — and a first turn is long enough to compact.
		assert.equal(getSharedSession("pi-parent"), null, "precondition: nothing has completed yet");

		markRebuildForSession("pi-parent", "session_compact:threshold");

		assert.ok(historyRewrittenBySession.has("pi-parent"),
			"recorded only on the session, the first turn's parked query survives the compaction");
	});

	it("arms only the parked queries of the rewriting pi session", () => {
		const { c } = parkedQuery("call_1", "pi-parent");
		const sub = parkedQuery("call_sub", "pi-subagent");

		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();

		assert.equal(c.historyStale, true,
			"the parent's query really was built from the history pi just rewrote");
		assert.equal(sub.c.historyStale, false,
			"the subagent parked inside the parent's tool call — its conversation was never rewritten");
	});

	it("arms nothing when the rewrite cannot be attributed", () => {
		const { c } = parkedQuery();

		markRebuildForSession(null, "session_compact:manual");
		armStaleContexts();

		assert.equal(c.historyStale, false,
			"conservative: killing a live query on an unattributed rewrite needs proof");
	});

	it("forces the next sync down the rebuild path for the owning session's conversation", () => {
		// Session mirrors are per pi session: parent and subagent each have one.
		setSharedSession("pi-a", { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-a" });
		setSharedSession("pi-b", { sessionId: "def", cursor: 2, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-b" });

		markRebuildForSession("pi-b", "session_compact:threshold");
		assert.equal(getSharedSession("pi-a").needsRebuild, false,
			"a subagent's compaction must not rebuild the conversation it never touched");
		assert.equal(getSharedSession("pi-b").needsRebuild, true,
			"--resume would replay a history pi no longer has");

		markRebuildForSession(null, "session_compact:served");
		// An unattributed rewrite marks the "(none)" bucket — the only mirror a
		// direct caller without a session id can be serving.
		assert.equal(getSharedSession("pi-a").needsRebuild, false,
			"the parent's mirror is untouched by an unattributed rewrite");
		// The discard set is keyed differently from the mirror on purpose: its
		// readers all guard on a real piSessionId, so a "(none)" entry here could
		// never be matched or consumed — only leaked.
		assert.ok(!historyRewrittenBySession.has("(none)"),
			"a null mark records no set entry: no reader could match or consume one");
	});

	it("arms the discarding session's replacement after a second rewrite (mid-turn double compaction)", () => {
		// The set key was consumed by the first discard; a second compaction in
		// the same turn re-adds it and must arm the replacement query too — the
		// replacement's reset (streamClaudeAgentSdk fresh-query setup) only clears
		// staleness carried over from the query it replaced, not new marks.
		const { c } = parkedQuery("call_1", "pi-parent");
		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();
		discardRewrittenQuery(c);
		assert.equal(c.historyStale, true, "the discard's own query is stale by construction");

		const replacement = parkedQuery("call_2", "pi-parent");
		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();

		assert.equal(replacement.c.historyStale, true,
			"a history rewritten under the replacement's predecessor makes this one stale too");
		discardRewrittenQuery(replacement.c);
		assert.equal(historyRewrittenBySession.has("pi-parent"), false, "and consumes the mark again");
		void c;
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

	it("consumes the mark for its pi session, leaving sibling sessions armed", () => {
		const { c } = parkedQuery("call_1", "pi-b");
		const other = parkedQuery("call_2", "pi-c");
		markRebuildForSession("pi-c", "session_compact:threshold");
		markRebuildForSession("pi-b", "session_compact:threshold");
		armStaleContexts();
		assert.ok(historyRewrittenBySession.has("pi-b"), "precondition: armed");

		discardRewrittenQuery(c);

		assert.equal(historyRewrittenBySession.has("pi-b"), false, "served");
		assert.ok(historyRewrittenBySession.has("pi-c"), "a sibling pi session's rewrite is not ours to consume");
		void other;
	});

	it("rotates the session id of the discarding session's own mirror, because the rebuild follows the kill immediately", () => {
		setSharedSession("pi-parent", { sessionId: "abc", cursor: 3, cwd: "/tmp", piSessionId: "pi-parent" });
		const { c } = parkedQuery("call_1", "pi-parent");

		discardRewrittenQuery(c);

		// The CLI we just killed may still flush a record into the JSONL, and the
		// rebuild is the very next thing that happens — the abort path's reasoning,
		// with the race made tighter. Another session's mirror is never touched.
		const s = getSharedSession("pi-parent");
		assert.equal(s.forceRotate, true);
		assert.equal(s.needsRebuild, true);
	});

	it("leaves a foreign session's mirror untouched when the foreign query discards", () => {
		// pi-b's query parks, pi-b compacts, the discard rotates only pi-b's
		// mirror — when there is none. The parent's mirror is not pi-b's to rotate.
		setSharedSession("pi-parent", { sessionId: "parent", cursor: 3, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-parent" });
		const { c } = parkedQuery("call_1", "pi-b");
		markRebuildForSession("pi-b", "session_compact:threshold");
		armStaleContexts();

		discardRewrittenQuery(c);

		const s = getSharedSession("pi-parent");
		assert.equal(s.needsRebuild, false, "the child's rebuild must not force the parent's next sync");
		assert.equal(s.forceRotate, undefined, "nor rotate it: the parent conversation is intact");
		assert.equal(getSharedSession("pi-b"), null, "the child never had a mirror to rotate");
	});

	it("is safe on a context whose query already ended", () => {
		const c = new QueryContext();
		activeQueryContexts.add(c);

		discardRewrittenQuery(c);

		assert.equal(c.activeQuery, null);
		assert.equal(activeQueryContexts.has(c), false);
	});
});

describe("per-session mirrors", () => {
	it("separates the CC conversations of two pi sessions", () => {
		setSharedSession("pi-a", { sessionId: "cc-a", cursor: 4, cwd: "/tmp", piSessionId: "pi-a" });
		setSharedSession("pi-b", { sessionId: "cc-b", cursor: 1, cwd: "/tmp", piSessionId: "pi-b" });

		assert.equal(getSharedSession("pi-a").sessionId, "cc-a");
		assert.equal(getSharedSession("pi-b").sessionId, "cc-b");
		assert.equal(getSharedSession("pi-c"), null, "a session with no mirror has none");

		resetSharedSession("pi-b");
		assert.equal(getSharedSession("pi-b"), null, "reset clears only the keyed mirror");
		assert.equal(getSharedSession("pi-a").sessionId, "cc-a", "a sibling survives the reset");
	});

	it("shares one bucket for unattributed callers", () => {
		setSharedSession(null, { sessionId: "cc-none", cursor: 2, cwd: "/tmp", piSessionId: undefined });

		assert.equal(getSharedSession(null).sessionId, "cc-none");
		assert.equal(getSharedSession("pi-a"), null,
			"an attributed session never touches the unattributed bucket");
	});
});
