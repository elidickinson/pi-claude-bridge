/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// Nested queries get a disposable session instead of overwriting the parent.
	it("starts a fresh session for a shorter reentrant context and preserves the parent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd, undefined, undefined, { reentrant: true });

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rebuilds a shorter top-level history instead of dropping conversation context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 42, cwd });

			const result = __test.syncSharedSession([
				{ role: "user", content: "Remember this.", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "Remembered." }], timestamp: 2 },
				{ role: "user", content: "What did I ask?", timestamp: 3 },
			], cwd);

			assert.equal(result.sessionId, sessionId);
			assert.equal(result.preserveSharedSession, undefined);
			assert.equal(__test.getSharedSession().cursor, 2);
			assert.equal(openSession({ sessionId, projectPath: cwd }).messages.length, 2);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("carries a compaction invalidation through a concurrent query completion", () => {
		const cwd = "/tmp/session-race";
		const sessionId = "11111111-1111-4111-8111-111111111111";
		__test.setSharedSession({ sessionId, cursor: 42, cwd });

		__test.markRebuild("session_compact");
		__test.recordQueryCompletion(sessionId, 5, cwd, false);

		assert.deepEqual(__test.getSharedSession(), {
			sessionId,
			cursor: 5,
			cwd,
			needsRebuild: true,
		});
	});

	it("does not lower the parent cursor when a reentrant query completes", () => {
		const cwd = "/tmp/reentrant-session";
		const sessionId = "11111111-1111-4111-8111-111111111111";
		__test.setSharedSession({ sessionId, cursor: 42, cwd });

		__test.recordQueryCompletion(sessionId, 5, cwd, true);

		assert.equal(__test.getSharedSession().cursor, 42);
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
