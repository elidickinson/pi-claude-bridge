#!/usr/bin/env node
// Measure isolated reconstruction differences against a warm, native CC session.
// Each case resumes the same probe-created session from an immutable JSONL snapshot:
// unchanged REUSE control, restore, one JSONL mutation, then the same continuation.
// Never point this at a production session; mutations are applied only under /tmp.
//
//   node diag/probe-cache-mutations.mjs [--model claude-haiku-5-5] [--out DIR]
//       [--cases NAME,NAME] [--order control-first|changed-first]
//
// --cases runs a subset (each probe run warms its own fresh seed, so running one
// case per invocation keeps one case's cache writes out of another's); --order
// runs the changed arm first, to check a result does not depend on which arm
// wrote the cache entry the other read.
//
// Live cases (see MUTATION_NAMES): drop CC context attachments together, the
// total_tokens reminders alone, and each other attachment type alone; change
// tool_result.content string/array shape, strip tool_result text's trailing "\n",
// reorder tool_result keys; turn single-text-block user content into a string;
// edit one attachment value in place (no record dropped for CC to re-add); and
// resume the same records under a new session id (changes only metadata).
// A case with no matching records is reported as not applicable and costs no
// request. CC runs with the bridge provider path's settings, effort and thinking
// display (src/index.ts); pi's appended system prompt and streaming-input prompt
// are not reproduced. Raw request pairs are sensitive.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { deleteSession, openSession } from "cc-session-io";
import { assessMutationAttribution, compareCacheUsage } from "./lib/cache-effect.mjs";
import { compareRequestBodies } from "./lib/request-diff.mjs";
import { MUTATION_NAMES, mutateSessionJsonl } from "./lib/session-mutations.mjs";
import { FIRST_PARTY_ENV } from "./lib/first-party.mjs";
import { configChanges } from "./lib/trace-analysis.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_META = JSON.parse(readFileSync(join(REPO, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};
const MODEL = flag("model", "claude-haiku-5-5");
const EFFORT = "medium";
// The bridge provider path's CC options (src/index.ts): CC_CHILD_ENV, settings, extraArgs.
const CC_SETTINGS = {
	autoMemoryEnabled: false,
	claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"],
	includeGitInstructions: false,
};
const EXTRA_ARGS = { "strict-mcp-config": null, "thinking-display": "summarized" };
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "cache-mutations-"));
const CASES = flag("cases")?.split(",") ?? MUTATION_NAMES;
for (const name of CASES) if (!MUTATION_NAMES.includes(name)) throw new Error(`unknown case ${name}; have ${MUTATION_NAMES.join(", ")}`);
const ORDER = flag("order", "control-first");
if (!["control-first", "changed-first"].includes(ORDER)) throw new Error(`--order must be control-first or changed-first`);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR;

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

function toolServer(calls) {
	const server = new McpServer({ name: "custom-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
	const tools = [{ name: "cache_probe", description: "Returns a fixed cache probe marker.", inputSchema: { type: "object", properties: {} } }];
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push({ name: request.params.name, arguments: request.params.arguments });
		return { content: [{ type: "text", text: "FIXED-CACHE-PROBE-RESULT" }] };
	});
	return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server } };
}

const textOf = (message) => typeof message.content === "string" ? message.content
	: (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
const requestHas = (request, marker) => (request.body.messages ?? []).some((message) => textOf(message).includes(marker));

/** Main-loop /v1/messages requests of any status, in send order. */
function requestRows(captureDir) {
	const rows = readFileSync(join(captureDir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return rows.filter((row) => /^\/v1\/messages(\?|$)/.test(row.path ?? "") && (row.tools ?? 0) > 0).sort((a, b) => a.n - b.n).map((row) => ({
		...row,
		body: JSON.parse(readFileSync(join(captureDir, `req-${String(row.n).padStart(4, "0")}.json`), "utf8")),
	}));
}

/** The first request after #afterN carrying `marker` is the arm's measurement: a later
 *  one (retry or tool loop) can read cache its predecessor wrote. All are reported. */
function armRequest(captureDir, afterN, marker) {
	const requests = requestRows(captureDir).filter((request) => request.n > afterN && requestHas(request, marker));
	const markerRequests = requests.map(({ n, status, terminal, retryCount }) => ({ n, status, terminal, retryCount }));
	if (!requests.length) throw new Error(`no captured request after #${afterN} carried ${marker}; see ${captureDir}`);
	if (requests[0].status !== 200 || !requests[0].usage) {
		throw new Error(`first request carrying ${marker} was not a measured 200: ${JSON.stringify(markerRequests)}; see ${captureDir}`);
	}
	return { request: requests[0], markerRequests };
}

function maxRequestNumber(captureDir) {
	const index = join(captureDir, "index.jsonl");
	if (!existsSync(index)) return 0;
	const lines = readFileSync(index, "utf8").split("\n").filter(Boolean);
	return lines.length ? Math.max(...lines.map((line) => JSON.parse(line).n)) : 0;
}

async function runTurn({ cwd, proxyUrl, prompt, resume, onSessionId }) {
	const calls = [];
	const q = query({
		prompt,
		options: {
			cwd,
			model: MODEL,
			tools: [],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			effort: EFFORT,
			settings: CC_SETTINGS,
			settingSources: ["user", "project"],
			maxTurns: 2,
			env: {
				...process.env,
				...FIRST_PARTY_ENV,
				ANTHROPIC_BASE_URL: proxyUrl,
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1",
			},
			extraArgs: EXTRA_ARGS,
			systemPrompt: { type: "preset", preset: "claude_code" },
			mcpServers: toolServer(calls),
			...(resume ? { resume } : {}),
		},
	});
	let sessionId = null;
	let ccVersion = null;
	let error = null;
	for await (const message of q) {
		if (message.type === "system" && message.subtype === "init") {
			ccVersion = message.claude_code_version;
			if (message.session_id) { sessionId = message.session_id; onSessionId?.(sessionId); }
		}
		if (message.type === "result") {
			sessionId = message.session_id;
			onSessionId?.(sessionId);
			if (message.is_error) error = message.result ?? "Claude Code reported an error";
		}
	}
	if (!sessionId) throw new Error(`query produced no session id${error ? `: ${error}` : ""}`);
	if (error) throw new Error(`Claude Code query failed: ${error}`);
	return { sessionId, ccVersion, calls };
}

function cacheControls(body) {
	const found = [];
	const visit = (value, path = "$") => {
		if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			if (key === "cache_control") found.push({ path, ...item });
			else visit(item, `${path}.${key}`);
		}
	};
	visit(body);
	return found;
}

function toolResultShapes(body) {
	return (body.messages ?? []).flatMap((message, messageIndex) => (Array.isArray(message.content) ? message.content : [])
		.filter((block) => block.type === "tool_result")
		.map((block, blockIndex) => ({
			message: messageIndex,
			block: blockIndex,
			content: typeof block.content === "string" ? "string" : Array.isArray(block.content) ? "array" : typeof block.content,
			keys: Object.keys(block),
		})));
}

function observedTargetWireDifference(name, controlBody, changedBody, diffs) {
	const control = toolResultShapes(controlBody);
	const changed = toolResultShapes(changedBody);
	if (name === "tool-result-content-shape") return JSON.stringify(control.map((item) => item.content)) !== JSON.stringify(changed.map((item) => item.content));
	if (name === "tool-result-key-order") return JSON.stringify(control.map((item) => item.keys)) !== JSON.stringify(changed.map((item) => item.keys));
	return diffs.length > 0;
}

function historyComplete(comparison, expectedBody, actualBody) {
	const missing = comparison.normalized.aligned.some((diff) => diff.kind === "missing-element" && diff.label?.startsWith("messages["));
	const messageMatches = comparison.normalized.alignments.filter((match) => /^messages\[\d+\]$/.test(match.path));
	const rolesMatch = messageMatches.every((match) => {
		const beforeIndex = Number(match.path.match(/\[(\d+)\]/)[1]);
		const afterIndex = Number(match.afterPath.match(/\[(\d+)\]/)[1]);
		return expectedBody.messages[beforeIndex]?.role === actualBody.messages[afterIndex]?.role;
	});
	return !missing && rolesMatch && messageMatches.length === expectedBody.messages.length;
}

function systemDiffs(comparison) {
	return comparison.normalized.aligned.filter((diff) => diff.path?.startsWith("system[") || diff.afterPath?.startsWith("system["));
}

function usageAgainst(expectedRequest, request) {
	const expected = expectedRequest.usage ? expectedRequest.usage.cacheRead + expectedRequest.usage.cacheWrite : null;
	return {
		cacheRead: request.usage?.cacheRead ?? null,
		cacheWrite: request.usage?.cacheWrite ?? null,
		expected,
		shortfall: expected !== null && request.usage ? expected - request.usage.cacheRead : null,
	};
}

async function main() {
	mkdirSync(OUT, { recursive: true });
	const cwd = join(OUT, `probe-cwd-${process.pid}-${Date.now()}`);
	const captureDir = join(OUT, "capture");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(captureDir, { recursive: true });
	const port = await freePort();
	const proxyLog = openSync(join(OUT, "proxy.log"), "w");
	const proxy = spawn(process.execPath, [join(REPO, "diag/capture-proxy.mjs"), "--port", String(port), "--out", captureDir], {
		stdio: ["ignore", "ignore", proxyLog],
	});
	let sessionId = null;
	let sessionPath = null;
	const extraSessions = [];
	let actualCcVersions = new Set();
	try {
		await waitForPort(port);
		const proxyUrl = `http://127.0.0.1:${port}`;
		const seedMarker = `[CACHE-SEED-${process.pid}-${Date.now()}]`;
		const seedCallsStart = maxRequestNumber(captureDir);
		const seed = await runTurn({
			cwd, proxyUrl,
			prompt: `${seedMarker} Call cache_probe exactly once, then reply with exactly: seeded.`,
			onSessionId: (id) => { sessionId = id; },
		});
		sessionId = seed.sessionId;
		actualCcVersions.add(seed.ccVersion);
		if (seed.calls.length !== 1) throw new Error(`seed called cache_probe ${seed.calls.length} times, not once`);
		const seedRequests = requestRows(captureDir).filter((request) => request.n > seedCallsStart && request.status === 200 && requestHas(request, seedMarker));
		if (!seedRequests.length) throw new Error(`seed prompt did not reach capture; see ${captureDir}`);
		const cachedRequest = seedRequests.at(-1);
		const seedPrefixObservations = seedRequests.map((request) => ({
			request: request.n,
			cacheRead: request.usage?.cacheRead ?? null,
			cacheWrite: request.usage?.cacheWrite ?? null,
			cachedPrefixTokens: request.usage ? request.usage.cacheRead + request.usage.cacheWrite : null,
		}));
		const session = openSession({ sessionId, projectPath: cwd, claudeDir: CLAUDE_DIR });
		sessionPath = session.jsonlPath;
		const baselineJsonl = readFileSync(sessionPath, "utf8");
		writeFileSync(join(OUT, "native-session-baseline.jsonl"), baselineJsonl);
		const changes = CASES.map((name) => mutateSessionJsonl(baselineJsonl, name));
		const results = [];
		for (const mutation of changes) {
			if (!mutation.changed) {
				results.push({ name: mutation.name, status: "not applicable", reason: "no matching records in native probe session", mutation: mutation.details });
				console.log(`${mutation.name}: not applicable (${JSON.stringify(mutation.details)})`);
				continue;
			}

			try {
			const continuationMarker = `[CACHE-CONTINUATION-${mutation.name}-${process.pid}-${Date.now()}]`;
			const continuation = `${continuationMarker} Resume this history and reply with exactly: continued.`;
			// A rotated session is written beside the original and resumed by its own id.
			const changedSessionId = mutation.sessionId ?? sessionId;
			const changedPath = mutation.sessionId ? join(dirname(sessionPath), `${mutation.sessionId}.jsonl`) : sessionPath;
			if (mutation.sessionId) extraSessions.push(mutation.sessionId);
			const runArm = async (arm, jsonl, path, id) => {
				writeFileSync(sessionPath, baselineJsonl);
				writeFileSync(path, jsonl);
				const start = maxRequestNumber(captureDir);
				const turn = await runTurn({ cwd, proxyUrl, prompt: continuation, resume: id });
				actualCcVersions.add(turn.ccVersion);
				if (turn.sessionId !== id) throw new Error(`${mutation.name}: ${arm} arm resumed ${turn.sessionId}, expected ${id}`);
				return { turn, ...armRequest(captureDir, start, continuationMarker) };
			};
			const arms = {};
			for (const arm of ORDER === "control-first" ? ["control", "changed"] : ["changed", "control"]) {
				arms[arm] = arm === "control" ? await runArm(arm, baselineJsonl, sessionPath, sessionId) : await runArm(arm, mutation.jsonl, changedPath, changedSessionId);
			}
			const { turn: controlTurn, request: controlRequest, markerRequests: controlMarkerRequests } = arms.control;
			const { turn: changedTurn, request: changedRequest, markerRequests: changedMarkerRequests } = arms.changed;
			const controlUsage = usageAgainst(cachedRequest, controlRequest);
			const controlHistory = compareRequestBodies(cachedRequest.body, controlRequest.body, { prefixOnly: true });
			const changedHistory = compareRequestBodies(cachedRequest.body, changedRequest.body, { prefixOnly: true });
			const pair = compareRequestBodies(controlRequest.body, changedRequest.body, { prefixBody: cachedRequest.body });
			const prefixChanged = pair.normalized.aligned.length > 0;
			// The normalized view folds single-text-block message content into a string, hiding this target.
			const attributionView = mutation.name === "user-content-single-block-to-string" ? "raw" : "normalized";
			const attributionDiffs = pair[attributionView].aligned;
			const changedUsage = usageAgainst(cachedRequest, changedRequest);
			const controlHistoryComplete = historyComplete(controlHistory, cachedRequest.body, controlRequest.body)
				&& controlHistory.normalized.aligned.length === 0;
			const changedHistoryComplete = historyComplete(changedHistory, cachedRequest.body, changedRequest.body);
			const invariants = {
				configuredSystemPrompt: "claude_code preset (same option on every arm)",
				model: { control: controlRequest.body.model, changed: changedRequest.body.model, same: controlRequest.body.model === changedRequest.body.model },
				modelSame: controlRequest.body.model === changedRequest.body.model,
				toolsSame: JSON.stringify(controlRequest.body.tools) === JSON.stringify(changedRequest.body.tools),
				thinking: { control: controlRequest.body.thinking ?? null, changed: changedRequest.body.thinking ?? null },
				thinkingSame: JSON.stringify(controlRequest.body.thinking ?? null) === JSON.stringify(changedRequest.body.thinking ?? null),
				normalizedSystemSame: !systemDiffs(pair).length && !systemDiffs(controlHistory).length && !systemDiffs(changedHistory).length,
				resumeSessionSame: controlTurn.sessionId === sessionId && changedTurn.sessionId === changedSessionId,
				controlHistoryComplete,
				changedHistoryComplete,
				// Rotation's target is metadata (it carries the session id); anything else confounds.
				configChanges: configChanges(controlRequest.body, changedRequest.body).filter((c) => !(mutation.sessionId && c.key === "metadata")),
				headerChanges: ["auth", "betas"].filter((key) => controlRequest[key] !== changedRequest[key])
					.map((key) => ({ key, before: controlRequest[key] ?? null, after: changedRequest[key] ?? null })),
			};
			const targetObserved = mutation.sessionId
				? JSON.stringify(controlRequest.body.metadata) !== JSON.stringify(changedRequest.body.metadata)
				: observedTargetWireDifference(mutation.name, controlRequest.body, changedRequest.body, attributionDiffs);
			const attribution = assessMutationAttribution(mutation.name, attributionDiffs, invariants, { targetObserved });
			const requestDifference = attribution.targetObserved;
			const validityIssues = attribution.status === "confounded" ? attribution.reasons : [];
			const result = {
				name: mutation.name,
				continuationMarker,
				order: ORDER,
				status: "measured",
				mutation: { changed: mutation.changed, ...mutation.details },
				control: { n: controlRequest.n, at: controlRequest.at, ...controlUsage, markerRequests: controlMarkerRequests, cacheControls: cacheControls(controlRequest.body) },
				changed: { n: changedRequest.n, at: changedRequest.at, ...changedUsage, markerRequests: changedMarkerRequests, cacheControls: cacheControls(changedRequest.body) },
				requestDifference: {
					observed: requestDifference,
					attributionView,
					anyRawPrefixChange: pair.raw.aligned.length > 0,
					anyNormalizedPrefixChange: prefixChanged,
					raw: pair.raw,
					normalized: pair.normalized,
					controlToolResults: toolResultShapes(controlRequest.body),
					changedToolResults: toolResultShapes(changedRequest.body),
				},
				invariants,
				attribution,
				cacheEffect: compareCacheUsage(controlUsage, changedUsage, requestDifference, { validityIssues }),
				seedPrefixReadbackMatches: changedUsage.cacheRead === null ? []
					: seedPrefixObservations.filter((observation) => observation.cachedPrefixTokens === changedUsage.cacheRead),
				requestPairFile: `request-pairs/${mutation.name}.json`,
			};
			const pairDir = join(OUT, "request-pairs");
			mkdirSync(pairDir, { recursive: true });
			writeFileSync(join(pairDir, `${mutation.name}.json`), JSON.stringify({
				cached: cachedRequest,
				control: controlRequest,
				changed: changedRequest,
				comparisonControlToChanged: pair,
				comparisonCachedToControl: compareRequestBodies(cachedRequest.body, controlRequest.body, { prefixOnly: true }),
				comparisonCachedToChanged: compareRequestBodies(cachedRequest.body, changedRequest.body, { prefixOnly: true }),
			}, null, 1));
			results.push(result);
			console.log(`${mutation.name}: ${attribution.status}; control read ${controlUsage.cacheRead}/${controlUsage.expected}, changed read ${changedUsage.cacheRead}/${changedUsage.expected}; ` +
				`${result.cacheEffect.status} (capped read loss ${result.cacheEffect.readLoss}, raw difference ${result.cacheEffect.rawReadDifference}, write increase ${result.cacheEffect.writeIncrease})`);
			for (const [arm, requests] of [["control", controlMarkerRequests], ["changed", changedMarkerRequests]]) {
				if (requests.length > 1) console.log(`  WARNING ${arm} arm sent ${requests.length} requests carrying its marker; measured #${requests[0].n}: ${JSON.stringify(requests)}`);
			}
			for (const diff of attributionDiffs) console.log(`  ${diff.kind}${diff.path ? ` ${diff.path}${diff.afterPath && diff.afterPath !== diff.path ? ` -> ${diff.afterPath}` : ""}` : diff.afterPath ? ` ${diff.afterPath}` : ""}`);
			} catch (error) {
				// One failed case does not cost the rest of a paid run -- but a rate limit
				// stops it: further requests would only be refused too.
				if (/429|rate.?limit|session limit|quota/i.test(String(error?.message))) throw error;
				results.push({ name: mutation.name, status: "error", error: String(error?.message ?? error) });
				console.log(`${mutation.name}: ERROR ${error?.message ?? error}`);
			}
		}

		const report = {
			model: MODEL,
			thinking: `effort ${EFFORT}, thinking-display summarized (bridge provider path)`,
			versions: { sdk: SDK_META.version, bundledClaudeCode: SDK_META.claudeCodeVersion, observedClaudeCode: [...actualCcVersions] },
			session: { sessionId, cwd, jsonlPath: sessionPath, immutableSnapshot: "native-session-baseline.jsonl" },
			seed: {
				request: cachedRequest.n,
				usage: cachedRequest.usage,
				observedCachedPrefixTokenCounts: seedPrefixObservations,
				model: cachedRequest.body.model,
				tools: (cachedRequest.body.tools ?? []).map((tool) => tool.name),
				thinking: cachedRequest.body.thinking ?? null,
				cacheControls: cacheControls(cachedRequest.body),
				attachmentTypes: session.attachments.map((record) => record.attachment.type),
				toolResults: toolResultShapes(cachedRequest.body),
			},
			effectiveOptions: {
				cwd, model: MODEL, tools: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
				effort: EFFORT, settings: CC_SETTINGS, extraArgs: EXTRA_ARGS, maxTurns: 2, settingSources: ["user", "project"],
				systemPrompt: { type: "preset", preset: "claude_code" }, mcpServers: ["custom-tools"], persistSession: true,
			},
			order: ORDER,
			mutationCount: results.filter((result) => result.status === "measured").length,
			results,
			captureDir,
		};
		writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
		console.log(`\nmodel ${MODEL}; SDK ${SDK_META.version}; observed CC ${[...actualCcVersions].join(", ") || "unknown"}; output ${OUT}`);
		console.log(`report: ${join(OUT, "report.json")}`);
		if (!results.some((result) => result.status === "measured")) throw new Error("no mutation target was present in the native probe session");
	} finally {
		proxy.kill();
		closeSync(proxyLog);
		if (sessionId) deleteSession(sessionId, cwd, CLAUDE_DIR);
		for (const id of extraSessions) deleteSession(id, cwd, CLAUDE_DIR);
	}
}

await main();
