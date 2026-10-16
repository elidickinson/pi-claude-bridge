#!/usr/bin/env node
// Does a rebuilt Claude Code session read back the prompt cache the live one left?
//
// "Always rebuild" (eli/structural-ideas.md) would rewrite CC's session file from
// pi's history before every prompt. That is affordable only if the request CC
// sends after a rebuild matches, element for element, the prefix the previous
// request cached. This probe runs one pi session through the real bridge under
// diag/capture-proxy.mjs and forces the bridge's in-process REBUILD before chosen
// prompts. It forces it through the markRebuildHooks registry the session_compact
// handler uses, with pi's history unchanged, so the rebuild is the production
// "preserved" path (same session id, attachments carried).
//
//   node diag/probe-rebuild-fidelity.mjs [--model claude-bridge/claude-haiku-4-5]
//       [--thinking low|off] [--runs 1] [--out DIR]
//
// Each run is five prompts in one pi process:
//   P1  clean start
//   P2  reuse    control: a normal continuation, expected warm
//   P3  rebuild  first rebuild over CC-live records (P1-P2 turns)
//   P4  rebuild  steady state: P1-P2 were already rebuilt, only P3's turn was live
//   P5  reuse    control after rebuilds
//
// For each prompt's first request it reports the bridge's sync path, cacheRead
// against what the previous request left cached (cacheRead + cacheWrite, the
// corrected expectation in diag/AUDIT.md), and the first element of the previous
// request's prompt that the new request changed, down to the field. Three things
// are excluded from the comparison because they differ between requests without
// affecting the cache: system[0], CC's per-request billing header; cache_control,
// whose breakpoint moves to the newest message each request; and whether a
// message's content is a string or a single text block, since CC switches a
// message to the block form to hold that breakpoint.
//
// The run is rejected, rather than reported, if any prompt cannot be located in
// the capture or any sync path differs from the plan: a forced rebuild that
// silently reused would otherwise read as a perfectly faithful rebuild.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("model", "claude-bridge/claude-haiku-4-5");
const THINKING = flag("thinking", "low");
const RUNS = Number(flag("runs", 1));
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "rebuild-fidelity-"));

const BILLING_HEADER = "x-anthropic-billing-header";

// Each prompt opens with its tag, which is how its first request is found in the
// capture. Every prompt runs a tool so the history holds tool_use/tool_result
// pairs, and P1/P4 ask for parallel calls.
const PLAN = [
	{ tag: "[P1]", expect: "clean-start", text: "Use the read tool to read notes-a.txt and notes-b.txt. Issue both read calls in a single message, in parallel. Then reply with just the two codewords." },
	{ tag: "[P2]", expect: "reuse", text: "Use the bash tool to run: ls -1 | wc -l. Reply with just the number." },
	{ tag: "[P3]", expect: "rebuild preserved", force: true, text: "Use the write tool to write the two codewords to out.txt, one per line. Then use the read tool to read out.txt back. Reply with just: done." },
	{ tag: "[P4]", expect: "rebuild preserved", force: true, text: "Use the read tool to read notes-a.txt and out.txt, both calls in a single message, in parallel. Reply with just yes or no: do they share a codeword?" },
	{ tag: "[P5]", expect: "reuse", text: "Use the bash tool to run: cat notes-b.txt. Reply with just its contents." },
];

const FORCE_EXTENSION = `// Forces claude-bridge's in-process REBUILD before chosen prompts, through the
// registry its session_compact handler uses, leaving pi's history unchanged.
export default function (pi: any) {
	const at = new Set((process.env.PROBE_FORCE_REBUILD_AT ?? "").split(",").filter(Boolean).map(Number));
	let prompt = 0;
	pi.on("before_agent_start", (_event: unknown, ctx: any) => {
		prompt++;
		if (!at.has(prompt)) return;
		const hooks = (globalThis as any)[Symbol.for("claude-bridge:markRebuildHooks")];
		if (!hooks?.size) throw new Error("probe: claude-bridge markRebuildHooks registry not found");
		for (const hook of hooks) hook(ctx.sessionManager.getSessionId(), \`probe-force-rebuild:P\${prompt}\`);
	});
}
`;

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

/** Main-loop /v1/messages requests in send order. CC's toolless side requests
 *  (titles, summaries) share no prefix with the agent loop and are dropped. */
function loadRequests(captureDir) {
	const rows = readFileSync(join(captureDir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const failed = rows.filter((row) => row.path?.startsWith("/v1/messages") && row.status !== 200);
	const requests = rows
		.filter((row) => row.path?.startsWith("/v1/messages") && row.status === 200 && (row.tools ?? 0) > 0)
		.map((row) => ({ ...row, body: JSON.parse(readFileSync(join(captureDir, `req-${String(row.n).padStart(4, "0")}.json`), "utf8")) }));
	return { requests, failed: failed.length };
}

/** Anchored `syncResult:` lines from the bridge debug log, one per fresh query,
 *  as "<path>" or "<path> <kind>" (e.g. "rebuild preserved"). */
function syncPaths(debugLog) {
	const re = /^\[[^\]]+\] \[[^\]]+\] syncResult: path=(\S+)(.*)$/;
	return readFileSync(debugLog, "utf8").split("\n").map((line) => line.match(re)).filter(Boolean).map((m) => {
		const kind = m[2].match(/ (first|preserved|rotated-post-abort|preserve-shared)\b/);
		return kind ? `${m[1]} ${kind[1]}` : m[1];
	});
}

const userTexts = (message) => message.role !== "user" ? []
	: typeof message.content === "string" ? [message.content]
	: message.content.filter((block) => block.type === "text").map((block) => block.text);

const opensWith = (message, tag) => userTexts(message).some((text) => text.trimStart().startsWith(tag));

/** The plan prompt whose turn contains messages[index]. */
function turnOf(messages, index) {
	for (let i = index; i >= 0; i--) {
		const step = PLAN.find((p) => opensWith(messages[i], p.tag));
		if (step) return step.tag;
	}
	return "?";
}

function withoutCacheControl(value) {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, withoutCacheControl(v)]));
	}
	return value;
}

const kinds = (message) => typeof message.content === "string" ? "text" : message.content.map((b) => b.type).join("+");

/** A message whose content is one plain text block, with that content as a string.
 *  The API caches both forms alike: a reuse control read back in full after CC sent
 *  the same system message as a block, then as a string. Applied after
 *  withoutCacheControl, so a block holding the breakpoint counts as plain. */
function contentAsString(message) {
	const c = message.content;
	const plain = Array.isArray(c) && c.length === 1 && c[0].type === "text" && Object.keys(c[0]).length === 2;
	return plain ? { ...message, content: c[0].text } : message;
}

/** The prompt prefix in wire order (tools, system, messages), minus the billing header. */
function elements(body) {
	const system = Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [];
	return [
		{ label: "tools", value: withoutCacheControl(body.tools ?? []) },
		...system.flatMap((block, i) => String(block.text ?? "").startsWith(BILLING_HEADER) ? []
			: [{ label: `system[${i}]`, value: withoutCacheControl(block) }]),
		...body.messages.map((message, i) => {
			const value = contentAsString(withoutCacheControl(message));
			return { label: `messages[${i}] ${value.role}/${kinds(value)}`, index: i, value };
		}),
	];
}

/** First structural difference, key order included: it changes the serialized bytes. */
function firstDiff(a, b, path = "") {
	if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return { path, a, b };
	if (Array.isArray(a)) {
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			const d = firstDiff(a[i], b[i], `${path}[${i}]`);
			if (d) return d;
		}
		return a.length === b.length ? null : { path: `${path}.length`, a: a.length, b: b.length };
	}
	if (a && typeof a === "object") {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		for (const k of ka) if (!(k in b)) return { path: `${path}.${k}`, a: a[k], b: "<absent>" };
		for (const k of kb) if (!(k in a)) return { path: `${path}.${k}`, a: "<absent>", b: b[k] };
		for (const k of ka) {
			const d = firstDiff(a[k], b[k], `${path}.${k}`);
			if (d) return d;
		}
		return ka.join() === kb.join() ? null : { path, keyOrder: true, a: ka, b: kb };
	}
	return a === b ? null : { path, a, b };
}

function describeDiff(d) {
	if (d.keyOrder) return `${d.path} key order only: [${d.a}] -> [${d.b}]`;
	if (typeof d.a === "string" && typeof d.b === "string") {
		let i = 0;
		while (i < d.a.length && i < d.b.length && d.a[i] === d.b[i]) i++;
		const around = (s) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
		return `${d.path} differs at char ${i} (length ${d.a.length} -> ${d.b.length})\n            before: ${around(d.a)}\n            after:  ${around(d.b)}`;
	}
	const show = (v) => {
		const s = JSON.stringify(v);
		return s.length > 240 ? `${s.slice(0, 240)}...(${s.length}b)` : s;
	};
	return `${d.path}\n            before: ${show(d.a)}\n            after:  ${show(d.b)}`;
}

/** How the step from `prev` to `curr` treated the prefix `prev` cached. */
function boundary(prev, curr) {
	const before = elements(prev.body);
	const after = elements(curr.body);
	const expected = prev.usage ? prev.usage.cacheRead + prev.usage.cacheWrite : null;
	const result = {
		from: prev.n,
		to: curr.n,
		cacheRead: curr.usage?.cacheRead ?? null,
		cacheWrite: curr.usage?.cacheWrite ?? null,
		expected,
		shortfall: expected !== null && curr.usage ? expected - curr.usage.cacheRead : null,
		sharedElements: before.length,
		divergence: null,
	};
	if (after.length < before.length) {
		result.divergence = { label: `prompt shrank ${before.length} -> ${after.length} elements` };
		return result;
	}
	for (let k = 0; k < before.length; k++) {
		const d = firstDiff(before[k].value, after[k].value);
		if (!d) continue;
		result.divergence = {
			label: before[k].label === after[k].label ? before[k].label : `${before[k].label} -> ${after[k].label}`,
			turn: before[k].index === undefined ? null : turnOf(prev.body.messages, before[k].index),
			detail: describeDiff({ ...d, path: `${before[k].label.split(" ")[0]}${d.path}` }),
		};
		break;
	}
	return result;
}

/** Which content shapes the final history actually exercised. */
function coverage(body) {
	const counts = {};
	let maxToolUsesPerMessage = 0;
	for (const message of body.messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content) counts[block.type] = (counts[block.type] ?? 0) + 1;
		maxToolUsesPerMessage = Math.max(maxToolUsesPerMessage, message.content.filter((b) => b.type === "tool_use").length);
	}
	return { ...counts, maxToolUsesPerMessage };
}

async function run(runIndex, extensionPath) {
	const runDir = join(OUT, `run-${runIndex}`);
	const captureDir = join(runDir, "capture");
	const cwd = join(runDir, "cwd");
	mkdirSync(captureDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const word = () => `${["amber", "cobalt", "saffron", "teal"][Math.floor(Math.random() * 4)]}${Math.random().toString(36).slice(2, 6)}`;
	writeFileSync(join(cwd, "notes-a.txt"), `codeword: ${word()}\n`);
	writeFileSync(join(cwd, "notes-b.txt"), `codeword: ${word()}\n`);

	const port = await freePort();
	const proxyLog = openSync(join(runDir, "proxy.log"), "w");
	const proxy = spawn(process.execPath, [join(REPO, "diag/capture-proxy.mjs"), "--port", String(port), "--out", captureDir], {
		stdio: ["ignore", "ignore", proxyLog],
	});
	const debugLog = join(runDir, "bridge-debug.log");
	const piOut = openSync(join(runDir, "pi.ndjson"), "w");
	const piErr = openSync(join(runDir, "pi.stderr"), "w");
	let pi;
	try {
		await waitForPort(port);
		// The system pi, as the int tests use: node_modules/.bin would pick the vendored one.
		const PATH = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
		pi = spawnSync("pi", [
			"--no-session", "-ne", "-e", REPO, "-e", extensionPath,
			"--model", MODEL,
			...(THINKING === "off" ? [] : ["--thinking", THINKING]),
			"--mode", "json",
			"-p", ...PLAN.map((step) => `${step.tag} ${step.text}`),
		], {
			cwd,
			env: {
				...process.env,
				PATH,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
				CLAUDE_BRIDGE_DEBUG: "1",
				CLAUDE_BRIDGE_DEBUG_PATH: debugLog,
				PROBE_FORCE_REBUILD_AT: PLAN.flatMap((step, i) => (step.force ? [i + 1] : [])).join(","),
			},
			stdio: ["ignore", piOut, piErr],
			timeout: 15 * 60_000,
		});
	} finally {
		proxy.kill();
		for (const fd of [proxyLog, piOut, piErr]) closeSync(fd);
	}
	if (pi.status !== 0) throw new Error(`run ${runIndex}: pi exited ${pi.status ?? pi.signal}; see ${runDir}/pi.stderr`);

	const { requests, failed } = loadRequests(captureDir);
	const firstIndex = PLAN.map((step) => requests.findIndex((r) => r.body.messages.some((m) => opensWith(m, step.tag))));
	const missing = PLAN.filter((_, i) => firstIndex[i] === -1).map((step) => step.tag);
	if (missing.length) throw new Error(`run ${runIndex}: no captured request carries ${missing.join(", ")}; see ${captureDir}`);
	if (firstIndex.some((idx, i) => i > 0 && idx <= firstIndex[i - 1])) throw new Error(`run ${runIndex}: prompts out of order in the capture`);

	const paths = syncPaths(debugLog);
	const mismatched = PLAN.flatMap((step, i) => (paths[i] === step.expect ? [] : [`${step.tag} expected "${step.expect}", got "${paths[i] ?? "nothing"}"`]));
	if (paths.length !== PLAN.length || mismatched.length) {
		throw new Error(`run ${runIndex}: sync paths do not match the plan (${paths.length} syncResult lines): ${mismatched.join("; ")}; see ${debugLog}`);
	}

	const prompts = PLAN.map((step, i) => ({
		tag: step.tag,
		path: paths[i],
		...(i === 0 ? { cacheRead: requests[0].usage?.cacheRead ?? null } : boundary(requests[firstIndex[i] - 1], requests[firstIndex[i]])),
	}));
	const promptStarts = new Set(firstIndex);
	const inTurn = requests.slice(1).map((r, k) => ({ at: k + 1, b: boundary(requests[k], r) })).filter(({ at }) => !promptStarts.has(at)).map(({ b }) => b);
	return {
		runDir,
		requests: requests.length,
		failedRequests: failed,
		prompts,
		inTurn: {
			boundaries: inTurn.length,
			diverged: inTurn.filter((b) => b.divergence).length,
			maxShortfall: Math.max(0, ...inTurn.map((b) => b.shortfall ?? 0)),
		},
		coverage: coverage(requests[requests.length - 1].body),
	};
}

function print(result, runIndex) {
	console.log(`\nrun ${runIndex}  ${result.runDir}`);
	console.log(`  ${result.requests} main-loop requests${result.failedRequests ? `, ${result.failedRequests} non-200 (retried)` : ""}; history exercised: ${JSON.stringify(result.coverage)}`);
	console.log(`  in-turn boundaries (tool continuations, a control): ${result.inTurn.boundaries}, diverged ${result.inTurn.diverged}, max shortfall ${result.inTurn.maxShortfall}`);
	console.log(`  ${"prompt".padEnd(7)} ${"sync path".padEnd(18)} ${"cacheRead".padStart(9)} ${"expected".padStart(9)} ${"shortfall".padStart(9)}  prefix`);
	for (const p of result.prompts) {
		const prefix = p.expected === undefined ? "(first request)"
			: p.divergence ? `diverges at ${p.divergence.label}${p.divergence.turn ? ` (in ${p.divergence.turn}'s turn)` : ""}`
			: `identical for all ${p.sharedElements} elements`;
		console.log(`  ${p.tag.padEnd(7)} ${p.path.padEnd(18)} ${String(p.cacheRead ?? "?").padStart(9)} ${String(p.expected ?? "-").padStart(9)} ${String(p.shortfall ?? "-").padStart(9)}  ${prefix}`);
		if (p.divergence?.detail) console.log(`          ${p.divergence.detail}`);
		if (p.divergence === null && (p.shortfall ?? 0) > 200) console.log("          >>> identical prefix but cache fell short: not our bytes");
	}
}

mkdirSync(OUT, { recursive: true });
const extensionPath = join(OUT, "force-rebuild.ts");
writeFileSync(extensionPath, FORCE_EXTENSION);
console.log(`model ${MODEL}, thinking ${THINKING}, ${RUNS} run(s), output ${OUT}`);

const results = [];
for (let i = 1; i <= RUNS; i++) {
	const result = await run(i, extensionPath);
	print(result, i);
	results.push(result);
}
writeFileSync(join(OUT, "report.json"), JSON.stringify({ model: MODEL, thinking: THINKING, results }, null, 1));

console.log("\nsummary");
for (const step of PLAN.slice(1)) {
	const rows = results.map((r) => r.prompts.find((p) => p.tag === step.tag));
	const identical = rows.filter((p) => !p.divergence).length;
	console.log(`  ${step.tag} ${step.expect.padEnd(18)} prefix identical in ${identical}/${rows.length} runs, shortfalls ${rows.map((p) => p.shortfall).join(", ")}`);
}
console.log(`\nreport: ${join(OUT, "report.json")}`);
