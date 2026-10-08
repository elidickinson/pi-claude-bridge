/**
 * A fork running at shutdown has its Claude Code process stopped and its
 * session deleted before session_shutdown resolves (issue #160). pi awaits
 * that handler, including when it exits on SIGTERM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-shutdown-cc-"));
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-shutdown-agent-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

const { IsolatedForks, ServedRequests } = await import("../src/isolated-fork.js");
const { handlers, sessionExists, startForkWithChild } = await import("./lib/fork-shutdown-setup.mjs");

const READY = "process.stdout.write('ready\\n'); setInterval(() => {}, 1e6);";
const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1e6);";
const exitedOf = (child) => child.exitCode !== null || child.signalCode !== null;

function fakeFork({ exits, stuckQuery = false }) {
	const served = new ServedRequests();
	served.record("pi-a", { id: "m" }, { messages: [], tools: [{ name: "compress", description: "", parameters: {} }] }, undefined, "/cwd");
	const log = { deleted: [], killed: 0, forkId: undefined };
	let exit;
	const exited = new Promise((r) => { exit = r; });
	let started;
	const running = new Promise((r) => { started = r; });
	const forks = new IsolatedForks(served, {
		refusal: () => undefined,
		source: () => ({ mainSessionId: "main-1", forkPoint: async () => "cut-1" }),
		startQuery: (_served, target, _prompt, controller) => {
			log.forkId = target.forkSessionId;
			const query = (async function* () {
				await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
				if (stuckQuery) await new Promise(() => {});
			})();
			query.close = () => {};
			started();
			return { query, process: { exited, close: () => { if (exits === "on-close") exit(); }, kill: () => { log.killed++; if (exits !== "never") exit(); } } };
		},
		sdkToolName: (name) => name,
		deleteSession: (id) => log.deleted.push(id),
		debug: () => {},
	});
	let accepted;
	forks.handle({ version: 1, piSessionId: "pi-a", prompt: "p", captureTool: "compress", signal: new AbortController().signal, accept: (r) => { accepted = r; return true; } });
	return { forks, log, accepted, running };
}

describe("isolated fork shutdown", () => {
	it("aborts a fork accepted but not yet started", async () => {
		const { forks, log, accepted } = fakeFork({ exits: "on-close" });
		await forks.shutdown(1000, 500);
		assert.deepEqual(await accepted, { ok: false, reason: "aborted" });
		assert.deepEqual(log.deleted, [], "no session was created");
	});

	it("waits for the process to exit, then deletes the session", async () => {
		const { forks, log, accepted, running } = fakeFork({ exits: "on-close" });
		await running;
		await forks.shutdown(1000, 500);
		assert.deepEqual(await accepted, { ok: false, reason: "aborted" });
		assert.deepEqual(log.deleted, [log.forkId]);
		assert.equal(log.killed, 0);
	});

	it("deletes the session once the process exits, even if the SDK stream never ends", async () => {
		const { forks, log, running } = fakeFork({ exits: "on-close", stuckQuery: true });
		await running;
		await forks.shutdown(1000, 500);
		assert.deepEqual(log.deleted, [log.forkId]);
		assert.equal(forks.unsettled.size, 0);
	});

	it("kills a process that is still running at the kill deadline", async () => {
		const { forks, log, running } = fakeFork({ exits: "on-kill" });
		await running;
		await forks.shutdown(200, 50);
		assert.equal(log.killed, 1);
		assert.deepEqual(log.deleted, [log.forkId]);
	});

	it("gives up at the deadline and leaves the session of a process that never exits", async () => {
		const { forks, log, running } = fakeFork({ exits: "never" });
		await running;
		const started = Date.now();
		await forks.shutdown(100, 20);
		assert.ok(Date.now() - started < 1000);
		assert.deepEqual(log.deleted, [], "its process may still be writing");
		assert.equal(forks.unsettled.size, 1);
	});

	it("the registered session_shutdown handler stops a real fork process and deletes its session", async () => {
		const fork = await startForkWithChild(READY);
		assert.ok(sessionExists(fork.forkId));
		await handlers.get("session_shutdown")();
		assert.ok(exitedOf(fork.child), "the child has exited when the handler resolves");
		assert.equal(sessionExists(fork.forkId), false);
		assert.deepEqual(await fork.accepted, { ok: false, reason: "aborted" });
		await fork.finishMain();
	});

	it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
		const fork = await startForkWithChild(IGNORES_SIGTERM);
		await handlers.get("session_shutdown")();
		assert.equal(fork.child.signalCode, "SIGKILL");
		assert.equal(sessionExists(fork.forkId), false);
		await fork.finishMain();
	});

	it("cleans up before a pi-like process exits on SIGTERM", async () => {
		const harness = spawn(process.execPath, ["--import", "tsx", "tests/lib/fork-shutdown-harness.mjs", READY], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "pipe", "inherit"],
		});
		const exited = new Promise((r) => harness.once("exit", (code) => r(code)));
		const [line] = await new Promise((r) => createInterface({ input: harness.stdout }).once("line", (l) => r([l])));
		const { forkId } = JSON.parse(line);
		assert.ok(sessionExists(forkId));
		harness.kill("SIGTERM");
		assert.equal(await exited, 143);
		assert.equal(sessionExists(forkId), false);
	});
});
