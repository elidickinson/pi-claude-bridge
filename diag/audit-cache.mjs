#!/usr/bin/env node
// Prompt-cache anomaly scanner for the bridge debug log.
//
// The Anthropic prompt cache is keyed on exact prompt-prefix bytes, so a request
// that reads back less cache than the previous one wrote is evidence the prefix
// we sent diverged from what Claude Code sent last time. Both bugs found in July
// 2026 (phantom tool calls, destroyed parallel tool results) were prefix-mutation
// bugs, which makes this the cheapest always-on integrity signal the bridge has.
//
//   node --import tsx diag/audit-cache.mjs [claude-bridge.log]
//
// Key idea: compare the *query-boundary* break rate against the *in-query* break
// rate measured from the same log. Within a single query() call the bridge cannot
// mutate the prefix — it only appends tool results — so in-query breaks are pure
// server-side eviction and serve as the control group. A bridge-side prefix bug
// would push the boundary rate above that floor. See diag/AUDIT.md for baselines.
//
// Exits 1 when the boundary rate exceeds the documented ceiling, or when a break
// lands on a rebuild boundary (the shape most likely to be our own bug).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Only lines carrying the bridge's own `[iso] [module-id] ` prefix count. Tool
// output is echoed into this log verbatim and contains `usage:`/`WARNING:`
// strings of its own; an unanchored scan picks those up and inflates every count.
const LINE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[([a-z0-9]+)\] (.*)$/;
const USAGE = /^usage: in=(\d+) out=(\d+) cacheRead=(\d+) cacheWrite=(\d+) total=(\d+)(?: reasoning=\d+)? cachePct=(\d+)% model=(\S+)/;
const FRESH = /^provider: fresh query model=(\S+) msgs=(\d+) tools=(\d+) resume=(\S+) effort=(\S+)/;
const SYNC = /^syncResult: path=(\S+)/;
const RESET = /^(session_start|session_compact|session_before_compact|compact summary|Case 1 synthetic)/;

// Claude Code's own detector (reference-code/claude-code-rip/src/services/api/
// promptCacheBreakDetection.ts) ignores drops under 2000 tokens. Matching it keeps
// this scanner's notion of "break" aligned with CC's.
const MIN_SHORTFALL = 2_000;
// Conservative: CC requests a 1h TTL only when a GrowthBook allowlist matches the
// query source, so a 5-90 min gap may or may not have expired. Excluding anything
// over 5 minutes means the residual is a lower bound on real breaks.
const TTL_MIN_MS = 5 * 60 * 1000;
// Boundary break rate measured over the full April-July 2026 log (see AUDIT.md).
// Well above it means a prefix-mutation regression, not server-side noise.
const BOUNDARY_RATE_CEILING = 0.10;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const since = args.includes("--since") ? Date.parse(flag("--since")) : null;
// The 28% boundary rate documented in diag/AUDIT.md is an open
// finding, not a regression, so the ceiling is a knob: set it just above the
// current rate to catch it getting *worse* while the root cause is unresolved.
const ceiling = Number(flag("--ceiling", BOUNDARY_RATE_CEILING));
if (Number.isNaN(since) || Number.isNaN(ceiling)) {
	console.error("usage: audit-cache.mjs [log] [--since YYYY-MM-DD] [--ceiling 0.30]");
	process.exit(2);
}
// Same resolution as src/log-paths.ts, without pulling pi's runtime into a diag
// script: PI_CODING_AGENT_DIR wins, ~/.pi/agent is only the default.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const logPath = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))[0]
	?? join(agentDir, "claude-bridge.log");

// A turn emits several `usage:` lines reporting the same request as its output
// grows. Collapsing runs that share (cacheRead, cacheWrite, model) leaves one row
// per API request, which is what the cache math needs.
function parse(text) {
	const perModule = new Map();
	for (const line of text.split("\n")) {
		const m = LINE.exec(line);
		if (!m) continue;
		const [, ts, moduleId, msg] = m;
		let entry = perModule.get(moduleId);
		if (!entry) perModule.set(moduleId, (entry = { requests: [], marks: [] }));
		const u = USAGE.exec(msg);
		if (!u) { entry.marks.push(msg); continue; }
		const cacheRead = +u[3], cacheWrite = +u[4], model = u[7];
		const prev = entry.requests.at(-1);
		if (prev && prev.cacheRead === cacheRead && prev.cacheWrite === cacheWrite && prev.model === model) {
			// Same request, later snapshot as its output grew. Keep the record's
			// original `marks` — they are the log lines that preceded the request,
			// and replacing the object here would swap in the ones that followed it.
			prev.ts = ts; prev.at = Date.parse(ts); prev.pct = +u[6];
			continue;
		}
		entry.requests.push({
			ts, at: Date.parse(ts), moduleId,
			in: +u[1], cacheRead, cacheWrite, pct: +u[6], model,
			marks: entry.marks,
		});
		entry.marks = [];
	}
	return perModule;
}

function run() {
	let text;
	try {
		text = readFileSync(logPath, "utf8");
	} catch (err) {
		console.error(`cannot read ${logPath}: ${err.message}`);
		process.exit(2);
	}

	const benign = new Map();
	const bump = (reason, tokens) => {
		const b = benign.get(reason) ?? { n: 0, tokens: 0 };
		b.n++; b.tokens += Math.max(0, tokens);
		benign.set(reason, b);
	};
	const group = { "in-query": { n: 0, breaks: 0, tokens: 0 }, boundary: { n: 0, breaks: 0, tokens: 0 } };
	const breaks = [];
	let requests = 0;

	for (const { requests: rs } of parse(text).values()) {
		requests += rs.length;
		for (let i = 1; i < rs.length; i++) {
			const prev = rs[i - 1], cur = rs[i];
			// What turn N-1 demonstrably left in the cache: what it read plus what it
			// wrote. Its `in` is deliberately excluded — those are tokens the API did
			// *not* cache on that request, so expecting them back is a false positive,
			// and a tool-heavy turn sends its whole result payload as uncached `in`.
			// (On the April–July corpus both formulas flag the same 336 pairs, because
			// real breaks collapse cacheRead by far more than one turn's `in`.)
			const expected = prev.cacheRead + prev.cacheWrite;
			const shortfall = expected - cur.cacheRead;

			const fresh = cur.marks.map((m) => FRESH.exec(m)).filter(Boolean).at(-1);
			const sync = cur.marks.map((m) => SYNC.exec(m)).filter(Boolean).at(-1);
			const prevFresh = prev.freshParams ?? null;
			cur.freshParams = fresh ?? prevFresh;

			// A high hit rate on the request itself means nothing was re-sent: the
			// prefix legitimately got shorter (a rebuild that dropped messages, a
			// shorter reentrant context). That is a shrink, not a cache break.
			if (shortfall < MIN_SHORTFALL || cur.pct >= 95) continue;

			// Everything below legitimately changes the prefix or the cache entry.
			const gap = cur.at - prev.at;
			if (prev.model !== cur.model) { bump(`model change (${prev.model} → ${cur.model})`, shortfall); continue; }
			if (cur.marks.some((m) => RESET.test(m))) { bump("compaction / new session / isolated subprocess", shortfall); continue; }
			if (sync && sync[1] === "clean-start") { bump("clean start (no prior history)", shortfall); continue; }
			if (fresh && fresh[4] === "none") { bump("fresh query, no resume", shortfall); continue; }
			if (fresh && prevFresh && fresh[3] !== prevFresh[3]) { bump("tool set changed", shortfall); continue; }
			if (fresh && prevFresh && fresh[5] !== prevFresh[5]) { bump("effort changed", shortfall); continue; }
			if (gap > TTL_MIN_MS) { bump(`idle > ${TTL_MIN_MS / 6e4}min (TTL may have expired)`, shortfall); continue; }

			const kind = fresh ? "boundary" : "in-query";
			group[kind].breaks++; group[kind].tokens += shortfall;
			breaks.push({ kind, ...cur, shortfall, expected, path: sync?.[1] ?? (fresh ? "?" : "in-query") });
		}
		// Denominators: every comparable pair, break or not.
		for (let i = 1; i < rs.length; i++) {
			const prev = rs[i - 1], cur = rs[i];
			if (prev.model !== cur.model || cur.at - prev.at > TTL_MIN_MS) continue;
			if (cur.marks.some((m) => RESET.test(m))) continue;
			const fresh = cur.marks.map((m) => FRESH.exec(m)).filter(Boolean).at(-1);
			if (fresh && fresh[4] === "none") continue;
			group[fresh ? "boundary" : "in-query"].n++;
		}
	}

	const rate = (g) => (g.n ? g.breaks / g.n : 0);
	console.log(`log:      ${logPath}`);
	console.log(`requests: ${requests} API requests (deduped from usage lines)`);
	console.log(`baseline: cacheRead[N] should equal cacheRead+cacheWrite[N-1]; break = shortfall >= ${MIN_SHORTFALL} tok\n`);

	console.log("prefix changes classified as benign:");
	for (const [reason, b] of [...benign].sort((a, b) => b[1].tokens - a[1].tokens)) {
		console.log(`  ${String(b.n).padStart(5)}  ${(b.tokens / 1e6).toFixed(1).padStart(5)}M tok  ${reason}`);
	}
	if (!benign.size) console.log("  (none)");

	console.log("\nresidual breaks (prefix should have been byte-identical):");
	console.log(`  in-query  ${String(group["in-query"].breaks).padStart(4)} / ${String(group["in-query"].n).padStart(5)} pairs  ${(rate(group["in-query"]) * 100).toFixed(1)}%  ${(group["in-query"].tokens / 1e6).toFixed(1)}M tok   <- control: bridge cannot mutate the prefix here`);
	console.log(`  boundary  ${String(group.boundary.breaks).padStart(4)} / ${String(group.boundary.n).padStart(5)} pairs  ${(rate(group.boundary) * 100).toFixed(1)}%  ${(group.boundary.tokens / 1e6).toFixed(1)}M tok   <- --resume boundaries`);

	const onRebuild = breaks.filter((b) => b.path === "rebuild");
	console.log(`\nbreaks on a rebuild boundary (bridge rewrote the session): ${onRebuild.length}`);
	for (const b of onRebuild.sort((x, y) => y.shortfall - x.shortfall).slice(0, 10)) {
		console.log(`  ${b.ts} module=${b.moduleId} -${b.shortfall} tok (read ${b.cacheRead}/${b.expected}, ${b.pct}%)`);
	}

	console.log("\nlargest residual breaks:");
	for (const b of [...breaks].sort((x, y) => y.shortfall - x.shortfall).slice(0, 10)) {
		console.log(`  ${b.ts} module=${b.moduleId} ${b.kind}/${b.path} -${b.shortfall} tok (read ${b.cacheRead}/${b.expected}, ${b.pct}%)`);
	}

	// Exit reflects only the window: the log spans months of already-fixed bugs.
	const recent = (b) => since === null || Date.parse(b.at) >= since;
	const windowed = onRebuild.filter(recent);
	const excess = rate(group.boundary) > ceiling && group.boundary.breaks >= 10;
	console.log();
	if (excess) console.log(`FAIL: boundary break rate ${(rate(group.boundary) * 100).toFixed(1)}% exceeds ceiling ${(ceiling * 100).toFixed(0)}% — suspect a prefix-mutation regression`);
	else if (windowed.length) console.log(`FAIL: ${windowed.length} break(s) on a rebuild boundary${since === null ? "" : " in window"} — inspect the rewritten session`);
	else console.log(`OK: boundary rate ${(rate(group.boundary) * 100).toFixed(1)}% vs in-query control ${(rate(group["in-query"]) * 100).toFixed(1)}% — residual is at the server-side eviction floor`);

	process.exit(excess || windowed.length ? 1 : 0);
}

run();
