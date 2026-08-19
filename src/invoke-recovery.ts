// Recovers literal `<invoke>` text when Claude ends a turn without a tool call.
// Parsing is strict: malformed input remains visible rather than running a
// partial command.

import { randomUUID } from "node:crypto";

const NS = "([A-Za-z][\\w.-]*:)?";
const INVOKE_OPEN = `<${NS}invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>`;
const PARAM_OPEN = `<${NS}parameter\\s+name\\s*=\\s*["']([^"']+)["']\\s*>`;

function closeTag(prefix: string | undefined, name: "invoke" | "parameter"): string {
	return `</${prefix ?? ""}${name}\\s*>`;
}

const RECOVERED_ID_PREFIX = "toolu_recovered_";

export const RECOVERED_CONTINUATION_PROMPT = "[continue: tool result above]";

function newRecoveredToolCallId(): string {
	return `${RECOVERED_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

export function isRecoveredToolCallId(id: unknown): boolean {
	return typeof id === "string" && id.startsWith(RECOVERED_ID_PREFIX);
}

/** One strict `<invoke>` block found in assistant text. */
export interface ParsedInvoke {
	name: string;
	arguments: Record<string, string>;
}

function scanFrom(source: string, text: string, from: number): RegExpExecArray | null {
	const re = new RegExp(source, "g");
	re.lastIndex = from;
	return re.exec(text);
}

/** Parse a body containing only whitespace-delimited, fully matched parameters. */
function parseParameters(body: string): Record<string, string> | null {
	const args: Record<string, string> = {};
	let cursor = 0;
	while (cursor < body.length) {
		const whitespace = /^[\t\n\r ]*/.exec(body.slice(cursor))![0];
		cursor += whitespace.length;
		if (cursor === body.length) return args;
		const open = scanFrom(PARAM_OPEN, body, cursor);
		if (!open || open.index !== cursor || args[open[2]] !== undefined) return null;
		const valueStart = cursor + open[0].length;
		const close = scanFrom(closeTag(open[1], "parameter"), body, valueStart);
		if (!close) return null;
		args[open[2]] = body.slice(valueStart, close.index);
		cursor = close.index + close[0].length;
	}
	return args;
}

/** Every strict, complete `<invoke>` block in source order. */
export function parseInvokeBlocks(text: string): ParsedInvoke[] {
	const found: ParsedInvoke[] = [];
	if (!text.includes("invoke")) return found;
	const open = new RegExp(INVOKE_OPEN, "g");
	let match: RegExpExecArray | null;
	while ((match = open.exec(text)) !== null) {
		const bodyStart = match.index + match[0].length;
		const close = scanFrom(closeTag(match[1], "invoke"), text, bodyStart);
		if (!close) break;
		const nextOpen = scanFrom(INVOKE_OPEN, text, bodyStart);
		if (nextOpen && nextOpen.index < close.index) return found;
		const args = parseParameters(text.slice(bodyStart, close.index));
		const end = close.index + close[0].length;
		if (args) found.push({ name: match[2], arguments: args });
		open.lastIndex = end;
	}
	return found;
}

/** A JSON-Schema-ish view of a tool's parameters. */
interface ParamSchema {
	properties?: Record<string, { type?: unknown } | undefined>;
}

/** Coerce only types explicitly declared by the tool schema. */
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
			out[key] = raw.trim() !== ""
				&& Number.isFinite(num)
				&& (declared !== "integer" || Number.isInteger(num))
				&& String(num) === raw.trim()
				? num
				: raw;
		} else if (declared === "boolean") {
			out[key] = raw === "true" ? true : raw === "false" ? false : raw;
		} else if (declared === "array" || declared === "object") {
			try {
				const parsed: unknown = JSON.parse(raw);
				out[key] = (declared === "array"
					? Array.isArray(parsed)
					: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
					? parsed
					: raw;
			} catch {
				out[key] = raw;
			}
		} else {
			out[key] = raw;
		}
	}
	return out;
}

export interface RecoveredCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface InvokeRecoveryPlan {
	calls: RecoveredCall[];
}

export interface InvokeRecoveryOptions {
	sawToolCall: boolean;
	resolveToolName: (name: string) => string | undefined;
	mapArgs: (piName: string, args: Record<string, string>) => Record<string, unknown>;
}

/** Plan recovered calls for a completed turn.
 *
 * Literal text is never suppressed: streaming may already have exposed it, and
 * a same-name draft can differ from the structured call beside it. */
export function planInvokeRecovery(
	blocks: ReadonlyArray<{ type: string; text?: string }>,
	options: InvokeRecoveryOptions,
): InvokeRecoveryPlan | null {
	const calls: RecoveredCall[] = [];
	const recovered = new Set<string>();

	blocks.forEach((block) => {
		if (block.type !== "text" || !block.text || options.sawToolCall) return;
		for (const invoke of parseInvokeBlocks(block.text)) {
			const piName = options.resolveToolName(invoke.name);
			if (!piName) continue;
			const arguments_ = options.mapArgs(piName, invoke.arguments);
			const identity = JSON.stringify([piName, arguments_]);
			if (recovered.has(identity)) continue;
			recovered.add(identity);
			calls.push({ id: newRecoveredToolCallId(), name: piName, arguments: arguments_ });
		}
	});

	return calls.length ? { calls } : null;
}

/** Whether the newest turn contains a synthesized call result. */
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
