#!/usr/bin/env node
// Coverage scanner for attachment carry-forward (src/attachments.ts).
//
// The unit tests exercise shapes I thought of. This runs the real collector over
// every Claude Code session on disk and reports what it actually resolves, which
// is the only way to notice that the shapes in the wild are not the shapes in the
// tests. It found exactly that: the first implementation required an attachment's
// parent to be a user message, and 63 of 179 content-bearing attachments chain to
// another attachment instead — silently dropped, no test failing.
//
//   node --import tsx diag/attachment-coverage.mjs [--claude-dir DIR]
//
// It checks reconstruction, not just resolution: the session records where each
// attachment really belongs (`parentUuid`, walked up any chain of attachments), so
// the scan computes the answer from ground truth and compares. Verified to detect
// an injected off-by-one in the ordinal — which the text guard turns into
// "dropped" rather than a wrong position, the property that keeps a keying error
// from telling the model it saw a file at a turn it did not.
//
// Exits 1 when a carried attachment fails to resolve, or resolves to the wrong
// message.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const ROOT = join(flag("claude-dir", join(homedir(), ".claude")), "projects");
// Must match src/attachments.ts. Kinds outside it are reported, not failed on.
const CARRIED = new Set(["file"]);
const REPORTED = new Set(["file", "edited_text_file"]);

function* sessionFiles(dir) {
	let entries;
	try { entries = readdirSync(dir); } catch { return; }
	for (const name of entries) {
		const path = join(dir, name);
		let st;
		try { st = statSync(path); } catch { continue; }
		if (st.isDirectory()) yield* sessionFiles(path);
		else if (name.endsWith(".jsonl")) yield path;
	}
}

const matrix = new Map();
const bump = (key) => matrix.set(key, (matrix.get(key) ?? 0) + 1);
let sessions = 0, totalContentBearing = 0, resolved = 0, checked = 0, correct = 0;
const unresolved = [];
const misplaced = [];

for (const path of sessionFiles(ROOT)) {
	let raw;
	try { raw = readFileSync(path, "utf8"); } catch { continue; }
	if (!raw.includes('"attachment"')) continue;
	let records;
	try {
		records = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
	} catch {
		continue; // a session CC was mid-write on; the bridge tolerates these too
	}
	sessions++;

	const byUuid = new Map(records.filter((r) => r?.uuid).map((r) => [r.uuid, r]));
	const present = records.filter(
		(r) => r?.type === "attachment" && CARRIED.has(r.attachment?.type),
	);
	for (const r of records.filter((r) => r?.type === "attachment" && REPORTED.has(r.attachment?.type) && !CARRIED.has(r.attachment?.type))) {
		bump(`${r.attachment.type} <- ${byUuid.get(r.parentUuid)?.type ?? "missing"}  (not carried)`);
	}
	for (const r of present) {
		const parent = byUuid.get(r.parentUuid);
		bump(`${r.attachment.type} <- ${parent?.type ?? "missing"}`);
	}
	totalContentBearing += present.length;

	const carried = collectCarriedAttachments(records);
	resolved += carried.length;

	// Ground-truth check. The session knows where each attachment really belongs:
	// parentUuid, walked up any chain of attachments, lands on a message record.
	// Rebuild the message array the way a rebuild would see it, ask the placer, and
	// compare. Resolution alone only proves it found *a* slot.
	const messages = records
		.filter((r) => r?.type === "user" || r?.type === "assistant")
		.map((r) => ({ role: r.type, content: r.message?.content, uuid: r.uuid }));
	const indexOfUuid = new Map(messages.map((m, i) => [m.uuid, i]));

	const expected = [];
	for (const r of present) {
		let cur = byUuid.get(r.parentUuid);
		while (cur?.type === "attachment") cur = byUuid.get(cur.parentUuid);
		expected.push(cur ? indexOfUuid.get(cur.uuid) : undefined);
	}
	// collect and place both preserve record order, so these line up positionally.
	const placed = placeCarriedAttachments(carried, messages);
	for (const [i, want] of expected.entries()) {
		const got = placed[i]?.afterIndex;
		if (want === undefined) continue;
		checked++;
		if (got === want) correct++;
		else misplaced.push({ path, want, got: got ?? "dropped", type: present[i]?.attachment?.type });
	}
	if (carried.length < present.length) {
		const got = new Set(carried.map((c) => c.attachment.filename));
		for (const r of present) {
			if (!got.has(r.attachment.filename)) {
				unresolved.push({ path, type: r.attachment.type, parent: byUuid.get(r.parentUuid)?.type ?? "missing" });
			}
		}
	}
}

console.log(`sessions with attachments: ${sessions}`);
console.log(`carried kinds present:       ${totalContentBearing}`);
console.log(`resolved to a prompt:        ${resolved}` +
	(totalContentBearing ? `  (${((100 * resolved) / totalContentBearing).toFixed(1)}%)` : ""));

console.log(`placed at the right message: ${correct}/${checked}` +
	(checked ? `  (${((100 * correct) / checked).toFixed(1)}%)` : ""));

console.log("\nshapes in the wild (attachment <- parent record):");
for (const [key, n] of [...matrix].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(n).padStart(5)}  ${key}`);
}

if (misplaced.length) {
	console.log("\nMISPLACED — resolved, but to the wrong message:");
	for (const m of misplaced.slice(0, 5)) {
		console.log(`  ${m.type}: expected afterIndex ${m.want}, got ${m.got}`);
		console.log(`    ${m.path}`);
	}
	console.log(`\nFAIL: ${misplaced.length} attachment(s) reconstruct to the wrong position`);
	process.exit(1);
}

if (unresolved.length) {
	const byShape = new Map();
	for (const u of unresolved) {
		const k = `${u.type} <- ${u.parent}`;
		byShape.set(k, (byShape.get(k) ?? 0) + 1);
	}
	console.log("\nUNRESOLVED — these would be dropped on a rebuild:");
	for (const [k, n] of [...byShape].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
	console.log(`\nexample: ${unresolved[0].path}`);
	console.log(`\nFAIL: ${unresolved.length} content-bearing attachment(s) do not resolve to a prompt`);
	process.exit(1);
}
console.log("\nOK: every carried attachment on disk resolves, and to the message it really belongs to");
