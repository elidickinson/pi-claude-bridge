/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

/**
 * A throwaway project directory plus a throwaway CLAUDE_CONFIG_DIR for one test.
 *
 * cc-session-io falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset, and the
 * unit runner does not set it, so these tests used to seed and rebuild sessions
 * inside the developer's real projects directory — and read back whatever earlier
 * runs had left there, which is how the record-count assertion went flaky.
 */
function createSandbox() {
	const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "sync-shared-session-cfg-"));
	const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	return {
		cwd,
		cleanup() {
			if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
			rmSync(claudeDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const sandbox = createSandbox();
		const { cwd } = sandbox;
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
			], cwd);

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
			sandbox.cleanup();
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const sandbox = createSandbox();
		const { cwd } = sandbox;
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
			sandbox.cleanup();
		}
	});
});
