#!/usr/bin/env node
// After /tree goes back to an earlier turn, does the next request read the
// conversation back from the prompt cache?
//
// pi's tree navigation leaves a history that is a strict prefix of the one Claude
// Code's session holds. The bridge used to rebuild CC's session from it, and the
// next request missed the cache wherever the rebuild's bytes differed from CC's.
// With tree-fork.ts it forks CC's own session at the turn boundary instead. This
// probe runs one pi session through the bridge under diag/capture-proxy.mjs:
//
//   P1, P2, P3   three turns with tool calls
//   /rewind-to 2 a real ctx.navigateTree to P2's user entry: pi's history is now
//                P1's turn, and P2/P3 are an abandoned branch
//   P4           the request under test
//   P5           a control: the conversation goes on from P4 as usual (reuse)
//
// For P4 it reports the bridge's sync path, whether the request still carries the
// abandoned turns (it must not), and cacheRead against the best any earlier request
// left cached: the largest cacheRead + cacheWrite of an earlier request whose whole
// prompt is a prefix of P4's. That is what a provider replaying pi's history byte
// for byte would read back.
//
//   node diag/probe-tree-fork.mjs [--model claude-bridge/claude-haiku-5-5]
//       [--thinking xhigh|off] [--runs 1] [--bridge PATH] [--out DIR]
//
// --bridge loads another checkout of the bridge (e.g. a worktree of an older
// commit) to measure the rebuild path on the same scenario.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeDiff, elements, firstDiff, freePort, loadRequests, opensWith, syncPaths, waitForPort } from "./lib/capture-compare.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("model", "claude-bridge/claude-haiku-5-5");
const THINKING = flag("thinking", "xhigh");
const RUNS = Number(flag("runs", 1));
const BRIDGE = resolve(flag("bridge", REPO));
const OUT = flag("out") ?? mkdtempSync(join(tmpdir(), "tree-fork-"));

const PROMPTS = [
	// A bash call in the kept turn: the model rarely passes a timeout, which is the
	// argument a rebuild has been seen to rewrite (mapToolArgs adds one).
	{ tag: "[P1]", text: "In a single message, in parallel: use the read tool to read notes-a.txt, and the bash tool to run: cat notes-b.txt. Then reply with just the two codewords." },
	{ tag: "[P2]", text: "Use the bash tool to run: ls -1 | wc -l. Reply with just the number." },
	{ tag: "[P3]", text: "Use the write tool to write the two codewords to out.txt, one per line. Reply with just: done." },
	{ command: "/rewind-to 2" },
	{ tag: "[P4]", text: "Use the bash tool to run: cat notes-b.txt. Reply with just its contents." },
	{ tag: "[P5]", text: "Use the read tool to read notes-a.txt. Reply with just its codeword." },
];
const ABANDONED = ["[P2]", "[P3]"];

const REWIND_EXTENSION = `// /rewind-to N: navigate to the N-th user entry on the current branch, as
// selecting it in /tree does (history ends before it), without a summary.
export default function (pi: any) {
	pi.registerCommand("rewind-to", {
		description: "Navigate the session tree to the N-th user message",
		handler: async (args: string, ctx: any) => {
			const n = Number(args.trim());
			const users = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message?.role === "user");
			const target = users[n - 1];
			if (!target) throw new Error(\`rewind-to: no user entry #\${n} (have \${users.length})\`);
			const result = await ctx.navigateTree(target.id, { summarize: false });
			if (result.cancelled) throw new Error("rewind-to: navigation cancelled");
		},
	});
}
`;

/** Elements of `prev` that `curr` repeats unchanged, from the start. */
function sharedPrefix(prev, curr) {
	const before = elements(prev.body);
	const after = elements(curr.body);
	for (let k = 0; k < before.length; k++) {
		if (k >= after.length) return { shared: k, whole: false, divergence: { label: "prompt shrank" } };
		const d = firstDiff(before[k].value, after[k].value);
		if (d) return { shared: k, whole: false, divergence: { label: before[k].label, detail: describeDiff({ ...d, path: `${before[k].label.split(" ")[0]}${d.path}` }) } };
	}
	return { shared: before.length, whole: true };
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
			"--no-session", "-ne", "-e", BRIDGE, "-e", extensionPath,
			"--model", MODEL,
			...(THINKING === "off" ? [] : ["--thinking", THINKING]),
			"--mode", "json",
			"-p", ...PROMPTS.map((step) => step.command ?? `${step.tag} ${step.text}`),
		], {
			cwd,
			env: {
				...process.env,
				PATH,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
				CLAUDE_BRIDGE_DEBUG: "1",
				CLAUDE_BRIDGE_DEBUG_PATH: debugLog,
				CLAUDE_BRIDGE_SESSION_LINKS_PATH: join(runDir, "session-links.json"),
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
	const p4 = requests.findIndex((r) => r.body.messages.some((m) => opensWith(m, "[P4]")));
	if (p4 === -1) throw new Error(`run ${runIndex}: no captured request carries [P4]; see ${captureDir}`);
	const target = requests[p4];
	const leaked = ABANDONED.filter((tag) => target.body.messages.some((m) => opensWith(m, tag)));

	// The best cache any earlier request could leave for P4: one whose whole prompt
	// P4's repeats. That is measured against this run's own bytes, so a rebuild that
	// rewrote an early message lowers it too; the per-request table shows where.
	let expected = 0;
	const earlier = requests.slice(0, p4).map((prev) => {
		const prefix = sharedPrefix(prev, target);
		const cached = prev.usage ? prev.usage.cacheRead + prev.usage.cacheWrite : null;
		if (prefix.whole && cached !== null) expected = Math.max(expected, cached);
		return { n: prev.n, cached, ...prefix };
	});
	// P5 continues the (possibly forked) session: it must reuse it and repeat
	// P4's last request whole.
	const p5 = requests.findIndex((r) => r.body.messages.some((m) => opensWith(m, "[P5]")));
	if (p5 === -1) throw new Error(`run ${runIndex}: no captured request carries [P5]; see ${captureDir}`);
	const control = sharedPrefix(requests[p5 - 1], requests[p5]);
	const paths = syncPaths(debugLog);
	return {
		runDir,
		requests: requests.length,
		failedRequests: failed,
		path: paths[paths.length - 2] ?? "nothing",
		control: { path: paths[paths.length - 1] ?? "nothing", whole: control.whole, divergence: control.divergence ?? null, cacheRead: requests[p5].usage?.cacheRead ?? null, cacheWrite: requests[p5].usage?.cacheWrite ?? null },
		leaked,
		cacheRead: target.usage?.cacheRead ?? null,
		cacheWrite: target.usage?.cacheWrite ?? null,
		expected,
		shortfall: target.usage ? expected - target.usage.cacheRead : null,
		earlier,
	};
}

mkdirSync(OUT, { recursive: true });
const extensionPath = join(OUT, "rewind-to.ts");
writeFileSync(extensionPath, REWIND_EXTENSION);
console.log(`model ${MODEL}, thinking ${THINKING}, bridge ${BRIDGE}, ${RUNS} run(s), output ${OUT}`);

const results = [];
for (let i = 1; i <= RUNS; i++) {
	const r = await run(i, extensionPath);
	results.push(r);
	console.log(`\nrun ${i}  ${r.runDir}`);
	console.log(`  ${r.requests} main-loop requests${r.failedRequests ? `, ${r.failedRequests} non-200 (retried)` : ""}`);
	console.log(`  [P4] sync path: ${r.path}`);
	console.log(`  [P4] abandoned turns in the request: ${r.leaked.length ? `${r.leaked.join(", ")}  <<< WRONG HISTORY` : "none"}`);
	console.log(`  [P4] cacheRead ${r.cacheRead}, cacheWrite ${r.cacheWrite}, ${r.expected
		? `best available ${r.expected}, shortfall ${r.shortfall}`
		: "no earlier request is repeated whole: this run rewrote the history's start"}`);
	for (const e of r.earlier) {
		const how = e.whole ? "whole prompt repeated" : `repeats ${e.shared} elements, diverges at ${e.divergence.label}`;
		console.log(`    #${String(e.n).padEnd(3)} cached ${String(e.cached ?? "?").padStart(6)}  ${how}`);
		if (!e.whole && e.divergence.detail) console.log(`          ${e.divergence.detail.split("\n")[0]}`);
	}
	const c = r.control;
	console.log(`  [P5] control: sync path ${c.path}, ${c.whole ? "repeats P4's last request whole" : `diverges from P4's last request at ${c.divergence.label}`}, cacheRead ${c.cacheRead}, cacheWrite ${c.cacheWrite}`);
}
writeFileSync(join(OUT, "report.json"), JSON.stringify({ model: MODEL, thinking: THINKING, bridge: BRIDGE, results }, null, 1));
console.log(`\nreport: ${join(OUT, "report.json")}`);
