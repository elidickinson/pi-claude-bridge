// Recovery for tool calls Claude typed as literal text instead of emitting as a
// structured tool_use block (issue #36). The leaked shape is the invoke syntax
// Claude is trained on:
//
//     <invoke name="bash">
//       <parameter name="command">npm test</parameter>
//     </invoke>
//
// When that text is the whole action of a turn, pi sees an ordinary answer and the
// work stops: nothing was dispatched, nothing failed, the agent just goes quiet.
// Mostly seen on long 1M-context sessions.
//
// Two cases, one pass over the turn's blocks:
//   1. no structured tool call this turn → synthesize the call the text describes
//   2. a structured tool call for the same tool exists → the literal text is a
//      stale draft of it; cut it from the visible answer so the user is not shown
//      the same command twice
//
// The parser is deliberately small and total. It never throws, and anything it
// cannot parse in full is left as plain text: a half-built call would run the
// wrong thing, which is worse than the stall it is recovering from.
//
// What this deliberately does NOT do is guess at context — an invoke block inside
// a fenced example is indistinguishable from a leaked one, and refusing to
// recover fenced text would silently reinstate the stall for the leaks that
// arrive fenced. The gate is instead the caller's: end_turn, no structured call,
// and a tool the bridge is actually serving this turn.
//
// Kept out of index.ts so it is testable without activating the extension.

import { randomUUID } from "node:crypto";

/** Namespaced tags (`<invoke>`) are the same leak; Claude emits both forms. */
const NS = "(?:[A-Za-z][\\w.-]*:)?";
const INVOKE_OPEN = `<${NS}invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>`;
const INVOKE_CLOSE = `</${NS}invoke\\s*>`;
const PARAM_OPEN = `<${NS}parameter\\s+name\\s*=\\s*["']([^"']+)["']\\s*>`;
const PARAM_CLOSE = `</${NS}parameter\\s*>`;
/** The wrapper Claude puts around a run of invokes, junk once they are cut. Eats
 *  its own line so removing it does not leave a blank one behind. */
const EMPTY_WRAPPER = new RegExp(
	`[ \\t]*<${NS}function_calls\\s*>\\s*</${NS}function_calls\\s*>[ \\t]*\\n?`,
	"g",
);

/** Ids we mint ourselves. Same shape as a Claude Code tool_use id — opaque and
 *  id-safe, so a synthesized call converts, sanitizes and pairs like any other —
 *  but recognizable, because a result keyed to one has no Claude Code counterpart:
 *  CC ended that turn as plain text, so no MCP handler is parked on the id and no
 *  live query is left to resume. See recoveredToolResultPending. */
const RECOVERED_ID_PREFIX = "toolu_recovered_";

/** Prompt for the turn that carries a recovered call's result back to Claude.
 *  The result itself rides in the rebuilt transcript; pi's context ends on it, so
 *  there is no user message to extract and the turn needs a nudge to continue. */
export const RECOVERED_CONTINUATION_PROMPT = "[continue: tool result above]";

/** Recovered ids carry their own prefix: pi's own transcript is the only place a
 *  result for one of these comes back, and the continuation turn has to be able
 *  to tell it from a real tool_use id Claude issued. */
function newRecoveredToolCallId(): string {
	return `${RECOVERED_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

export function isRecoveredToolCallId(id: unknown): boolean {
	return typeof id === "string" && id.startsWith(RECOVERED_ID_PREFIX);
}

/** One `<invoke>` block found in assistant text. Values stay as written: XML
 *  carries no types, and the tool's own schema is the only thing that knows which
 *  of them is a number — see coerceInvokeArgs. `start`/`end` span the literal
 *  source so it can be cut once a real call represents it. */
export interface ParsedInvoke {
	/** Tool name exactly as written in the tag. */
	name: string;
	arguments: Record<string, string>;
	start: number;
	end: number;
}

/** Fresh regex per scan: the parser nests scans, and sharing `lastIndex` between
 *  an outer and an inner loop is how these get subtly wrong. Only compiled when
 *  the text actually mentions an invoke, which is the rare case. */
function scanFrom(source: string, text: string, from: number): RegExpExecArray | null {
	const re = new RegExp(source, "g");
	re.lastIndex = from;
	return re.exec(text);
}

/** Parameters of one invoke body, or null if the body is malformed — an opening
 *  `<parameter>` with no close means the text was truncated mid-call. */
function parseParameters(body: string): Record<string, string> | null {
	const args: Record<string, string> = {};
	const open = new RegExp(PARAM_OPEN, "g");
	let match: RegExpExecArray | null;
	while ((match = open.exec(body)) !== null) {
		const valueStart = match.index + match[0].length;
		// indexOf-style search for the close tag, never a greedy regex over the
		// body: a parameter value is arbitrary text — newlines, code, `<`, XML —
		// and a `[^<]*` or `.*` pattern either truncates it or swallows the
		// sibling parameters after it.
		const close = scanFrom(PARAM_CLOSE, body, valueStart);
		if (!close) return null;
		args[match[1]] = body.slice(valueStart, close.index);
		open.lastIndex = close.index + close[0].length;
	}
	return args;
}

/** Every well-formed `<invoke>` block in `text`, in source order. Malformed and
 *  truncated blocks are skipped rather than guessed at. */
export function parseInvokeBlocks(text: string): ParsedInvoke[] {
	const found: ParsedInvoke[] = [];
	if (!text.includes("invoke")) return found;
	const open = new RegExp(INVOKE_OPEN, "g");
	let match: RegExpExecArray | null;
	while ((match = open.exec(text)) !== null) {
		const bodyStart = match.index + match[0].length;
		const close = scanFrom(INVOKE_CLOSE, text, bodyStart);
		if (!close) break; // truncated: nothing from here on is a finished call
		// A close tag that sits past the next opening tag belongs to that block,
		// not this one — this one was never closed. Resume at the sibling rather
		// than parsing the two as a single invoke.
		const nextOpen = scanFrom(INVOKE_OPEN, text, bodyStart);
		if (nextOpen && nextOpen.index < close.index) {
			open.lastIndex = nextOpen.index;
			continue;
		}
		const args = parseParameters(text.slice(bodyStart, close.index));
		const end = close.index + close[0].length;
		if (args) found.push({ name: match[1], arguments: args, start: match.index, end });
		open.lastIndex = end;
	}
	return found;
}

/** A JSON-Schema-ish view of a tool's parameters — enough of TypeBox's output to
 *  tell a declared number from a declared string. */
interface ParamSchema {
	properties?: Record<string, { type?: unknown } | undefined>;
}

/** Give each parsed parameter the type its tool declares.
 *
 *  Every value arrives as text because XML has no types, and a tool that wants
 *  `timeout: 120` rejects `"120"`. Guessing from the value's shape instead is the
 *  trap: it turns a file body of `42`, an id of `007`, or a commit message of
 *  `true` into the wrong type, and those are exactly the parameters a recovered
 *  call is most likely to be writing somewhere. So only a declared non-string
 *  type converts, and only when the text round-trips back to itself — anything
 *  else stays the string Claude wrote and fails in the tool's own validator
 *  rather than silently writing the wrong bytes.
 *
 *  Runs after the caller's key renaming, so `schema` is keyed by the names the pi
 *  tool declares; values the renamer already typed are passed through. */
export function coerceInvokeArgs(
	args: Record<string, unknown>,
	schema: unknown,
): Record<string, unknown> {
	const properties = (schema as ParamSchema | undefined)?.properties;
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(args)) {
		const declared = properties?.[key]?.type;
		if (typeof raw !== "string") {
			out[key] = raw;
		} else if (declared === "number" || declared === "integer") {
			const num = Number(raw);
			out[key] = raw.trim() !== "" && Number.isFinite(num) && String(num) === raw.trim() ? num : raw;
		} else if (declared === "boolean") {
			out[key] = raw === "true" ? true : raw === "false" ? false : raw;
		} else if (declared === "array" || declared === "object") {
			try {
				const parsed: unknown = JSON.parse(raw);
				out[key] = Array.isArray(parsed) === (declared === "array") && parsed !== null && typeof parsed === "object" ? parsed : raw;
			} catch {
				out[key] = raw;
			}
		} else {
			out[key] = raw;
		}
	}
	return out;
}

/** Remove `spans` from `text`, taking each block's own line with it when it had
 *  one to itself. Widening is per-span and computed against the original offsets,
 *  so the surrounding answer is returned byte for byte — a blanket
 *  trailing-whitespace or blank-line normalization would edit prose and code the
 *  leak never touched. */
function cutSpans(text: string, spans: ParsedInvoke[]): string {
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		let start = span.start;
		let end = span.end;
		while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
		while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
		// Alone on its lines: take the line break too, or cutting leaves a hole.
		const ownLine = (start === 0 || text[start - 1] === "\n") && text[end] === "\n";
		if (ownLine) end++;
		if (start < cursor) start = cursor; // adjacent blocks sharing a break
		out += text.slice(cursor, start);
		// A draft between two blank lines leaves both separators behind. One is
		// the paragraph break the prose already had; the other only existed to
		// set the draft apart, so it goes with it. Decided at this boundary, not
		// by normalizing the whole answer.
		if (ownLine && out.endsWith("\n\n") && text[end] === "\n") end++;
		cursor = end;
	}
	out += text.slice(cursor);
	return out.replace(EMPTY_WRAPPER, "").trim();
}

export interface RecoveredCall {
	id: string;
	/** pi tool name, already resolved and served. */
	name: string;
	arguments: Record<string, unknown>;
}

export interface InvokeRecoveryPlan {
	/** Text blocks whose literal draft a real call now represents. */
	rewrites: Array<{ blockIndex: number; text: string }>;
	calls: RecoveredCall[];
}

export interface InvokeRecoveryOptions {
	/** True when this turn already emitted a structured tool call. */
	sawToolCall: boolean;
	/** pi name for a name Claude wrote, or undefined when the bridge does not
	 *  serve it this turn. */
	resolveToolName: (name: string) => string | undefined;
	/** The same argument shaping a structured tool_use gets, plus schema typing. */
	mapArgs: (piName: string, args: Record<string, string>) => Record<string, unknown>;
}

/** What to do about literal invoke text in a finished turn, or null for the
 *  overwhelmingly common case of nothing to do.
 *
 *  Pure: the caller applies the plan, which is what keeps this testable without a
 *  pi stream. Two rules do all the deciding:
 *
 *  - a tool the bridge does not serve this turn is left as plain text. Claude
 *    writing about a tool is not Claude calling one, and synthesizing a call
 *    nobody serves only trades a stall for a failure.
 *  - when the turn already has a structured call, nothing is synthesized. That
 *    turn continues on its own, and an extra call from a draft Claude did not
 *    dispatch would run a real side effect it never asked for. */
export function planInvokeRecovery(
	blocks: ReadonlyArray<{ type: string; text?: string; name?: string }>,
	options: InvokeRecoveryOptions,
): InvokeRecoveryPlan | null {
	const rewrites: InvokeRecoveryPlan["rewrites"] = [];
	const calls: RecoveredCall[] = [];
	const structured = new Set(
		blocks.filter((b) => b.type === "toolCall" && b.name).map((b) => b.name as string),
	);

	blocks.forEach((block, blockIndex) => {
		if (block.type !== "text" || !block.text) return;
		const cut: ParsedInvoke[] = [];
		for (const invoke of parseInvokeBlocks(block.text)) {
			const piName = options.resolveToolName(invoke.name);
			if (!piName) continue;
			// Matched by tool name only: a draft and the call it became routinely
			// differ in their arguments, and suppressing on name is what stops the
			// user seeing the same command twice.
			if (structured.has(piName)) { cut.push(invoke); continue; }
			if (options.sawToolCall) continue;
			calls.push({ id: newRecoveredToolCallId(), name: piName, arguments: options.mapArgs(piName, invoke.arguments) });
			cut.push(invoke);
		}
		if (cut.length) rewrites.push({ blockIndex, text: cutSpans(block.text, cut) });
	});

	return rewrites.length || calls.length ? { rewrites, calls } : null;
}

/** True when the tool results pi just delivered include one for a call we
 *  synthesized. Walks the same context tail as extractAllToolResults: results
 *  back to the assistant message that owns them, past any steer between them. */
export function recoveredToolResultPending(
	messages: ReadonlyArray<{ role: string; toolCallId?: string }>,
): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			if (isRecoveredToolCallId(msg.toolCallId)) return true;
		} else if (msg.role === "assistant") break;
	}
	return false;
}
