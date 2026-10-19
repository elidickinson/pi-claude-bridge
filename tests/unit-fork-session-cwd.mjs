/**
 * A fork of a pi session whose cwd is not the process cwd (pi-web serves many
 * sessions from one process) reads the main transcript, runs, and has its copy
 * deleted in the session's cwd, where the main query ran (follow-up to #175).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-cwd-cc-"));
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-cwd-agent-"));
const sessionCwd = mkdtempSync(join(tmpdir(), "claude-bridge-fork-cwd-session-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
	for (const dir of [claudeDir, agentDir, sessionCwd]) rmSync(dir, { recursive: true, force: true });
});

const { cwd, handlers, sessionExists, SHUTDOWN_CTX, startForkWithChild } = await import("./lib/fork-shutdown-setup.mjs");

const READY = "process.stdout.write('ready\\n'); setInterval(() => {}, 1e6);";

describe("isolated fork in a session cwd", () => {
	it("runs in the session's cwd and deletes its copy there", async () => {
		assert.notEqual(sessionCwd, cwd);
		const fork = await startForkWithChild(READY, { sessionCwd });
		assert.equal(fork.mainCwd, sessionCwd);
		assert.equal(fork.forkCwd, sessionCwd);
		assert.ok(sessionExists(fork.forkId, sessionCwd));
		await handlers.get("session_shutdown")({}, SHUTDOWN_CTX);
		assert.equal(sessionExists(fork.forkId, sessionCwd), false);
		assert.deepEqual(await fork.accepted, { ok: false, reason: "aborted" });
	});
});
