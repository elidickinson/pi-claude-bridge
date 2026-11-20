#!/usr/bin/env node
// A pi shutdown has to take the Claude Code subprocess with it.
//
// The SDK spawns `claude` with plain pipes and no parent-death watchdog. CC does
// exit on stdin EOF while it is merely waiting on an API response — but not while
// a tool call is parked: its MCP transport is gone, so CC reads each tool call as
// an ordinary tool error, feeds it to the model and issues another API request,
// forever. Two incidents in the 2026-07-29 audit ran 59 and 23 minutes, and one
// consumed enough quota to trip an account-wide 429. See diag/AUDIT.md, "Not
// covered by these scripts".
//
// So the repro shuts pi down with a tool call in flight. Nothing throws when this
// regresses and the pi-side logs simply stop, so the assertion is on the process
// table.

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";

function children(pid) {
	try {
		return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return []; // pgrep exits 1 when there are none
	}
}

function commandOf(pid) {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

/** The `claude` processes under `pid`, at any depth. Matches on the executable,
 *  not the whole command line: every pi process here carries the extension dir
 *  `pi-claude-code-acp` in its args, which a bare /claude/ would match. */
function claudeDescendants(pid) {
	const found = [];
	for (const child of children(pid)) {
		const command = commandOf(child);
		if (basename(command.split(" ")[0]) === "claude") found.push({ pid: child, command: command.slice(0, 100) });
		found.push(...claudeDescendants(child));
	}
	return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("abort with a tool call in flight kills the Claude Code subprocess", { timeout: 120_000 }, async () => {
	const harness = createRpcHarness({
		name: "abort-kills-cc",
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	await harness.startAndWait();
	let cc = [];
	try {
		await harness.send({ type: "prompt", message: "Call SlowTool with seconds=60." });
		await harness.waitForEvent("tool_execution_start", 60_000);

		cc = claudeDescendants(harness.pi().pid);
		assert.ok(cc.length, "expected a Claude Code subprocess under pi while a tool call is in flight");

		// Abort fails the prompt stream, which closes the child's stdin and with it
		// the MCP control channel. pi stays alive, so nothing else will ever reap
		// the child — it has to be killed here or it retries the dead tool call
		// against a fresh API request forever.
		const idle = harness.waitForEvent("agent_end", 30_000);
		await harness.send({ type: "abort" });
		await idle;

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && cc.some((p) => alive(p.pid))) await sleep(200);

		const survivors = cc.filter((p) => alive(p.pid));
		assert.deepEqual(survivors.map((p) => `${p.pid} ${p.command}`), [], "Claude Code outlived the aborted query");
	} finally {
		for (const p of cc) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
		await harness.stop();
	}
});

test("pi shutdown with a tool call in flight kills the Claude Code subprocess", { timeout: 120_000 }, async () => {
	const harness = createRpcHarness({
		name: "shutdown-kills-cc",
		args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", BRIDGE_MODEL],
		defaultTimeout: 60_000,
	});

	await harness.startAndWait();
	let cc = [];
	try {
		// SlowTool never returns within the test: pi's handler is still waiting when
		// pi goes down, which is the state CC does not survive on its own.
		await harness.send({ type: "prompt", message: "Call SlowTool with seconds=60." });
		await harness.waitForEvent("tool_execution_start", 60_000);

		cc = claudeDescendants(harness.pi().pid);
		assert.ok(cc.length, "expected a Claude Code subprocess under pi while a tool call is in flight");

		await harness.stop(); // SIGTERM — rpc mode turns this into session_shutdown

		// Grace period: the kill is a signal to another process, not a synchronous
		// call. Ends as soon as they are all gone.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && cc.some((p) => alive(p.pid))) await sleep(200);

		const survivors = cc.filter((p) => alive(p.pid));
		assert.deepEqual(survivors.map((p) => `${p.pid} ${p.command}`), [], "Claude Code outlived pi");
	} finally {
		// Leaving a survivor behind is the very failure under test, and it bills
		// API requests until something stops it.
		for (const p of cc) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
	}
});
