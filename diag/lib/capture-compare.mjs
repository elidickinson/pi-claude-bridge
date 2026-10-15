// Reading capture-proxy.mjs output and comparing prompts the way the prompt cache
// does: wire order, key order included, minus the per-request billing header and
// cache_control markers. Shared by diag/probe-rebuild-fidelity.mjs and
// diag/probe-tree-fork.mjs so the two cannot disagree about "same prefix".

import { readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const BILLING_HEADER = "x-anthropic-billing-header";

export async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

export async function waitForPort(port) {
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
export function loadRequests(captureDir) {
	const rows = readFileSync(join(captureDir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const failed = rows.filter((row) => row.path?.startsWith("/v1/messages") && row.status !== 200);
	const requests = rows
		.filter((row) => row.path?.startsWith("/v1/messages") && row.status === 200 && (row.tools ?? 0) > 0)
		.map((row) => ({ ...row, body: JSON.parse(readFileSync(join(captureDir, `req-${String(row.n).padStart(4, "0")}.json`), "utf8")) }));
	return { requests, failed: failed.length };
}

/** Anchored `syncResult:` lines from the bridge debug log, one per fresh query,
 *  as "<path>" or "<path> <kind>" (e.g. "rebuild preserved"). */
export function syncPaths(debugLog) {
	const re = /^\[[^\]]+\] \[[^\]]+\] syncResult: path=(\S+)(.*)$/;
	return readFileSync(debugLog, "utf8").split("\n").map((line) => line.match(re)).filter(Boolean).map((m) => {
		const kind = m[2].match(/ (first|preserved|rotated-post-abort|preserve-shared)\b/);
		return kind ? `${m[1]} ${kind[1]}` : m[1];
	});
}

export const userTexts = (message) => message.role !== "user" ? []
	: typeof message.content === "string" ? [message.content]
	: message.content.filter((block) => block.type === "text").map((block) => block.text);

export const opensWith = (message, tag) => userTexts(message).some((text) => text.trimStart().startsWith(tag));

export function withoutCacheControl(value) {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, withoutCacheControl(v)]));
	}
	return value;
}

export const kinds = (message) => typeof message.content === "string" ? "text" : message.content.map((b) => b.type).join("+");

/** A message whose content is one plain text block, with that content as a string.
 *  The API caches both forms alike: a reuse control read back in full after CC sent
 *  the same system message as a block, then as a string. Applied after
 *  withoutCacheControl, so a block holding the breakpoint counts as plain. */
export function contentAsString(message) {
	const c = message.content;
	const plain = Array.isArray(c) && c.length === 1 && c[0].type === "text" && Object.keys(c[0]).length === 2;
	return plain ? { ...message, content: c[0].text } : message;
}

/** The prompt prefix in wire order (tools, system, messages), minus the billing header. */
export function elements(body) {
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
export function firstDiff(a, b, path = "") {
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

export function describeDiff(d) {
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
