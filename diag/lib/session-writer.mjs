// Candidate rebuild writer, for diag/probe-writer.mjs: the records a rebuild
// should write so Claude Code sends the request it would have sent natively.
// Load with `node --import tsx` (imports the bridge's own conversion).
//
// - Messages come from pi's history, converted exactly as the bridge's rebuild
//   does (convertPiMessages, then cc-session-io's importMessages), so pi stays
//   the source of message content.
// - Optionally (`nativeToolDetails`) with Claude Code's details of tool blocks:
//   tool_result blocks in CC's stored shape and each tool_use input as CC sent it.
// - Every attachment record of the replaced session is copied verbatim
//   (`rendered`, `renderedRole`, every field), after the converted message that
//   corresponds to the native message it followed. Native and converted messages
//   are matched by content -- tool_use/tool_result ids, thinking signatures,
//   user and assistant text -- never by position. An attachment that cannot be
//   placed unambiguously throws.
// - `prompt_snapshot` attachments are left out unless asked for (they freeze the
//   system prompt and tools), as are attachments following a message past the
//   last one pi's history has. Other non-message records (queue-operation,
//   last-prompt, cost-state, ...) are not written.
// - One parentUuid chain over the result, all under the new session id.

import { createSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../../src/convert.js";
import { nonSystemMessages } from "../../src/transcript.js";

const isMessage = (record) => record.type === "user" || record.type === "assistant";
const isChain = (record) => isMessage(record) || record.type === "attachment";
const textOf = (content) => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";

/** The history a rebuild writes from a provider call's messages: what precedes
 *  the current user turn, without transcript system messages (as syncSharedSession). */
export function priorMessages(messages) {
	const history = nonSystemMessages(messages);
	let start = history.length;
	while (start > 0 && history[start - 1].role === "user") start--;
	return history.slice(0, start);
}

/** pi messages as the bridge's rebuild writes them: cc-session-io records, chained. */
export function convertedRecords(messages, servedToolNames, { sessionId, projectPath, model }) {
	const { anthropicMessages } = convertPiMessages(messages, new Map(Object.entries(servedToolNames)));
	const session = createSession({ projectPath, sessionId, ...(model ? { model } : {}) });
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length) session.importMessages(repaired);
	return [...session.records];
}

/** What identifies a message record's content, independent of how CC split it into records. */
export function contentKeys(record) {
	const content = record.message?.content;
	if (record.type === "assistant") {
		return (Array.isArray(content) ? content : [{ type: "text", text: content }]).flatMap((b) =>
			b.type === "tool_use" ? [`tool_use ${b.id}`]
			: b.type === "thinking" ? [`thinking ${b.signature}`]
			: b.type === "redacted_thinking" ? [`redacted_thinking ${b.data}`]
			: b.type === "text" && b.text ? [`assistant ${b.text}`] : []);
	}
	if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
		return content.filter((b) => b.type === "tool_result").map((b) => `tool_result ${b.tool_use_id}`);
	}
	const text = textOf(content);
	return text ? [`user ${text}`] : [];
}

/** Converted records with tool_result blocks as CC stores them (text as a block
 *  array, CC's key order) and each tool_use input taken from the native record with
 *  the same tool id (pi's copy can carry arguments the bridge added, #203). */
function withNativeToolDetails(converted, native) {
	const inputs = new Map(native.flatMap((r) => r.type === "assistant" && Array.isArray(r.message.content) ? r.message.content : [])
		.filter((b) => b.type === "tool_use").map((b) => [b.id, b.input]));
	const detail = (block) => {
		if (block.type === "tool_use") {
			if (!inputs.has(block.id)) throw new Error(`tool_use ${block.id} is not in the native session`);
			return { ...block, input: inputs.get(block.id) };
		}
		if (block.type !== "tool_result") return block;
		const { tool_use_id, type, content, ...rest } = block;
		return { tool_use_id, type, content: typeof content === "string" ? [{ type: "text", text: content }] : content, ...rest };
	};
	return converted.map((r) => Array.isArray(r.message?.content) ? { ...r, message: { ...r.message, content: r.message.content.map(detail) } } : r);
}

/** Message records whose content must never reach a rebuild. */
function mustNotCopy(record) {
	if (record.isApiErrorMessage) return "api-error message";
	if (record.type === "user" && textOf(record.message?.content).startsWith("[Request interrupted by user")) return "interrupted marker";
	return null;
}

const describe = (record) => `${record.type} ${record.uuid} (${contentKeys(record)[0]?.slice(0, 60) ?? "no content key"})`;

/**
 * Map each native message record to the converted record holding its content.
 * Returns native index -> converted index, for the records that map.
 */
function mapMessages(native, converted) {
	const convertedKeys = converted.map((record) => new Set(contentKeys(record)));
	const rows = native.map((record, index) => ({ record, index })).filter(({ record }) => isMessage(record)).map((row) => {
		const keys = mustNotCopy(row.record) ? [] : contentKeys(row.record);
		const candidates = keys.length ? convertedKeys.flatMap((set, i) => keys.every((key) => set.has(key)) ? [i] : []) : [];
		return { ...row, candidates, at: candidates.length === 1 ? candidates[0] : undefined };
	});
	// Duplicate content (the same prompt twice) narrows to the window between its
	// uniquely mapped neighbours; still more than one candidate stays unmapped.
	for (const [i, row] of rows.entries()) {
		if (row.at !== undefined || row.candidates.length < 2) continue;
		const lo = rows.slice(0, i).findLast((r) => r.at !== undefined)?.at ?? -1;
		const hi = rows.slice(i + 1).find((r) => r.at !== undefined)?.at ?? Infinity;
		const within = row.candidates.filter((c) => c >= lo && c <= hi);
		if (within.length === 1) row.at = within[0];
	}
	const mapped = rows.filter((row) => row.at !== undefined);
	for (let i = 1; i < mapped.length; i++) {
		if (mapped[i].at < mapped[i - 1].at) {
			throw new Error(`native and pi histories disagree on order: ${describe(mapped[i].record)} maps before ${describe(mapped[i - 1].record)}`);
		}
	}
	return new Map(mapped.map((row) => [row.index, row.at]));
}

/**
 * The records a rebuild should write.
 *
 * @param {object} opts
 * @param {object[]} opts.native - records of the Claude Code session being replaced
 * @param {object[]} opts.messages - pi messages to write (see priorMessages)
 * @param {Record<string,string>} opts.servedToolNames - pi -> served tool names
 * @param {string} opts.sessionId - the session id to write under
 * @param {string} opts.projectPath
 * @param {string} [opts.model]
 * @param {boolean} [opts.keepPromptSnapshot=false]
 * @param {boolean} [opts.nativeToolDetails=false] - see withNativeToolDetails
 */
export function rebuildRecords({ native, messages, servedToolNames, sessionId, projectPath, model, keepPromptSnapshot = false, nativeToolDetails = false }) {
	const fromPi = convertedRecords(messages, servedToolNames, { sessionId, projectPath, model });
	const converted = nativeToolDetails ? withNativeToolDetails(fromPi, native) : fromPi;
	const mapping = mapMessages(native, converted);
	const lastMapped = Math.max(-1, ...mapping.keys());
	const indexOf = new Map(native.map((record, index) => [record.uuid, index]));
	const following = new Map(); // converted index (-1: before the first) -> attachments
	const placed = [];
	const omitted = [];
	const skippedTypes = {};

	for (const [index, record] of native.entries()) {
		if (isMessage(record)) {
			const reason = mustNotCopy(record);
			if (reason) omitted.push({ uuid: record.uuid, type: record.type, reason });
			continue;
		}
		if (record.type !== "attachment") {
			skippedTypes[record.type] = (skippedTypes[record.type] ?? 0) + 1;
			continue;
		}
		const kind = record.attachment?.type;
		if (kind === "prompt_snapshot" && !keepPromptSnapshot) {
			omitted.push({ uuid: record.uuid, type: kind, reason: "prompt_snapshot" });
			continue;
		}
		// The message this attachment follows: up its parent chain (attachments chain
		// to each other), which must agree with the last message before it in the file.
		let anchor = null;
		for (let parent = record.parentUuid; parent != null;) {
			const at = indexOf.get(parent);
			if (at === undefined) throw new Error(`attachment ${record.uuid} (${kind}) has a parent ${parent} that is not in the session`);
			if (isMessage(native[at])) { anchor = at; break; }
			parent = native[at].parentUuid;
		}
		const fileAnchor = native.slice(0, index).findLastIndex(isMessage);
		if ((anchor ?? -1) !== fileAnchor) {
			throw new Error(`attachment ${record.uuid} (${kind}): its parent chain leads to record ${anchor}, but it sits after record ${fileAnchor} in the file`);
		}
		if (anchor === null) {
			following.set(-1, [...(following.get(-1) ?? []), record]);
			placed.push({ uuid: record.uuid, type: kind, after: null });
			continue;
		}
		const target = mapping.get(anchor);
		if (target === undefined) {
			if (anchor > lastMapped) {
				omitted.push({ uuid: record.uuid, type: kind, reason: "follows a message past the end of pi's history" });
				continue;
			}
			throw new Error(`attachment ${record.uuid} (${kind}) follows ${describe(native[anchor])}, which has no unambiguous match in pi's history`);
		}
		// Placing it after the converted message would move it past the rest of a
		// message CC split across records.
		const later = native.slice(index + 1).findIndex((r, i) => isMessage(r) && mapping.get(index + 1 + i) === target);
		if (later !== -1) {
			throw new Error(`attachment ${record.uuid} (${kind}) sits inside a message: ${describe(native[index + 1 + later])} comes after it and maps to the same message`);
		}
		following.set(target, [...(following.get(target) ?? []), record]);
		placed.push({ uuid: record.uuid, type: kind, after: contentKeys(converted[target])[0] ?? null });
	}

	const ordered = [...(following.get(-1) ?? [])];
	for (const [i, record] of converted.entries()) ordered.push(record, ...(following.get(i) ?? []));
	let parentUuid = null;
	const records = ordered.map((record) => {
		const copy = structuredClone(record);
		copy.parentUuid = parentUuid;
		copy.sessionId = sessionId;
		parentUuid = copy.uuid;
		return copy;
	});
	return { records, placed, omitted, skippedTypes, mappedMessages: mapping.size };
}

/**
 * Native records up to and including record `cut` (verbatim but for the session
 * id), then the bridge's conversion of `messages`, chained onto the last kept
 * chain record.
 */
export function prefixRecords({ native, cut, messages, servedToolNames, sessionId, projectPath, model }) {
	const kept = native.slice(0, cut + 1).map((record) => record.sessionId ? { ...record, sessionId } : record);
	const tail = convertedRecords(messages, servedToolNames, { sessionId, projectPath, model });
	if (tail.length) tail[0] = { ...tail[0], parentUuid: kept.findLast(isChain)?.uuid ?? null };
	return [...kept, ...tail];
}
