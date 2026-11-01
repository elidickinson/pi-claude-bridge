#!/usr/bin/env node
// Test the candidate rebuild writer (diag/lib/session-writer.mjs) against Claude
// Code's own session, before any bridge change.
//
//   node --import tsx diag/probe-writer.mjs [--out DIR]
//
// 1. Real pi + the bridge (raw trace, capture proxy, thinking-binding beta) run
//    three short tool-using turns with small reasoning questions on Haiku 5.5 at
//    medium thinking, then stop. No rebuild.
// 2. From the trace: the live Claude Code session file, pi's last effective input
//    (plus the final reply, from pi's get_messages), the served tool map, tools and
//    system-prompt append of the last provider query.
// 3. Session files under new ids in the same project: CONTROL (native file as is),
//    WRITER (the writer's records), PREFIX (native records through turn two, then
//    the bridge's conversion of turn three), BRIDGE (what today's rebuild writes:
//    syncSharedSession on a missing mirror), WRITER-FIXED (the writer's records
//    with Claude Code's tool_result shape and tool_use inputs).
// 4. Each is resumed through the Agent SDK with the bridge provider path's options
//    (src/index.ts) and the same continuation prompt, in that order. If CONTROL
//    does not read back the whole cached prefix or reports a thinking drop, the
//    setup does not reproduce production: inconclusive, nothing more is sent.
// 5. Per arm: cache read against the live last request's cached prefix, the API's
//    thinking drops, and the request diff against CONTROL (raw and normalized).
//
// Writer passes: full read, no thinking drops, no normalized prefix difference
// from CONTROL. Paid: ~11 Haiku requests on the Claude subscription; stops at the
// first rate-limit or quota error. The probe's Claude Code project directory is
// deleted at the end; capture, trace, session copies and report stay under --out.
// Must run outside the sandbox.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getProjectDir, getSessionPath, normalizeProjectPath, parseJsonlFile } from "cc-session-io";
import { claudeCodeSettings } from "../src/config.js";
import { createToolServer } from "../src/mcp-server.js";
import { makePromptStream, userMessage } from "../src/prompt-stream.js";
import { MCP_SERVER_NAME } from "../src/skills.js";
import { nonSystemMessages } from "../src/transcript.js";
import { FIRST_PARTY_ENV } from "./lib/first-party.mjs";
import { compareRequestBodies } from "./lib/request-diff.mjs";
import { prefixRecords, priorMessages, rebuildRecords } from "./lib/session-writer.mjs";
import { configChanges, isMessages, loadCapture, loadTrace, traceRuns } from "./lib/trace-analysis.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "probe-writer-"));
if (existsSync(join(OUT, "cwd"))) throw new Error(`${OUT} was already used; the project path is the run's nonce`);
const MODEL = "claude-bridge/claude-haiku-5-5";
const THINKING = "medium";
// Sent by Claude Code itself on thinking requests once it treats the proxy as first-party.
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const EXTENSION = join(REPO, "diag/lib/lifecycle-extension.ts");
const TIMEOUT = 180_000;
const RATE_LIMIT = /\b429\b|rate.?limit|session limit|quota/i;
// Small reasoning questions make Haiku 5.5 think at medium effort; plain requests do not.
const PROMPTS = [
	"Look up the key alpha with lc_lookup. Then: a farmer has 17 sheep, all but 9 run away, and he buys twice as many as remain. How many does he have? Give the value and the number.",
	"Look up the key beta with lc_lookup. Then: what is 4837 * 29 - 1966? Give the value and the number.",
	"Look up the key gamma with lc_lookup. Then: a train leaves at 3:40 and the trip takes 2 hours 35 minutes. When does it arrive? Give the value and the time.",
];
const CONTINUATION = "Without using any tools, reply with exactly one word: continued.";
// As src/index.ts (CLAUDE_MD_EXCLUDES is module-private there).
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];
process.env.CLAUDE_BRIDGE_TEST_LOG_DIR ??= join(OUT, "logs");
// The parent-side bridge helpers use the same isolated state as the child.
process.env.PI_CODING_AGENT_DIR = join(OUT, "agent");
const { createRpcHarness } = await import("../tests/lib/rpc-harness.mjs");
const { __test: bridge } = await import("../src/index.js");

/** Ends the probe early with a reported reason (inconclusive setup, rate limit). */
class Stop extends Error {}

const cwd = join(OUT, "cwd");
const captureDir = join(OUT, "capture");
const traceDir = join(OUT, "trace");
const report = { model: MODEL, thinking: THINKING, out: OUT, continuation: CONTINUATION, stopped: null };
const textOf = (content) => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
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

/** Send a prompt and wait until pi will not continue on its own. */
async function prompt(h, message) {
	const settled = h.waitForEvent("agent_settled", TIMEOUT);
	await h.send({ type: "prompt", message }, TIMEOUT);
	await settled;
}

/** Orderly shutdown (stdin closed) so the trace writes its end record. */
async function shutdown(h) {
	const child = h.pi();
	if (child.exitCode === null) {
		child.stdin.end();
		const exited = once(child, "exit");
		const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
		await exited;
		clearTimeout(timer);
	}
	await h.stop();
}

/** Main-loop Messages requests in send order. */
function mainRequests() {
	return loadCapture(captureDir).requests.filter((r) => isMessages(r) && (r.tools ?? 0) > 0);
}

function stopOnRateLimit(where, rows) {
	const limited = rows.filter((r) => r.status === 429 || (r.status >= 400 && RATE_LIMIT.test(JSON.stringify(r.streamError ?? ""))));
	if (limited.length) throw new Stop(`rate limited during ${where}: requests ${limited.map((r) => `#${r.n} ${r.status}`).join(", ")}`);
}

// --- 1. Live turns ---

async function liveRun(proxyUrl) {
	const agentDir = join(OUT, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}");
	const h = createRpcHarness({
		name: "probe-writer",
		args: ["-e", EXTENSION, "--model", MODEL, "--thinking", THINKING, "--session-dir", join(OUT, "sessions")],
		cwd,
		persistSession: true,
		defaultTimeout: TIMEOUT,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			CLAUDE_BRIDGE_TRACE_DIR: traceDir,
			CLAUDE_BRIDGE_TRACE_RAW: "1",
			CLAUDE_BRIDGE_TRACE_PROXY: proxyUrl,
		},
	});
	await h.startAndWait();
	try {
		for (const p of PROMPTS) await prompt(h, p);
		const { messages } = await h.send({ type: "get_messages" }, TIMEOUT);
		return messages;
	} finally {
		await shutdown(h);
	}
}

// --- 2. What the trace recorded ---

const stable = (m) => JSON.stringify({ role: m.role, content: m.content, toolCallId: m.toolCallId });

function liveEvidence(sessionMessages) {
	const runs = traceRuns(traceDir);
	if (runs.length !== 1) throw new Error(`expected one traced pi run, found ${runs.length}`);
	const trace = loadTrace(runs[0]);
	const starts = trace.events.filter((e) => e.type === "query-start" && e.kind === "provider");
	const ccSessions = new Set(trace.events.filter((e) => e.type === "query-init").map((e) => e.ccSession));
	const decisions = trace.events.filter((e) => e.type === "decision").map((e) => `${e.path}/${e.reason}`);
	if (ccSessions.size !== 1) throw new Error(`live turns ran on ${ccSessions.size} Claude Code sessions, expected one`);
	if (decisions.some((d) => d.startsWith("rebuild"))) throw new Error(`live turns rebuilt: ${decisions.join(", ")}`);
	const appends = new Set(starts.map((s) => s.digests?.systemPromptAppend));
	if (appends.size !== 1) throw new Error(`the system-prompt append changed between live queries`);
	const last = starts.at(-1);
	const appendArtifact = last.artifacts?.systemPromptAppend?.artifact;
	if (last.digests.systemPromptAppend && !appendArtifact) throw new Error("the trace did not keep the system-prompt append (bridge without the recorder change?)");
	const input = trace.events.filter((e) => e.type === "input").at(-1);
	const effective = trace.artifact(input.effective === "source" ? input.source.artifact : input.effective.artifact);
	// The final reply is in no provider input; pi's own history has it. The input must be
	// its prefix (pi's history also holds transcript system messages; the bridge skips those).
	const inputHistory = nonSystemMessages(effective.messages);
	const piHistory = nonSystemMessages(sessionMessages);
	const diverges = inputHistory.findIndex((m, i) => stable(m) !== stable(piHistory[i] ?? {}));
	if (diverges !== -1) throw new Error(`pi's history differs from the last effective input at message ${diverges}`);
	const history = [...effective.messages, ...piHistory.slice(inputHistory.length)];
	const served = new Set(last.mcpTools);
	return {
		ccSession: [...ccSessions][0],
		decisions,
		model: last.model,
		effort: last.effort,
		servedToolNames: last.servedToolNames,
		tools: effective.tools.filter((t) => served.has(t.name)),
		append: appendArtifact ? trace.artifact(appendArtifact) : undefined,
		history,
		tail: piHistory.length - inputHistory.length,
	};
}

// --- 3. Session files ---

function writeSession(id, records) {
	const path = getSessionPath(id, normalizeProjectPath(cwd));
	writeFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	mkdirSync(join(OUT, "cc-sessions"), { recursive: true });
	copyFileSync(path, join(OUT, "cc-sessions", `${id}.jsonl`));
	return path;
}

function buildArms(live) {
	const nativePath = getSessionPath(live.ccSession, normalizeProjectPath(cwd));
	mkdirSync(join(OUT, "cc-sessions"), { recursive: true });
	copyFileSync(nativePath, join(OUT, "cc-sessions", `native-${live.ccSession}.jsonl`));
	const native = parseJsonlFile(nativePath);
	const priors = priorMessages(live.history);
	const common = { servedToolNames: live.servedToolNames, projectPath: cwd, model: live.model };
	const ids = { control: randomUUID(), writer: randomUUID(), prefix: randomUUID(), "writer-fixed": randomUUID() };

	writeSession(ids.control, native.map((r) => r.sessionId ? { ...r, sessionId: ids.control } : r));

	const written = rebuildRecords({ native, messages: priors, sessionId: ids.writer, ...common });
	writeSession(ids.writer, written.records);
	writeSession(ids["writer-fixed"], rebuildRecords({ native, messages: priors, sessionId: ids["writer-fixed"], nativeToolDetails: true, ...common }).records);

	// PREFIX: cut after the last chain record before turn three's prompt.
	const thirdPi = priors.reduce((found, m, i) => found.length < 3 && m.role === "user" ? [...found, i] : found, []).at(2);
	const thirdNative = native.findIndex((r) => r.type === "user" && textOf(r.message?.content) === textOf(priors[thirdPi].content));
	if (thirdPi === undefined || thirdNative === -1) throw new Error("turn three's prompt not found in both histories");
	const cut = native.slice(0, thirdNative).findLastIndex((r) => ["user", "assistant", "attachment"].includes(r.type));
	writeSession(ids.prefix, prefixRecords({ native, cut, messages: priors.slice(thirdPi), sessionId: ids.prefix, ...common }));

	// BRIDGE: today's rebuild, on the next provider call's messages with no mirror.
	bridge.resetSharedSession();
	const sync = bridge.syncSharedSession([...live.history, { role: "user", content: CONTINUATION, timestamp: Date.now() }],
		cwd, new Map(Object.entries(live.servedToolNames)), live.model, `probe-writer-${process.pid}`);
	if (!sync.sessionId) throw new Error(`syncSharedSession did not rebuild: ${JSON.stringify(sync)}`);
	ids.bridge = sync.sessionId;
	copyFileSync(getSessionPath(ids.bridge, normalizeProjectPath(cwd)), join(OUT, "cc-sessions", `${ids.bridge}.jsonl`));

	return {
		ids,
		cut: { nativeRecord: cut, piMessage: thirdPi, prompt: textOf(priors[thirdPi].content) },
		writer: { placed: written.placed.length, omitted: written.omitted, skippedTypes: written.skippedTypes, mappedMessages: written.mappedMessages },
		nativeRecords: native.length,
		priors: priors.length,
		thinking: {
			pi: priors.flatMap((m) => m.role === "assistant" ? m.content : []).filter((b) => b.type === "thinking" && b.thinkingSignature).length,
			native: native.flatMap((r) => r.type === "assistant" ? r.message.content : []).filter((b) => b.type === "thinking").length,
		},
	};
}

// --- 4. Resume one arm as the bridge's provider query would ---

async function resumeArm(name, sessionId, live, proxyUrl) {
	const promptStream = makePromptStream();
	void promptStream.push(userMessage([{ type: "text", text: CONTINUATION }])).catch(() => {});
	const tools = live.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async () => ({ content: [{ type: "text", text: "probe: tools are not served here" }], isError: true }),
	}));
	mkdirSync(join(OUT, "cc-debug"), { recursive: true });
	const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
	const sdkQuery = query({
		prompt: promptStream.stream,
		options: {
			cwd,
			env: { ...process.env, PATH: cleanPath, ...bridge.CC_CHILD_ENV, ...FIRST_PARTY_ENV, ANTHROPIC_BASE_URL: `${proxyUrl}/q/arm-${name}` },
			tools: [],
			permissionMode: "bypassPermissions",
			includePartialMessages: true,
			settings: { ...claudeCodeSettings({}), claudeMdExcludes: CLAUDE_MD_EXCLUDES, includeGitInstructions: false },
			systemPrompt: { type: "preset", preset: "claude_code", append: live.append ? live.append : undefined },
			extraArgs: { model: live.model, "strict-mcp-config": null, ...(live.effort ? { "thinking-display": "summarized" } : {}) },
			...(live.effort ? { effort: live.effort } : {}),
			mcpServers: { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools) },
			resume: sessionId,
			// The live queries ran with CLAUDE_BRIDGE_DEBUG=1 (rpc harness), which adds these.
			debug: true,
			debugFile: join(OUT, "cc-debug", `${name}.log`),
			stderr: (data) => appendFileSync(join(OUT, "cc-debug", `${name}-stderr.log`), data),
		},
	});
	let init = null;
	let result = null;
	try {
		for await (const message of sdkQuery) {
			if (message.type === "system" && message.subtype === "init") init = message;
			if (message.type === "result") { result = message; promptStream.end(); }
		}
	} catch (error) {
		if (RATE_LIMIT.test(String(error?.message))) throw new Stop(`rate limited in arm ${name}: ${error.message}`);
		throw error;
	}
	const resultText = result?.is_error ? String(result.result ?? result.errors ?? result.subtype) : null;
	if (resultText && RATE_LIMIT.test(resultText)) throw new Stop(`rate limited in arm ${name}: ${resultText}`);
	return { sessionId: init?.session_id ?? null, ccVersion: init?.claude_code_version ?? null, error: resultText };
}

// --- 5. Measurement ---

const thinkingCount = (body) => body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "thinking" || b?.type === "redacted_thinking").length;
const drops = (row) => (row.inputTransformations ?? []).filter((t) => t.type === "thinking_dropped")
	.map((t) => ({ ...t, message: Number(String(t.path).match(/^messages\.(\d+)/)?.[1]) }));
const brief = (d) => ({ kind: d.kind, label: d.label, path: d.path, afterPath: d.afterPath, before: d.before, after: d.after });

function measureArm(name, row, live, control, liveRows) {
	const cached = row.usage.cacheRead + row.usage.cacheWrite;
	const out = {
		n: row.n, status: row.status, betaSent: String(row.betas ?? "").includes(BINDING_BETA),
		cacheRead: row.usage.cacheRead, cacheWrite: row.usage.cacheWrite, cached,
		liveLastCached: live.cached, readMinusLiveLast: row.usage.cacheRead - live.cached,
		// Which earlier request's cached prefix the read equals, if any.
		readEquals: [...liveRows.map((r) => ({ who: `live #${r.n}`, cached: r.usage.cacheRead + r.usage.cacheWrite })),
			...(control && control.row !== row ? [{ who: `CONTROL #${control.row.n}`, cached: control.cached }] : [])]
			.filter((c) => c.cached === row.usage.cacheRead).map((c) => c.who),
		thinkingInRequest: thinkingCount(row.body),
		drops: drops(row),
		messages: row.body.messages.length,
	};
	if (!control || control.row === row) return out;
	const full = compareRequestBodies(control.row.body, row.body);
	const prefix = compareRequestBodies(control.row.body, row.body, { prefixBody: live.row.body });
	out.vsControl = {
		config: configChanges(control.row.body, row.body),
		headers: ["auth", "betas"].filter((k) => control.row[k] !== row[k]).map((k) => ({ key: k, control: control.row[k], arm: row[k] })),
		normalizedPrefix: prefix.normalized.aligned.map(brief),
		rawPrefix: prefix.raw.aligned.map(brief),
		normalizedFull: full.normalized.aligned.map(brief),
		rawFull: full.raw.aligned.map(brief),
	};
	return out;
}

async function main() {
	mkdirSync(OUT, { recursive: true });
	const proxy = await startProxy();
	let projectDir = null;
	try {
		const sessionMessages = await liveRun(proxy.url);
		projectDir = getProjectDir(realpathSync(cwd));
		const liveRows = mainRequests();
		stopOnRateLimit("the live turns", liveRows);
		const failed = sessionMessages.filter((m) => m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted"));
		if (failed.length) throw new Stop(`a live turn failed: ${failed.map((m) => m.errorMessage).join("; ")}`);
		const live = liveEvidence(sessionMessages);
		const lastRow = liveRows.at(-1);
		report.live = {
			ccSession: live.ccSession, decisions: live.decisions, model: live.model, effort: live.effort,
			requests: liveRows.map((r) => ({ n: r.n, messages: r.messages, cacheRead: r.usage?.cacheRead, cacheWrite: r.usage?.cacheWrite, drops: drops(r).length })),
			historyMessages: live.history.length, fromGetMessages: live.tail, appendChars: live.append?.length ?? 0,
		};
		const arms = buildArms(live);
		report.build = arms;
		console.log(`live: ${liveRows.length} requests, CC session ${live.ccSession}; thinking blocks pi ${arms.thinking.pi}, native ${arms.thinking.native}`);
		if (!arms.thinking.pi || !arms.thinking.native) throw new Stop("the live turns produced no thinking blocks; drops cannot be observed");

		const liveLast = { row: lastRow, cached: lastRow.usage.cacheRead + lastRow.usage.cacheWrite };
		const results = {};
		let control = null;
		for (const name of ["control", "writer", "prefix", "bridge", "writer-fixed"]) {
			const start = Math.max(0, ...loadCapture(captureDir).requests.map((r) => r.n));
			const run = await resumeArm(name, arms.ids[name], live, proxy.url);
			const rows = mainRequests().filter((r) => r.n > start && r.route === `arm-${name}`);
			stopOnRateLimit(`arm ${name}`, rows);
			if (run.error) throw new Stop(`arm ${name} failed: ${run.error}`);
			if (!rows[0] || rows[0].status !== 200 || !rows[0].usage) throw new Error(`arm ${name}: no measured 200 request; see ${captureDir}`);
			if (run.sessionId !== arms.ids[name]) throw new Error(`arm ${name} resumed ${run.sessionId}, expected ${arms.ids[name]}`);
			results[name] = { ...measureArm(name, rows[0], liveLast, control, liveRows), ccVersion: run.ccVersion, requests: rows.length };
			if (name === "control") {
				control = { row: rows[0], cached: results.control.cached };
				const c = results.control;
				const problems = [
					c.cacheRead < liveLast.cached && `read ${c.cacheRead} < live cached ${liveLast.cached}`,
					c.drops.length && `${c.drops.length} thinking drop(s)`,
					!c.thinkingInRequest && "no thinking blocks in the request",
					!c.betaSent && "binding beta not sent",
				].filter(Boolean);
				if (problems.length) {
					report.results = results;
					throw new Stop(`inconclusive: CONTROL does not reproduce production (${problems.join("; ")})`);
				}
			}
			console.log(`${name}: read ${results[name].cacheRead} (live last cached ${liveLast.cached}), write ${results[name].cacheWrite}, drops ${results[name].drops.length}/${results[name].thinkingInRequest}`);
		}
		const prefixRow = mainRequests().find((r) => r.n === results.prefix.n);
		const cutMessage = prefixRow.body.messages.findIndex((m) => textOf(m.content).includes(arms.cut.prompt));
		results.prefix.cut = {
			requestMessage: cutMessage,
			dropsBefore: results.prefix.drops.filter((d) => d.message < cutMessage).length,
			dropsAfter: results.prefix.drops.filter((d) => d.message >= cutMessage).length,
			thinkingBefore: prefixRow.body.messages.slice(0, cutMessage).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "thinking").length,
			thinkingAfter: prefixRow.body.messages.slice(cutMessage).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "thinking").length,
		};
		const bridgeFirst = results.bridge.vsControl.normalizedFull.find((d) => /^messages\[/.test(d.path ?? d.afterPath ?? ""));
		report.toolsSystemRead = { cacheRead: results.bridge.cacheRead, from: "BRIDGE arm", bridgeFirstNormalizedDifference: bridgeFirst?.label ?? null };
		report.writerPass = Object.fromEntries(["writer", "writer-fixed"].map((name) => [name, {
			fullRead: results[name].cacheRead >= liveLast.cached,
			noThinkingDrops: results[name].drops.length === 0,
			noNormalizedPrefixDifference: results[name].vsControl.normalizedPrefix.length === 0,
		}]));
		report.results = results;
	} catch (error) {
		if (!(error instanceof Stop)) throw error;
		report.stopped = error.message;
		console.log(`STOPPED: ${error.message}`);
	} finally {
		await proxy.stop();
		report.requestsSent = existsSync(join(captureDir, "index.jsonl")) ? loadCapture(captureDir).requests.filter(isMessages).length : 0;
		writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
		// Every session this probe created lives in its own project directory.
		if (projectDir) rmSync(projectDir, { recursive: true, force: true });
		else if (existsSync(cwd)) rmSync(getProjectDir(realpathSync(cwd)), { recursive: true, force: true });
		console.log(`report: ${join(OUT, "report.json")}; captures req-${pad(1)}.. in ${captureDir}`);
	}
}

await main();
