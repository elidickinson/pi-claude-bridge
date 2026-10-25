// Isolated mutations for cache probes. These operate on copied probe JSONL only;
// callers must never point them at a user's production Claude session.
export const CONTEXT_ATTACHMENT_TYPES = new Set([
	"total_tokens_reminder", "environment", "model", "session_context", "date",
]);

function toolResultBlocks(records) {
	return records.flatMap((record) => record.type === "user" && Array.isArray(record.message?.content)
		? record.message.content.filter((block) => block?.type === "tool_result").map((block) => ({ record, block }))
		: []);
}

function dropContextAttachments(records) {
	const removed = records.filter((record) => record.type === "attachment" && CONTEXT_ATTACHMENT_TYPES.has(record.attachment?.type));
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
}

function changeToolResultContentShape(records) {
	let changed = 0;
	const transitions = [];
	const result = records.map((record) => {
		if (record.type !== "user" || !Array.isArray(record.message?.content)) return record;
		let recordChanged = false;
		const content = record.message.content.map((block) => {
			if (block?.type !== "tool_result") return block;
			if (typeof block.content === "string") {
				recordChanged = true;
				changed++;
				transitions.push({ from: "string", to: "array" });
				return { ...block, content: [{ type: "text", text: block.content }] };
			}
			if (Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === "text"
				&& typeof block.content[0].text === "string" && Object.keys(block.content[0]).length === 2) {
				recordChanged = true;
				changed++;
				transitions.push({ from: "array", to: "string" });
				return { ...block, content: block.content[0].text };
			}
			return block;
		});
		if (!recordChanged) return record;
		return { ...record, message: { ...record.message, content } };
	});
	return { records: result, changed, details: { eligible: toolResultBlocks(records).length, transitions } };
}

function reorderToolResultKeys(records) {
	let changed = 0;
	const result = records.map((record) => {
		if (record.type !== "user" || !Array.isArray(record.message?.content)) return record;
		let recordChanged = false;
		const content = record.message.content.map((block) => {
			if (block?.type !== "tool_result" || Object.keys(block).length < 2) return block;
			recordChanged = true;
			changed++;
			return Object.fromEntries(Object.entries(block).reverse());
		});
		return recordChanged ? { ...record, message: { ...record.message, content } } : record;
	});
	return { records: result, changed, details: { eligible: toolResultBlocks(records).length } };
}

const MUTATIONS = {
	"drop-context-attachments": dropContextAttachments,
	"tool-result-content-shape": changeToolResultContentShape,
	"tool-result-key-order": reorderToolResultKeys,
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
