#!/usr/bin/env node
// Warning/anomaly inventory for the bridge debug log.
//
// The bridge logs a handful of conditions it believes are impossible or broken
// (`WARNING:`, `BUG:`). The integration suite gates deadlock markers; this
// collects all warnings with counts and dates, plus the tool-loop invariants that
// have no WARNING of their own: MCP handlers that waited and were never resolved,
// and tool results queued for a handler that never claimed them. Both are the
// deadlock signature.
//
//   node --import tsx diag/audit-warnings.mjs [claude-bridge.log]
//
// Exits 1 if any WARNING/BUG line or stranded handler/result is present.
// See diag/AUDIT.md for baselines.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Anchoring on the bridge's own line prefix is load-bearing, not cosmetic: tool
// output is echoed into this log verbatim, so a bare /WARNING:/ grep matches
// compiler output, other tools' logs, and any file the agent happened to read.
const LINE = /^\[(\d{4}-\d{2}-\d{2})T([\d:.]+)Z\] \[([a-z0-9]+)\] (.*)$/;
const NOTABLE = /^(WARNING|BUG)\b/;

const WAITING = /^mcp handler: (\S+) \[(\S+)\] → waiting/;
const RESOLVING = /^provider: resolving \S+ \[(\S+)\]/;
const QUEUED = /^provider: queued result \[(\S+)\]/;
const CLAIMED = /^mcp handler: \S+ \[(\S+)\] → resolved from queue/;
// A pi process that aborted the turn or shut down explains a handler that never
// got its result; only the ones with no such line are worth a human's attention.
const ENDED = /wasAborted=true|abort detected|session_shutdown/;

const args = process.argv.slice(2);
const sinceArg = args.indexOf("--since");
const since = sinceArg === -1 ? null : Date.parse(args[sinceArg + 1]);
if (Number.isNaN(since)) {
	console.error("usage: audit-warnings.mjs [log] [--since YYYY-MM-DD]");
	process.exit(2);
}
// The log reaches back to April; without a window every historical warning keeps
// the check red forever. Everything is still printed — only the exit narrows.
const inWindow = (iso) => since === null || Date.parse(iso) >= since;
// Same resolution as src/log-paths.ts, without pulling pi's runtime into a diag
// script: PI_CODING_AGENT_DIR wins, ~/.pi/agent is only the default.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const logPath = args.filter((a, i) => !a.startsWith("--") && i !== sinceArg + 1)[0]
	?? join(agentDir, "claude-bridge.log");

function run() {
	let text;
	try { text = readFileSync(logPath, "utf8"); }
	catch (err) { console.error(`cannot read ${logPath}: ${err.message}`); process.exit(2); }

	const notable = new Map();
	const modules = new Map();
	let anchored = 0, total = 0;

	for (const line of text.split("\n")) {
		total++;
		const m = LINE.exec(line);
		if (!m) continue;
		anchored++;
		const [, date, time, moduleId, msg] = m;
		let mod = modules.get(moduleId);
		if (!mod) modules.set(moduleId, (mod = { waiting: new Map(), queued: new Map(), ended: false, order: [] }));

		if (NOTABLE.test(msg)) {
			// Collapse ids/counts so repeats of the same condition group together.
			const key = msg.replace(/\[[^\]]*\]/g, "[…]").replace(/\d+/g, "N").slice(0, 100);
			const rec = notable.get(key) ?? { n: 0, dates: new Set(), sample: `${date}T${time}Z [${moduleId}] ${msg}` };
			rec.n++; rec.dates.add(date);
			notable.set(key, rec);
		}

		if (ENDED.test(msg)) mod.ended = true;
		let g;
		if ((g = WAITING.exec(msg))) mod.waiting.set(g[2], { ts: `${date}T${time}Z`, tool: g[1] });
		else if ((g = RESOLVING.exec(msg))) mod.waiting.delete(g[1]);
		else if ((g = QUEUED.exec(msg))) mod.queued.set(g[1], { ts: `${date}T${time}Z` });
		else if ((g = CLAIMED.exec(msg))) mod.queued.delete(g[1]);
	}

	const strandedHandlers = [];
	const orphanResults = [];
	for (const [moduleId, mod] of modules) {
		for (const [id, info] of mod.waiting) strandedHandlers.push({ moduleId, id, ...info, ended: mod.ended });
		for (const [id, info] of mod.queued) orphanResults.push({ moduleId, id, ...info, ended: mod.ended });
	}
	strandedHandlers.sort((a, b) => a.ts.localeCompare(b.ts));
	orphanResults.sort((a, b) => a.ts.localeCompare(b.ts));

	console.log(`log:      ${logPath}`);
	console.log(`lines:    ${total} total, ${anchored} carrying the bridge's own log prefix`);
	console.log(`modules:  ${modules.size} pi process instances\n`);

	console.log("WARNING / BUG lines:");
	for (const [, rec] of [...notable].sort((a, b) => b[1].n - a[1].n)) {
		const dates = [...rec.dates].sort();
		const span = dates.length === 1 ? dates[0] : `${dates[0]}..${dates.at(-1)} (${dates.length} days)`;
		console.log(`  ${String(rec.n).padStart(4)}  ${span}`);
		console.log(`        ${rec.sample.slice(0, 150)}`);
	}
	if (!notable.size) console.log("  none");

	// A handler still waiting when its pi process aborted or shut down is the
	// expected outcome, not a bug: pi tore the turn down before delivering.
	const show = (label, list) => {
		const unexplained = list.filter((x) => !x.ended);
		console.log(`\n${label}: ${list.length} (${list.length - unexplained.length} after an abort/shutdown, ${unexplained.length} unexplained)`);
		for (const x of unexplained) console.log(`  ${x.ts} module=${x.moduleId} ${x.tool ?? ""} ${x.id}`);
		return unexplained.filter((x) => inWindow(x.ts)).length;
	};
	const a = show("MCP handlers that waited and were never resolved", strandedHandlers);
	const b = show("tool results queued for a handler that never claimed them", orphanResults);

	const recentNotable = [...notable.values()].filter((rec) => [...rec.dates].some((d) => inWindow(d))).length;
	const bad = recentNotable + a + b;
	console.log();
	const window = since === null ? "" : ` since ${new Date(since).toISOString().slice(0, 10)}`;
	if (bad) console.log(`FAIL: ${recentNotable} distinct WARNING/BUG condition(s), ${a} stranded handler(s), ${b} orphan result(s)${window}`);
	else console.log(`OK: no WARNING/BUG lines and no stranded handlers or orphan results${window}`);
	process.exit(bad ? 1 : 0);
}

run();
