#!/usr/bin/env node
// Structural scanner for Claude Code session transcripts.
//
// Checks the write path: pi history -> convertPiMessages -> repairToolPairing ->
// Session.importMessages -> JSONL -> `--resume`. Everything the bridge writes has
// to be a shape Claude Code can read back and the Anthropic API will accept, and
// the failure mode is silence — nothing throws, no test fails, the model just
// sees a conversation that did not happen.
//
//   node --import tsx diag/audit-transcripts.mjs [file.jsonl | projects-dir] [--since YYYY-MM-DD]
//
// Everything found is reported. The **exit code covers only records written on or
// after `--since`**, because most of what is on disk is damage from bugs already
// fixed and no amount of correctness makes it disappear — without a window the
// check is red forever and stops being read. Pass the date of the last known-good
// audit to ask "has anything gone wrong since?"; omit it and the exit code covers
// everything, which is a report rather than a gate.
//
// Caveat: a rebuild re-stamps old messages with the time it ran, so a session
// rebuilt inside the window carries its whole history into the window with it.
//
// See diag/AUDIT.md for baselines and the known-benign patterns.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// Placeholder text the write path substitutes when it cannot represent something.
// `[no tool result recorded]` comes from cc-session-io's repairToolPairing; the
// rest from src/convert.ts.
const MARKERS = [
	"[no tool result recorded]",
	"[incompatible content omitted]",
	"[orphaned tool result removed]",
	"[empty]", "[image]", "[document]", "[thinking]",
];

const args = process.argv.slice(2);
const sinceArg = args.indexOf("--since");
const since = sinceArg === -1 ? null : Date.parse(args[sinceArg + 1]);
if (Number.isNaN(since)) {
	console.error("--since needs a parseable date, e.g. --since 2026-07-29");
	process.exit(2);
}
const target = args.filter((a, i) => !a.startsWith("--") && i !== sinceArg + 1)[0] ?? join(homedir(), ".claude/projects");
const inWindow = (ts) => since === null || (ts !== null && ts >= since);

// Test harnesses run in temp dirs and deliberately produce aborted turns and
// synthetic tool names; counting them as defects buries the real signal.
const isTestPath = (f) => {
	const d = basename(dirname(f));
	return d.startsWith("-private-var-folders") || d.startsWith("-var-folders") || d.includes("--test-output");
};

function collect(path) {
	const st = statSync(path);
	if (!st.isDirectory()) return [path];
	const out = [];
	for (const entry of readdirSync(path)) {
		const p = join(path, entry);
		try {
			if (statSync(p).isDirectory()) out.push(...collect(p));
			else if (entry.endsWith(".jsonl")) out.push(p);
		} catch { /* races with CC writing; skip */ }
	}
	return out;
}

// Claude Code stores one content block per record, several records sharing a
// `message.id` for one logical assistant message, and each tool_result in its own
// user record. cc-session-io writes one record per message. Any structural check
// has to regroup first or it reports hundreds of phantom defects on CC's own files.
function logicalMessages(records) {
	const out = [];
	for (const r of records) {
		if (r.type !== "user" && r.type !== "assistant") continue;
		const msg = r.message ?? {};
		const content = Array.isArray(msg.content)
			? msg.content
			: typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
		const last = out.at(-1);
		const ts = Date.parse(r.timestamp ?? "") || null;
		if (r.type === "assistant") {
			const synthetic = String(msg.id ?? "").startsWith("msg_syn_") || String(r.requestId ?? "").startsWith("req_syn_");
			if (last?.role === "assistant" && last.id === msg.id) { last.content.push(...content); continue; }
			out.push({ role: "assistant", id: msg.id, line: r.__line, ts, content: [...content], synthetic });
		} else {
			if (last?.role === "user") { last.content.push(...content); continue; }
			out.push({ role: "user", id: null, line: r.__line, ts, content: [...content], synthetic: null });
		}
	}
	return out;
}

function scanFile(file) {
	const defects = [];
	const markers = new Map();
	let records;
	try {
		records = readFileSync(file, "utf8").split("\n").flatMap((line, i) => {
			if (!line.trim()) return [];
			try { const r = JSON.parse(line); r.__line = i + 1; return [r]; } catch { return []; }
		});
	} catch { return null; }

	const msgs = logicalMessages(records);
	if (!msgs.length) return { defects, markers, bridgeRecords: 0, ccRecords: 0 };

	let msgTs = null;
	const add = (kind, line, detail) => defects.push({ kind, line, detail, ts: msgTs });
	const text = (v) => typeof v === "string" ? v
		: Array.isArray(v) ? v.map((b) => (b && typeof b === "object" ? b.text ?? "" : "")).join("") : "";

	let pending = new Map(); // tool_use id -> {line, name} awaiting a result
	const seen = new Set();
	let bridgeRecords = 0, ccRecords = 0;

	for (const m of msgs) {
		msgTs = m.ts;
		if (m.role === "assistant") m.synthetic ? bridgeRecords++ : ccRecords++;
		for (const b of m.content) {
			if (!b || typeof b !== "object") continue;
			const body = b.type === "tool_result" ? text(b.content) : b.type === "text" ? b.text ?? "" : "";
			for (const marker of MARKERS) {
				// Substring-match only on short bodies: the full marker text appears
				// inside tool output whenever someone greps for it, and an unguarded
				// `includes` turns those echoes into findings.
				if (body.trim() === marker || (body.length < 200 && body.includes(marker))) {
					const [total, recent] = markers.get(marker) ?? [0, 0];
					markers.set(marker, [total + 1, recent + (inWindow(m.ts) ? 1 : 0)]);
				}
			}
		}
		if (m.role === "assistant") {
			for (const [id, info] of pending) add("tool_use with no tool_result", info.line, `${info.name} ${id}`);
			pending = new Map();
			if (!m.content.length) add("assistant message with empty content", m.line, "");
			for (const b of m.content) {
				if (b?.type !== "tool_use") continue;
				if (seen.has(b.id)) add("duplicate tool_use id", m.line, `${b.name} ${b.id}`);
				seen.add(b.id);
				pending.set(b.id, { line: m.line, name: b.name });
				// The provider path runs with `tools: []`, so every tool Claude can
				// legitimately call is one we serve over MCP. A bare builtin or a
				// pascalCased pi name means the write path mangled it. Exception: an
				// AskClaude session left behind by a crash legitimately holds
				// Read/Write/Edit/Bash/Grep, since CC runs its own tools there.
				if (m.synthetic && !String(b.name).startsWith("mcp__")) {
					add("bridge-written tool_use with a non-MCP name", m.line, String(b.name));
				}
			}
		} else {
			for (const b of m.content) {
				if (b?.type !== "tool_result") continue;
				if (pending.has(b.tool_use_id)) pending.delete(b.tool_use_id);
				else if (seen.has(b.tool_use_id)) add("tool_result after the next turn began", m.line, b.tool_use_id);
				else add("tool_result with no matching tool_use", m.line, b.tool_use_id);
			}
		}
	}
	msgTs = msgs.at(-1).ts;
	for (const [id, info] of pending) add("tool_use unanswered at end of file", info.line, `${info.name} ${id}`);
	msgTs = msgs[0].ts;
	if (msgs[0].role !== "user") add("transcript starts mid-turn", msgs[0].line, msgs[0].role);

	return { defects, markers, bridgeRecords, ccRecords };
}

function run() {
	let files;
	try { files = collect(target); }
	catch (err) { console.error(`cannot read ${target}: ${err.message}`); process.exit(2); }

	const totals = { real: new Map(), test: new Map() };
	const markerTotals = { real: new Map(), test: new Map() };
	const examples = new Map();
	const classes = new Map();
	let scanned = 0;

	for (const file of files) {
		const res = scanFile(file);
		if (!res) continue;
		scanned++;
		const bucket = isTestPath(file) ? "test" : "real";
		const cls = res.bridgeRecords && res.ccRecords ? "mixed" : res.bridgeRecords ? "bridge-written" : res.ccRecords ? "cc-authored" : "no assistant records";
		classes.set(cls, (classes.get(cls) ?? 0) + 1);
		for (const d of res.defects) {
			const [dt, dr] = totals[bucket].get(d.kind) ?? [0, 0];
			totals[bucket].set(d.kind, [dt + 1, dr + (inWindow(d.ts) ? 1 : 0)]);
			const key = `${bucket}:${d.kind}`;
			if (!examples.has(key)) examples.set(key, []);
			const list = examples.get(key);
			if (list.length < 4) list.push(`${file}:${d.line} ${d.detail}`);
		}
		for (const [m, [t, r]] of res.markers) {
			const [mt, mr] = markerTotals[bucket].get(m) ?? [0, 0];
			markerTotals[bucket].set(m, [mt + t, mr + r]);
		}
	}

	console.log(`target:  ${target}`);
	console.log(`scanned: ${scanned} transcripts${since === null ? "" : `, exit code covers records since ${new Date(since).toISOString().slice(0, 10)}`}`);
	for (const [k, v] of classes) console.log(`  ${String(v).padStart(5)}  ${k}`);

	for (const bucket of ["real", "test"]) {
		const label = bucket === "real" ? "REAL PROJECTS" : "TEST/TEMP DIRS (informational)";
		console.log(`\n${label}`);
		console.log("  loss markers:");
		const ms = [...markerTotals[bucket]].sort((a, b) => b[1][0] - a[1][0]);
		for (const [m, [t, r]] of ms) console.log(`    ${String(t).padStart(6)}  ${m}${since === null ? "" : `   (${r} in window)`}`);
		if (!ms.length) console.log("    none");
		console.log("  structural defects:");
		const ds = [...totals[bucket]].sort((a, b) => b[1][0] - a[1][0]);
		for (const [kind, [t, r]] of ds) {
			console.log(`    ${String(t).padStart(6)}  ${kind}${since === null ? "" : `   (${r} in window)`}`);
			for (const ex of examples.get(`${bucket}:${kind}`) ?? []) console.log(`            ${ex}`);
		}
		if (!ds.length) console.log("    none");
	}

	const idx = since === null ? 0 : 1;
	const realDefects = [...totals.real.values()].reduce((a, b) => a + b[idx], 0);
	const realMarkers = [...markerTotals.real.values()].reduce((a, b) => a + b[idx], 0);
	const window = since === null ? "" : ` since ${new Date(since).toISOString().slice(0, 10)}`;
	console.log();
	if (realDefects || realMarkers) console.log(`FAIL: ${realDefects} structural defect(s) and ${realMarkers} loss marker(s) in non-test transcripts${window}`);
	else console.log(`OK: no structural defects or loss markers in non-test transcripts${window}`);
	process.exit(realDefects || realMarkers ? 1 : 0);
}

run();
