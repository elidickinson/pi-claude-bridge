/**
 * The SDK's ProcessTransport (^0.2.141) has no `error` listener on child.stdin,
 * so a CLI that exits before reading stdin used to crash the host with an
 * uncaught EPIPE. makeGuardedSpawn absorbs that write error and SIGTERMs (then
 * SIGKILLs) a still-running child so the SDK's exit listener reports the failure.
 *
 * POSIX only: the fixtures use `sh` and `/bin/false`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeGuardedSpawn } from "../src/spawn.js";

async function withUncaughtGuard(fn) {
	const uncaught = [];
	const onUncaught = (err) => { uncaught.push(err); };
	process.on("uncaughtException", onUncaught);
	try {
		await fn();
	} finally {
		process.off("uncaughtException", onUncaught);
	}
	assert.equal(
		uncaught.length,
		0,
		`uncaughtException: ${uncaught.map((e) => e.code ?? e.message).join("; ")}`,
	);
}

function spawnOpts(command, args = []) {
	const env = { ...process.env };
	delete env.DEBUG_CLAUDE_AGENT_SDK;
	return {
		command,
		args,
		cwd: tmpdir(),
		env,
		signal: new AbortController().signal,
	};
}

function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]);
}

function exitOf(child) {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function killIfRunning(child) {
	if (child.exitCode === null && child.signalCode === null) {
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
	}
}

// Overflow the pipe so the write is in-flight when the child closes stdin. A
// write after the `exit` event hits a destroyed stream and never emits EPIPE
// (Node reports ERR_STREAM_DESTROYED on the write callback instead).
const BIG = Buffer.alloc(1024 * 1024);

describe("makeGuardedSpawn", () => {
	it("absorbs EPIPE on stdin after /bin/false exits", async () => {
		await withUncaughtGuard(async () => {
			const logs = [];
			let sawEpipe;
			const epipeP = new Promise((resolve) => { sawEpipe = resolve; });
			const spawnFn = makeGuardedSpawn({
				tag: "test",
				log: (msg) => {
					logs.push(msg);
					if (msg.includes("EPIPE")) sawEpipe();
				},
			});
			const child = spawnFn(spawnOpts("/bin/false"));
			child.stdin.write(BIG);
			await withTimeout(epipeP, 5000, `timed out waiting for EPIPE log, got ${JSON.stringify(logs)}`);
			assert.ok(
				logs.some((m) => m.includes("EPIPE")),
				`expected EPIPE in logs, got ${JSON.stringify(logs)}`,
			);
		});
	});

	it("SIGTERMs a still-running child after stdin error", async () => {
		await withUncaughtGuard(async () => {
			const logs = [];
			const spawnFn = makeGuardedSpawn({ tag: "test", log: (msg) => logs.push(msg) });
			// exec twice: no forked `sleep` is left behind when the shell dies.
			const child = spawnFn(spawnOpts("sh", ["-c", "exec 0<&-; exec sleep 30"]));
			try {
				const exitP = exitOf(child);
				child.stdin.write(BIG);
				const result = await withTimeout(
					exitP,
					5000,
					`timed out waiting for SIGTERM after stdin error, logs=${JSON.stringify(logs)}`,
				);
				assert.equal(result.signal, "SIGTERM");
				assert.ok(
					logs.some((m) => m.includes("sent SIGTERM")),
					`expected kill logged, got ${JSON.stringify(logs)}`,
				);
				assert.ok(!logs.some((m) => m.includes("SIGKILL")), `unexpected escalation: ${JSON.stringify(logs)}`);
			} finally {
				killIfRunning(child);
			}
		});
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		await withUncaughtGuard(async () => {
			const logs = [];
			const spawnFn = makeGuardedSpawn({ tag: "test", log: (msg) => logs.push(msg), killEscalationMs: 200 });
			// Ignored signals survive exec, so the exec'd sleep ignores SIGTERM too.
			const child = spawnFn(spawnOpts("sh", ["-c", "trap '' TERM; exec 0<&-; exec sleep 30"]));
			try {
				const exitP = exitOf(child);
				child.stdin.write(BIG);
				const result = await withTimeout(
					exitP,
					5000,
					`timed out waiting for SIGKILL escalation, logs=${JSON.stringify(logs)}`,
				);
				assert.equal(result.signal, "SIGKILL");
				assert.ok(
					logs.some((m) => m.includes("sent SIGKILL")),
					`expected escalation logged, got ${JSON.stringify(logs)}`,
				);
			} finally {
				killIfRunning(child);
			}
		});
	});

	it("still escalates to SIGKILL when the child was already signalled before the stdin error", async () => {
		await withUncaughtGuard(async () => {
			const logs = [];
			const spawnFn = makeGuardedSpawn({ tag: "test", log: (msg) => logs.push(msg), killEscalationMs: 200 });
			const child = spawnFn(spawnOpts("sh", ["-c", "trap '' TERM; exec 0<&-; echo ready; exec sleep 30"]));
			try {
				// Wait until the trap is installed before sending the first SIGTERM,
				// otherwise it would kill the shell before it ignores TERM.
				await withTimeout(
					new Promise((resolve) => {
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += chunk.toString();
							if (out.includes("ready")) resolve();
						});
					}),
					5000,
					"timed out waiting for the fixture to become ready",
				);
				const exitP = exitOf(child);
				// Mimic the SDK's abort path: child.kill sets `killed` while the
				// SIGTERM-ignoring child keeps running.
				assert.equal(child.kill("SIGTERM"), true);
				assert.equal(child.killed, true);
				child.stdin.write(BIG);
				const result = await withTimeout(
					exitP,
					5000,
					`timed out waiting for SIGKILL of an already-signalled child, logs=${JSON.stringify(logs)}`,
				);
				assert.equal(result.signal, "SIGKILL");
				assert.ok(
					logs.some((m) => m.includes("already signalled")),
					`expected the duplicate SIGTERM to be skipped, got ${JSON.stringify(logs)}`,
				);
				assert.ok(!logs.some((m) => m.includes("sent SIGTERM")), `unexpected second SIGTERM: ${JSON.stringify(logs)}`);
				assert.ok(logs.some((m) => m.includes("sent SIGKILL")), `expected escalation logged, got ${JSON.stringify(logs)}`);
			} finally {
				killIfRunning(child);
			}
		});
	});

	it("survives a throwing logger inside the stdin error handler", async () => {
		await withUncaughtGuard(async () => {
			let calls = 0;
			const spawnFn = makeGuardedSpawn({
				tag: "test",
				log: () => { calls++; throw new Error("disk full"); },
			});
			const child = spawnFn(spawnOpts("sh", ["-c", "exec 0<&-; exec sleep 30"]));
			try {
				const exitP = exitOf(child);
				child.stdin.write(BIG);
				const result = await withTimeout(exitP, 5000, "timed out waiting for SIGTERM with a throwing logger");
				assert.equal(result.signal, "SIGTERM");
				assert.ok(calls > 0, "logger was never called");
			} finally {
				killIfRunning(child);
			}
		});
	});

	it("forwards piped stderr to log when DEBUG_CLAUDE_AGENT_SDK is enabled", async () => {
		const logs = [];
		let saw;
		const logP = new Promise((resolve) => { saw = resolve; });
		const spawnFn = makeGuardedSpawn({
			tag: "test",
			log: (msg) => {
				logs.push(msg);
				if (msg.includes("cli stderr:") && msg.includes("boo")) saw();
			},
		});
		const opts = spawnOpts("sh", ["-c", "echo boo >&2"]);
		opts.env.DEBUG_CLAUDE_AGENT_SDK = "1";
		const child = spawnFn(opts);
		try {
			await withTimeout(logP, 5000, `timed out waiting for cli stderr log, got ${JSON.stringify(logs)}`);
		} finally {
			killIfRunning(child);
		}

		const spawnOff = makeGuardedSpawn({ tag: "test" });
		const optsOff = spawnOpts("sh", ["-c", "echo boo >&2"]);
		optsOff.env.DEBUG_CLAUDE_AGENT_SDK = "0";
		const ignored = spawnOff(optsOff);
		assert.equal(ignored.stderr, null);
		await exitOf(ignored);
	});

	it("ignores stderr without a callback and forwards it with one", async () => {
		const spawnIgnore = makeGuardedSpawn({ tag: "test" });
		const ignored = spawnIgnore(spawnOpts("sh", ["-c", "echo boo >&2"]));
		assert.equal(ignored.stderr, null);
		await exitOf(ignored);

		const chunks = [];
		let sawBoo;
		const booP = new Promise((resolve) => { sawBoo = resolve; });
		const spawnPipe = makeGuardedSpawn({
			tag: "test",
			stderr: (data) => {
				chunks.push(data);
				if (chunks.join("").includes("boo")) sawBoo();
			},
		});
		const piped = spawnPipe(spawnOpts("sh", ["-c", "echo boo >&2"]));
		try {
			await withTimeout(booP, 5000, `timed out waiting for stderr, got ${JSON.stringify(chunks)}`);
		} finally {
			killIfRunning(piped);
		}
	});

	it("SDK query against /bin/false rejects with exited-with-code-1, not uncaught EPIPE", async () => {
		await withUncaughtGuard(async () => {
			async function* prompt() {
				yield { type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null, session_id: "" };
				await new Promise(() => {});
			}
			const q = query({
				prompt: prompt(),
				options: {
					pathToClaudeCodeExecutable: "/bin/false",
					cwd: tmpdir(),
					tools: [],
					permissionMode: "bypassPermissions",
					spawnClaudeCodeProcess: makeGuardedSpawn({ tag: "test" }),
				},
			});
			try {
				await withTimeout(
					assert.rejects(
						async () => {
							for await (const _ of q) { /* drain */ }
						},
						{ message: /exited with code 1/ },
					),
					15000,
					"timed out waiting for the SDK query against /bin/false to reject",
				);
			} finally {
				try { q.close(); } catch { /* already closed */ }
			}
		});
	});
});
