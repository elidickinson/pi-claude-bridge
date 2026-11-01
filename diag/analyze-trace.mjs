#!/usr/bin/env node
// Check captured Claude Code requests against the request-boundary contracts in
// diag/lib/trace-analysis.mjs: unchanged history stays unchanged on the wire,
// and pi's effective history reaches the request.
//
//   node diag/analyze-trace.mjs --capture DIR [--trace RUN_DIR|TRACE_ROOT] [--out report.json]
//   node diag/analyze-trace.mjs --probe DIR      # a probe-cache-mutations output dir
//
// --capture  a diag/capture-proxy.mjs directory (old or new format)
// --trace    a bridge cache-trace run (CLAUDE_BRIDGE_TRACE_DIR); links each
//            request to the provider call, session decision and pi history behind it
// --probe    reads the probe's report.json for its recorded seed -> arm pairs
//
// Without a trace (or probe relations) ancestry is inferred from adjacency, which
// is good for grouping candidates and nothing more: those transitions are marked
// unattributed and the propagation contract is uncheckable.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	NORMALIZATION, groupFindings, inferredTransitions, linkCalls, loadCapture, loadTrace,
	isMessages, readBoundary, relationTransitions, snapshotControl, traceRuns, traceTransitions,
} from "./lib/trace-analysis.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};
const probeDir = flag("probe");
const captureDir = flag("capture") ?? (probeDir && join(probeDir, "capture"));
if (!captureDir) {
	console.error("usage: analyze-trace.mjs --capture DIR [--trace RUN_DIR] [--out FILE] | --probe DIR");
	process.exit(2);
}

let capture;
try {
	capture = loadCapture(captureDir);
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
const gaps = [];
if (capture.unparsedLines) gaps.push(`${capture.unparsedLines} capture line(s) did not parse (writer killed mid-append?)`);
if (capture.schema === "legacy") gaps.push("legacy capture: no request-start records, routes or terminal kinds");
if (capture.unterminated.length) gaps.push(`${capture.unterminated.length} request(s) started but never ended`);
const missingBodies = capture.requests.filter((r) => r.bodyMissing && isMessages(r));
if (missingBodies.length) gaps.push(`${missingBodies.length} request body/bodies not recorded (${[...new Set(missingBodies.map((r) => r.bodyMissing))].join(", ")})`);

let transitions;
let unattributed = [];
let traceSummary = null;
let coverage = null;
const snapshots = [];
const tracePath = flag("trace");
if (tracePath) {
	const calls = [];
	let runs;
	try {
		runs = traceRuns(tracePath);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	if (!runs.length) gaps.push(`no trace runs found at ${tracePath}`);
	traceSummary = [];
	const traces = [];
	for (const [runIndex, runDir] of runs.entries()) {
		let trace;
		try {
			trace = loadTrace(runDir);
		} catch (error) {
			gaps.push(`${runDir}: unreadable trace run (${error.message})`);
			continue;
		}
		traces.push(trace);
		const m = trace.manifest;
		if (trace.unparsedLines) gaps.push(`${m.run}: ${trace.unparsedLines} event line(s) did not parse`);
		if (!m.endedAt) gaps.push(`${m.run}: no end record (process still running or killed)`);
		if (m.incomplete) gaps.push(`${m.run}: trace incomplete: ${m.incomplete}`);
		if (m.recording !== "raw") gaps.push(`${m.run}: shape-mode trace, propagation uncheckable`);
		if (!m.routing) gaps.push(`${m.run}: no proxy routing, requests cannot be tied to queries`);
		const linked = linkCalls(capture, trace, runIndex);
		unattributed.push(...linked.unattributed);
		calls.push(...linked.calls);
		for (const e of trace.events.filter((e) => e.type === "snapshot")) {
			if (!e.recorded) {
				snapshots.push({ ccSession: e.ccSession, reason: e.reason, usable: false, reasons: ["shape mode: session files not copied"] });
				continue;
			}
			const control = { callId: e.callId ?? null, queryId: e.queryId ?? null, ...snapshotControl(runDir, e.snapshotId) };
			// "no-known-writer" is the bridge's belief; check it against the lifecycle
			// this run recorded: any query on the session not yet ended could still write.
			const ended = new Set(trace.events.filter((x) => x.type === "query-end" && x.seq < e.seq).map((x) => x.queryId));
			const live = trace.events.filter((x) => x.type === "query-init" && x.ccSession === e.ccSession && x.seq < e.seq && !ended.has(x.queryId));
			if (live.length) control.reasons.push(`query ${live.map((x) => x.queryId).join(", ")} on this session had not ended`);
			control.usable = control.reasons.length === 0;
			snapshots.push(control);
		}
		traceSummary.push({
			run: m.run, recording: m.recording, routing: m.routing, bridge: m.bridge, sdk: m.sdk, pi: m.pi,
			calls: linked.calls.length, unlinkedCalls: linked.calls.filter((c) => !c.request).map((c) => c.callId),
			claudeCode: [...new Set(trace.events.filter((e) => e.type === "query-init").map((e) => e.claudeCodeVersion))],
		});
	}
	transitions = traceTransitions(calls);
	// Artifacts are read while building transitions; a corrupt one is lost evidence.
	for (const trace of traces) for (const name of trace.corrupt) gaps.push(`${trace.manifest.run}: artifact ${name} does not match its digest`);
	// One request can only be unattributed if no run claimed it.
	const claimed = new Set(calls.flatMap((c) => (c.attempts ?? []).map((a) => a.n)));
	unattributed = unattributed.filter((u, i, all) => !claimed.has(u.n) && all.findIndex((x) => x.n === u.n) === i);
	// Every Messages request is accounted for: compared in a transition, linked to a
	// call that has no comparison (a session's first call, a side query), or unattributed.
	const endpoints = new Set(transitions.flatMap((t) => [t.from.request, t.to.request, t.cache.request, ...(t.to.attempts ?? []).map((a) => a.n)]));
	coverage = capture.requests.filter(isMessages).map((r) => {
		const call = calls.find((c) => (c.attempts ?? []).some((a) => a.n === r.n));
		return { n: r.n, as: endpoints.has(r.n) ? "compared" : call ? `linked-not-compared (${call.queryKind}${call.kind === "fresh" ? ", first of its session or no ancestor" : ""})` : "unattributed" };
	});
} else if (probeDir) {
	const report = JSON.parse(readFileSync(join(probeDir, "report.json"), "utf8"));
	const relations = report.results.flatMap((r) => [
		{ label: `${r.name}/control`, ancestor: report.seed.request, request: r.control?.n },
		{ label: `${r.name}/changed`, ancestor: report.seed.request, request: r.changed?.n },
	]).filter((r) => r.request);
	transitions = relationTransitions(capture, relations);
	gaps.push("no bridge trace: propagation uncheckable; ancestry from the probe's recorded seed");
} else {
	transitions = inferredTransitions(capture);
	gaps.push("no bridge trace or recorded relations: ancestry inferred from adjacency, all transitions unattributed");
	const excluded = capture.requests.filter((r) => isMessages(r) && !(r.status === 200 && (r.tools ?? 0) > 0));
	if (excluded.length) gaps.push(`${excluded.length} request(s) left out as non-200 or tool-less: ${excluded.map((r) => `#${r.n}`).join(", ")}`);
}

for (const t of transitions) {
	if (t.cache.status?.startsWith("shortfall")) t.cache.readStopsAt = readBoundary(capture, t.cache.request ?? t.to.request, t.cache.cacheRead);
}
const groups = groupFindings(transitions);
const usageIssues = [...new Set(transitions.flatMap((t) => t.cache.usageIssues ?? []))];
if (usageIssues.length) gaps.push(`inconsistent usage records: ${usageIssues.join("; ")}`);
// The API reports thinking it dropped only when asked (a beta); otherwise a drop is silent.
const withThinking = capture.requests.filter((r) => isMessages(r) && JSON.stringify(r.body?.messages ?? []).includes('"type":"thinking"'));
const unreported = withThinking.filter((r) => !String(r.betas ?? "").includes("thinking-binding-controls"));
if (unreported.length) gaps.push(`${unreported.length} request(s) carried thinking without the thinking-binding-controls beta: whether the API dropped it is not observable`);
const report = {
	schema: 1,
	capture: { dir: captureDir, schema: capture.schema, requests: capture.requests.length },
	trace: traceSummary,
	normalization: NORMALIZATION,
	gaps,
	unattributed,
	coverage,
	snapshots,
	groups,
	transitions,
};
const out = flag("out") ?? join(captureDir, "analysis.json");
writeFileSync(out, JSON.stringify(report, null, 1), { mode: 0o600 });

// --- Summary ---
const line = (t) => {
	const name = t.label ?? `${t.to.kind} ${t.to.callId ?? ""}`.trim();
	const at = t.cache.readStopsAt;
	// A read equal to a one-message first request's read is the shared tools + system prefix.
	const stop = !at ? "" : at.kind === "read" && at.messages === 1 ? " (read stops at tools + system: none of the conversation)" : ` (read stops at #${at.request}'s ${at.kind})`;
	const cache = t.cache.status.startsWith("shortfall") ? `${t.cache.status}${stop}` : t.cache.status;
	const pres = t.preservation.status === "changed" ? `changed(${t.preservation.normalized.length}) from ${t.preservation.firstChange?.label ?? "outside the cached region"}` : t.preservation.status;
	const decision = t.decision ? ` ${t.decision.path}/${t.decision.reason}` : "";
	const attempts = t.to.attempts ? `  attempts=${t.to.attempts.map((a) => `#${a.n}(${a.status}${a.terminal && a.terminal !== "complete" ? ` ${a.terminal}` : ""})`).join(",")}` : "";
	return `  #${t.from.request ?? "?"} -> #${t.to.request ?? "?"}  ${name}  source=${t.source.relation}${decision}  preservation=${pres}  propagation=${t.propagation.status}  cache=${cache}  [${t.validity}]${attempts}`;
};
console.log(`${transitions.length} transition(s) in ${captureDir}`);
for (const t of transitions) console.log(line(t));
if (groups.length) {
	console.log("\nfinding groups:");
	for (const g of groups) console.log(`  ${g.count}x ${g.signature}  (${g.transitions.map((t) => `#${t.from}->#${t.to}${t.breaksAt ? ` from ${t.breaksAt}` : ""}`).join(", ")})`);
}
if (snapshots.length) {
	console.log("\nsession snapshots (native-resume control):");
	for (const s of snapshots) console.log(`  ${s.snapshotId ?? "-"} ${s.reason} ${s.ccSession?.slice(0, 8) ?? ""}: ${s.usable ? "usable" : `refused (${s.reasons.join("; ")})`}`);
}
if (unattributed.length) console.log(`\n${unattributed.length} unattributed request(s): ${unattributed.map((u) => `#${u.n} ${u.why}`).join("; ")}`);
if (gaps.length) console.log(`\ncoverage gaps:\n${gaps.map((g) => `  - ${g}`).join("\n")}`);
console.log(`\nreport: ${out}`);
