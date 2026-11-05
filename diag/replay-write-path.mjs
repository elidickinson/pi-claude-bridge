#!/usr/bin/env node
// Replay a real pi session through the bridge's session write path
// (importHistory: convertPiMessages, repair, record writes) and report
// what the rebuild would actually hand Claude Code. Reaches for this when a
// rebuild is suspected of mangling history: it answers "did we lose a tool
// result?" and "did the transcript stay cache-stable?" without spending a turn.
//
//   node --import tsx diag/replay-write-path.mjs <pi-session.jsonl>
//   node --import tsx diag/replay-write-path.mjs ~/projects/briet-project/briet/bridge-stuck.jsonl
//
// Nothing is written to disk and no API is called; the Session is built in
// memory purely to inspect its records. Exits non-zero if it finds a defect.
//
// Input is a pi session log: one JSON object per line, either the session
// envelope pi writes (`{"type":"message","message":{...}}`) or bare pi messages
// (`{"role":...}`), as tests/fixtures/pi-history-310.jsonl stores them.
//
// Checks:
//   pairing      every tool_use has its tool_result and vice versa
//   stubs        no synthetic "[no tool result recorded]" reached the transcript
//   results      every pi toolResult survived, in order
//   determinism  converting twice yields identical record content
//   prefix       transcript(history[0..n]) is a content-prefix of the full
//                rebuild, for every n where the history is settled (no tool
//                call outstanding). Mid-turn truncation cannot be stable —
//                repairToolPairing must stand in a stub for results that have
//                not arrived — so those lengths are reported, not failed.

import { repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../src/convert.js";
import { loadPiMessages, providerMessages, settledPrefixes, transcript } from "./lib/write-path.mjs";

// A long session makes the prefix sweep quadratic; sample evenly past this.
const MAX_PREFIX_SAMPLES = 200;
const STUB = "no tool result recorded";

const path = process.argv[2];
if (!path) {
	console.error("usage: node --import tsx diag/replay-write-path.mjs <pi-session.jsonl>");
	process.exit(2);
}

function sample(values, limit) {
	if (values.length <= limit) return values;
	const step = values.length / limit;
	return Array.from({ length: limit }, (_, i) => values[Math.floor(i * step)]);
}

const blocksOf = (messages, role) => messages
	.filter((m) => m.role === role && Array.isArray(m.content))
	.flatMap((m) => m.content);

// --- Replay ---

const loaded = loadPiMessages(path);
const { skipped } = loaded;
const messages = providerMessages(loaded.messages);
const roles = {};
for (const m of messages) roles[m.role] = (roles[m.role] ?? 0) + 1;

const { anthropicMessages, sanitizedIds } = convertPiMessages(messages);
const repaired = repairToolPairing(anthropicMessages);
const records = transcript(messages);
const renamed = [...sanitizedIds.entries()].filter(([from, to]) => from !== to);

console.log(`session      ${path}`);
console.log(`pi messages  ${messages.length}${skipped ? ` (${skipped} non-message records skipped)` : ""} — ${Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(" ")}`);
console.log(`transform    ${messages.length} pi → ${anthropicMessages.length} anthropic → ${repaired.length} repaired → ${records.length} session records`);
console.log(`tool ids     ${sanitizedIds.size} seen, ${renamed.length} rewritten to satisfy Anthropic${renamed.length ? ` (e.g. ${renamed[0][0]} → ${renamed[0][1]})` : ""}`);

const defects = [];

// --- Pairing ---

const uses = blocksOf(repaired, "assistant").filter((b) => b.type === "tool_use");
const results = blocksOf(repaired, "user").filter((b) => b.type === "tool_result");
const useIds = new Set(uses.map((b) => b.id));
const resultIds = new Set(results.map((b) => b.tool_use_id));
const unanswered = uses.filter((b) => !resultIds.has(b.id)).map((b) => b.id);
const orphaned = results.filter((b) => !useIds.has(b.tool_use_id)).map((b) => b.tool_use_id);

console.log(`pairing      ${uses.length} tool_use / ${results.length} tool_result — ${unanswered.length} unanswered, ${orphaned.length} orphaned`);
if (unanswered.length) defects.push(`${unanswered.length} tool_use without a result: ${unanswered.slice(0, 5).join(", ")}`);
if (orphaned.length) defects.push(`${orphaned.length} tool_result without a call: ${orphaned.slice(0, 5).join(", ")}`);

const duplicateIds = uses.map((b) => b.id).filter((id, i, all) => all.indexOf(id) !== i);
if (duplicateIds.length) defects.push(`${duplicateIds.length} tool_use ids collide after sanitizing: ${[...new Set(duplicateIds)].slice(0, 5).join(", ")}`);

// --- Synthetic stubs ---

const stubs = results.filter((b) => String(b.content).includes(STUB));
console.log(`stubs        ${stubs.length} synthetic "[${STUB}]" placeholders`);
if (stubs.length) defects.push(`${stubs.length} results replaced by a synthetic stub: ${stubs.slice(0, 5).map((b) => b.tool_use_id).join(", ")}`);

// --- Result preservation ---

const piResults = messages.filter((m) => m.role === "toolResult");
const lost = piResults.filter((m, i) => results[i]?.tool_use_id !== sanitizedIds.get(m.toolCallId));
console.log(`results kept ${results.length - stubs.length}/${piResults.length} pi tool results reached the transcript`);
if (lost.length) defects.push(`${lost.length} pi tool results are missing or reordered, first at pi message ${messages.indexOf(lost[0])} (${lost[0].toolCallId})`);

// --- Determinism ---

const deterministic = JSON.stringify(transcript(messages)) === JSON.stringify(records);
console.log(`determinism  ${deterministic ? "identical on a second conversion" : "CONTENT DIFFERS between two conversions"}`);
if (!deterministic) defects.push("conversion is not deterministic — the same history produced two different transcripts");

// --- Prefix stability ---

const settled = settledPrefixes(messages);
const checked = sample(settled.filter((n) => n < messages.length), MAX_PREFIX_SAMPLES);
const unstable = [];
for (const n of checked) {
	const shorter = transcript(messages.slice(0, n));
	const at = shorter.findIndex((rec, i) => records[i] !== rec);
	if (at >= 0) unstable.push({ n, at, of: shorter.length });
}
console.log(`prefix       ${checked.length} settled prefixes checked (of ${settled.length} settled, ${messages.length - settled.length} mid-turn), ${unstable.length} unstable`);
for (const u of unstable.slice(0, 5)) {
	console.log(`             history[0..${u.n}] diverges at record ${u.at} of ${u.of}`);
	console.log(`               rebuilt: ${u.at < records.length ? records[u.at].slice(0, 160) : "(transcript is shorter)"}`);
	console.log(`               shorter: ${transcript(messages.slice(0, u.n))[u.at].slice(0, 160)}`);
}
if (unstable.length) defects.push(`${unstable.length} settled prefixes are not content-prefixes of the full rebuild — every rebuild re-caches from record ${unstable[0].at}`);

// --- Verdict ---

console.log("");
if (!defects.length) {
	console.log("OK — the rebuild preserves every result and stays cache-stable.");
	process.exit(0);
}
console.log(`${defects.length} defect(s):`);
for (const d of defects) console.log(`  - ${d}`);
process.exit(1);
