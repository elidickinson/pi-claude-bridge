import { randomUUID } from "node:crypto";

// Isolated mutations for cache probes. These operate on copied probe JSONL only;
// callers must never point them at a user's production Claude session.
export const CONTEXT_ATTACHMENT_TYPES = new Set([
	"total_tokens_reminder", "environment", "model", "session_context", "date",
]);

// Attachment types a native session carries, each dropped alone as `drop-attachment-<type>`.
// A rebuild drops all of them; `credential_org` and `prompt_snapshot` are not rendered as reminders.
const SINGLE_ATTACHMENT_TYPES = ["environment", "model", "instructions", "session_context", "date", "credential_org", "prompt_snapshot"];

function toolResultBlocks(records) {
	return records.flatMap((record) => record.type === "user" && Array.isArray(record.message?.content)
		? record.message.content.filter((block) => block?.type === "tool_result").map((block) => ({ record, block }))
		: []);
}

/** Replace tool_result blocks; `change` returns the new block, or undefined to keep one. */
function mapToolResults(records, change) {
	let changed = 0;
	const result = records.map((record) => {
		if (record.type !== "user" || !Array.isArray(record.message?.content)) return record;
		let recordChanged = false;
		const content = record.message.content.map((block) => {
			const next = block?.type === "tool_result" ? change(block) : undefined;
			if (!next) return block;
			recordChanged = true;
			changed++;
			return next;
		});
		return recordChanged ? { ...record, message: { ...record.message, content } } : record;
	});
	return { records: result, changed, details: { eligible: toolResultBlocks(records).length } };
}

const dropAttachments = (types) => (records) => {
	const removed = records.filter((record) => record.type === "attachment" && types.has(record.attachment?.type));
	const removedIds = new Set(removed.map((record) => record.uuid));
	const parents = new Map(records.map((record) => [record.uuid, record.parentUuid]));
	const resolveParent = (uuid) => {
		const seen = new Set();
		while (removedIds.has(uuid) && !seen.has(uuid)) {
			seen.add(uuid);
			uuid = parents.get(uuid);
		}
		return uuid ?? null;
	};
	const kept = records.filter((record) => !removedIds.has(record.uuid)).map((record) => {
		if (!removedIds.has(record.parentUuid)) return record;
		return { ...record, parentUuid: resolveParent(record.parentUuid) };
	});
	return { records: kept, changed: removed.length, details: { removed: removed.map((record) => record.attachment.type) } };
};

function changeToolResultContentShape(records) {
	const transitions = [];
	const mutation = mapToolResults(records, (block) => {
		if (typeof block.content === "string") {
			transitions.push({ from: "string", to: "array" });
			return { ...block, content: [{ type: "text", text: block.content }] };
		}
		if (Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === "text"
			&& typeof block.content[0].text === "string" && Object.keys(block.content[0]).length === 2) {
			transitions.push({ from: "array", to: "string" });
			return { ...block, content: block.content[0].text };
		}
	});
	return { ...mutation, details: { ...mutation.details, transitions } };
}

/** Strip one trailing "\n" from tool_result text blocks, keeping the array shape. */
function stripToolResultTrailingNewline(records) {
	return mapToolResults(records, (block) => {
		if (!Array.isArray(block.content) || !block.content.some((item) => item?.type === "text" && item.text?.endsWith("\n"))) return;
		return { ...block, content: block.content.map((item) => item?.type === "text" && item.text?.endsWith("\n") ? { ...item, text: item.text.slice(0, -1) } : item) };
	});
}

function reorderToolResultKeys(records) {
	return mapToolResults(records, (block) => Object.keys(block).length < 2 ? undefined : Object.fromEntries(Object.entries(block).reverse()));
}

/** User message content that is exactly one plain text block becomes a string. */
function userContentSingleBlockToString(records) {
	let changed = 0;
	const result = records.map((record) => {
		const content = record.type === "user" ? record.message?.content : undefined;
		if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text"
			|| typeof content[0].text !== "string" || Object.keys(content[0]).length !== 2) return record;
		changed++;
		return { ...record, message: { ...record.message, content: content[0].text } };
	});
	return { records: result, changed, details: {} };
}

/** Change one character of the first attachment of `type`, keeping the record:
 *  a pure in-place value change, with no record removed for Claude Code to re-add. */
const editAttachment = (type, field) => (records) => {
	const at = records.findIndex((record) => record.type === "attachment" && record.attachment?.type === type && typeof record.attachment[field] === "string");
	if (at === -1) return { records, changed: 0, details: { type } };
	const before = records[at].attachment[field];
	// The last digit, moved by one: same length, same shape.
	const after = before.replace(/(\d)(\D*)$/, (_, d, rest) => `${d === "0" ? 1 : Number(d) - 1}${rest}`);
	const changed = records.map((record, i) => i === at ? { ...record, attachment: { ...record.attachment, [field]: after } } : record);
	return { records: changed, changed: before === after ? 0 : 1, details: { type, field, before, after } };
};

/** The same records under a new session id: what a rotated rebuild sends, minus
 *  every content change. The caller resumes the returned id. */
function rotateSessionId(records) {
	const sessionId = randomUUID();
	const changed = records.filter((record) => record.sessionId).length;
	return { records: records.map((record) => record.sessionId ? { ...record, sessionId } : record), changed, sessionId, details: { sessionId } };
}

const MUTATIONS = {
	"drop-context-attachments": dropAttachments(CONTEXT_ATTACHMENT_TYPES),
	"drop-total-tokens-reminders": dropAttachments(new Set(["total_tokens_reminder"])),
	...Object.fromEntries(SINGLE_ATTACHMENT_TYPES.map((type) => [`drop-attachment-${type}`, dropAttachments(new Set([type]))])),
	"tool-result-content-shape": changeToolResultContentShape,
	"tool-result-trailing-newline": stripToolResultTrailingNewline,
	"tool-result-key-order": reorderToolResultKeys,
	"user-content-single-block-to-string": userContentSingleBlockToString,
	"edit-attachment-date": editAttachment("date", "date"),
	"edit-total-tokens-reminder": editAttachment("total_tokens_reminder", "text"),
	"rotate-session-id": rotateSessionId,
};

export const MUTATION_NAMES = Object.keys(MUTATIONS);

export function mutateSessionRecords(records, name) {
	const mutate = MUTATIONS[name];
	if (!mutate) throw new Error(`unknown session mutation: ${name}`);
	return { name, ...mutate(records) };
}

export function mutateSessionJsonl(jsonl, name) {
	const records = jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const mutation = mutateSessionRecords(records, name);
	return {
		...mutation,
		jsonl: mutation.records.map((record) => JSON.stringify(record)).join("\n") + "\n",
	};
}
