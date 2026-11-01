#!/usr/bin/env node
// Recording proxy for Claude Code's API traffic.
//
// The bridge passes process.env through to the CC child, and the shipped SDK
// honours ANTHROPIC_BASE_URL, so pointing that at this server captures the exact
// request bodies CC sends. That is the only way to see whether a `--resume`
// boundary re-sends a prompt prefix that differs from what CC sent live, which is
// the open ~25% cold-resume finding in diag/AUDIT.md.
//
//   node diag/capture-proxy.mjs [--port 8787] [--out DIR] [--upstream URL]
//                               [--shape-only] [--max-body-bytes N] [--max-run-bytes N]
//                               [--fault-file PATH]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pi --model claude-bridge/...
//   node diag/diff-captures.mjs DIR
//
// Responses stream through as they arrive, with backpressure, so abort and
// disconnect timing is the same as without the proxy; usage is read off the SSE
// events on the way past. A client disconnect cancels the upstream request.
//
// Routing: a base URL of http://127.0.0.1:8787/q/<route> sends that client's
// traffic here tagged with <route>; the /q/<route> prefix is stripped before
// forwarding. The bridge's trace mode gives each SDK query its own route, which
// is what ties a request to the query that sent it.
//
// Files in DIR (owner-only; they contain the conversation, so treat DIR as sensitive):
//   proxy-manifest.json  mode, limits, upstream, start/end
//   proxy-events.jsonl   request-start, written before the request is forwarded
//   index.jsonl          one row per request once it ends: status, terminal kind
//                        (complete | upstream-error | client-disconnect), usage
//   req-NNNN.json        the raw request body (omitted with --shape-only, which
//                        records digests, sizes and block types instead)
//   err-NNNN.json        a non-2xx /v1/ response: allowlisted request headers,
//                        response headers and body — the rate-limit and billing
//                        headers there are the record of what the server decided
//
// Fault injection (test runs only): with --fault-file, a /v1/messages request
// arriving while PATH holds {"status":529,"count":1,"headers":{},"body":{...}}
// is answered with that response instead of being forwarded, and count is
// decremented. Optional "route" limits it to one query's traffic, and
// "match":"tool-result" to a request carrying a tool result after its last
// assistant message (the continuation at a tool boundary; CC may append reminder
// messages after it), so it can be armed before the turn starts. Such requests are recorded with terminal "injected", so they can
// never be mistaken for a real Anthropic error.
//
// Credentials are never recorded: request headers are reduced to an allowlist plus
// the auth key family (`sk-ant-oat01`, `sk-ant-api03`), which names the billing
// path a request took without writing credential material.

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const PORT = Number(flag("port", 8787));
const OUT = flag("out", `/tmp/cc-capture-${process.pid}`);
const UPSTREAM = flag("upstream", "https://api.anthropic.com").replace(/\/$/, "");
const SHAPE_ONLY = args.includes("--shape-only");
const MAX_BODY_BYTES = Number(flag("max-body-bytes", 64 * 1024 * 1024));
const MAX_RUN_BYTES = Number(flag("max-run-bytes", 2 * 1024 * 1024 * 1024));
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const FAULT_FILE = flag("fault-file");

mkdirSync(OUT, { recursive: true, mode: 0o700 });
chmodSync(OUT, 0o700);
const INDEX = join(OUT, "index.jsonl");
const EVENTS = join(OUT, "proxy-events.jsonl");
const MANIFEST = join(OUT, "proxy-manifest.json");

const appendRecord = (file, record) => appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
/** Written whole or not at all: a crash never leaves a truncated file under the final name. */
const writePrivate = (file, data) => {
	writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
};
const pad = (n) => String(n).padStart(4, "0");

const manifest = {
	schema: 1,
	tool: "capture-proxy",
	upstream: UPSTREAM,
	port: PORT,
	recording: SHAPE_ONLY ? "shape" : "raw",
	faultInjection: FAULT_FILE ? { file: FAULT_FILE } : null,
	limits: { maxBodyBytes: MAX_BODY_BYTES, maxRunBytes: MAX_RUN_BYTES },
	node: process.version,
	pid: process.pid,
	startedAt: new Date().toISOString(),
	endedAt: null,
};
writePrivate(MANIFEST, JSON.stringify(manifest, null, 1));

let seq = 0;
let artifactBytes = 0;
let inFlight = 0;

/** `/q/<route>/rest?x` -> { route, path: "/rest?x" }. Anything else is unrouted. */
function splitRoute(url) {
	const m = url.match(/^\/q\/([A-Za-z0-9_.-]+)(\/.*)?$/);
	return m ? { route: m[1], path: m[2] ?? "/" } : { route: null, path: url };
}

/** The auth header reduced to its key family: names the billing path, holds no secret. */
function authFamily(headers) {
	const bearer = headers.authorization?.split(" ")[1];
	if (bearer) return `bearer ${bearer.slice(0, 12)}`;
	if (headers["x-api-key"]) return `x-api-key ${String(headers["x-api-key"]).slice(0, 12)}`;
	return null;
}

const RECORDED_REQUEST_HEADER = /^(anthropic-(version|beta)|content-type|user-agent|x-app|x-stainless-[a-z-]+|x-claude-code-session-id)$/;
function recordedRequestHeaders(headers) {
	const out = Object.fromEntries(Object.entries(headers).filter(([k]) => RECORDED_REQUEST_HEADER.test(k)));
	out.auth = authFamily(headers);
	return out;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
const NOT_RECORDED_RESPONSE = new Set(["set-cookie", "anthropic-organization-id"]);

/** Digest, size and block shape of a request body: enough to group and diff
 *  requests in --shape-only mode without keeping their text. */
function bodyShape(parsed) {
	if (!parsed || typeof parsed !== "object") return null;
	const blocks = (content) => typeof content === "string" ? ["string"] : Array.isArray(content) ? content.map((b) => b?.type ?? typeof b) : [typeof content];
	return {
		keys: Object.keys(parsed),
		system: blocks(parsed.system),
		tools: Array.isArray(parsed.tools) ? parsed.tools.map((t) => t?.name) : null,
		messages: Array.isArray(parsed.messages) ? parsed.messages.map((m) => ({ role: m?.role, blocks: blocks(m?.content), digest: sha256(JSON.stringify(m)) })) : null,
	};
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Incremental SSE reader: survives events, lines and UTF-8 characters split
 *  across arbitrary chunk boundaries, and multi-line `data:` fields. Records what
 *  the cache did (message_start usage) and whether the message finished. */
function sseObserver() {
	const decoder = new TextDecoder();
	let pending = "";
	let data = [];
	const state = { events: 0, unparsed: 0, apiMessageId: null, startUsage: null, finalUsage: null, stopReason: null, messageStop: false, error: null, inputTransformations: null };

	const dispatch = () => {
		if (data.length === 0) return;
		const text = data.join("\n");
		data = [];
		let event;
		try { event = JSON.parse(text); } catch { state.unparsed++; return; }
		state.events++;
		// What the API changed in the input before using it, e.g. thinking it dropped
		// because the context before it no longer matches what it was signed against.
		const transformed = event.message?.input_transformations ?? event.input_transformations;
		if (Array.isArray(transformed)) state.inputTransformations = [...(state.inputTransformations ?? []), ...transformed];
		if (event.type === "message_start") {
			state.apiMessageId = event.message?.id ?? null;
			state.startUsage = event.message?.usage ?? null;
		} else if (event.type === "message_delta") {
			if (event.usage) state.finalUsage = event.usage;
			if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
		} else if (event.type === "message_stop") {
			state.messageStop = true;
		} else if (event.type === "error") {
			state.error = event.error ?? event;
		}
	};
	const line = (raw) => {
		const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (l === "") return dispatch();
		if (l.startsWith("data:")) data.push(l.slice(l[5] === " " ? 6 : 5));
	};
	return {
		state,
		push(chunk) {
			pending += decoder.decode(chunk, { stream: true });
			let i;
			while ((i = pending.indexOf("\n")) !== -1) {
				line(pending.slice(0, i));
				pending = pending.slice(i + 1);
			}
		},
		end() {
			pending += decoder.decode();
			if (pending) line(pending);
			pending = "";
			dispatch();
		},
	};
}

/** The compact usage shape existing diag readers use; null when no message_start
 *  arrived — absence of usage is not zero usage. */
function compactUsage(usage) {
	if (!usage) return null;
	return { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
}

/** The armed fault for this request, consumed; null when none is armed. */
function takeFault(path, route, parsed) {
	if (!FAULT_FILE || new URL(path, "http://x").pathname !== "/v1/messages" || !existsSync(FAULT_FILE)) return null;
	const fault = JSON.parse(readFileSync(FAULT_FILE, "utf8"));
	if (!(fault.count > 0)) return null;
	if (fault.route && fault.route !== route) return null;
	const messages = parsed?.messages ?? [];
	const tail = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1);
	if (fault.match === "tool-result" && !tail.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result"))) return null;
	writePrivate(FAULT_FILE, JSON.stringify({ ...fault, count: fault.count - 1 }));
	return fault;
}

/** Keep the raw body as the artifact when the budgets allow; otherwise say why not.
 *  A rejected artifact is never truncated: the request is recorded without it. */
function storeBody(n, body) {
	if (SHAPE_ONLY) return { artifact: null, artifactRejected: null };
	if (body.length > MAX_BODY_BYTES) return { artifact: null, artifactRejected: "max-body-bytes" };
	if (artifactBytes + body.length > MAX_RUN_BYTES) return { artifact: null, artifactRejected: "max-run-bytes" };
	artifactBytes += body.length;
	const artifact = `req-${pad(n)}.json`;
	writePrivate(join(OUT, artifact), body);
	return { artifact, artifactRejected: null };
}

async function handle(req, res, body) {
	const n = ++seq;
	const id = `p${process.pid}-${n}`;
	const { route, path } = splitRoute(req.url);
	const startedAt = new Date().toISOString();
	const requestHeaders = recordedRequestHeaders(req.headers);

	let parsed = null;
	try { parsed = JSON.parse(body.toString("utf8")); } catch {}
	const { artifact, artifactRejected } = body.length ? storeBody(n, body) : { artifact: null, artifactRejected: null };
	appendRecord(EVENTS, {
		type: "request-start", id, n, route, at: startedAt, method: req.method, path,
		retryCount: requestHeaders["x-stainless-retry-count"] ?? null,
		bodyBytes: body.length, bodyDigest: body.length ? sha256(body) : null,
		artifact, artifactRejected,
		...(SHAPE_ONLY ? { shape: bodyShape(parsed) } : {}),
		headers: requestHeaders,
	});

	const headers = { ...req.headers };
	for (const k of ["host", "content-length", "accept-encoding", ...HOP_BY_HOP]) delete headers[k]; // identity encoding keeps SSE readable

	const fault = takeFault(path, route, parsed);
	if (fault) {
		const text = JSON.stringify(fault.body ?? { type: "error", error: { type: "overloaded_error", message: "Injected by capture-proxy" } });
		res.writeHead(fault.status, { "content-type": "application/json", ...fault.headers }).end(text);
		appendRecord(INDEX, {
			n, id, route, at: new Date().toISOString(), startedAt, method: req.method, path, status: fault.status, terminal: "injected", injected: true,
			model: parsed?.model, messages: parsed?.messages?.length ?? null, tools: parsed?.tools?.length ?? null, usage: null,
			retryCount: requestHeaders["x-stainless-retry-count"] ?? null, betas: requestHeaders["anthropic-beta"] ?? null, auth: requestHeaders.auth,
		});
		console.error(`[${n}]${route ? ` (${route})` : ""} ${req.method} ${path} → ${fault.status} INJECTED`);
		return;
	}

	const controller = new AbortController();
	// Whichever side failed first: a dying upstream also tears `res` down, and
	// that close must not read as the client leaving.
	let clientGone = false;
	let upstreamFailed = false;
	res.on("close", () => {
		if (res.writableFinished || upstreamFailed) return;
		clientGone = true;
		controller.abort();
	});

	const observer = sseObserver();
	const errorBody = [];
	let errorBodyBytes = 0;
	let status = null;
	let responseHeaders = null;
	let terminal = "complete";
	let failure = null;
	inFlight++;
	try {
		const upstream = await fetch(`${UPSTREAM}${path}`, {
			method: req.method,
			headers,
			body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
			signal: controller.signal,
		});
		status = upstream.status;
		responseHeaders = {};
		for (const [k, v] of upstream.headers) {
			if (["content-encoding", "content-length", ...HOP_BY_HOP].includes(k)) continue;
			responseHeaders[k] = v;
		}
		res.writeHead(status, responseHeaders);
		res.flushHeaders();
		const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
		const tap = new Transform({
			transform(chunk, _enc, done) {
				if (isSse) observer.push(chunk);
				if (status >= 300 && errorBodyBytes < MAX_ERROR_BODY_BYTES) {
					errorBody.push(chunk);
					errorBodyBytes += chunk.length;
				}
				done(null, chunk);
			},
		});
		if (upstream.body) {
			const source = Readable.fromWeb(upstream.body);
			source.on("error", () => { if (!clientGone) upstreamFailed = true; });
			await pipeline(source, tap, res);
		} else res.end();
		if (isSse) observer.end();
	} catch (error) {
		terminal = clientGone ? "client-disconnect" : "upstream-error";
		failure = error?.cause?.message ?? error?.message ?? String(error);
		if (!clientGone) {
			if (!res.headersSent) res.writeHead(502).end(failure);
			else res.destroy();
		}
	} finally {
		inFlight--;
	}

	const s = observer.state;
	const errorText = Buffer.concat(errorBody).toString("utf8");
	// /v1/ only: the SDK health-checks `/` with HEAD and takes the 404 in stride.
	if (status >= 300 && path.startsWith("/v1/")) {
		const filtered = Object.fromEntries(Object.entries(responseHeaders ?? {}).filter(([k]) => !NOT_RECORDED_RESPONSE.has(k)));
		writePrivate(join(OUT, `err-${pad(n)}.json`), JSON.stringify({
			n, id, route, at: new Date().toISOString(), status, path, requestHeaders, responseHeaders: filtered,
			responseBody: errorText, responseBodyTruncated: errorBodyBytes >= MAX_ERROR_BODY_BYTES,
		}, null, 1));
	}

	appendRecord(INDEX, {
		n, id, route,
		at: new Date().toISOString(),
		startedAt,
		method: req.method,
		path,
		status,
		terminal,
		failure,
		model: parsed?.model,
		messages: parsed?.messages?.length ?? null,
		tools: parsed?.tools?.length ?? null,
		usage: compactUsage(s.startUsage),
		usageRaw: s.startUsage || s.finalUsage ? { start: s.startUsage, final: s.finalUsage } : null,
		messageStop: s.messageStop,
		stopReason: s.stopReason,
		streamError: s.error,
		inputTransformations: s.inputTransformations,
		sse: s.events || s.unparsed ? { events: s.events, unparsed: s.unparsed } : null,
		apiMessageId: s.apiMessageId,
		requestId: responseHeaders?.["request-id"] ?? null,
		retryCount: requestHeaders["x-stainless-retry-count"] ?? null,
		betas: requestHeaders["anthropic-beta"] ?? null,
		auth: requestHeaders.auth,
	});
	const tag = status >= 300 ? ` ERROR → err-${pad(n)}.json` : "";
	const end = terminal === "complete" ? "" : ` ${terminal}${failure ? `: ${failure}` : ""}`;
	console.error(`[${n}]${route ? ` (${route})` : ""} ${req.method} ${path} → ${status ?? "-"} msgs=${parsed?.messages?.length ?? "-"}${tag}${end}`);
}

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		handle(req, res, Buffer.concat(chunks)).catch((error) => {
			// A recording failure (disk full, permissions) is fatal: a capture that
			// silently stopped recording would read as complete.
			console.error("capture proxy: recording failed", error);
			process.exit(1);
		});
	});
});

function finish(signal) {
	writePrivate(MANIFEST, JSON.stringify({ ...manifest, endedAt: new Date().toISOString(), endSignal: signal, inFlightAtEnd: inFlight, requests: seq }, null, 1));
	process.exit(0);
}
process.on("SIGINT", () => finish("SIGINT"));
process.on("SIGTERM", () => finish("SIGTERM"));

server.listen(PORT, "127.0.0.1", () => {
	// --port 0 picks a free port; the manifest and this line name the real one.
	manifest.port = server.address().port;
	writePrivate(MANIFEST, JSON.stringify(manifest, null, 1));
	console.error(`capture proxy on http://127.0.0.1:${manifest.port} → ${UPSTREAM} (${manifest.recording})`);
	console.error(`writing to ${OUT}`);
});
