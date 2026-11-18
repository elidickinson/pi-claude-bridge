// Opt-in recorder for diagnosing prompt-cache failures. Private: no extension
// event, no settings entry, no effect unless the environment asks for it.
//
//   CLAUDE_BRIDGE_TRACE_DIR=<dir>    record to <dir>/run-<time>-<pid>/
//   CLAUDE_BRIDGE_TRACE_RAW=1        also keep the provider inputs themselves as
//                                    artifacts (conversation content: owner-only files)
//   CLAUDE_BRIDGE_TRACE_PROXY=<url>  send each Claude Code child's API traffic to
//                                    diag/capture-proxy.mjs as <url>/q/<queryId>
//
// A run directory holds manifest.json, events.jsonl (provider inputs, routing,
// session decisions, query lifecycle, all linked by ids), artifacts/ (raw mode
// only, named by digest) and snapshots/ (raw mode only: Claude Code session
// files copied before the bridge deletes or abandons them). Disabled, every export returns at its first line:
// no hashing, files, listeners or retained messages.
//
// Recorder I/O failure (a full disk, the trace folder deleted under a running
// process): the run is latched as incomplete, stops recording, and is reported
// once; nothing throws, so the trace never fails a provider call. The latch
// lives on globalThis and survives /reload, so a throwing recorder would keep a
// session failing until its process exits. An incomplete run says so in its
// manifest; analysis reads it as such. Serialization errors are programming
// errors and always throw.

import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";
import { getSessionPath, normalizeProjectPath } from "cc-session-io";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface TraceRun {
	dir: string;
	raw: boolean;
	proxy: string | undefined;
	maxArtifactBytes: number;
	maxRunBytes: number;
	artifactBytes: number;
	seq: number;
	ids: number;
	incomplete: string | null;
	signals: WeakMap<AbortSignal, string>;
	manifest: Record<string, unknown>;
}

/** One run per process, shared by every module instance (worktree subagents
 *  load this module fresh), so ids and seq stay unique within the run. */
const RUN_KEY = Symbol.for("claude-bridge:cacheTrace");
/** Which module instance wrote a record. */
const INSTANCE = randomBytes(3).toString("hex");

let notify: (message: string) => void = (message) => console.error(message);

/** Where an incomplete trace is reported. index.ts points this at the pi UI. */
export function setTraceNotifier(fn: (message: string) => void): void {
	notify = fn;
}

function run(): TraceRun | null {
	const root = process.env.CLAUDE_BRIDGE_TRACE_DIR;
	if (!root) return null;
	const g = globalThis as Record<symbol, unknown>;
	return (g[RUN_KEY] as TraceRun | undefined) ?? (g[RUN_KEY] = startRun(root)) as TraceRun;
}

/** Test-only: forget the process's run so the next call starts a new one. */
export function resetTraceForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[RUN_KEY];
}

export function packageVersion(name: string): string | null {
	try {
		const require = createRequire(import.meta.url);
		let dir = dirname(require.resolve(name));
		while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? null;
	} catch {
		return null; // not resolvable from here: recorded as unknown
	}
}

export const BRIDGE_VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

function startRun(root: string): TraceRun {
	const wanted = process.env.CLAUDE_BRIDGE_TRACE_PROXY?.replace(/\/$/, "") || undefined;
	// Claude Code refuses to be routed twice, and a gateway the user configured is
	// never overridden: with one set the run records without routing, as incomplete.
	const gateway = Boolean(wanted && process.env.ANTHROPIC_BASE_URL);
	const proxy = gateway ? undefined : wanted;
	const r: TraceRun = {
		dir: join(root, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`),
		raw: process.env.CLAUDE_BRIDGE_TRACE_RAW === "1",
		proxy,
		maxArtifactBytes: Number(process.env.CLAUDE_BRIDGE_TRACE_MAX_ARTIFACT_BYTES ?? 64 * 1024 * 1024),
		maxRunBytes: Number(process.env.CLAUDE_BRIDGE_TRACE_MAX_RUN_BYTES ?? 2 * 1024 * 1024 * 1024),
		artifactBytes: 0,
		seq: 0,
		ids: 0,
		incomplete: null,
		signals: new WeakMap(),
		manifest: {},
	};
	r.manifest = {
		schema: 1,
		run: r.dir.split("/").pop(),
		startedAt: new Date().toISOString(),
		endedAt: null,
		incomplete: null,
		pid: process.pid,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		bridge: BRIDGE_VERSION,
		sdk: packageVersion("@anthropic-ai/claude-agent-sdk"),
		pi: PI_VERSION,
		recording: r.raw ? "raw" : "shape",
		// A base URL can itself change what Claude Code sends: traced and untraced
		// runs are comparable only with that in mind.
		routing: proxy ? { mode: "per-query-base-url", proxy } : null,
		limits: { maxArtifactBytes: r.maxArtifactBytes, maxRunBytes: r.maxRunBytes },
	};
	try {
		mkdirSync(join(r.dir, "artifacts"), { recursive: true, mode: 0o700 });
		writeFileSync(join(r.dir, "manifest.json"), JSON.stringify(r.manifest, null, 1), { mode: 0o600 });
	} catch (error) {
		latch(r, error);
		return r;
	}
	// The configured URL is not repeated: a gateway URL can carry credentials.
	if (gateway) latch(r, new Error("CLAUDE_BRIDGE_TRACE_PROXY set but ANTHROPIC_BASE_URL is already configured; not routing"));
	process.on("exit", () => {
		try {
			writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ ...r.manifest, endedAt: new Date().toISOString(), incomplete: r.incomplete, events: r.seq, artifactBytes: r.artifactBytes }, null, 1));
		} catch {
			// A manifest without endedAt is itself the record that the run did not finish cleanly.
		}
	});
	return r;
}

function latch(r: TraceRun, error: unknown): void {
	if (r.incomplete) return;
	r.incomplete = error instanceof Error ? error.message : String(error);
	// Now, not only at exit: a process that is killed must still read as incomplete.
	try {
		writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ ...r.manifest, incomplete: r.incomplete }, null, 1), { mode: 0o600 });
	} catch {
		// The failure being latched may be this very disk; the notice below still reports it.
	}
	notify(`Claude bridge cache trace is incomplete and stopped recording: ${r.incomplete} (${r.dir})`);
}

export function digest(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 32);
}

function write(r: TraceRun, type: string, fields: Record<string, unknown>): void {
	if (r.incomplete) return;
	const line = `${JSON.stringify({ seq: r.seq + 1, at: new Date().toISOString(), instance: INSTANCE, type, ...fields })}\n`;
	try {
		appendFileSync(join(r.dir, "events.jsonl"), line, { mode: 0o600 });
		r.seq++;
	} catch (error) {
		latch(r, error);
	}
}

/** A new id for a provider call, query or side call; undefined when disabled. */
export function traceId(kind: string): string | undefined {
	const r = run();
	return r ? `${kind}-${INSTANCE}-${++r.ids}` : undefined;
}

/** A stable id for an abort signal, so ownership is recorded without the object. */
export function traceSignalId(signal: AbortSignal | undefined): string | undefined {
	const r = run();
	if (!r || !signal) return undefined;
	let id = r.signals.get(signal);
	if (!id) r.signals.set(signal, id = `signal-${INSTANCE}-${++r.ids}`);
	return id;
}

/** Record an event; never throws for recorder I/O. */
export function traceEvent(type: string, fields: Record<string, unknown>): void {
	const r = run();
	if (r) write(r, type, fields);
}

/** Record a session decision before the query or the session file change it
 *  decides; like traceEvent, recorder I/O latches the run and never throws. */
export function traceStrict(type: string, fields: Record<string, unknown>): void {
	const r = run();
	if (r) write(r, type, fields);
}

/** Record a query about to start and route its child's API traffic through the
 *  capture proxy under /q/<queryId>. Returns `env` untouched when disabled.
 *  `digests` values are recorded as digests, and in raw mode also kept as
 *  artifacts (so a query can be reproduced with them); only when enabled. */
export function traceQueryStart<E extends Record<string, string | undefined>>(
	queryId: string | undefined,
	fields: Record<string, unknown> & { digests?: Record<string, unknown> },
	env: E,
): E {
	const r = run();
	if (!r || !queryId) return env;
	const { digests, ...rest } = fields;
	const hashed = digests && Object.fromEntries(Object.entries(digests).map(([k, v]) => [k, v === undefined ? null : digest(v)]));
	let kept: Record<string, unknown> | undefined;
	try {
		kept = r.raw && digests && !r.incomplete
			? Object.fromEntries(Object.entries(digests).filter(([, v]) => v !== undefined).map(([k, v]) => [k, artifact(r, v)]))
			: undefined;
	} catch (error) {
		// artifact() writes are recorder I/O; anything else here is a bug.
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
	}
	write(r, "query-start", { queryId, ...rest, ...(hashed ? { digests: hashed } : {}), ...(kept ? { artifacts: kept } : {}), route: r.proxy ? queryId : null });
	// CC treats a base URL other than api.anthropic.com as not first-party and changes
	// what it sends (no thinking-binding beta, tool search off, ...); the override keeps
	// a traced request shaped like an untraced one. Mirrored in diag/lib/first-party.mjs.
	return r.proxy ? { ...env, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ANTHROPIC_BASE_URL: `${r.proxy}/q/${queryId}` } : env;
}

/** Fields that are pi's bookkeeping rather than history content. Left out of the
 *  source digest so they do not read as edits; still listed in `keys`. */
const BOOKKEEPING = new Set(["timestamp", "usage", "responseId", "responseModel", "diagnostics", "details", "providerThinkingLevel", "thinkingLevel"]);

function projectMessage(message: Record<string, unknown>): Record<string, unknown> {
	const source = Object.fromEntries(Object.entries(message).filter(([key]) => !BOOKKEEPING.has(key)));
	const content = message.content;
	const blocks = typeof content === "string"
		? [{ type: "string", digest: digest(content) }]
		: Array.isArray(content)
			? content.map((block: Record<string, unknown>) => ({
				type: block.type,
				keys: Object.keys(block),
				digest: digest(block),
				...(block.type === "toolCall" ? { id: block.id, name: block.name } : {}),
			}))
			: [{ type: typeof content }];
	return {
		role: message.role,
		keys: Object.keys(message),
		digest: digest(source),
		blocks,
		...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
		...(message.role === "assistant" ? { provider: message.provider, stopReason: message.stopReason } : {}),
	};
}

/** Content-addressed copy of `value` in raw mode, within the run's limits.
 *  Over a limit the artifact is refused, never truncated. */
function artifact(r: TraceRun, value: unknown): { artifact?: string; artifactRejected?: string } {
	if (!r.raw) return {};
	const text = JSON.stringify(value);
	const name = `${digest(text)}.json`;
	const path = join(r.dir, "artifacts", name);
	if (existsSync(path)) return { artifact: name };
	const bytes = Buffer.byteLength(text);
	if (bytes > r.maxArtifactBytes) return { artifactRejected: "max-artifact-bytes" };
	if (r.artifactBytes + bytes > r.maxRunBytes) return { artifactRejected: "max-run-bytes" };
	// Whole or absent: a crash must not leave a truncated file under its digest name.
	writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
	r.artifactBytes += bytes;
	return { artifact: name };
}

/** The provider input as pi handed it over (`source`, before transcript folding)
 *  and as the bridge uses it (`effective`). Hashed (and in raw mode copied) now:
 *  pi may mutate these messages after the call returns. */
export function traceInput(callId: string | undefined, source: Context, effective: Context, model: Model<any>, options: SimpleStreamOptions | undefined): void {
	const r = run();
	if (!r || !callId || r.incomplete) return;
	try {
		const sameAsSource = source === effective;
		write(r, "input", {
			callId,
			piSessionId: options?.sessionId ?? null,
			signal: traceSignalId(options?.signal),
			model: model.id,
			reasoning: options?.reasoning ?? null,
			cacheRetention: options?.cacheRetention ?? null,
			source: { messages: source.messages.map((m) => projectMessage(m as unknown as Record<string, unknown>)), ...artifact(r, source) },
			effective: sameAsSource ? "source" : {
				systemPrompt: effective.systemPrompt === undefined ? null : digest(effective.systemPrompt),
				tools: (effective.tools ?? []).map((tool) => ({ name: tool.name, digest: digest(tool) })),
				messages: effective.messages.map((m) => projectMessage(m as unknown as Record<string, unknown>)),
				...artifact(r, effective),
			},
		});
	} catch (error) {
		// artifact() writes are recorder I/O; anything else here is a bug.
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
	}
}

/** Who may still be appending to a session file when it is copied.
 *  "no-known-writer" is a settled copy. */
type SnapshotWriter = "no-known-writer";

/** Copy a Claude Code session's files -- its JSONL and companion directory, the
 *  set deleteSession removes -- before the bridge deletes or abandons them. Raw
 *  mode only; shape mode records that it happened and the file size. Symlinks,
 *  non-files and files over the limits are refused, never followed or truncated,
 *  and leave the snapshot incomplete. Paths the JSONL names under the projects
 *  dir are checked: inside the session's own area they must be in the copy;
 *  anywhere else they are listed as outside the owned area. Recorder I/O
 *  latches the run and never throws: a session file is then replaced without
 *  its snapshot, and the run reads as incomplete. */
export function traceSnapshot(
	fields: { ccSession: string; cwd: string; mirrorCwd?: string; reason: string; writer: SnapshotWriter; callId?: string; queryId?: string },
): void {
	const r = run();
	if (!r || r.incomplete) return;
	let record: Record<string, unknown>;
	try {
		record = snapshot(r, fields);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
		return;
	}
	write(r, "snapshot", record);
}

function snapshot(r: TraceRun, fields: { ccSession: string; cwd: string; mirrorCwd?: string; reason: string; writer: SnapshotWriter }): Record<string, unknown> {
	const jsonl = getSessionPath(fields.ccSession, normalizeProjectPath(fields.cwd), process.env.CLAUDE_CONFIG_DIR);
	const projectDir = dirname(jsonl);
	const companion = jsonl.slice(0, -".jsonl".length);
	if (!r.raw) return { ...fields, jsonl, recorded: false, bytes: existsSync(jsonl) ? statSync(jsonl).size : null };

	const snapshotId = `snap-${INSTANCE}-${++r.ids}`;
	const dir = join(r.dir, "snapshots", snapshotId);
	const files: Array<{ path: string; bytes: number; sha256: string }> = [];
	const rejected: Array<{ path: string; reason: string }> = [];
	let changedDuringCopy = false;
	let jsonlText: string | null = null;
	const copy = (abs: string, rel: string) => {
		const before = lstatSync(abs);
		if (before.isSymbolicLink()) return void rejected.push({ path: rel, reason: "symlink" });
		if (before.isDirectory()) {
			for (const name of readdirSync(abs).sort()) copy(join(abs, name), `${rel}/${name}`);
			return;
		}
		if (!before.isFile()) return void rejected.push({ path: rel, reason: "not-a-file" });
		if (before.size > r.maxArtifactBytes) return void rejected.push({ path: rel, reason: "max-artifact-bytes" });
		if (r.artifactBytes + before.size > r.maxRunBytes) return void rejected.push({ path: rel, reason: "max-run-bytes" });
		const data = readFileSync(abs);
		const after = statSync(abs);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || data.length !== before.size) changedDuringCopy = true;
		const target = join(dir, "files", rel);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(`${target}.tmp`, data, { mode: 0o600 });
		renameSync(`${target}.tmp`, target);
		r.artifactBytes += data.length;
		files.push({ path: rel, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
		if (abs === jsonl) jsonlText = data.toString("utf8");
	};
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// lstat, not exists: a dangling symlink must be refused, not skipped as absent.
	const jsonlPresent = lstatSync(jsonl, { throwIfNoEntry: false }) !== undefined;
	if (jsonlPresent) copy(jsonl, basename(jsonl));
	if (lstatSync(companion, { throwIfNoEntry: false })) copy(companion, basename(companion));

	// References into the projects dir, as the JSONL spells them.
	const projectsRoot = dirname(projectDir);
	const missingReferences = new Set<string>();
	const externalReferences = new Set<string>();
	const named = (jsonlText as string | null)?.match(new RegExp(`${projectsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'<>\\\\]+`, "g")) ?? [];
	for (const raw of new Set(named)) {
		const path = resolve(raw.replace(/[.,;:)\]]+$/, ""));
		if (path === jsonl) continue;
		if (path.startsWith(companion + sep)) {
			const rel = relative(projectDir, path);
			if (!files.some((f) => f.path === rel || f.path.startsWith(rel + "/"))) missingReferences.add(rel);
		} else externalReferences.add(relative(projectsRoot, path));
	}

	const manifest = {
		snapshotId, ...fields, jsonl, takenAt: new Date().toISOString(),
		// External references are data the session needs that a copy of it cannot hold.
		complete: jsonlPresent && !rejected.length && !missingReferences.size && !externalReferences.size && !changedDuringCopy,
		jsonlPresent, changedDuringCopy, files, rejected,
		missingReferences: [...missingReferences], externalReferences: [...externalReferences],
	};
	writeFileSync(join(dir, "manifest.json.tmp"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
	renameSync(join(dir, "manifest.json.tmp"), join(dir, "manifest.json"));
	const { files: _files, ...summary } = manifest;
	return { ...summary, recorded: true, fileCount: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}
