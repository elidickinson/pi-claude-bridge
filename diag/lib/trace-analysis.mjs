// Generic request-boundary checks over a capture-proxy directory and, when
// available, a bridge cache-trace run (src/cache-trace.ts). Two contracts:
//
// - Preservation: across an append-only (or unchanged) history boundary, the
//   part of a request that its ancestor already sent must not change. Checked on
//   the normalized wire view; raw differences are kept alongside.
// - Propagation: the effective pi history the bridge was handed must reach the
//   request CC actually sent, however warm the cache is.
//
// Neither looks for a particular field or issue. Findings are grouped by
// signatures derived from where in the request a difference sits and what kind
// it is. Anything this cannot establish (no trace, no raw content, ambiguous
// link) is reported as such, never as a pass.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { compareRequestBodies } from "./request-diff.mjs";

export const NORMALIZATION = {
	version: 1,
	rules: [
		"per-request billing header system block dropped",
		"cache_control removed everywhere",
		"message-level single text block compared as string content",
	],
};

/** A Messages API call proper, not a sub-path such as /v1/messages/count_tokens. */
export const isMessages = (r) => new URL(r.path ?? "/", "http://x").pathname === "/v1/messages";
/** Records of a JSONL file. A line that does not parse (a writer killed mid-append)
 *  is counted in `bad`, never dropped silently. */
function readJsonl(file, bad) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { bad.push(file); return []; }
	});
}
const sha = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const pad = (n) => String(n).padStart(4, "0");

/** Requests from a capture-proxy directory, old (index + bodies only) or new
 *  (request-start events, routes, terminal kinds). */
export function loadCapture(dir) {
	if (!existsSync(join(dir, "index.jsonl"))) throw new Error(`${dir}: no index.jsonl, not a capture-proxy directory`);
	const unparsed = [];
	const starts = new Map(readJsonl(join(dir, "proxy-events.jsonl"), unparsed).filter((e) => e.type === "request-start").map((e) => [e.n, e]));
	const rows = readJsonl(join(dir, "index.jsonl"), unparsed);
	const ended = new Set(rows.map((row) => row.n));
	const requests = rows.map((row) => {
		const start = starts.get(row.n);
		const file = join(dir, start?.artifact ?? `req-${pad(row.n)}.json`);
		let body = null;
		let bodyMissing = null;
		if (!existsSync(file)) bodyMissing = start?.artifactRejected ?? "absent";
		else try { body = JSON.parse(readFileSync(file, "utf8")); } catch { bodyMissing = "unparseable"; }
		return { ...row, route: row.route ?? null, retryCount: row.retryCount ?? start?.retryCount ?? null, body, bodyMissing };
	});
	// A start with no end: the proxy died or is still running. Visible, never dropped.
	const unterminated = [...starts.values()].filter((s) => !ended.has(s.n)).map((s) => ({ n: s.n, route: s.route, path: s.path }));
	return { dir, schema: starts.size ? "streaming" : "legacy", requests: requests.sort((a, b) => a.n - b.n), unterminated, unparsedLines: unparsed.length };
}

/** A bridge cache-trace run directory. */
export function loadTrace(runDir) {
	const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
	const unparsed = [];
	const events = readJsonl(join(runDir, "events.jsonl"), unparsed);
	/** Artifacts that exist but do not match their digest name: evidence lost, not replaced. */
	const corrupt = new Set();
	const artifact = (name) => {
		const file = join(runDir, "artifacts", name);
		if (!existsSync(file)) return null;
		const text = readFileSync(file, "utf8");
		if (`${sha(text)}.json` !== name) { corrupt.add(name); return null; }
		return JSON.parse(text);
	};
	return { runDir, manifest, events, artifact, corrupt, unparsedLines: unparsed.length };
}

/** Can a recorded snapshot stand in for the native session in a counterfactual
 *  resume? Re-verified here rather than trusting the recorder's `complete`:
 *  every listed file must be present, contained and unaltered, nothing refused or
 *  missing, and no writer possibly still appending when it was taken. */
export function snapshotControl(runDir, snapshotId) {
	const dir = join(runDir, "snapshots", snapshotId);
	if (!existsSync(join(dir, "manifest.json"))) return { snapshotId, usable: false, reasons: ["no snapshot manifest"] };
	const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	const reasons = [];
	if (!m.jsonlPresent) reasons.push("session file was absent");
	for (const r of m.rejected) reasons.push(`refused ${r.path}: ${r.reason}`);
	for (const p of m.missingReferences) reasons.push(`referenced file not in snapshot: ${p}`);
	for (const p of m.externalReferences ?? []) reasons.push(`references data outside the session: ${p}`);
	if (m.changedDuringCopy) reasons.push("changed while being copied");
	if (m.writer !== "no-known-writer") reasons.push(`writer not settled: ${m.writer}`);
	const root = existsSync(join(dir, "files")) ? realpathSync(join(dir, "files")) : null;
	for (const f of m.files) {
		const file = join(dir, "files", f.path);
		if (f.path.startsWith("/") || f.path.split("/").includes("..")) reasons.push(`unsafe path ${f.path}`);
		else if (!existsSync(file) || lstatSync(file).isSymbolicLink()) reasons.push(`missing ${f.path}`);
		// Real path, not just the name: a swapped-in directory symlink would escape.
		else if (!root || !realpathSync(file).startsWith(root + sep)) reasons.push(`escapes the snapshot ${f.path}`);
		else if (createHash("sha256").update(readFileSync(file)).digest("hex") !== f.sha256) reasons.push(`altered ${f.path}`);
	}
	return { snapshotId, reason: m.reason, writer: m.writer, ccSession: m.ccSession, usable: reasons.length === 0, reasons };
}

/** A bare trace root holds one directory per process run. */
export function traceRuns(root) {
	if (!existsSync(root)) throw new Error(`${root}: no such trace directory`);
	if (existsSync(join(root, "manifest.json"))) return [root];
	return readdirSync(root).filter((d) => d.startsWith("run-")).sort().map((d) => join(root, d));
}

// --- Comparable content: pi history vs wire request ---

const textOf = (content) => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
const stable = (value) => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
/** The API's tool id grammar; the bridge maps pi ids into it when it writes history. */
const apiToolId = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
const imageDigests = (content) => Array.isArray(content) ? content.filter((b) => b?.type === "image").map((b) => sha(b.data ?? b.source?.data ?? "")) : [];

const PI_KNOWN = new Set(["text", "image", "thinking", "toolCall"]);
const WIRE_KNOWN = new Set(["text", "image", "thinking", "redacted_thinking", "tool_use", "tool_result"]);

/** pi messages as comparable items. `servedNames` is the recorded pi -> served tool
 *  name map; a name it lacks is reported as unrecorded, never guessed. */
export function piItems(messages, servedNames = {}) {
	const items = [];
	const coverage = { thinking: 0, emptyText: 0, unsupported: [] };
	const served = (name) => servedNames[name] ?? servedNames[String(name).toLowerCase()];
	// A user message pi appends right after tool results is a steer pi drained at
	// that boundary; Claude Code may deliver it inside those very results.
	const drainedWith = (index) => {
		const ids = [];
		for (let i = index - 1; i >= 0 && messages[i].role === "toolResult"; i--) ids.push(apiToolId(messages[i].toolCallId));
		return ids;
	};
	messages.forEach((m, index) => {
		if (m.role === "user" || m.role === "assistant") {
			const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
			const steerOf = m.role === "user" ? drainedWith(index) : [];
			for (const b of blocks) {
				if (!b || typeof b !== "object") coverage.unsupported.push(`${m.role}/non-object-block`);
				else if (b.type === "text" && b.text) items.push({ kind: "text", role: m.role, text: b.text, at: index, ...(steerOf.length ? { drainedWith: steerOf } : {}) });
				else if (b.type === "text") coverage.emptyText++;
				else if (b.type === "image" && b.data) items.push({ kind: "image", role: m.role, digest: sha(b.data), at: index });
				else if (b.type === "image") coverage.unsupported.push(`${m.role}/image-without-data`);
				else if (b.type === "toolCall") {
					const name = served(b.name);
					if (!name) coverage.unsupported.push(`tool-name-unrecorded/${b.name}`);
					items.push({ kind: "tool_use", id: apiToolId(b.id), name, input: stable(b.arguments ?? {}), at: index });
				}
				else if (b.type === "thinking") coverage.thinking++;
				else if (!PI_KNOWN.has(b.type)) coverage.unsupported.push(`${m.role}/${b.type}`);
			}
		} else if (m.role === "toolResult") {
			items.push({ kind: "tool_result", id: apiToolId(m.toolCallId), text: textOf(m.content), isError: Boolean(m.isError), images: imageDigests(m.content).join(","), at: index });
		} else if (m.role !== "system") {
			coverage.unsupported.push(`role/${m.role}`);
		}
	});
	return { items, coverage };
}

/** A request body's messages as comparable items. */
export function wireItems(body) {
	const items = [];
	const coverage = { thinking: 0, unknown: [] };
	(body.messages ?? []).forEach((m, index) => {
		const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
		blocks.forEach((b, block) => {
			const at = `messages[${index}].content[${block}]`;
			if (!b || typeof b !== "object") return void coverage.unknown.push(`${m.role}/non-object-block`);
			if (b.type === "text") items.push({ kind: "text", role: m.role, text: b.text ?? "", at });
			else if (b.type === "image" && b.source?.data) items.push({ kind: "image", role: m.role, digest: sha(b.source.data), at });
			else if (b.type === "image") coverage.unknown.push(`${m.role}/image-${b.source?.type ?? "without-source"}`);
			else if (b.type === "tool_use") items.push({ kind: "tool_use", id: b.id, name: b.name, input: stable(b.input ?? {}), at });
			else if (b.type === "tool_result") {
				const texts = typeof b.content === "string" ? [b.content] : (b.content ?? []).filter((c) => c?.type === "text").map((c) => c.text);
				items.push({ kind: "tool_result", id: b.tool_use_id, text: textOf(b.content), texts, isError: Boolean(b.is_error), images: imageDigests(b.content).join(","), at });
			}
			else if (b.type === "thinking" || b.type === "redacted_thinking") coverage.thinking++;
			if (!WIRE_KNOWN.has(b.type)) coverage.unknown.push(`${m.role}/${b.type}`);
		});
	});
	return { items, coverage };
}

/** Does `outer` hold `inner` plus nothing but Claude Code's reminder blocks and
 *  whitespace? Anything else around it -- older text, a redacted tail -- is a
 *  different content, not the same content delivered with additions. */
function containsWithOnlyReminders(outer, inner) {
	const at = outer.indexOf(inner);
	if (at === -1) return false;
	const rest = outer.slice(0, at) + outer.slice(at + inner.length);
	return rest.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() === "";
}

const wireMessage = (w) => Number(w.at.match(/^messages\[(\d+)\]/)[1]);

/** Did a steer pi drained alongside some tool results reach the request where
 *  Claude Code delivers those: inside one of the results, or in a system message
 *  after them and before the next assistant turn. */
function drainedSteerDelivered(items, steer) {
	const results = items.filter((w) => w.kind === "tool_result" && steer.drainedWith.includes(w.id));
	if (results.some((w) => w.text.includes(steer.text))) return true;
	if (!results.length) return false;
	const from = Math.max(...results.map(wireMessage));
	const nextAssistant = Math.min(...items.filter((w) => w.role === "assistant" && wireMessage(w) > from).map(wireMessage));
	return items.some((w) => w.role === "system" && w.kind === "text" && wireMessage(w) > from && wireMessage(w) < nextAssistant && w.text.includes(steer.text));
}

/** Does every pi-origin item reach the request, in order? Tool items align by id;
 *  text aligns in order. A text that arrives inside a larger CC block whose only
 *  additions are reminder blocks is a weaker `contained` match, reported apart
 *  from exact ones. Ids that occur twice cannot be paired and are ambiguous.
 *  Unmatched CC items are CC-owned or unknown additions. */
export function checkPropagation(messages, body, servedNames) {
	const pi = piItems(messages, servedNames);
	const wire = wireItems(body);
	const used = new Set();
	const missing = [];
	const changed = [];
	const duplicated = (list) => new Set(list.filter((x) => x.id).map((x) => `${x.kind}:${x.id}`).filter((k, i, all) => all.indexOf(k) !== i));
	const ambiguousKeys = new Set([...duplicated(pi.items), ...duplicated(wire.items)]);
	const ambiguous = [];
	let exact = 0;
	let contained = 0;
	let steerContained = 0;
	let cursor = 0;
	for (const item of pi.items) {
		if (item.kind === "tool_use" || item.kind === "tool_result") {
			if (ambiguousKeys.has(`${item.kind}:${item.id}`)) { ambiguous.push({ kind: item.kind, id: item.id, piMessage: item.at }); continue; }
			const at = wire.items.findIndex((w, i) => !used.has(i) && w.kind === item.kind && w.id === item.id);
			if (at === -1) { missing.push(item); continue; }
			used.add(at);
			const w = wire.items[at];
			const textMatch = item.kind !== "tool_result" ? "exact"
				: w.text === item.text || w.texts.includes(item.text) ? "exact"
				: w.texts.some((t) => containsWithOnlyReminders(t, item.text)) || containsWithOnlyReminders(w.text, item.text) ? "contained" : "differs";
			// An unrecorded served name is not compared (reported under unsupported instead).
			const fields = (item.kind === "tool_use" ? ["name", "input"] : ["isError", "images"]).filter((f) => !(f === "name" && item.name === undefined) && w[f] !== item[f]);
			if (textMatch === "differs") fields.unshift("text");
			if (fields.length) changed.push({ kind: item.kind, id: item.id, fields, piMessage: item.at, wire: w.at });
			else if (textMatch === "contained") contained++;
			else exact++;
			if (at < cursor) changed.push({ kind: item.kind, id: item.id, fields: ["order"], piMessage: item.at, wire: w.at });
			cursor = Math.max(cursor, at + 1);
			continue;
		}
		const same = (w) => w.kind === item.kind && w.role === item.role;
		let at = wire.items.findIndex((w, i) => i >= cursor && !used.has(i) && same(w) && (item.kind === "image" ? w.digest === item.digest : w.text === item.text));
		let weak = false;
		if (at === -1 && item.kind === "text") {
			at = wire.items.findIndex((w, i) => i >= cursor && !used.has(i) && same(w) && containsWithOnlyReminders(w.text, item.text));
			weak = at !== -1;
		}
		// A steer CC drained at a tool boundary rides inside one of the tool results it
		// was drained with, or (Haiku 5.5's system turns) in a system message right
		// after them -- only there, which precedes its pi position.
		if (at === -1 && item.drainedWith && drainedSteerDelivered(wire.items, item)) {
			steerContained++;
			continue;
		}
		if (at === -1) { missing.push(item); continue; }
		used.add(at);
		weak ? contained++ : exact++;
		cursor = at + 1;
	}
	const unsupported = [...pi.coverage.unsupported, ...wire.coverage.unknown];
	return {
		status: missing.length || changed.length ? "stale-or-missing" : ambiguous.length ? "ambiguous-ids" : unsupported.length ? "unsupported-content"
			: pi.items.length === 0 ? "nothing-compared" : contained || steerContained ? "checked-contained" : "checked",
		compared: pi.items.length,
		ambiguous,
		exact,
		contained,
		steerContained,
		missing: missing.map(({ kind, role, id, at, text }) => ({ kind, role, id, piMessage: at, ...(text ? { preview: text.slice(0, 80), length: text.length } : {}) })),
		changed,
		unsupported,
		notCompared: { thinking: { pi: pi.coverage.thinking, wire: wire.coverage.thinking }, emptyText: pi.coverage.emptyText, ccAdditions: wire.items.filter((_, i) => !used.has(i)).length },
	};
}

// --- Preservation and grouping ---

function walk(body, path) {
	const tokens = [...path.matchAll(/([A-Za-z_]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]));
	const labels = [];
	let node = body;
	let rest = [];
	for (const token of tokens) {
		node = node?.[token];
		if (node && typeof node === "object" && !Array.isArray(node) && (node.type || node.role)) {
			labels.push(node.type ?? node.role);
			rest = [];
		} else if (typeof token === "string") rest.push(token);
	}
	return { labels, rest };
}

/** Where a difference sits and what kind it is, with indices and values removed:
 *  e.g. `user>tool_result.content type-or-shape array->string`. */
export function diffSignature(diff, before, after) {
	if (diff.kind === "missing-element" || diff.kind === "added-element" || diff.kind === "reordered") {
		return `${diff.kind} ${String(diff.label).replace(/\[\d+\]/g, "").replace(/\b(\w+)(\+\1)+\b/g, "$1*")}`;
	}
	const path = diff.path ?? diff.afterPath;
	const { labels, rest } = walk(diff.path ? before : after, path);
	const where = [path.split(/[.[]/)[0], ...labels].join(">") + (rest.length ? `.${rest[0]}` : "");
	const detail = diff.kind === "type-or-shape" ? ` ${diff.before?.type}->${diff.after?.type}` : "";
	return `${where} ${diff.kind}${detail}`;
}

/** Position [message, block] of the last cache_control marker in the messages,
 *  or null. Only content up to it can have been read from cache. */
function lastBreakpoint(body) {
	let last = null;
	(body.messages ?? []).forEach((m, i) => {
		if (m.cache_control) last = [i, Infinity];
		if (Array.isArray(m.content)) m.content.forEach((b, j) => { if (b?.cache_control) last = [i, j]; });
	});
	return last;
}

/** Is a difference at `path` inside what the ancestor marked for caching? Tools and
 *  system precede every message marker; a change to a whole message's content
 *  counts as inside when that message holds the marker. */
function insideBreakpoint(path, breakpoint) {
	const m = path.match(/^messages\[(\d+)\](?:\.content\[(\d+)\])?/);
	if (!m) return true;
	if (!breakpoint) return false;
	const [i, j] = [Number(m[1]), m[2] === undefined ? -1 : Number(m[2])];
	return i < breakpoint[0] || (i === breakpoint[0] && j <= breakpoint[1]);
}

/** Top-level request fields outside the prompt (model, thinking, metadata, ...)
 *  that differ. None is assumed cache-neutral, with one exception: a `diagnostics`
 *  change in `previous_message_id` alone, which Claude Code sends first-party and
 *  changes on every request (measured: REUSE still reads its full prefix). */
export function configChanges(before, after) {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !["messages", "system", "tools"].includes(k));
	const sansMessageId = (d) => (d && typeof d === "object" ? stable({ ...d, previous_message_id: undefined }) : stable(d));
	return keys
		.filter((k) => (k === "diagnostics" ? sansMessageId(before[k]) !== sansMessageId(after[k]) : stable(before[k]) !== stable(after[k])))
		.map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
}

/** Where the cached prefix stops matching: the first difference inside what the
 *  ancestor marked for caching. Everything after it misses, so "message 0 of 40"
 *  loses a whole conversation where "message 39 of 40" loses one turn. */
export function firstChange(diffs, messageCount) {
	const first = diffs.find((d) => d.beforeAncestorBreakpoint !== false);
	if (!first) return null;
	const path = first.path ?? first.afterPath ?? "";
	if (path.startsWith("tools")) return { where: "tools", label: "tools (whole prompt)" };
	if (path.startsWith("system")) return { where: "system", label: "system prompt (whole conversation)" };
	const message = Number(path.match(/^messages\[(\d+)\]/)?.[1]);
	return { where: "message", message, of: messageCount, label: message === 0 ? `message 0 of ${messageCount} (whole conversation)` : `message ${message} of ${messageCount}` };
}

const messageIndex = (path) => { const m = path?.match(/^messages\[(\d+)\]/); return m ? Number(m[1]) : null; };
/** Comparable form of a message: no cache_control, a lone text block as a string
 *  (the same rules as the normalized view). */
const comparable = (message) => {
	const plain = JSON.parse(JSON.stringify(message, (k, v) => (k === "cache_control" ? undefined : v)));
	const c = plain.content;
	if (Array.isArray(c) && c.length === 1 && c[0]?.type === "text" && Object.keys(c[0]).length === 2) plain.content = c[0].text;
	return stable(plain);
};
const toolIds = (message) => (Array.isArray(message?.content) ? message.content : []).map((b) => b?.id ?? b?.tool_use_id).filter(Boolean).sort().join(",");

/** A metadata change that is only Claude Code's session id (a rotated session).
 *  Measured cache-neutral: probe-cache-mutations' rotate-session-id case resumes
 *  identical records under a new id and reads back the full prefix. */
function sessionIdOnly(change) {
	if (change.key !== "metadata") return false;
	const user = (m) => { try { const { session_id: _, ...rest } = JSON.parse(m?.user_id ?? "{}"); return stable({ ...m, user_id: rest }); } catch { return null; } };
	const a = user(change.before);
	return a !== null && a === user(change.after);
}

/** Differences in the part of `after` its ancestor `before` already sent.
 *
 *  The underlying diff compares only up to the last element the two still share,
 *  so after an early break (every rebuild) two corrections apply: an ancestor
 *  message reported missing that is in fact present further on is re-labelled
 *  (`realigned`), and a cached region that reaches past the compared window makes
 *  the result `partial` rather than `preserved`. */
export function checkPreservation(before, after) {
	const { raw, normalized } = compareRequestBodies(before, after, { prefixOnly: true });
	const breakpoint = lastBreakpoint(before);
	// After-request message index -> ancestor message index, for matched messages.
	const afterToBefore = new Map(normalized.alignments.map((a) => [messageIndex(a.afterPath), messageIndex(a.path)]).filter(([k, i]) => k !== null && i !== null));
	// Where a difference sits in the ancestor's coordinates. An added element has no
	// ancestor path: it sits after the closest matched message that precedes it.
	const inside = (diff) => {
		if (diff.path) return insideBreakpoint(diff.path, breakpoint);
		const k = messageIndex(diff.afterPath);
		if (k === null) return true; // tools / system precede every message
		if (afterToBefore.has(k)) return insideBreakpoint(diff.afterPath.replace(/^messages\[\d+\]/, `messages[${afterToBefore.get(k)}]`), breakpoint);
		const prior = [...afterToBefore].filter(([a]) => a < k).sort((x, y) => y[0] - x[0])[0];
		return breakpoint ? (prior ? prior[1] : -1) + 1 <= breakpoint[0] : false;
	};
	const realigned = [];
	const changes = [];
	for (const diff of normalized.aligned) {
		const i = diff.kind === "missing-element" ? messageIndex(diff.path) : null;
		const gone = i === null ? null : before.messages[i];
		const k = gone ? after.messages.findIndex((m, j) => !afterToBefore.has(j) && m.role === gone.role && (toolIds(gone) ? toolIds(m) === toolIds(gone) : textOf(m.content) === textOf(gone.content))) : -1;
		if (k !== -1) {
			const same = comparable(after.messages[k]) === comparable(gone);
			realigned.push({ path: diff.path, afterPath: `messages[${k}]`, unchanged: same });
			if (same) continue;
			changes.push({ ...diff, kind: "realigned-changed", afterPath: `messages[${k}]`, signature: `realigned-changed ${String(diff.label).replace(/\[\d+\]/g, "")}`, beforeAncestorBreakpoint: inside(diff) });
			continue;
		}
		changes.push({ ...diff, signature: diffSignature(diff, before, after), beforeAncestorBreakpoint: inside(diff) });
	}
	// How far the comparison reached in the ancestor, against how far it cached.
	const comparedThrough = Math.max(-1, ...[...afterToBefore.values()], ...changes.map((d) => messageIndex(d.path) ?? -1), ...realigned.map((r) => messageIndex(r.path)));
	const cachedThrough = breakpoint ? breakpoint[0] : -1;
	const partial = cachedThrough > comparedThrough;
	return {
		status: changes.length ? "changed" : partial ? "partial" : "preserved",
		firstChange: firstChange(changes, before.messages?.length ?? 0),
		window: { comparedThrough, cachedThrough, partial },
		normalized: changes,
		realigned,
		raw: raw.aligned.map((diff) => ({ path: diff.path ?? diff.afterPath, kind: diff.kind, signature: diffSignature(diff, before, after) })),
	};
}

/** Inconsistencies in a request's recorded usage: a write total that does not
 *  match its 5m/1h split, or final usage disagreeing with message_start. */
function usageIssues(row) {
	const start = row.usageRaw?.start;
	if (!start) return [];
	const issues = [];
	const split = start.cache_creation;
	if (split && (split.ephemeral_5m_input_tokens ?? 0) + (split.ephemeral_1h_input_tokens ?? 0) !== (start.cache_creation_input_tokens ?? 0)) issues.push(`#${row.n} cache write total differs from its 5m/1h split`);
	for (const key of ["cache_read_input_tokens", "cache_creation_input_tokens"]) {
		const final = row.usageRaw.final?.[key];
		if (final !== undefined && final !== start[key]) issues.push(`#${row.n} final ${key} ${final} differs from message_start ${start[key]}`);
	}
	return issues;
}

/** Shortest TTL the ancestor asked for: past it, an entry may simply have expired. */
function requestedTtlSeconds(body) {
	const ttls = JSON.stringify(body ?? {}).match(/"cache_control":\{[^}]*\}/g)?.map((c) => (c.includes('"ttl":"1h"') ? 3600 : 300)) ?? [];
	return ttls.length ? Math.min(...ttls) : null;
}

/** What the cache did, relative to what the ancestor is known to have cached. */
export function cacheObservation(ancestor, request) {
	const a = ancestor.usage;
	const b = request.usage;
	if (!a || !b) return { status: "usage-unavailable" };
	const cached = a.cacheRead + a.cacheWrite;
	// Nothing cached (below the minimum cacheable length, or not marked): no
	// read can fall short of it, so "covered" would mean nothing.
	if (cached === 0) return { status: "ancestor-cached-nothing", cacheRead: b.cacheRead, cacheWrite: b.cacheWrite };
	const ttlSeconds = requestedTtlSeconds(ancestor.body);
	const ageSeconds = ancestor.at && request.startedAt ? (Date.parse(request.startedAt) - Date.parse(ancestor.at)) / 1000 : null;
	const shortfall = Math.max(0, cached - b.cacheRead);
	return {
		// A shortfall after the requested TTL may be expiry, not a changed prefix.
		status: !shortfall ? "covered" : ttlSeconds !== null && ageSeconds !== null && ageSeconds > ttlSeconds ? "shortfall-past-ttl" : "shortfall",
		ageSeconds,
		ttlSeconds,
		usageIssues: [...usageIssues(ancestor), ...usageIssues(request)],
		ancestorCached: cached,
		cacheRead: b.cacheRead,
		cacheWrite: b.cacheWrite,
		shortfall,
		// Share of the ancestor's cached prefix read back. Includes tools + system, so
		// it understates a loss of the conversation itself; see firstChange for where.
		readFraction: Math.round((Math.min(b.cacheRead, cached) / cached) * 100) / 100,
		// Read beyond the ancestor's prefix: supplied by some other write, source unknown.
		readBeyondAncestor: Math.max(0, b.cacheRead - cached),
	};
}

// --- Linking requests to provider calls ---

/** History relation between two calls' effective inputs, by source digest. */
export function historyRelation(before, after) {
	const a = before.map((m) => m.digest);
	const b = after.map((m) => m.digest);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	if (i === a.length) return { relation: a.length === b.length ? "same" : "append", firstChanged: null };
	return { relation: b.length < a.length && i === b.length ? "shrink" : "edit", firstChanged: i };
}

const effectiveMessages = (input) => input.effective === "source" ? input.source.messages : input.effective.messages;
const effectiveArtifact = (input) => input.effective === "source" ? input.source.artifact : input.effective.artifact;
/** Does `body` carry tool_result blocks for every id? Parsed blocks, not text: a
 *  tool output that quotes another request's JSON must not count. */
const hasToolResults = (body, ids) => {
	if (!body || !ids?.length) return false;
	const present = new Set(wireItems(body).items.filter((w) => w.kind === "tool_result").map((w) => w.id));
	return ids.every((id) => present.has(apiToolId(id)));
};

/** What a fresh query's first request must carry: the prompt it was opened with
 *  (the trailing user text) or, when the history ends at a tool result, that
 *  result. Null without recorded content (shape mode) -- the link is then unverified. */
function freshAnchor(call) {
	const name = call.input && effectiveArtifact(call.input);
	const messages = name ? call.trace.artifact(name)?.messages : null;
	const last = messages?.at(-1);
	if (!last) return null;
	if (last.role === "toolResult") return (body) => hasToolResults(body, [last.toolCallId]);
	const text = (typeof last.content === "string" ? [last.content] : (last.content ?? []).filter((b) => b?.type === "text").map((b) => b.text)).find(Boolean);
	if (last.role !== "user" || !text) return null;
	return (body) => wireItems(body).items.some((w) => w.kind === "text" && w.role === "user" && (w.text === text || containsWithOnlyReminders(w.text, text)));
}

/** Link each traced provider call to the API request that carried it, using the
 *  query route and content anchors; never timestamps. */
export function linkCalls(capture, trace, runIndex = 0) {
	const events = trace.events;
	const inputs = new Map(events.filter((e) => e.type === "input").map((e) => [e.callId, e]));
	const ccSessions = new Map(events.filter((e) => e.type === "query-init").map((e) => [e.queryId, e.ccSession]));
	const decisions = new Map(events.filter((e) => e.type === "decision").map((e) => [e.callId, e]));
	const starts = events.filter((e) => e.type === "query-start");
	const byRoute = new Map();
	for (const r of capture.requests) if (r.route) byRoute.set(r.route, [...(byRoute.get(r.route) ?? []), r]);
	const calls = [];
	for (const start of starts) {
		const requests = (byRoute.get(start.queryId) ?? []).filter(isMessages);
		const continuations = events.filter((e) => e.type === "route" && e.route === "tool-result" && e.queryId === start.queryId);
		const own = [{ callId: start.callId, kind: "fresh" }, ...continuations.map((e) => ({ callId: e.callId, kind: "tool-result", results: e.results }))];
		let after = -1;
		for (const call of own) {
			const input = inputs.get(call.callId);
			// Fresh: the first request carrying the query's own prompt (or, without
			// recorded content, the route's first request, marked unverified).
			// Continuation: the first later request carrying every delivered tool result.
			const anchor = call.kind === "fresh" ? freshAnchor({ input, trace }) : null;
			const at = call.kind !== "fresh" ? requests.findIndex((r, i) => i > after && hasToolResults(r.body, call.results))
				: anchor ? requests.findIndex((r) => r.body && anchor(r.body)) : requests.length ? 0 : -1;
			if (at !== -1) after = at;
			const link = at === -1 ? "unlinked" : call.kind !== "fresh" ? "tool-result-anchor" : anchor ? "prompt-anchor" : "first-in-route-unverified";
			calls.push({
				...call,
				queryId: start.queryId,
				queryKind: start.kind,
				piSessionId: input?.piSessionId ?? start.piSessionId ?? null,
				servedToolNames: start.servedToolNames ?? {},
				input,
				decision: call.kind === "fresh" ? decisions.get(call.callId) ?? null : null,
				request: at === -1 ? null : requests[at],
				link,
				ccSession: ccSessions.get(start.queryId) ?? null,
				trace,
				runIndex,
				seq: input?.seq ?? start.seq,
			});
		}
	}
	// Retries: a later request on the same route with the same body (apart from the
	// per-request billing header) is another attempt of that call. The conversation
	// went on from the last attempt; the cache is measured on the first attempt
	// that reached the model, since a retry can read what that attempt just wrote.
	const attemptKey = (body) => stable({ ...body, system: (Array.isArray(body.system) ? body.system : []).filter((b) => !String(b?.text ?? "").startsWith("x-anthropic-billing-header")) });
	for (const call of calls) {
		if (!call.request) continue;
		if (!call.request.body) {
			call.attempts = [{ n: call.request.n, status: call.request.status, terminal: call.request.terminal ?? null }];
			continue;
		}
		const key = attemptKey(call.request.body);
		const taken = new Set(calls.map((c) => c.request?.n));
		const retries = (byRoute.get(call.queryId) ?? []).filter((r) => r.n > call.request.n && !taken.has(r.n) && r.body && attemptKey(r.body) === key);
		const all = [call.request, ...retries];
		call.attempts = all.map((r) => ({ n: r.n, status: r.status, terminal: r.terminal ?? null }));
		call.cacheRequest = all.find((r) => r.usage) ?? null;
		if (retries.length) call.request = retries.at(-1);
	}
	const linked = new Set(calls.flatMap((c) => (c.attempts ?? []).map((a) => a.n)));
	const unattributed = capture.requests.filter((r) => isMessages(r) && !linked.has(r.n))
		.map((r) => ({ n: r.n, route: r.route, why: !r.route ? "unrouted" : starts.some((s) => s.queryId === r.route) ? "in-query-not-linked (retry, side request, or CC-internal)" : "route-without-query-start" }));
	return { calls: calls.sort((a, b) => a.seq - b.seq), unattributed };
}

/** Transitions between linked provider calls of the same pi session, across all
 *  traced processes (a restart is a new run). The ancestor is the latest earlier
 *  call whose history is a prefix of this one's; "earlier" is run order, then
 *  record order within a run. */
export function traceTransitions(calls) {
	calls = [...calls].sort((a, b) => a.runIndex - b.runIndex || a.seq - b.seq);
	const out = [];
	const provider = calls.filter((c) => c.queryKind === "provider" && c.input);
	provider.forEach((call, index) => {
		// No pi session id: nothing ties this call to any other, however alike the history.
		if (call.piSessionId === null) return;
		const earlier = provider.slice(0, index).filter((c) => c.piSessionId === call.piSessionId);
		if (!earlier.length) return;
		const mine = effectiveMessages(call.input);
		const related = earlier.map((c) => ({ c, ...historyRelation(effectiveMessages(c.input), mine) }));
		const prefixes = related.filter((r) => r.relation === "append" || r.relation === "same");
		// Cached amounts only compare within one model: another model's cache is another namespace.
		const sameModel = prefixes.filter((r) => r.c.input?.model === call.input?.model);
		const { c: ancestor, relation, firstChanged } = prefixes.at(-1) ?? related.at(-1);
		// A request that never reached the model (an injected rejection) cached nothing:
		// measure against the closest one on the same history that did.
		const cacheFrom = [...sameModel].reverse().find((r) => r.c.request?.usage)?.c
			?? { request: null, otherModel: prefixes.length > 0 && sameModel.length === 0 };
		out.push(transition(ancestor, call, { relation, firstChanged, ancestry: ancestor.runIndex === call.runIndex ? "trace" : "trace-across-restart", cacheFrom }, call.trace));
	});
	return out;
}

function transition(ancestor, call, { relation, firstChanged, ancestry, cacheFrom = ancestor }, trace) {
	const A = ancestor.request;
	const B = call.request;
	const config = A?.body && B?.body ? [
		...configChanges(A.body, B.body).filter((c) => !sessionIdOnly(c)),
		// Billing path and beta set, as the proxy recorded them: also part of what a request is.
		// Unrecorded is unknown, not different.
		...["auth", "betas"].filter((k) => A[k] != null && B[k] != null && A[k] !== B[k]).map((key) => ({ key: `header:${key}`, before: A[key] ?? null, after: B[key] ?? null })),
	] : [];
	const unverified = [ancestor.link, call.link].includes("first-in-route-unverified");
	const validity = !A || !B ? "unattributed-request" : !A.body || !B.body ? "missing-artifacts" : unverified ? "unverified-link" : config.length ? "confounded-config" : "valid";
	const preservation = !A?.body || !B?.body ? { status: "not-checked", why: validity }
		: relation === "append" || relation === "same" || relation === "native-only"
			? checkPreservation(A.body, B.body)
			: { status: "not-checked", why: `source ${relation} at pi message ${firstChanged}; only append-only boundaries are judged` };
	const artifactName = call.input ? effectiveArtifact(call.input) : null;
	const effective = artifactName && trace ? trace.artifact(artifactName) : null;
	const propagation = !B?.body ? { status: "incomplete", why: "no request body" }
		: !call.input ? { status: "incomplete", why: "no recorded provider input" }
		: !effective ? { status: "incomplete", why: call.input.source.artifactRejected ?? "shape-mode trace: content not recorded" }
		: checkPropagation(effective.messages, B.body, call.servedToolNames);
	const decision = call.decision;
	// Avoidable only as a candidate: a native session for the same history appears
	// to exist, which says nothing yet about whether it was complete or safe to resume.
	// A decision that recorded "no session" means none; only an unrecorded one falls back.
	const nativeAvailable = decision && "ccSessionBefore" in decision ? decision.ccSessionBefore : ancestor.ccSession ?? null;
	const reconstruction = !decision ? "n/a" : decision.path !== "rebuild" ? decision.path
		: relation === "append" && nativeAvailable ? "candidate-avoidable" : relation === "edit" || relation === "shrink" ? "expected" : "unknown";
	return {
		from: { callId: ancestor.callId, request: A?.n ?? null },
		to: { callId: call.callId, request: B?.n ?? null, kind: call.kind, link: call.link, ...(call.attempts?.length > 1 ? { attempts: call.attempts } : {}) },
		piSessionId: call.piSessionId,
		ancestry,
		source: { relation, firstChanged },
		decision: decision ? { path: decision.path, reason: decision.reason, rotation: decision.rotation ?? null } : null,
		reconstruction,
		preservation,
		propagation,
		configChanges: config.map(({ key }) => key),
		// The API's own report of input it altered (e.g. thinking_dropped), as observed.
		apiTransformations: B?.inputTransformations ?? null,
		cache: cacheFrom.request && B ? { ...cacheObservation(cacheFrom.request, call.cacheRequest ?? B), ancestorRequest: cacheFrom.request.n, request: (call.cacheRequest ?? B).n }
			: { status: cacheFrom.otherModel ? "unknown-scope-other-model" : "usage-unavailable" },
		validity,
	};
}

/** Explicit ancestor/request pairs recorded by a probe (e.g. probe-cache-mutations'
 *  seed -> control/changed arms), where the source history is unchanged by design. */
export function relationTransitions(capture, relations) {
	const byN = new Map(capture.requests.map((r) => [r.n, r]));
	return relations.map(({ label, ancestor, request }) => {
		const a = byN.get(ancestor);
		const b = byN.get(request);
		const t = transition({ callId: null, request: a ?? null }, { callId: null, request: b ?? null, kind: label, link: "probe-recorded" },
			{ relation: "native-only", firstChanged: null, ancestry: "probe-recorded" }, null);
		// The recording is trusted only as far as the capture agrees: an ancestor cannot
		// be longer than its descendant or come from another model.
		const consistent = a && b && a.n < b.n && (a.messages ?? 0) <= (b.messages ?? 0) && a.model === b.model;
		return { ...t, label, ...(t.validity === "valid" && !consistent ? { validity: "confounded-relation" } : {}) };
	});
}

/** Adjacent main-loop requests of an untraced capture. Ancestry is a guess, so
 *  these are unattributed: useful for grouping, excluded from causal claims. */
export function inferredTransitions(capture) {
	const main = capture.requests.filter((r) => isMessages(r) && r.status === 200 && (r.tools ?? 0) > 0);
	return main.slice(1).map((request, i) => ({
		...transition({ callId: null, request: main[i] }, { callId: null, request, kind: "inferred", link: "adjacent" },
			{ relation: "native-only", firstChanged: null, ancestry: "inferred-adjacent" }, null),
		validity: "unattributed-ancestry",
	}));
}

/** An earlier request whose cached prefix ends exactly where request `n`'s read
 *  stopped, if any. A read equal to the first request's read is tools + system. */
export function readBoundary(capture, n, cacheRead) {
	for (const r of capture.requests) {
		if (r.n >= n || !r.usage) continue;
		if (r.usage.cacheRead === cacheRead && r.usage.cacheRead > 0) return { request: r.n, kind: "read", messages: r.messages };
		if (r.usage.cacheRead + r.usage.cacheWrite === cacheRead) return { request: r.n, kind: "cached-prefix", messages: r.messages };
	}
	return null;
}

/** Findings grouped by signature, so one cause shows up once with its instances. */
export function groupFindings(transitions) {
	const groups = new Map();
	const add = (signature, t, extra) => {
		// count: transitions showing it; occurrences: every instance, repeats included.
		const g = groups.get(signature) ?? { signature, count: 0, occurrences: 0, transitions: [] };
		g.count++;
		g.occurrences++;
		g.transitions.push({ from: t.from.request, to: t.to.request, label: t.label, validity: t.validity, cache: t.cache.status, readFraction: t.cache.readFraction ?? null, breaksAt: t.preservation.firstChange?.label ?? null, ...extra });
		groups.set(signature, g);
	};
	for (const t of transitions) {
		const seen = new Set();
		for (const diff of t.preservation.normalized ?? []) {
			const g = groups.get(`preservation: ${diff.signature}`);
			if (seen.has(diff.signature)) { g.occurrences++; continue; }
			seen.add(diff.signature);
			add(`preservation: ${diff.signature}`, t, { beforeAncestorBreakpoint: diff.beforeAncestorBreakpoint });
		}
		for (const m of t.propagation.missing ?? []) add(`propagation: missing ${m.role ?? ""}/${m.kind}`.replace(" /", " "), t, { piMessage: m.piMessage });
		for (const c of t.propagation.changed ?? []) add(`propagation: ${c.kind} ${c.fields.join("+")} differs`, t, { piMessage: c.piMessage });
		for (const u of t.propagation.unsupported ?? []) add(`coverage: unsupported ${u}`, t, {});
		for (const x of t.apiTransformations ?? []) add(`api: ${x.type} ${x.reason ?? ""}`.trim(), t, { path: x.path ?? null });
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}
