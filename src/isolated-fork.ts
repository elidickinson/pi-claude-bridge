// Isolated compression fork (billion-context-pi #614): Claude Code forks the
// main session, runs one extra prompt in the copy, and the arguments of the
// model's first call to one tool come back. Where the copy is cut:
//
// - `cutAfterToolResult`: right after that call's result in the request being
//   served, plus the attachments written with it. The main turn keeps running.
// - Otherwise once that request ends in a final answer, at the answer; a
//   request that ends on a tool call is not forked.
//
// - The copy is Claude Code's own (resume + forkSession + resumeSessionAt), so
//   its request repeats the main request up to the cut, and the fork prompt
//   follows it.
// - Never routed through streamSimple: replayed tool results would match the
//   main query (contextForToolResults) and steer the prompt into it.
// - No tool runs: the fork refuses to run where external tools could load, and
//   its own tool server refuses every call. Hooks from settings files and
//   plugins are off in the fork; managed-policy hooks still run, and Claude
//   Code still writes its own state (e.g. ~/.claude.json) as on any query.
// - The fork's session id is chosen up front and is never the main one; it is
//   deleted only once its CC process has exited.
// - pi.events is a synchronous emitter, so the instance that served the session
//   accepts in the emit tick or there is no fork.

import { randomUUID } from "node:crypto";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { userPromptText } from "./attachments.js";
import type { ServedInput, ServedReply } from "./query-state.js";

export const ISOLATED_FORK_CHANNEL = "claude-bridge:isolated-fork";

export interface ForkUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** True only when the response's final output count (its `message_delta`) and a
	 *  valid input count were read. False means the totals are unconfirmed; output may understate. */
	complete: boolean;
}

export type ForkFailure = "no-capture-tool" | "no-capture" | "unsafe-config" | "unsupported-context" | "stale-context" | "cut-timeout" | "aborted" | "error";

export type ForkResult =
	| { ok: true; args: Record<string, unknown>; usage?: ForkUsage }
	| { ok: false; reason: ForkFailure; usage?: ForkUsage };

export interface ForkRequest {
	version: 1;
	piSessionId: string;
	prompt: string;
	captureTool: string;
	/** Cut right after this tool call's result instead of after the answer. */
	cutAfterToolResult?: string;
	signal: AbortSignal;
	/** `false` means another acceptor was taken first. */
	accept(result: Promise<ForkResult>): unknown;
}

export interface ServedRequest {
	readonly seq: number;
	readonly piSessionId: string;
	readonly model: Model<any>;
	readonly reasoning: SimpleStreamOptions["reasoning"];
	readonly cwd: string;
	readonly context: Context;
}

/** Thrown by fork deps to decline without counting as an error. */
export class ForkRefused extends Error {
	constructor(readonly reason: ForkFailure) {
		super(reason);
		this.name = "ForkRefused";
	}
}

export function parseForkRequest(data: unknown): ForkRequest | undefined {
	if (!data || typeof data !== "object") return undefined;
	const r = data as Record<string, unknown>;
	if (r.version !== 1) return undefined;
	if (typeof r.piSessionId !== "string" || !r.piSessionId) return undefined;
	if (typeof r.prompt !== "string" || !r.prompt) return undefined;
	if (typeof r.captureTool !== "string" || !r.captureTool) return undefined;
	if (r.cutAfterToolResult !== undefined && (typeof r.cutAfterToolResult !== "string" || !r.cutAfterToolResult)) return undefined;
	if (!(r.signal instanceof AbortSignal)) return undefined;
	if (typeof r.accept !== "function") return undefined;
	return r as unknown as ForkRequest;
}

/** A private deep copy of the last provider call each pi session made. */
export class ServedRequests {
	private readonly bySession = new Map<string, ServedRequest>();
	private seq = 0;

	/** False when the request could not be copied; the session then has no record. */
	record(piSessionId: string | null | undefined, model: Model<any>, context: Context, reasoning: SimpleStreamOptions["reasoning"], cwd: string): boolean {
		if (!piSessionId) return true;
		try {
			const copy = structuredClone({
				model,
				reasoning,
				context: {
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					...(context.tools ? { tools: context.tools } : {}),
				},
			});
			this.bySession.set(piSessionId, { seq: ++this.seq, piSessionId, cwd, ...copy });
			return true;
		} catch {
			this.bySession.delete(piSessionId);
			return false;
		}
	}

	get(piSessionId: string): ServedRequest | undefined {
		return this.bySession.get(piSessionId);
	}

	drop(piSessionId: string | null | undefined): void {
		if (piSessionId) this.bySession.delete(piSessionId);
	}

	clear(): void {
		this.bySession.clear();
	}
}

/** A CC message as far as the fork reads it. */
export interface ForkStreamMessage {
	type: string;
	subtype?: unknown;
	session_id?: unknown;
	message?: unknown;
}

export interface ForkQuery extends AsyncIterable<ForkStreamMessage> {
	close(): void;
}

/** The fork's CC process, as seen by its spawner. */
export interface ForkProcess {
	/** Resolves once the process has exited, or once it can no longer be started after `close`.
	 *  The SDK's own close() returns before that, while CC may still write the session. */
	readonly exited: Promise<void>;
	close(): void;
	/** SIGKILL now, for a shutdown that cannot wait for `close`'s own timer. */
	kill(): void;
}

/** Where the fork copies the main session from. */
export interface ForkSource {
	mainSessionId: string;
	/** Waits, once the fork starts, for the entry to cut at: after the result for
	 *  `cutAfterToolResult`, or else the answer that ends the main turn. */
	forkPoint(signal: AbortSignal, cutAfterToolResult?: string): Promise<string>;
}

export interface ForkTarget {
	mainSessionId: string;
	forkSessionId: string;
	resumeAt: string;
}

export interface ForkDeps {
	/** Why this request must not fork, checked before anything is written. */
	refusal(served: ServedRequest): ForkFailure | undefined;
	/** Called in the emit tick: the main session that holds exactly `served`. */
	source(served: ServedRequest): ForkSource | ForkFailure;
	/** Starts the fork query with the main query's options. */
	startQuery(served: ServedRequest, target: ForkTarget, prompt: string, abortController: AbortController): { query: ForkQuery; process: ForkProcess };
	/** The SDK-side name CC uses for a pi tool. */
	sdkToolName(piToolName: string): string;
	deleteSession(sessionId: string, cwd: string): void;
	debug(...args: unknown[]): void;
	/** Overrides FORK_USAGE_WAIT_MS. */
	usageWaitMs?: number;
}

const USAGE_FIELDS = [
	["input", "input_tokens"],
	["output", "output_tokens"],
	["cacheRead", "cache_read_input_tokens"],
	["cacheWrite", "cache_creation_input_tokens"],
] as const;

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A response's usage as reported so far: the counts `usage` carries replace the
 *  ones in `base` (the API reports running totals, never increments). */
function usageOf(usage: unknown, base?: ForkUsage): ForkUsage | undefined {
	if (!usage || typeof usage !== "object") return base;
	const raw = usage as Record<string, unknown>;
	const next: ForkUsage = { ...(base ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), complete: false };
	let read = false;
	for (const [field, key] of USAGE_FIELDS) {
		const value = count(raw[key]);
		if (value === undefined) continue;
		next[field] = value;
		read = true;
	}
	return read ? next : base;
}

/** How long a captured call waits for its response's final usage. */
export const FORK_USAGE_WAIT_MS = 2_000;

function firstToolUse(content: unknown, sdkName: string): { args: Record<string, unknown>; id?: string } | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; name?: unknown; input?: unknown; id?: unknown };
		if (b.type !== "tool_use" || b.name !== sdkName) continue;
		const args = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input as Record<string, unknown> : {};
		return typeof b.id === "string" ? { args, id: b.id } : { args };
	}
	return undefined;
}

/** A record holding nothing but the refused result of the call `id`. */
function onlyRefusalOf(record: { type?: unknown; message?: unknown }, id: string): boolean {
	if (record.type !== "user") return false;
	const content = (record.message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) && content.length > 0 && content.every((b: { type?: unknown; tool_use_id?: unknown; is_error?: unknown } | null) => b?.type === "tool_result" && b.tool_use_id === id && b.is_error === true);
}

function holdsToolResult(record: Record<string, unknown>, id: string): boolean {
	if (record.type !== "user") return false;
	const content = (record.message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) && content.some((b: { type?: unknown; tool_use_id?: unknown } | null) => b?.type === "tool_result" && b.tool_use_id === id);
}

/** The record holding `input`: the prompt, or the last of its tool results. */
function inputAt(records: readonly Record<string, unknown>[], input: ServedInput): number | undefined {
	if (input.kind === "prompt") {
		const at = records.findIndex((r) => userPromptText(r) === input.text);
		return at < 0 ? undefined : at;
	}
	// Parallel results can sit in separate records; every one must be on disk.
	let anchor = -1;
	for (const id of input.ids) {
		const at = records.findIndex((r) => holdsToolResult(r, id));
		if (at < 0) return undefined;
		anchor = Math.max(anchor, at);
	}
	return anchor;
}

/** Where to fork a main transcript that answered `input` with the entry
 *  `lastUuid`, given the records it wrote from `input.fromByte` on: that entry.
 *  Undefined until it is on disk, "superseded" when other input reached the
 *  turn first. */
export function answerEndIn(records: readonly Record<string, unknown>[], input: ServedInput, lastUuid: string): number | "superseded" | undefined {
	const anchor = inputAt(records, input);
	if (anchor === undefined) return undefined;
	for (let i = anchor + 1; i < records.length; i++) {
		const r = records[i];
		if (r.uuid === lastUuid) return r.type === "assistant" ? i : "superseded";
		const attachment = r.attachment as { type?: unknown } | undefined;
		if (r.type === "user" || (r.type === "attachment" && attachment?.type === "queued_command")) return "superseded";
	}
	return undefined;
}

/** Where to cut after the served input's tool results: the last record holding
 *  one of them, or a later attachment Claude Code wrote with them, before the
 *  next user or assistant record. `settled` once such a record follows.
 *  Undefined until every result is on disk; "superseded" if a queued command
 *  arrived with them. */
export function toolResultCutIn(records: readonly Record<string, unknown>[], input: ServedInput): { uuid: string; settled: boolean } | "superseded" | undefined {
	const anchor = inputAt(records, input);
	if (anchor === undefined) return undefined;
	let cut = anchor;
	for (let i = anchor + 1; i < records.length; i++) {
		const r = records[i];
		if (r.type === "attachment") {
			if ((r.attachment as { type?: unknown } | undefined)?.type === "queued_command") return "superseded";
			cut = i;
		} else if (r.type === "user" || r.type === "assistant") {
			return typeof records[cut].uuid === "string" ? { uuid: records[cut].uuid as string, settled: true } : undefined;
		}
	}
	return typeof records[cut].uuid === "string" ? { uuid: records[cut].uuid as string, settled: false } : undefined;
}

/** The main query's view of one served input, read while a fork waits on it. */
export interface AnswerWatch {
	reply(): ServedReply | undefined;
	/** True once the input can no longer get a reply: a newer input, a rewritten
	 *  history, or another query (or none) holding the session. */
	superseded(): boolean;
	records(): readonly Record<string, unknown>[];
}

export interface AnswerWait {
	/** For the main turn to end. */
	replyMs: number;
	/** For the answer's last entry to reach the transcript once the turn ended. */
	flushMs: number;
	pollMs: number;
}

/** The entry to fork at once the main turn for `input` ends in a final answer.
 *  Declines a turn that ends on a tool call (`unsupported-context`) or that
 *  another input overtakes (`stale-context`). */
export async function waitForAnswerEnd(watch: AnswerWatch, input: ServedInput, signal: AbortSignal, wait: AnswerWait): Promise<string> {
	const replyDeadline = Date.now() + wait.replyMs;
	let flushDeadline: number | undefined;
	for (;;) {
		if (signal.aborted) throw new ForkRefused("aborted");
		const reply = watch.reply();
		if (reply) {
			if (reply.kind !== "answer") throw new ForkRefused(reply.kind === "toolUse" ? "unsupported-context" : "stale-context");
			const at = answerEndIn(watch.records(), input, reply.lastUuid);
			if (at === "superseded") throw new ForkRefused("stale-context");
			if (at !== undefined) return reply.lastUuid;
			flushDeadline ??= Date.now() + wait.flushMs;
			if (Date.now() >= flushDeadline) throw new ForkRefused("unsupported-context");
		} else if (watch.superseded() || Date.now() >= replyDeadline) {
			throw new ForkRefused("stale-context");
		}
		await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
	}
}

export interface CutWait {
	/** For the results to reach the transcript, from when the fork starts. */
	cutMs: number;
	/** For later attachments once the results are there. */
	settleMs: number;
	pollMs: number;
}

/** The entry to fork at, right after the served input's result for
 *  `toolCallId`. Declines input that does not deliver that result
 *  (`unsupported-context`), a rewritten or overtaken history (`stale-context`),
 *  and results that do not reach the transcript in time (`cut-timeout`). */
export async function waitForToolResultCut(watch: AnswerWatch, input: ServedInput, toolCallId: string, signal: AbortSignal, wait: CutWait): Promise<string> {
	if (input.kind !== "toolResults" || !input.ids.includes(toolCallId)) throw new ForkRefused("unsupported-context");
	const deadline = Date.now() + wait.cutMs;
	let anchoredAt: number | undefined;
	for (;;) {
		if (signal.aborted) throw new ForkRefused("aborted");
		const at = toolResultCutIn(watch.records(), input);
		if (at === "superseded") throw new ForkRefused("stale-context");
		if (at) {
			anchoredAt ??= Date.now();
			if (at.settled || Date.now() - anchoredAt >= wait.settleMs) return at.uuid;
		} else if (watch.superseded()) {
			throw new ForkRefused("stale-context");
		} else if (Date.now() >= deadline) {
			throw new ForkRefused("cut-timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
	}
}

/** The main query's settings with hooks from settings files and plugins off.
 *  Undefined for a settings file path, which cannot be extended unread. */
export function forkSettings<S extends object>(settings: string | S | undefined): (S & { disableAllHooks: true }) | { disableAllHooks: true } | undefined {
	if (typeof settings === "string") return undefined;
	return { ...settings, disableAllHooks: true };
}

function errorKind(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/** Owns every fork this bridge instance started, so shutdown can stop them. */
export class IsolatedForks {
	private readonly running = new Set<() => void>();
	private readonly runs = new Set<Promise<unknown>>();
	private generation = 0;
	private readonly settling = new Map<Promise<void>, () => void>();
	private readonly handled = new WeakSet<object>();
	readonly unsettled = new Set<string>();

	constructor(private readonly served: ServedRequests, private readonly deps: ForkDeps) {}

	/** pi.events handler. Accepts only for sessions this instance served. */
	handle(data: unknown): void {
		const request = parseForkRequest(data);
		if (!request || this.handled.has(request)) return;
		const served = this.served.get(request.piSessionId);
		if (!served) return;
		this.handled.add(request);
		let start!: () => void;
		const go = new Promise<void>((resolve) => { start = resolve; });
		const generation = this.generation;
		const source = this.sourceOf(served);
		const result = go.then(() => (generation === this.generation ? this.run(request, served, source) : { ok: false as const, reason: "aborted" as const }));
		if (request.accept(result) === false) return;
		this.runs.add(result);
		const forget = () => { this.runs.delete(result); };
		result.then(forget, forget);
		start();
	}

	private sourceOf(served: ServedRequest): ForkSource | ForkFailure {
		try {
			return this.deps.source(served);
		} catch (error) {
			this.deps.debug(`isolated-fork: source failed: ${errorKind(error)}`);
			return "error";
		}
	}

	/** Stops running forks, and accepted ones that have not started yet. */
	abortAll(): void {
		this.generation++;
		for (const abort of this.running) abort();
	}

	/** Stops every fork and waits, at most `deadlineMs`, for each process to exit
	 *  and its session to be deleted. Processes still running at `killAfterMs`
	 *  get SIGKILL. A session whose process never exits is left on disk. */
	async shutdown(deadlineMs: number, killAfterMs: number): Promise<void> {
		this.abortAll();
		const start = Date.now();
		const within = async (promises: Promise<unknown>[], ms: number) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled(promises),
				new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); }),
			]);
			clearTimeout(timer);
		};
		await within([...this.runs], killAfterMs);
		await within([...this.settling.keys()], killAfterMs - (Date.now() - start));
		for (const kill of this.settling.values()) kill();
		await within([...this.runs, ...this.settling.keys()], deadlineMs - (Date.now() - start));
		if (this.unsettled.size > 0) this.deps.debug(`isolated-fork: shutdown left ${this.unsettled.size} session(s) whose process did not exit`);
	}

	private async run(request: ForkRequest, served: ServedRequest, source: ForkSource | ForkFailure): Promise<ForkResult> {
		if (request.signal.aborted) return { ok: false, reason: "aborted" };
		if (!served.context.tools?.some((tool) => tool.name === request.captureTool)) {
			return { ok: false, reason: "no-capture-tool" };
		}
		const refusal = this.deps.refusal(served);
		if (refusal) return { ok: false, reason: refusal };
		if (typeof source === "string") return { ok: false, reason: source };

		const controller = new AbortController();
		let wake!: () => void;
		const stopped = new Promise<void>((resolve) => { wake = resolve; });
		const abort = () => {
			controller.abort();
			wake();
		};
		request.signal.addEventListener("abort", abort, { once: true });
		this.running.add(abort);
		let sessionId: string | undefined;
		let started: ReturnType<ForkDeps["startQuery"]> | undefined;
		let consumed: Promise<void> | undefined;
		// Usage per response, keyed by message id, or by the record itself when it
		// names no response. Stream events carry no id after message_start, so they
		// belong to the response it opened.
		const usageByKey = new Map<string | symbol, { usage: ForkUsage; input: boolean }>();
		const seen = (key: string | symbol, raw: unknown, final = false) => {
			const known = usageByKey.get(key);
			const usage = usageOf(raw, known?.usage);
			if (!usage || usage === known?.usage) return;
			const input = (known?.input ?? false) || count((raw as { input_tokens?: unknown }).input_tokens) !== undefined;
			const output = final && count((raw as { output_tokens?: unknown }).output_tokens) !== undefined;
			usageByKey.set(key, { usage: { ...usage, complete: output && input }, input });
		};
		let openId: string | undefined;
		let lastKey: string | symbol | undefined;
		let args: Record<string, unknown> | undefined;
		let capturedKey: string | symbol | undefined;
		let capturedCallId: string | undefined;
		let usageTimer: ReturnType<typeof setTimeout> | undefined;
		let usageWaited!: () => void;
		const usageWait = new Promise<void>((resolve) => { usageWaited = resolve; });
		const reported = (): ForkUsage | undefined => {
			const key = args ? capturedKey : lastKey;
			return key === undefined ? undefined : usageByKey.get(key)?.usage;
		};
		const withUsage = () => {
			const usage = reported();
			return usage ? { usage } : {};
		};
		try {
			const resumeAt = await source.forkPoint(controller.signal, request.cutAfterToolResult);
			if (controller.signal.aborted) return { ok: false, reason: "aborted" };
			const forkSessionId = randomUUID();
			if (forkSessionId === source.mainSessionId) return { ok: false, reason: "error" };
			const sdkName = this.deps.sdkToolName(request.captureTool);
			sessionId = forkSessionId;
			started = this.deps.startQuery(served, { mainSessionId: source.mainSessionId, forkSessionId, resumeAt }, request.prompt, controller);
			const q = started.query;
			consumed = (async () => {
				for await (const message of q) {
					if (controller.signal.aborted) return;
					if (message.type === "system" && message.subtype === "init") {
						if (message.session_id === forkSessionId) continue;
						// Not a session this fork owns, so it is left alone.
						this.deps.debug("isolated-fork: init named a session other than the fork's");
						throw new ForkRefused("error");
					}
					if (message.type === "stream_event") {
						const event = (message as { event?: { type?: unknown; message?: { id?: unknown; usage?: unknown }; usage?: unknown } }).event;
						if (event?.type === "message_start") {
							// Everything of the captured response has been read.
							if (args) return;
							openId = typeof event.message?.id === "string" ? event.message.id : undefined;
							if (openId === undefined) continue;
							lastKey = openId;
							seen(openId, event.message?.usage);
						} else if (event?.type === "message_delta" && openId !== undefined) {
							// Complete only with the closing output count and a valid input count from any event of the response.
							seen(openId, event.usage, true);
							if (args && openId === capturedKey) return;
						} else if (event?.type === "message_stop") {
							if (args && openId === capturedKey) return;
							openId = undefined;
						}
						continue;
					}
					// Past the captured call, only its own response's events are read. Claude Code
					// can refuse the call before that response's final usage arrives, so the refusal
					// is passed over too; the usage wait still bounds how long this reads.
					if (args) {
						if (message.type === "assistant" || message.type === "system") continue;
						if (capturedCallId !== undefined && onlyRefusalOf(message, capturedCallId)) continue;
						return;
					}
					if (message.type !== "assistant") continue;
					const body = message.message && typeof message.message === "object" ? message.message as { id?: unknown; content?: unknown; usage?: unknown } : {};
					const id = typeof body.id === "string" ? body.id : openId;
					const key = id ?? Symbol("unidentified response");
					lastKey = key;
					// A record repeats its response's counts so far; the stream's own are never replaced by it.
					if (!usageByKey.has(key)) seen(key, body.usage);
					const captured = firstToolUse(body.content, sdkName);
					if (captured) {
						args = captured.args;
						capturedCallId = captured.id;
						capturedKey = key;
						// Without the response's stream events its final usage never arrives.
						if (id === undefined || id !== openId) return;
						usageTimer = setTimeout(usageWaited, this.deps.usageWaitMs ?? FORK_USAGE_WAIT_MS);
						usageTimer.unref?.();
					}
				}
			})();
			// usageWait starts only once a call is captured, so it bounds just that wait.
			await Promise.race([consumed, usageWait, stopped]);
			if (args && !controller.signal.aborted) return { ok: true, args, ...withUsage() };
			return { ok: false, reason: controller.signal.aborted ? "aborted" : "no-capture", ...withUsage() };
		} catch (error) {
			if (error instanceof ForkRefused) return { ok: false, reason: error.reason, ...withUsage() };
			this.deps.debug(`isolated-fork: failed (${errorKind(error)})`);
			return { ok: false, reason: controller.signal.aborted ? "aborted" : "error", ...withUsage() };
		} finally {
			clearTimeout(usageTimer);
			// The result is known, so stop the process instead of waiting for it.
			controller.abort();
			request.signal.removeEventListener("abort", abort);
			this.running.delete(abort);
			this.cleanup(served.cwd, sessionId, started);
		}
	}

	private cleanup(cwd: string, sessionId: string | undefined, started: ReturnType<ForkDeps["startQuery"]> | undefined): void {
		try {
			started?.query.close();
		} catch {}
		try {
			started?.process.close();
		} catch {}
		if (!sessionId) return;
		const id = sessionId;
		this.unsettled.add(id);
		const remove = () => {
			try {
				this.deps.deleteSession(id, cwd);
			} catch (error) {
				this.deps.debug(`isolated-fork: delete ${id.slice(0, 8)} failed (${errorKind(error)})`);
			}
			this.unsettled.delete(id);
		};
		if (!started) {
			remove();
			return;
		}
		const child = started.process;
		// Only the process writes the session, so its exit is what deletion waits for.
		const settled = child.exited.then(remove);
		this.settling.set(settled, () => child.kill());
		const forget = () => { this.settling.delete(settled); };
		settled.then(forget, forget);
	}
}
