#!/usr/bin/env node
// The first turn of a pi session forked or cloned from a bridge session reads
// the shared conversation from the prompt cache: the child inherits its
// parent's bridge state (src/fork-inherit.ts) and forks the parent's Claude Code
// session at a cut (row 6 or 7) instead of writing pi's history to a new CC
// session (row 2). Cases: RPC `clone`, RPC `fork` of the parent at its third
// user message, and a new pi process started with `--fork <parent file>`. The
// parent's CC file must keep its size, line count and mtime through every
// child turn.
//
// FORK_CACHE_BRIDGE_DIR: bridge checkout to load (default: this one).
// FORK_CACHE_CONTROL=1: record the table without asserting the cache hit, the
//   inherit line or the rows (a control run on a bridge without the change);
//   the parent-file check stays asserted.
// FORK_CACHE_REPORT: write the markdown usage table there.
// Requires: pi CLI, Claude Code. Uses real API quota.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSessionPath } from "cc-session-io";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { cacheHit, MIN_CONVERSATION_TOKENS, promptUsage, writeUsageReport } from "./lib/cache-usage.mjs";
import { deleteSessionState, loadSessionState } from "../src/session-store.js";

const TIMEOUT = 180_000;
const MODEL = "claude-bridge/claude-haiku-4-5";
// The cache lives 5 minutes; each case runs well inside that after its reference turn.
const MAX_SECONDS_AFTER_REFERENCE = 120;
const REPO = resolve(import.meta.dirname, "..");
const BRIDGE_DIR = resolve(process.env.FORK_CACHE_BRIDGE_DIR ?? REPO);
const CONTROL = process.env.FORK_CACHE_CONTROL === "1";
// Read by absolute path from a temporary cwd; large enough that the shared
// prefix of every case carries the 30K conversation tokens the check needs.
const LARGE_READS = ["CHANGELOG.md", "README.md", "PLAN-SESSION-SYNC.md", "diag/CACHE-REBUILD-FINDINGS.md", "diag/AUDIT.md"].map((file) => join(REPO, file));

const tmp = mkdtempSync(join(tmpdir(), "pi-claude-bridge-fork-cache-"));
const cwd = join(tmp, "project");
mkdirSync(cwd);
const sessionDir = join(tmp, "sessions");
const debugLog = join(tmp, "bridge-debug.log");
const piSessionIds = new Set();

function harnessFor(name, extraArgs = [], env = {}) {
	return createRpcHarness({
		name,
		cwd,
		bridgeDir: BRIDGE_DIR,
		persistSession: true,
		args: ["--session-dir", sessionDir, "--model", MODEL, ...extraArgs],
		env: { CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: debugLog, ...env },
		defaultTimeout: TIMEOUT,
	});
}

const logSize = () => { try { return statSync(debugLog).size; } catch { return 0; } };
const logSince = (mark) => readFileSync(debugLog).subarray(mark).toString("utf8");

/** Decision rows of every provider sync logged after byte offset `mark`. */
function syncsSince(mark) {
	return [...logSince(mark).matchAll(/syncResult: path=([a-z-]+) sessionId=(\S+) .* row=(\d+)/g)].map((m) => ({ path: m[1], sessionId: m[2], row: Number(m[3]) }));
}

async function sessionInfo(harness) {
	const state = await harness.send({ type: "get_state" });
	piSessionIds.add(state.sessionId);
	return state;
}

/** Size, line count and mtime of a CC session file. */
function fileFacts(path) {
	const stat = statSync(path);
	return { size: stat.size, lines: readFileSync(path, "utf8").split("\n").filter(Boolean).length, mtimeMs: stat.mtimeMs };
}

async function stopAndWait(harness) {
	const proc = harness.pi();
	const exited = !proc || proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
	await harness.stop();
	await exited;
}

/** The fingerprint side file of a pi session (format of src/fork-inherit.ts). */
function fingerprintPath(agentDir, piSessionId) {
	const hash = createHash("sha256").update(piSessionId, "utf16le").digest("hex");
	return join(agentDir, "claude-bridge", "fork-inherit", `f-${hash}.json`);
}

describe("prompt cache after fork and clone", () => {
	let current;
	let passed = false;

	after(async () => {
		if (current) await stopAndWait(current);
		for (const id of piSessionIds) {
			deleteSessionState(id);
			rmSync(fingerprintPath(getAgentDir(), id), { force: true });
		}
		const projectDir = dirname(getSessionPath("probe", cwd, process.env.CLAUDE_CONFIG_DIR));
		if (passed) {
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(tmp, { recursive: true, force: true });
		} else {
			console.log(`  Kept for diagnosis: ${tmp} and ${projectDir}`);
		}
	});

	it("keeps the cache for clone, fork at an earlier message and --fork", { timeout: 15 * 60_000 }, async () => {
		const cases = [];
		const failures = [];
		let parent;
		/** One case: `event` creates the child and returns its pi session id, then one prompt follows. */
		async function measure(name, { reference, sessionFirst, event, prompt }) {
			const before = fileFacts(parent.ccPath);
			const mark = logSize();
			const childId = await event();
			assert.notEqual(childId, parent.id, `${name}: still on the parent session`);
			const turn = await promptUsage(current, prompt);
			const afterTurn = fileFacts(parent.ccPath);
			const log = logSince(mark);
			const syncs = syncsSince(mark);
			const inherited = log.includes(`fork-inherit: ${childId} inherits CC session ${parent.ccSessionId.slice(0, 8)} from ${parent.id}`);
			const decision = log.match(new RegExp(`fork-inherit: ${childId} (inherits|not inherited[^\\n]*)`))?.[1] ?? "none";
			const parentFile = before.size === afterTurn.size && before.lines === afterTurn.lines && before.mtimeMs === afterTurn.mtimeMs ? "unchanged" : "CHANGED";
			const seconds = (turn.endedAt - reference.endedAt) / 1000;
			const check = cacheHit({ after: turn.first, reference: reference.last, sessionFirst });
			const rows = `${syncs.map((s) => `${s.row} (${s.path})`).join(", ") || "none"}; fork-inherit: ${decision}; parent CC file: ${parentFile}`;
			cases.push({ name, rows, seconds, after: turn.first, check });
			console.log(`  ${name}: rows=${rows} seconds=${seconds.toFixed(0)} referenceInput=${check.referenceInput} conversation=${check.conversation} `
				+ `input=${turn.first.input} cacheRead=${turn.first.cacheRead} cacheWrite=${turn.first.cacheWrite}`);
			if (parentFile !== "unchanged") failures.push(`${name}: parent CC file changed ${JSON.stringify(before)} -> ${JSON.stringify(afterTurn)}`);
			if (!syncs.length) failures.push(`${name}: no syncResult logged`);
			if (CONTROL) return turn;
			if (!check.largeEnough) failures.push(`${name}: reference conversation ${check.conversation} < ${MIN_CONVERSATION_TOKENS} tokens, a miss could pass`);
			if (!check.hit) failures.push(`${name}: cache miss (read ${(check.readShare * 100).toFixed(1)}% of reference input, wrote ${(check.writeShare * 100).toFixed(1)}% of conversation)`);
			if (!inherited) failures.push(`${name}: no inherit line for ${childId} (${decision})`);
			if (syncs.length && ![6, 7].includes(syncs[0].row)) failures.push(`${name}: first sync took row ${syncs[0].row}, expected 6 or 7`);
			if (seconds > MAX_SECONDS_AFTER_REFERENCE) failures.push(`${name}: ran ${seconds.toFixed(0)}s after its reference turn`);
			return turn;
		}

		try {
			current = harnessFor("fork-cache");
			await current.startAndWait();

			// Parent: the first turn carries the large reads, so every reference turn is large.
			const t1 = await promptUsage(current,
				`Use the read tool to read each of these files in full: ${LARGE_READS.join(", ")}. Then reply with one line: the number of files you read.`);
			const sessionFirst = t1.first;
			const t2 = await promptUsage(current, "In one line: what is the first heading in CHANGELOG.md?");
			const t3Prompt = "In one line: which of the files you read is the longest?";
			const t3 = await promptUsage(current, t3Prompt);
			const { sessionId, sessionFile } = await sessionInfo(current);
			assert.ok(sessionFile, "pi did not persist the session");
			const lastSync = syncsSince(0).at(-1);
			const state = loadSessionState(sessionId, () => {});
			assert.ok(state, "the parent's bridge state was not persisted");
			assert.equal(lastSync?.sessionId, state.ccSessionId, "the parent's last sync and its persisted state name different CC sessions");
			parent = { id: sessionId, file: sessionFile, ccSessionId: state.ccSessionId, ccPath: getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR) };

			await measure("clone", {
				reference: t3, sessionFirst,
				event: async () => {
					assert.equal((await current.send({ type: "clone" })).cancelled, false);
					return (await sessionInfo(current)).sessionId;
				},
				prompt: "In one line: what is the first heading in README.md?",
			});

			await measure("fork at the third user message", {
				reference: t2, sessionFirst,
				event: async () => {
					assert.equal((await current.send({ type: "switch_session", sessionPath: parent.file })).cancelled, false);
					assert.equal((await sessionInfo(current)).sessionId, parent.id, "switch_session did not return to the parent");
					const { messages } = await current.send({ type: "get_fork_messages" });
					assert.equal(messages[2]?.text, t3Prompt, "the third user message is not the parent's third prompt");
					assert.equal((await current.send({ type: "fork", entryId: messages[2].entryId })).cancelled, false);
					return (await sessionInfo(current)).sessionId;
				},
				prompt: "In one line: what is the first heading in PLAN-SESSION-SYNC.md?",
			});

			await measure("--fork in a new process", {
				reference: t3, sessionFirst,
				event: async () => {
					await stopAndWait(current);
					current = harnessFor("fork-cache-cross-process", ["--fork", parent.file]);
					await current.startAndWait();
					return (await sessionInfo(current)).sessionId;
				},
				prompt: "In one line: what is the first heading in diag/AUDIT.md?",
			});
		} finally {
			if (process.env.FORK_CACHE_REPORT) {
				writeUsageReport(process.env.FORK_CACHE_REPORT, `Prompt cache after fork and clone${CONTROL ? " (control run)" : ""}`, cases);
				writeFileSync(process.env.FORK_CACHE_REPORT, `${readFileSync(process.env.FORK_CACHE_REPORT, "utf8")}\nBridge: \`${BRIDGE_DIR === REPO ? "this checkout" : "FORK_CACHE_BRIDGE_DIR"}\`${CONTROL ? ", control mode (only the parent-file check asserted)" : ""}.\n`);
			}
		}
		assert.deepEqual(failures, []);
		passed = true;
	});
});
