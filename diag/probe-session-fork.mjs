#!/usr/bin/env node
// Can the bridge cut Claude Code's own session at a record and resume from there,
// keeping the prompt cache and earlier thinking up to the cut? Measures the Agent
// SDK's truncating resume (resumeSessionAt + forkSession, optionally resumeDropsTurn)
// and its alpha sessionStore on native sessions, including after aborts, a steer
// and a tool result CC saved to tool-results/.
//
//   node --import tsx diag/probe-session-fork.mjs [--cases NAME,NAME] [--out DIR]
//
// Two native seeds, each two tool-using turns with small reasoning questions:
// store-seed is recorded through an in-memory sessionStore; steer-seed gets a steer
// while turn two's tool call is pending, delivered as the bridge delivers it.
// Cases (--cases adds their prerequisites):
//   store-mirror            the store's entries equal CC's file, byte for byte, in order
//   fork-truncate           cut at turn 1's last record, resumeDropsTurn = turn 2's prompt
//   store-resume            resume from the store's entries unchanged
//   store-resume-cut        resume from the store's entries cut after turn 1
//   plain-resume            control: plain resume of store-seed
//   steer-refusal           resumeDropsTurn refuses a dropped range holding the steer
//   abort-mid-text          plain resume of steer-seed, aborted mid-reply
//   fork-after-abort-text   cut before that turn; the next turn is aborted mid-tool
//   fork-after-abort-tool   right after that abort, cut before it; the next turn's
//                           93,599-character tool result is saved to tool-results/
//   fork-after-big-result   cut at that turn's last record
//   fork-two-turns-back     cut at turn 1's last record, dropping the steer and the abort
//   fork-at-aborted-prompt  cut at the aborted turn's own prompt record
//   abort-at-first-delta    new session aborted at the reply's first text delta,
//                           before any assistant message: does CC record an
//                           assistant message no complete one showed, and does a
//                           stream event's uuid name it?
//
// Every query uses the bridge provider path's options (src/index.ts), supplies its
// own prompt uuid, and goes through the capture proxy with Claude Code treating it
// as first-party (diag/lib/first-party.mjs), so CC sends the thinking-binding beta
// and the API reports any thinking it drops. A measured case compares its first
// request with the request that ended the kept range (the ancestor): the cache read
// must equal what the ancestor cached, the kept range's thinking must all be sent
// with none dropped, and the normalized bodies may differ only in metadata. Each
// case adds its own checks. A case whose setup did not happen (no thinking, abort
// never triggered, tool not called) is NOT EXERCISED, never a pass.
//
// Paid: about 20 Haiku 5.5 requests at medium effort on the Claude subscription;
// stops at the first rate-limit or quota error. Must run outside the sandbox. Every
// Claude Code session it creates is deleted at the end; the capture, copies of the
// sessions and report.json stay under --out (they hold the conversation).

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deleteSession, InMemorySessionStore, query } from "@anthropic-ai/claude-agent-sdk";
import { getProjectDir, normalizeProjectPath, projectPathToHash } from "cc-session-io";
import { claudeCodeSettings } from "../src/config.js";
import { __test as bridge } from "../src/index.js";
import { createToolServer } from "../src/mcp-server.js";
import { makePromptStream, userMessage } from "../src/prompt-stream.js";
import { MCP_SERVER_NAME } from "../src/skills.js";
import { FIRST_PARTY_ENV } from "./lib/first-party.mjs";
import { compareRequestBodies } from "./lib/request-diff.mjs";
import { configChanges, isMessages, loadCapture } from "./lib/trace-analysis.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "probe-session-fork-"));
if (existsSync(OUT) && readdirSync(OUT).length) throw new Error(`${OUT} is not empty; each run needs its own --out`);
const MODEL = "claude-haiku-5-5";
const EFFORT = "medium";
// Sent by Claude Code itself on thinking requests once it treats the proxy as first-party.
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const RATE_LIMIT = /\b429\b|rate.?limit|session limit|usage limit|quota/i;
const INTERRUPTED = "[Request interrupted by user";
const REJECTED = "doesn't want to proceed";
// As src/index.ts (CLAUDE_MD_EXCLUDES is module-private there).
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];
const NONCE = Date.now().toString(36);
const PRIME = "Think it through first: is 391 prime, and if not what are its factors?";
const LEVEL = "Think it through first: how many distinct arrangements are there of the letters in LEVEL?";
const callOnce = (tool) => ` Then call ${tool} exactly once. After the tool result, reply in one line with the answer and the tool's marker.`;
const OK = "Do not call any tools. Reply with exactly: ok.";
// 1300 lines, 93,599 characters: over CC's 50,000-character limit, so CC saves it to tool-results/.
const BIG = Array.from({ length: 1300 }, (_, i) => `L${String(i + 1).padStart(5, "0")} ${createHash("sha256").update(`big-${i + 1}`).digest("hex")}`).join("\n");

/** Ends the run early with a reported reason (rate limit, quota). */
class Stop extends Error {}

const cwd = join(OUT, "cwd");
const captureDir = join(OUT, "capture");
mkdirSync(cwd, { recursive: true });
const projectDir = getProjectDir(cwd);
const projectKey = projectPathToHash(normalizeProjectPath(cwd));
const report = { model: MODEL, effort: EFFORT, out: OUT, sdk: JSON.parse(readFileSync(join(REPO, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version, claudeCode: null, stopped: null, cases: {} };
let proxyUrl = null;

const text = (value) => ({ content: [{ type: "text", text: value }] });
const textOf = (content) => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
const prompt = (name, body) => ({ marker: `[${name}-${NONCE}]`, text: `[${name}-${NONCE}] ${body}`, uuid: randomUUID() });
const sha = (id) => createHash("sha256").update(readFileSync(sessionFile(id))).digest("hex");
const pad = (n) => String(n).padStart(4, "0");

async function startProxy() {
	const proxy = spawn(process.execPath, [join(REPO, "diag/capture-proxy.mjs"), "--port", "0", "--out", captureDir], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	proxy.stderr.on("data", (d) => { log += d; });
	const url = await new Promise((resolve, reject) => {
		proxy.stderr.on("data", () => { const m = log.match(/capture proxy on (http:\/\/\S+)/); if (m) resolve(m[1]); });
		proxy.on("exit", (code) => reject(new Error(`capture proxy exited ${code}: ${log}`)));
	});
	return { url, stop: async () => { if (proxy.exitCode === null) { proxy.kill("SIGTERM"); await once(proxy, "exit"); } writeFileSync(join(OUT, "proxy.log"), log); } };
}

/** Polls `probe` until it returns something truthy or `ms` pass; null on timeout. */
async function waitFor(probe, ms = 10_000) {
	for (const end = Date.now() + ms; Date.now() < end; await delay(50)) {
		const value = probe();
		if (value) return value;
	}
	return null;
}

// --- Capture ---

const capture = () => existsSync(join(captureDir, "index.jsonl")) ? loadCapture(captureDir) : null;
const routeRequests = (route) => capture()?.requests.filter((r) => r.route === route) ?? [];
/** Every request the route started has ended (the proxy records a disconnect a moment after it). */
const proxySettled = (route) => {
	const c = capture();
	return c ? !c.unterminated.some((u) => u.route === route) : !existsSync(join(captureDir, "proxy-events.jsonl"));
};
/** Main-loop Messages requests of one query, in send order. */
const mainRequests = (route) => routeRequests(route).filter((r) => isMessages(r) && (r.tools ?? 0) > 0);
const sends = (row, marker) => JSON.stringify(row.body?.messages ?? []).includes(marker);
const requestList = (route) => routeRequests(route).map((r) => ({ n: r.n, path: new URL(r.path, "http://x").pathname, status: r.status, terminal: r.terminal, usage: r.usage }));
const thinkingIn = (messages) => messages.flatMap((m) => Array.isArray(m?.content) ? m.content : [])
	.filter((b) => b?.type === "thinking" || b?.type === "redacted_thinking").length;

function stopOnRateLimit(route) {
	const errorBody = (n) => existsSync(join(captureDir, `err-${pad(n)}.json`)) ? readFileSync(join(captureDir, `err-${pad(n)}.json`), "utf8") : "";
	const limited = routeRequests(route).filter((r) => r.status === 429 || RATE_LIMIT.test(JSON.stringify(r.streamError ?? "")) || (r.status >= 400 && RATE_LIMIT.test(errorBody(r.n))));
	if (limited.length) throw new Stop(`rate limited in ${route}: requests ${limited.map((r) => `#${r.n} ${r.status}`).join(", ")}`);
}

// --- Session files ---

const sessionFile = (id) => join(projectDir, `${id}.jsonl`);
function readSession(id) {
	const lines = readFileSync(sessionFile(id), "utf8").split("\n").filter(Boolean);
	return { lines, records: lines.map((line) => JSON.parse(line)) };
}
const isChain = (r) => Boolean(r.uuid) && ["user", "assistant", "attachment", "system"].includes(r.type);
const promptIndex = (records, marker) => records.findIndex((r) => r.type === "user" && !r.isMeta && textOf(r.message?.content).includes(marker));
const assistantMessages = (records) => records.filter((r) => r.type === "assistant").map((r) => r.message);
const interrupted = (records) => records.some((r) => r.type === "user" && textOf(r.message?.content).startsWith(INTERRUPTED));
/** CC writes an aborted turn's records as it exits, ending with an interrupt marker: wait
 *  for the marker after the prompt carrying `marker` (bounded; it may never come), then read. */
async function readAfterAbort(id, marker) {
	await waitFor(() => { const { records } = readSession(id); return interrupted(records.slice(promptIndex(records, marker))); });
	return readSession(id).records;
}
/** Paths of tool results Claude Code saved to a session's tool-results/ directory. */
const savedPaths = (value) => [...new Set((JSON.stringify(value).match(/\/[^"\\\s]*tool-results\/[^"\\\s]+/g) ?? []).map((p) => p.replace(/[.,;:)]+$/, "")))];

/** Each prompt's record, the turn's last chain record, and the request that ended the turn. */
function seedTurns(id, route, prompts) {
	const { lines, records } = readSession(id);
	const rows = mainRequests(route);
	const at = prompts.map((p) => promptIndex(records, p.marker));
	if (at.includes(-1)) throw new Error(`${route}: a prompt is missing from session ${id}`);
	const ends = at.map((_, k) => records.slice(0, at[k + 1] ?? records.length).findLast(isChain));
	const turnRows = prompts.map((p, k) => rows.findLast((r) => sends(r, p.marker) && !(prompts[k + 1] && sends(r, prompts[k + 1].marker))));
	if (turnRows.some((r) => !r?.usage)) throw new Error(`${route}: a turn has no measured request; see ${captureDir}`);
	return { session: id, lines, records, prompts: at.map((i) => records[i]), ends, rows: turnRows };
}

// --- Queries ---

function probeTools(seen, slow) {
	const tool = (name, description, result) => ({
		name, description, inputSchema: { type: "object", properties: {} },
		handler: async () => { seen.calls.push(name); return result(); },
	});
	return [
		tool("cache_probe", "Returns a fixed cache probe marker.", () => text("FIXED-CACHE-PROBE-RESULT")),
		tool("slow_probe", "Returns a fixed slow probe marker (may take a while).", () => slow ? slow() : text("FIXED-SLOW-PROBE-RESULT")),
		tool("big_probe", "Returns a large fixed data listing.", () => text(BIG)),
	];
}

/**
 * One query with the bridge provider path's options, its traffic routed as `route`.
 * Prompts are sent one per result. `hooks.onMessage(m, seen, abort)` sees every SDK
 * message; `hooks.slow({ send, park, abort })` serves slow_probe. `abort` does what the
 * bridge's abort does: fail the prompt stream, release a parked tool call, interrupt
 * and close. The query is always disposed (the SDK waits up to 2 s for CC to exit).
 */
async function run(route, prompts, options = {}, hooks = {}) {
	const promptStream = makePromptStream();
	const seen = { session: null, results: [], assistantUuids: [], toolResultUuids: [], streamEventUuids: [], textChars: 0, calls: [], abort: null };
	let parked = null;
	let sdkQuery = null;
	const send = (p, priority) => promptStream.push({ ...userMessage([{ type: "text", text: p.text }], priority), uuid: p.uuid });
	const abort = (why) => {
		if (seen.abort) return;
		seen.abort = { why, streamEventsBefore: seen.streamEventUuids.length, assistantsBefore: seen.assistantUuids.length, at: Date.now() };
		promptStream.fail(new Error("Operation aborted"));
		parked?.(text("Operation aborted"));
		void sdkQuery.interrupt().catch(() => {});
		sdkQuery.close();
	};
	const slow = hooks.slow && (() => hooks.slow({ send, abort, park: () => new Promise((resolve) => { parked = resolve; }) }));
	let next = 0;
	void send(prompts[next++]).catch(() => {});
	sdkQuery = query({
		prompt: promptStream.stream,
		options: {
			cwd,
			env: { ...process.env, ...bridge.CC_CHILD_ENV, ...FIRST_PARTY_ENV, ANTHROPIC_BASE_URL: `${proxyUrl}/q/${route}` },
			tools: [],
			permissionMode: "bypassPermissions",
			includePartialMessages: true,
			settings: { ...claudeCodeSettings({}), claudeMdExcludes: CLAUDE_MD_EXCLUDES, includeGitInstructions: false },
			systemPrompt: { type: "preset", preset: "claude_code" },
			extraArgs: { model: MODEL, "strict-mcp-config": null, "thinking-display": "summarized" },
			effort: EFFORT,
			mcpServers: { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, probeTools(seen, slow)) },
			...options,
		},
	});
	try {
		for await (const m of sdkQuery) {
			if (m.type === "system" && m.subtype === "init") { seen.session = m.session_id; report.claudeCode = m.claude_code_version; }
			else if (m.type === "stream_event") {
				seen.streamEventUuids.push(m.uuid);
				if (m.event.delta?.type === "text_delta") seen.textChars += m.event.delta.text.length;
			} else if (m.type === "assistant") seen.assistantUuids.push(m.uuid);
			else if (m.type === "user" && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result")) seen.toolResultUuids.push(m.uuid);
			else if (m.type === "result") {
				const resultText = m.is_error ? JSON.stringify(m.errors ?? m.result) : null;
				if (resultText && RATE_LIMIT.test(resultText)) throw new Stop(`rate limited in ${route}: ${resultText}`);
				seen.results.push({ subtype: m.subtype, error: resultText });
				if (next < prompts.length) void send(prompts[next++]).catch(() => {});
				else promptStream.end();
			}
			hooks.onMessage?.(m, seen, abort);
			if (seen.abort) break;
		}
	} catch (error) {
		if (error instanceof Stop) throw error;
		if (RATE_LIMIT.test(String(error?.message))) throw new Stop(`rate limited in ${route}: ${error.message}`);
		// Our own abort ends the query; what the SDK throws then is the expected path.
		if (!seen.abort) throw error;
		seen.errorAfterAbort = String(error?.message ?? error);
	} finally {
		await sdkQuery.return();
		if (!(await waitFor(() => proxySettled(route)))) throw new Error(`${route}: the proxy never ended a request`);
		stopOnRateLimit(route);
	}
	const failed = seen.results.find((r) => r.error);
	if (failed) throw new Error(`${route}: Claude Code returned an error: ${failed.error}`);
	return seen;
}

// --- Checks ---

const check = (name, ok, details) => ({ name, ok: Boolean(ok), ...(details ? { details } : {}) });
/** A check on the case's setup: failing it means the case did not test anything. */
const pre = (name, ok, details) => ({ ...check(name, ok, details), precondition: true });
const brief = (d) => ({ kind: d.kind, label: d.label, path: d.path, afterPath: d.afterPath });

/** The route's first main request against `ancestor`, the request that cached the kept range. */
function measure(route, ancestor, keptMessages) {
	const row = mainRequests(route)[0];
	if (!row?.usage) throw new Error(`${route}: no measured request; see ${captureDir}`);
	const cached = ancestor.usage.cacheRead + ancestor.usage.cacheWrite;
	const kept = thinkingIn(keptMessages);
	const sent = thinkingIn(row.body.messages);
	const dropped = (row.inputTransformations ?? []).filter((t) => t.type === "thinking_dropped").length;
	const diffs = compareRequestBodies(ancestor.body, row.body, { prefixOnly: true }).normalized.aligned;
	const config = configChanges(ancestor.body, row.body).map((c) => c.key);
	return {
		measured: { request: row.n, cacheRead: row.usage.cacheRead, cacheWrite: row.usage.cacheWrite, ancestor: ancestor.n, ancestorCached: cached, thinkingSent: sent, thinkingDropped: dropped, inputTransformations: row.inputTransformations ?? [] },
		checks: [
			pre("thinking-binding beta sent", String(row.betas ?? "").includes(BINDING_BETA)),
			pre("kept range has thinking", kept > 0),
			check("cache read = ancestor's cached prefix", row.usage.cacheRead === cached, { cacheRead: row.usage.cacheRead, cached }),
			check("kept range's thinking sent", sent === kept, { sent, kept }),
			check("no thinking dropped", dropped === 0),
			check("no normalized difference up to the ancestor", diffs.length === 0, diffs.length ? diffs.map(brief) : undefined),
			check("top-level fields: only metadata changed", config.every((k) => k === "metadata"), { changed: config }),
		],
	};
}

/** Fork session `source` at record `cut` and send `p`; checks every fork makes. */
async function fork(route, { source, records, cut, dropsTurn, ancestor, p, hooks, absent = [], present = [] }) {
	const cutAt = records.findIndex((r) => r.uuid === cut);
	if (cutAt === -1) throw new Error(`${route}: cut ${cut} is not in the source records`);
	const kept = records.slice(0, cutAt + 1);
	const before = sha(source);
	const seen = await run(route, [p], { resume: source, resumeSessionAt: cut, forkSession: true, ...(dropsTurn ? { resumeDropsTurn: dropsTurn } : {}) }, hooks);
	const keptIds = kept.filter((r) => r.uuid).map((r) => r.uuid);
	const forked = readSession(seen.session).records;
	const forkedIds = forked.filter((r) => r.uuid).map((r) => r.uuid);
	const snapshots = kept.filter((r) => r.attachment?.type === "prompt_snapshot").map((r) => r.uuid);
	const next = forked[promptIndex(forked, p.marker)];
	const sent = JSON.stringify(mainRequests(route)[0]?.body.messages ?? []);
	const m = measure(route, ancestor, assistantMessages(kept));
	return {
		seen, session: seen.session, measured: m.measured,
		checks: [
			...m.checks,
			check("source file untouched", sha(source) === before),
			check("kept records re-recorded with the same uuids", JSON.stringify(forkedIds.slice(0, keptIds.length)) === JSON.stringify(keptIds), { kept: keptIds.length }),
			check("kept prompt_snapshot records copied", snapshots.every((id) => forkedIds.includes(id)), { snapshots: snapshots.length }),
			check("prompt uuid adopted, parented on the cut", next?.uuid === p.uuid && next.parentUuid === cut, { uuid: next?.uuid, parent: next?.parentUuid }),
			...(absent.length ? [check("dropped records not sent", absent.every((s) => !sent.includes(s)), { absent })] : []),
			...(present.length ? [check("kept records sent", present.every((s) => sent.includes(s)), { present })] : []),
		],
	};
}

/** After an abort: assistant records CC wrote past the prompt carrying `marker` that no complete
 *  assistant message showed, and whether a stream event's uuid names any of them anyway. */
function hiddenChecks(records, marker, seen) {
	const hidden = records.slice(promptIndex(records, marker) + 1).filter((r) => r.type === "assistant" && !seen.assistantUuids.includes(r.uuid));
	const named = hidden.filter((r) => seen.streamEventUuids.includes(r.uuid)).map((r) => r.uuid);
	return {
		hidden: hidden.map((r) => ({ uuid: r.uuid, blocks: r.message.content.map((b) => b.type), stopReason: r.message.stop_reason })),
		checks: [
			check("CC recorded an assistant message no complete assistant message showed", hidden.length > 0),
			check("no stream-event uuid names a hidden record", named.length === 0, { streamEvents: seen.streamEventUuids.length, named }),
		],
	};
}

/** The seed checks: what the stream showed is what the file holds. */
function streamChecks(seen, records, prompts) {
	const ids = new Set(records.map((r) => r.uuid));
	const streamed = [...seen.assistantUuids, ...seen.toolResultUuids];
	const missing = streamed.filter((id) => !ids.has(id));
	return [
		check("streamed assistant and tool-result uuids are the file's", missing.length === 0, { streamed: streamed.length, missing }),
		check("prompt uuids adopted", prompts.every((p) => records[promptIndex(records, p.marker)].uuid === p.uuid)),
	];
}

// --- Cases ---

const ctx = {};

async function storeSeed() {
	const prompts = [prompt("store-T1", PRIME + callOnce("cache_probe")), prompt("store-T2", LEVEL + callOnce("cache_probe"))];
	const store = new InMemorySessionStore();
	const seen = await run("store-seed", prompts, { sessionStore: store });
	ctx.store = { ...seedTurns(seen.session, "store-seed", prompts), p: prompts, store };
	return { session: seen.session, checks: [pre("cache_probe called once per turn", seen.calls.join() === "cache_probe,cache_probe", { calls: seen.calls }), ...streamChecks(seen, ctx.store.records, prompts)] };
}

// Claude Code 2.1.308+ also writes request-audit records into the session file,
// which the store does not mirror.
const AUDIT_TYPES = new Set(["api-request", "api-request-shape", "api-request-blob"]);

function storeMirror() {
	const { session, store } = ctx.store;
	const isAudit = (line) => AUDIT_TYPES.has(JSON.parse(line).type);
	const audit = ctx.store.lines.filter(isAudit);
	const lines = ctx.store.lines.filter((line) => !isAudit(line));
	const entries = store.getEntries({ projectKey, sessionId: session });
	const firstMismatch = lines.findIndex((line, i) => JSON.stringify(entries[i]) !== line);
	return { checks: [check("store entries = CC's file, byte-identical and in order", entries.length === lines.length && firstMismatch === -1, { entries: entries.length, fileLines: lines.length, auditRecordsSkipped: audit.length, firstMismatch })] };
}

async function forkTruncate() {
	const s = ctx.store;
	const { session, measured, checks } = await fork("fork-truncate", { source: s.session, records: s.records, cut: s.ends[0].uuid, dropsTurn: s.prompts[1].uuid, ancestor: s.rows[0], p: prompt("fork-truncate", OK), absent: [s.p[1].marker] });
	return { session, measured, checks };
}

async function storeResume(route, cutAfterTurn1) {
	const s = ctx.store;
	const mirrored = s.store.getEntries({ projectKey, sessionId: s.session });
	const entries = cutAfterTurn1 ? mirrored.slice(0, mirrored.findIndex((e) => e.uuid === s.ends[0].uuid) + 1) : mirrored;
	const store = new InMemorySessionStore();
	await store.append({ projectKey, sessionId: s.session }, structuredClone(entries));
	await run(route, [prompt(route, OK)], { resume: s.session, sessionStore: store });
	const m = measure(route, s.rows[cutAfterTurn1 ? 0 : 1], assistantMessages(entries));
	return { loadedEntries: entries.length, ...m };
}

async function plainResume() {
	const s = ctx.store;
	await run("plain-resume", [prompt("plain-resume", OK)], { resume: s.session });
	return measure("plain-resume", s.rows[1], assistantMessages(s.records));
}

async function steerSeed() {
	const prompts = [prompt("steer-T1", PRIME + callOnce("cache_probe")), prompt("steer-T2", LEVEL + callOnce("slow_probe"))];
	const steer = prompt("steer", "Also give the count for the letters in RADAR.");
	let steered = false;
	// As the bridge delivers a steer: push it while the tool call is pending, await the stdin ack, then release the result.
	const seen = await run("steer-seed", prompts, {}, { slow: async ({ send }) => {
		if (!steered) { steered = true; await send(steer, "next"); }
		return text("FIXED-SLOW-PROBE-RESULT");
	} });
	const s = seedTurns(seen.session, "steer-seed", prompts);
	const queued = s.records.findIndex((r) => r.attachment?.type === "queued_command" && JSON.stringify(r.attachment).includes(steer.marker));
	ctx.steer = { ...s, p: prompts, steer };
	return {
		session: seen.session,
		checks: [
			pre("cache_probe in turn 1, slow_probe in turn 2", seen.calls.join() === "cache_probe,slow_probe", { calls: seen.calls }),
			pre("steer recorded in turn 2 as a queued_command", queued > s.records.indexOf(s.prompts[1])),
			...streamChecks(seen, s.records, prompts),
		],
	};
}

async function steerRefusal() {
	const s = ctx.steer;
	const before = sha(s.session);
	let refusal = null;
	try {
		await run("steer-refusal", [prompt("steer-refusal", OK)], { resume: s.session, resumeSessionAt: s.ends[0].uuid, forkSession: true, resumeDropsTurn: s.prompts[1].uuid });
	} catch (error) {
		if (error instanceof Stop) throw error;
		refusal = String(error.message);
	}
	return {
		refusal,
		checks: [
			check("resume refused for the queued steer", /Resume rejected by --resume-drops-turn/.test(refusal) && /queued/.test(refusal)),
			check("no request sent", routeRequests("steer-refusal").length === 0),
			check("source file untouched", sha(s.session) === before),
		],
	};
}

async function abortMidText() {
	const s = ctx.steer;
	const p = prompt("T3", "Think briefly, then write a 400-word story about a lighthouse keeper. Do not call any tools.");
	const seen = await run("abort-mid-text", [p], { resume: s.session }, { onMessage: (m, seen, abort) => { if (seen.textChars >= 150) abort("mid-text"); } });
	const records = await readAfterAbort(s.session, p.marker);
	const at = promptIndex(records, p.marker);
	const after = records.slice(at + 1);
	const recordedChars = assistantMessages(after).flatMap((m) => m.content).filter((b) => b.type === "text").reduce((n, b) => n + b.text.length, 0);
	ctx.abortText = { p, prompt: records[at], records };
	const m = measure("abort-mid-text", s.rows[1], assistantMessages(records.slice(0, at)));
	const h = hiddenChecks(records, p.marker, seen);
	return {
		measured: m.measured,
		hidden: h.hidden,
		checks: [
			pre("aborted mid-text", seen.abort?.why === "mid-text" && !seen.results.length),
			...m.checks,
			check("prompt uuid adopted", records[at].uuid === p.uuid),
			check("CC recorded more text than streamed", recordedChars > seen.textChars, { recorded: recordedChars, streamed: seen.textChars }),
			check("interrupt marker recorded", interrupted(after)),
			...h.checks,
		],
	};
}

async function forkAfterAbortText() {
	const s = ctx.steer;
	const a = ctx.abortText;
	const p = prompt("P4", "Think it through first: what is 17 * 23 + 4? Then call slow_probe exactly once. After the tool result, reply in one line.");
	const f = await fork("fork-after-abort-text", {
		source: s.session, records: a.records, cut: s.ends[1].uuid, dropsTurn: a.prompt.uuid, ancestor: s.rows[1], p,
		absent: [a.p.marker, INTERRUPTED],
		hooks: { slow: ({ park, abort }) => { const pending = park(); queueMicrotask(() => abort("mid-tool")); return pending; } },
	});
	ctx.f1 = { session: f.session, p, closedAt: f.seen.abort?.at };
	return { session: f.session, measured: f.measured, checks: [pre("aborted with slow_probe pending", f.seen.abort?.why === "mid-tool"), ...f.checks] };
}

async function forkAfterAbortTool() {
	const s = ctx.steer;
	const f1 = ctx.f1;
	const atFork = readSession(f1.session).records;
	const abortRecords = (records) => ({ rejectedToolResult: JSON.stringify(records).includes(REJECTED), interruptMarker: interrupted(records) });
	const p = prompt("P5", "Think it through first: what is 2^10 - 1? Then call big_probe exactly once. After the tool result, reply in one line with the answer and the number of lines the tool reported.");
	const forkStartedMsAfterClose = Date.now() - f1.closedAt;
	const f = await fork("fork-after-abort-tool", {
		source: f1.session, records: atFork, cut: s.ends[1].uuid, dropsTurn: atFork[promptIndex(atFork, f1.p.marker)].uuid, ancestor: s.rows[1], p,
		absent: [f1.p.marker, REJECTED, INTERRUPTED],
	});
	const f1After = await readAfterAbort(f1.session, f1.p.marker);
	ctx.f2 = seedTurns(f.session, "fork-after-abort-tool", [p]);
	const saved = savedPaths(ctx.f2.records);
	const after = abortRecords(f1After);
	return {
		session: f.session, measured: f.measured, forkStartedMsAfterClose, abortRecordsAtFork: abortRecords(atFork), abortRecordsAfter: after,
		checks: [
			pre("big_probe called", f.seen.calls.includes("big_probe")),
			...f.checks,
			check("the aborted fork holds CC's rejected tool result and interrupt marker", after.rejectedToolResult && after.interruptMarker),
			check("CC saved the big result under this session's tool-results/", saved.length > 0 && saved.every((path) => path.startsWith(join(projectDir, f.session, "tool-results")) && existsSync(path)), { saved }),
		],
	};
}

async function forkAfterBigResult() {
	const f2 = ctx.f2;
	const f = await fork("fork-after-big-result", { source: f2.session, records: f2.records, cut: f2.ends[0].uuid, ancestor: f2.rows[0], p: prompt("P6", OK) });
	const paths = savedPaths(mainRequests("fork-after-big-result")[0].body.messages);
	return {
		session: f.session, measured: f.measured,
		checks: [...f.checks, check("request points at the source session's saved result, which exists", paths.length > 0 && paths.every((path) => path.includes(`/${f2.session}/tool-results/`) && existsSync(path)), { paths })],
	};
}

async function forkTwoTurnsBack() {
	const s = ctx.steer;
	const f = await fork("fork-two-turns-back", { source: s.session, records: ctx.abortText.records, cut: s.ends[0].uuid, ancestor: s.rows[0], p: prompt("P7", OK), absent: [s.p[1].marker, s.steer.marker, ctx.abortText.p.marker] });
	return { session: f.session, measured: f.measured, checks: f.checks };
}

async function forkAtAbortedPrompt() {
	const s = ctx.steer;
	const a = ctx.abortText;
	const f = await fork("fork-at-aborted-prompt", { source: s.session, records: a.records, cut: a.prompt.uuid, ancestor: s.rows[1], p: prompt("P8", `Never mind the story. ${OK}`), absent: [INTERRUPTED], present: [a.p.marker] });
	return { session: f.session, measured: f.measured, checks: f.checks };
}

async function abortAtFirstDelta() {
	const p = prompt("P9", "What is 19 * 21? Reply in one line.");
	// CC holds reply text by now, but emits an assistant message (with its uuid) only once a
	// content block ends. `status: requesting` comes too early: CC sends it on entering its
	// query loop, before the API request is made.
	const seen = await run("abort-at-first-delta", [p], {}, { onMessage: (m, seen, abort) => { if (m.type === "stream_event" && m.event.delta?.type === "text_delta") abort("first-text-delta"); } });
	const records = await readAfterAbort(seen.session, p.marker);
	const h = hiddenChecks(records, p.marker, seen);
	return {
		session: seen.session,
		hidden: h.hidden,
		checks: [
			pre("aborted at the first text delta, before any assistant message", seen.abort?.why === "first-text-delta" && seen.abort.assistantsBefore === 0, { streamEventsBefore: seen.abort?.streamEventsBefore }),
			...h.checks,
			check("interrupt marker recorded", interrupted(records)),
		],
	};
}

// Run order matters where a case changes a session a later case reads: plain-resume
// appends to store-seed, abort-mid-text to steer-seed (after steer-refusal).
const CASES = {
	"store-seed": { run: storeSeed },
	"store-mirror": { needs: ["store-seed"], run: storeMirror },
	"fork-truncate": { needs: ["store-seed"], run: forkTruncate },
	"store-resume": { needs: ["store-seed"], run: () => storeResume("store-resume", false) },
	"store-resume-cut": { needs: ["store-seed"], run: () => storeResume("store-resume-cut", true) },
	"plain-resume": { needs: ["store-seed"], run: plainResume },
	"steer-seed": { run: steerSeed },
	"steer-refusal": { needs: ["steer-seed"], run: steerRefusal },
	"abort-mid-text": { needs: ["steer-seed"], run: abortMidText },
	"fork-after-abort-text": { needs: ["abort-mid-text"], run: forkAfterAbortText },
	"fork-after-abort-tool": { needs: ["fork-after-abort-text"], run: forkAfterAbortTool },
	"fork-after-big-result": { needs: ["fork-after-abort-tool"], run: forkAfterBigResult },
	"fork-two-turns-back": { needs: ["abort-mid-text"], run: forkTwoTurnsBack },
	"fork-at-aborted-prompt": { needs: ["abort-mid-text"], run: forkAtAbortedPrompt },
	"abort-at-first-delta": { run: abortAtFirstDelta },
};

function selectedCases() {
	const requested = flag("cases")?.split(",") ?? Object.keys(CASES);
	for (const name of requested) if (!CASES[name]) throw new Error(`unknown case ${name}; have ${Object.keys(CASES).join(", ")}`);
	const selected = new Set();
	const add = (name) => { selected.add(name); for (const need of CASES[name].needs ?? []) add(need); };
	requested.forEach(add);
	return Object.keys(CASES).filter((name) => selected.has(name));
}

function summary(name, result) {
	const m = result.measured;
	const line = `${name.padEnd(24)} ${result.status.toUpperCase()}${m ? `  #${m.request} read ${m.cacheRead}, ancestor #${m.ancestor} cached ${m.ancestorCached}; thinking ${m.thinkingSent} sent, ${m.thinkingDropped} dropped` : ""}`;
	const failed = (result.checks ?? []).filter((c) => !c.ok).map((c) => `\n    ${c.precondition ? "not set up" : "failed"}: ${c.name}${c.details ? ` ${JSON.stringify(c.details)}` : ""}`);
	return line + failed.join("") + (result.error ? `\n    ${result.error.split("\n")[0]}` : "");
}

async function main() {
	const names = selectedCases();
	const proxy = await startProxy();
	proxyUrl = proxy.url;
	try {
		for (const name of names) {
			const blocked = (CASES[name].needs ?? []).find((need) => report.cases[need].status !== "pass" && report.cases[need].status !== "fail");
			let result;
			if (blocked) result = { status: "skipped", error: `${blocked} was ${report.cases[blocked].status}` };
			else {
				try {
					result = await CASES[name].run();
					result.status = result.checks.some((c) => c.precondition && !c.ok) ? "not exercised" : result.checks.every((c) => c.ok) ? "pass" : "fail";
				} catch (error) {
					if (error instanceof Stop) throw error;
					result = { status: "error", error: String(error?.stack ?? error) };
				}
			}
			report.cases[name] = { status: result.status, requests: requestList(name), ...result };
			console.log(summary(name, result));
			writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
		}
	} catch (error) {
		if (!(error instanceof Stop)) throw error;
		report.stopped = error.message;
		console.log(`STOPPED: ${error.message}`);
	} finally {
		await proxy.stop();
		if (existsSync(join(captureDir, "index.jsonl"))) {
			const requests = loadCapture(captureDir).requests.filter(isMessages);
			report.requestsSent = requests.length;
			report.thinkingDropsAnywhere = requests.filter((r) => (r.inputTransformations ?? []).some((t) => t.type === "thinking_dropped")).map((r) => r.n);
		}
		if (existsSync(projectDir)) {
			cpSync(projectDir, join(OUT, "cc-sessions"), { recursive: true });
			const ids = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
			for (const id of ids) await deleteSession(id, { dir: cwd });
			report.deletedSessions = ids;
			report.leftInProjectDir = readdirSync(projectDir);
			if (!report.leftInProjectDir.length) rmdirSync(projectDir);
		}
		writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
		console.log(`\nClaude Code ${report.claudeCode}, SDK ${report.sdk}, ${MODEL} at ${EFFORT}; ${report.requestsSent ?? 0} Messages requests`);
		console.log(`report: ${join(OUT, "report.json")}`);
	}
}

await main();
