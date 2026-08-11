#!/usr/bin/env node

/**
 * Side requests: the route into a bridge model that pi's model runtime does not own.
 *
 * An extension driving its own `agentLoop` is served by pi-ai's default stream
 * function, which resolves the api id in pi-ai's registry rather than in pi's model
 * runtime — so `pi.registerProvider` alone leaves it unserved. That was not a failed
 * call but a dead process: `agentLoop` starts its run with `void
 * runAgentLoop(...).then(...)` and no `catch`, so the rejection escaped as an
 * unhandled one and pi exited.
 *
 * These pin the registration and the session isolation. Serving one for real needs a
 * Claude Code subprocess — see tests/int-side-request.mjs.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, openSession } from "cc-session-io";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

describe("api provider registration", () => {
	after(() => { __test.resetSharedSession(); });

	it("covers the api id in pi-ai's own registry, not just pi's model runtime", () => {
		const handlers = activateWithMockPi();
		assert.ok(
			getApiProvider("claude-bridge"),
			"unregistered here, an extension's own agentLoop on a bridge model throws where nothing catches it",
		);

		// A live session keeps serving side requests, so only shutdown may withdraw it.
		handlers.get("session_start")({ reason: "new" }, {});
		assert.ok(getApiProvider("claude-bridge"), "session_start must not withdraw the registration");

		handlers.get("session_shutdown")({}, {});
		assert.equal(getApiProvider("claude-bridge"), undefined, "shutdown leaves no route to a torn-down module");

		// The /reload shape: pi tears the old instance down before reactivating.
		activateWithMockPi();
		assert.ok(getApiProvider("claude-bridge"), "reactivation after shutdown must restore it");
	});
});

describe("side request session", () => {
	it("holds the caller's own history and leaves the shared session alone", () => {
		const cwd = mkdtempSync(join(tmpdir(), "side-request-"));
		const mainSession = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42, cwd };
		__test.setSharedSession(mainSession);
		let sessionId;
		try {
			sessionId = __test.buildSideRequestSession([
				{ role: "user", content: "the caller's own first turn", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "and its reply" }], timestamp: Date.now() },
			], cwd, undefined, "claude-haiku-4-5");

			assert.notEqual(sessionId, mainSession.sessionId, "a side request must not write into pi's session");
			assert.deepEqual(__test.getSharedSession(), mainSession, "nor take over the shared-session bookkeeping");

			// Skipping the rebuild would drop this history silently: the prompt Claude Code
			// receives is only the caller's last user turn.
			const written = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			assert.equal(written.messages.length, 2, "the caller's prior turns must reach Claude Code");
		} finally {
			__test.resetSharedSession();
			if (sessionId) deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
