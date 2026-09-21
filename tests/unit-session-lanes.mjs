#!/usr/bin/env node

/**
 * Session state is keyed by pi's request lane (`options.sessionId`).
 *
 * The bridge answers a provider request by driving a live Claude Code session, and
 * anything in the request past that session's cursor is written to its stdin as a
 * steer. That is right for the conversation's own turns. It is wrong for a request
 * that is not the conversation: an extension running a small agent of its own sends
 * the agent's context plus its own appended instruction, and with one global session
 * that request passed the REUSE check — so the instruction was delivered into the
 * user's conversation as a user message, and the conversation's agent obeyed it.
 *
 * pi already labels every request: `ProviderRequestOptions.sessionId`, which its own
 * turns fill with the AgentSession id. These pin that the label decides which Claude
 * Code session a request may resume, and that one lane's bookkeeping cannot be moved
 * by another lane's request.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession } from "cc-session-io";
import { QueryContext } from "../src/query-state.js";

const { default: activate, __test } = await import("../src/index.js");

const CONVERSATION = "00000000-0000-4000-8000-000000000001";
const SIDE = `${CONVERSATION}-notes`;

const history = () => [
	{ role: "user", content: "Where is the retry logic?", timestamp: Date.now() },
	{ role: "assistant", content: [{ type: "text", text: "In src/retry.ts." }], timestamp: Date.now() },
];

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {} });
	return handlers;
}

describe("session lanes", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// The steer bug itself. The side request carries the conversation's history, so its
	// priors reach past the conversation's cursor and the REUSE check matched — which
	// resumed the conversation's Claude Code session and steered the trailing message
	// into it. A different lane must never be handed that session id.
	it("refuses another lane's session even when the history would pass the reuse check", () => {
		const cwd = mkdtempSync(join(tmpdir(), "session-lanes-"));
		const conversationSession = { sessionId: randomUUID(), cursor: 2, cwd };
		__test.setSharedSession(conversationSession, CONVERSATION);
		let built;
		try {
			const result = __test.syncSharedSession(
				[...history(), { role: "user", content: "Summarize the conversation above.", timestamp: Date.now() }],
				cwd, undefined, "claude-haiku-4-5", SIDE,
			);
			built = result.sessionId;

			assert.notEqual(
				built, conversationSession.sessionId,
				"resuming here is what wrote the side request's instruction into the conversation's stdin",
			);
			assert.deepEqual(
				__test.getSharedSession(CONVERSATION), conversationSession,
				"and the conversation's own cursor must not move for a request that is not its own",
			);
		} finally {
			if (built) deleteSession(built, cwd, process.env.CLAUDE_CONFIG_DIR);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still reuses the session on the lane that owns it", () => {
		const cwd = mkdtempSync(join(tmpdir(), "session-lanes-"));
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 2, cwd }, CONVERSATION);

			const result = __test.syncSharedSession(
				[...history(), { role: "user", content: "And the backoff?", timestamp: Date.now() }],
				cwd, undefined, "claude-haiku-4-5", CONVERSATION,
			);

			assert.equal(result.sessionId, sessionId, "the conversation's own next turn still resumes, cache intact");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// A steer that never reached Claude Code forces a rebuild, because the cursor has
	// already counted it. That is bookkeeping for the lane whose query dropped it; a
	// rebuild charged to another lane costs it a full re-import and its prompt cache.
	it("marks only the lane whose steer was dropped", async () => {
		const conversationSession = { sessionId: "conversation", cursor: 3, cwd: "/tmp", needsRebuild: false };
		__test.setSharedSession(conversationSession, CONVERSATION);
		__test.setSharedSession({ sessionId: "side", cursor: 3, cwd: "/tmp", needsRebuild: false }, SIDE);

		const c = new QueryContext();
		c.lane = SIDE;
		c.promptStream = null;

		await __test.deliverToolResults(c, [], [{ type: "text", text: "actually stop" }], 4);

		assert.equal(__test.getSharedSession(SIDE).needsRebuild, true);
		assert.deepEqual(
			__test.getSharedSession(CONVERSATION), conversationSession,
			"the conversation's session is not this lane's to rebuild",
		);
	});

	// /compact and tree navigation rewrite pi's history, and every lane was built from
	// that history, so every lane is stale — not just the one that happened to be last.
	it("marks every lane for rebuild when pi rewrites its history", () => {
		const handlers = activateWithMockPi();
		__test.setSharedSession({ sessionId: "conversation", cursor: 3, cwd: "/tmp" }, CONVERSATION);
		__test.setSharedSession({ sessionId: "side", cursor: 3, cwd: "/tmp" }, SIDE);

		handlers.get("session_compact")({ reason: "manual", willRetry: false });

		assert.equal(__test.getSharedSession(CONVERSATION).needsRebuild, true);
		assert.equal(__test.getSharedSession(SIDE).needsRebuild, true);
	});

	it("drops every lane when the pi session ends", () => {
		const handlers = activateWithMockPi();
		__test.setSharedSession({ sessionId: "conversation", cursor: 3, cwd: "/tmp" }, CONVERSATION);
		__test.setSharedSession({ sessionId: "side", cursor: 3, cwd: "/tmp" }, SIDE);

		handlers.get("session_shutdown")({}, {});

		assert.equal(__test.getLaneCount(), 0, "a new pi session must not resume the old one's Claude Code sessions");
	});
});
