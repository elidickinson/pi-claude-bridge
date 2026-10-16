#!/usr/bin/env node
// What Claude Code's recorded system prompt freezes, and whether the bridge's
// REBUILD releases it.
//
// eli/plan-snapshot-middle.md rests on a chain no probe has run end to end: a
// changed append while the recording stands (the known issue in
// eli/known-issues.md), then a rebuild in the bridge's own shape, then what the
// next request carries. This runs the whole chain in one session and reads
// every answer off the wire (diag/capture-proxy.mjs), cross-checked against the
// session file.
//
//   Q1  append changed, no rebuild            the request carries the old append
//   Q2  append changed, then a rebuild        the request carries the new append
//   Q3  same append again after that rebuild  it still carries the new append
//   Q4  MCP tool set changed on resume        recorded list or fresh list?
//
// Q1-Q3 are measured answers, not expectations: if one comes back the other
// way, the plan is void and that is the finding. The run exits non-zero only
// when the probe itself produced no data — a turn missing from the capture, a
// recording that never appeared, a rebuild that kept one. If no prompt_snapshot
// record appears at all, the recording is not active for this account, nothing
// here is measured, and the run stops rather than reporting staleness it never
// exercised.
//
// The rebuild is cc-session-io's deleteSession + createSession(same id) +
// importMessages, the calls src/index.ts's REBUILD path makes. The history it
// imports is hand-written (one user/assistant pair per turn) rather than
// converted from pi's, since message content cannot affect the recording. That
// also skips attachment carrying, which only moves `file` attachments and is
// not at issue here.
//
//   node diag/probe-prompt-recording.mjs [--model claude-haiku-4-5] [--out DIR]
//
// Needs ANTHROPIC_API_KEY or a logged-in Claude Code, and a writable ~/.claude:
// CC persists session state there. Seven Haiku requests per run.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession, deleteSession, openSession, parseJsonlFile } from "cc-session-io";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("model", "claude-haiku-4-5");
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "prompt-recording-"));
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR;

// The claude_code preset's own anchor. CC's title/summary side requests share no
// prefix with it, so this selects the agent-loop requests from a capture.
const PRESET_ANCHOR = "You are an interactive agent";

const runTag = randomUUID().slice(0, 8);
const MARK = { one: `MARKER-ONE-${runTag}`, two: `MARKER-TWO-${runTag}` };
const MARKS = [{ label: "ONE", value: MARK.one }, { label: "TWO", value: MARK.two }];

/** One probe turn. `token` appears in its own user prompt only, which is how the
 *  turn's request is located in the capture and how the rebuild history is
 *  described. */
const makeTurn = (label) => ({
	label,
	token: `${label}-${runTag}`,
	prompt: `Reply with exactly: ${label}-${runTag}.`,
});

const T = {
	A1: makeTurn("A1"),
	A2: makeTurn("A2"),
	A2b: makeTurn("A2b"),
	A3: makeTurn("A3"),
	A4: makeTurn("A4"),
	B1: makeTurn("B1"),
	B2: makeTurn("B2"),
};

// --- probe hygiene ---

// Whether a step produced data at all. The answers below are measured, not
// expected: a step that produced nothing invalidates all of them, so that is
// the only thing that fails the run.
const checks = [];
const hygiene = (ok, label, detail = "") => {
	checks.push({ ok: Boolean(ok), label, detail });
	console.error(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? `  [${detail}]` : ""}`);
	return Boolean(ok);
};

// --- capture ---

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitForPort(port) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const open = await new Promise((resolve) => {
			const socket = connect(port, "127.0.0.1", () => { socket.end(); resolve(true); });
			socket.once("error", () => resolve(false));
		});
		if (open) return;
		await delay(100);
	}
	throw new Error(`capture proxy did not listen on ${port}`);
}

/** Agent-loop /v1/messages requests in send order, bodies included. */
function loadRequests(captureDir) {
	const rows = readFileSync(join(captureDir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return rows
		.filter((row) => row.path?.startsWith("/v1/messages") && row.status === 200)
		.map((row) => ({
			n: row.n,
			usage: row.usage ?? null,
			body: JSON.parse(readFileSync(join(captureDir, `req-${String(row.n).padStart(4, "0")}.json`), "utf8")),
		}))
		.filter((row) => JSON.stringify(row.body.system ?? []).includes(PRESET_ANCHOR));
}

const systemText = (body) => JSON.stringify(body.system ?? []);

/** Which markers a request's system prompt carries. */
const carried = (body) => MARKS.filter((m) => systemText(body).includes(m.value)).map((m) => m.label).join("+") || "none";

/** The request whose conversation contains `token` first: that turn's own request. */
const reqFor = (requests, token) => requests.find((row) => JSON.stringify(row.body.messages ?? []).includes(token));

// --- session file ---

/** prompt_snapshot records in a session file. A missing file is a bug in the
 *  step that should have written one, so throw rather than report it as none. */
function snapshots(jsonlPath) {
	let records;
	try {
		records = parseJsonlFile(jsonlPath);
	} catch (error) {
		throw new Error(`no session file at ${jsonlPath}: ${error.message}`);
	}
	return records
		.filter((record) => record.type === "attachment" && record.attachment?.type === "prompt_snapshot")
		.map((record) => {
			const attachment = record.attachment;
			const text = JSON.stringify(attachment.systemPrompt ?? []);
			return {
				keys: Object.keys(attachment).join(","),
				segments: Array.isArray(attachment.systemPrompt) ? attachment.systemPrompt.length : null,
				markers: MARKS.filter((m) => text.includes(m.value)).map((m) => m.label),
				tools: Array.isArray(attachment.tools) ? attachment.tools.map((tool) => tool?.name ?? "?") : null,
			};
		});
}

const describeSnapshots = (list) => list.length === 0 ? "0 records"
	: `${list.length} record(s) ` + list.map((s) => `[${s.keys}${s.markers.length ? ` ${s.markers.join("+")}` : ""}${s.tools ? ` tools=${s.tools.join("+") || "none"}` : ""}]`).join(" ");

// --- tools for the Q4 leg ---

const noArgTool = (name) => ({ name, description: `Returns the ${name} value.`, inputSchema: { type: "object", properties: {} } });

/** Bare MCP server serving `tools` and answering every call with a canned value. */
function toolServer(tools) {
	const server = new McpServer({ name: "custom-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => ({
		content: [{ type: "text", text: `${request.params.name}-VALUE` }],
	}));
	return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server } };
}

// --- one turn ---

/** Run one turn through the capture proxy. Returns the session id it produced. */
async function runTurn(cwd, proxyUrl, { turn, append, resume, mcpServers }) {
	const q = query({
		prompt: turn.prompt,
		options: {
			cwd,
			model: MODEL,
			tools: [],
			permissionMode: "bypassPermissions",
			maxTurns: 3,
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: proxyUrl,
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1",
			},
			systemPrompt: { type: "preset", preset: "claude_code", append },
			// Suppress ambient filesystem MCP servers, so a tools list means ours.
			extraArgs: { "strict-mcp-config": null },
			...(resume ? { resume } : {}),
			...(mcpServers ? { mcpServers } : {}),
		},
	});
	let sessionId = null;
	let reply = "";
	for await (const message of q) {
		if (message.type === "assistant") {
			for (const block of message.message?.content ?? []) if (block.type === "text") reply += block.text;
		}
		if (message.type === "result") sessionId = message.session_id;
	}
	if (!sessionId) throw new Error(`${turn.label}: no session id; see ${OUT}`);
	return { sessionId, reply: reply.trim() };
}

// --- the run ---

async function run() {
	mkdirSync(OUT, { recursive: true });
	const cwd = join(OUT, "cwd");
	const captureDir = join(OUT, "capture");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(captureDir, { recursive: true });

	const port = await freePort();
	const proxyLog = openSync(join(OUT, "proxy.log"), "w");
	const proxy = spawn(process.execPath, [join(REPO, "diag/capture-proxy.mjs"), "--port", String(port), "--out", captureDir], {
		stdio: ["ignore", "ignore", proxyLog],
	});
	const proxyUrl = `http://127.0.0.1:${port}`;
	const state = { requests: [], snapshots: {}, rows: [] };
	const replies = {};
	try {
		await waitForPort(port);

		// A1: fresh session. This is where the recording is made.
		const a1 = await runTurn(cwd, proxyUrl, { turn: T.A1, append: MARK.one });
		replies.A1 = a1.reply;
		const sessionId = a1.sessionId;
		const jsonlPath = openSession({ sessionId, projectPath: cwd, claudeDir: CLAUDE_DIR }).jsonlPath;
		state.requests = loadRequests(captureDir);
		state.snapshots.afterA1 = snapshots(jsonlPath);
		console.error(`session ${sessionId.slice(0, 8)} file ${jsonlPath}`);

		if (state.snapshots.afterA1.length === 0) {
			console.error(`\nNo prompt_snapshot record after the first request: the recording is not active for`);
			console.error(`this account (it is an account-gated rollout). Nothing below is measured.`);
			writeFileSync(join(OUT, "report.json"), JSON.stringify({ model: MODEL, recording: "inactive", ...state }, null, 1));
			process.exit(1);
		}

		// A2, A2b: the same changed append twice, no rebuild. The known issue is
		// that neither reaches the model. A2b is the control that keeps Q2 from
		// reading as "the second attempt wins".
		replies.A2 = (await runTurn(cwd, proxyUrl, { turn: T.A2, append: MARK.two, resume: sessionId })).reply;
		replies.A2b = (await runTurn(cwd, proxyUrl, { turn: T.A2b, append: MARK.two, resume: sessionId })).reply;
		state.requests = loadRequests(captureDir);

		// The bridge's REBUILD: wipe the file, re-author it from pi's history under
		// the same id. The recording is not among the records this writes.
		deleteSession(sessionId, cwd, CLAUDE_DIR);
		const rebuilt = createSession({ projectPath: cwd, claudeDir: CLAUDE_DIR, sessionId, model: MODEL });
		rebuilt.importMessages([T.A1, T.A2, T.A2b].flatMap((t) => [
			{ role: "user", content: t.prompt },
			{ role: "assistant", content: [{ type: "text", text: replies[t.label] ?? t.token }] },
		]));
		rebuilt.save();
		state.snapshots.afterRebuild = snapshots(rebuilt.jsonlPath);

		// A3: same append A2 asked for. The chain holds if it arrives now.
		await runTurn(cwd, proxyUrl, { turn: T.A3, append: MARK.two, resume: sessionId });
		// A4: unchanged append, to show the new recording sticks.
		await runTurn(cwd, proxyUrl, { turn: T.A4, append: MARK.two, resume: sessionId });
		state.requests = loadRequests(captureDir);
		state.snapshots.afterA4 = snapshots(jsonlPath);

		// Q4: the loadout changes between two resumes and the append does not.
		const b1 = await runTurn(cwd, proxyUrl, {
			turn: T.B1, append: MARK.one,
			mcpServers: toolServer([noArgTool("alpha")]),
		});
		const b1Path = openSession({ sessionId: b1.sessionId, projectPath: cwd, claudeDir: CLAUDE_DIR }).jsonlPath;
		state.snapshots.afterB1 = snapshots(b1Path);
		await runTurn(cwd, proxyUrl, {
			turn: T.B2, append: MARK.one, resume: b1.sessionId,
			mcpServers: toolServer([noArgTool("alpha"), noArgTool("beta")]),
		});
		state.requests = loadRequests(captureDir);
		state.snapshots.afterB2 = snapshots(b1Path);
	} finally {
		proxy.kill();
		closeSync(proxyLog);
	}

	// --- report ---

	const requests = state.requests;
	const rows = Object.values(T).map((t) => {
		const request = reqFor(requests, t.token);
		return request ? {
			turn: t.label,
			request: `req-${String(request.n).padStart(4, "0")}`,
			carried: carried(request.body),
			tools: (request.body.tools ?? []).map((tool) => tool.name),
			cacheRead: request.usage?.cacheRead ?? null,
			cacheWrite: request.usage?.cacheWrite ?? null,
		} : { turn: t.label, request: "not captured" };
	});
	state.rows = rows;

	console.log(`\nmodel ${MODEL}, ${requests.length} agent-loop requests, output ${OUT}`);
	console.log(`  turn  request  system carried  cacheRead  cacheWrite  tools`);
	for (const row of rows) {
		console.log(`  ${row.turn.padEnd(4)}  ${String(row.request).padEnd(8)}  ${String(row.carried ?? "-").padEnd(14)}  ${String(row.cacheRead ?? "-").padStart(9)}  ${String(row.cacheWrite ?? "-").padStart(10)}  ${(row.tools ?? []).join("+") || "-"}`);
	}
	for (const [label, list] of Object.entries(state.snapshots)) console.log(`  ${label}: ${describeSnapshots(list)}`);

	const of = (label) => rows.find((row) => row.turn === label);
	const verdicts = [];
	const q = (name, answer, expected) => {
		verdicts.push({ name, answer, expected });
		console.log(`${answer === expected ? "  " : "!!"}${name} ${answer}${answer === expected ? "" : ` (expected ${expected})`}`);
	};

	const a1 = of("A1");
	const a2 = of("A2");
	const a2b = of("A2b");
	const a3 = of("A3");
	const a4 = of("A4");
	const b1 = of("B1");
	const b2 = of("B2");

	for (const row of rows) hygiene(row.request !== "not captured", `${row.turn} reached the capture`);
	hygiene(state.snapshots.afterA1.some((s) => s.markers.includes("ONE")), "the first request records the append", describeSnapshots(state.snapshots.afterA1));
	hygiene(state.snapshots.afterRebuild.length === 0, "the rebuild leaves no prompt_snapshot", describeSnapshots(state.snapshots.afterRebuild));
	hygiene(state.snapshots.afterA4.some((s) => s.markers.includes("TWO")), "the request after the rebuild re-records the new append", describeSnapshots(state.snapshots.afterA4));

	q("Q1 append changed, no rebuild -> carried", a2?.carried ?? "?", "ONE");
	q("Q1 again, second attempt -> carried", a2b?.carried ?? "?", "ONE");
	q("Q2 append changed, then rebuild -> carried", a3?.carried ?? "?", "TWO");
	q("Q3 unchanged after the rebuild -> carried", a4?.carried ?? "?", "TWO");

	const b1Tools = b1?.tools ?? [];
	const b2Tools = b2?.tools ?? [];
	const b1Request = reqFor(requests, T.B1.token);
	const b2Request = reqFor(requests, T.B2.token);
	// The schemas on the wire are only half of it. The snapshot also froze the
	// prose describing tools, so a new tool can be callable but undescribed.
	const mentions = (body, name) => systemText(body).includes(name);
	console.log(`\nQ4 tool loadout changed on resume: request carried ${b2Tools.join("+") || "nothing"}`);
	console.log(`   schemas: ${(state.snapshots.afterB1[0]?.tools ?? []).join("+") || "none"} recorded -> ` +
		`${b2Tools.join("+") || "nothing"} on the wire, ${b2Tools.length > b1Tools.length ? "re-listed fresh" : "frozen at the recording"}`);
	for (const name of ["alpha", "beta"]) {
		console.log(`   prose: tool "${name}" mentioned in B2 system prompt: ${mentions(b2Request?.body ?? {}, name)}`);
	}
	verdicts.push({
		name: "Q4 tool loadout changed on resume -> carried",
		answer: b2Tools.join("+"),
		expected: "reported only",
	});

	writeFileSync(join(OUT, "report.json"), JSON.stringify({ model: MODEL, recording: "active", ...state, verdicts }, null, 1));
	console.log(`\nreport: ${join(OUT, "report.json")}`);
	if (checks.some((c) => !c.ok)) {
		console.error(`\n${checks.filter((c) => !c.ok).length} step(s) produced no data — the answers above are not measured`);
		process.exit(1);
	}
}

await run();
