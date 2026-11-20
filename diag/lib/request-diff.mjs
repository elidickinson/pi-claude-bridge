// Request comparisons for cache probes. Keep the raw form as the evidence; the
// normalized form excludes only known non-cache differences from the fidelity probe.
export const BILLING_HEADER = "x-anthropic-billing-header";

function withoutCacheControl(value) {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCacheControl(item)]));
	}
	return value;
}

function contentAsString(message) {
	const content = message.content;
	const plain = Array.isArray(content) && content.length === 1 && content[0].type === "text" && Object.keys(content[0]).length === 2;
	return plain ? { ...message, content: content[0].text } : message;
}

const kinds = (message) => typeof message.content === "string" ? "text" : (message.content ?? []).map((block) => block.type).join("+");
const signature = (value) => JSON.stringify(value);

/** Prompt elements in cache order. Normalization never renumbers system paths. */
export function requestElements(body, normalized = false) {
	const system = Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [];
	const clean = normalized ? withoutCacheControl : (value) => value;
	return [
		{ label: "tools", value: clean(body.tools ?? []) },
		...system.map((block, index) => ({ block, index })).filter(({ block }) => !normalized || !String(block.text ?? "").startsWith(BILLING_HEADER))
			.map(({ block, index }) => ({ label: `system[${index}]`, value: clean(block), index })),
		...body.messages.map((message, index) => {
			const value = normalized ? contentAsString(clean(message)) : message;
			return { label: `messages[${index}] ${value.role}/${kinds(value)}`, index, value };
		}),
	];
}

function brief(value) {
	if (typeof value === "string") return { type: "string", length: value.length, preview: value.slice(0, 120) };
	const json = JSON.stringify(value);
	return { type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value, preview: json.length > 180 ? `${json.slice(0, 180)}…` : json };
}

function stringSimilarity(left, right) {
	let start = 0;
	while (start < left.length && start < right.length && left[start] === right[start]) start++;
	let end = 0;
	while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
	return Math.max(start + end, 0) / Math.max(left.length, right.length, 1);
}

function similarity(left, right) {
	if (signature(left) === signature(right)) return 1;
	if (typeof left === "string" && typeof right === "string") return stringSimilarity(left, right);
	if (Array.isArray(left) && Array.isArray(right)) {
		const aligned = alignSequence(left, right);
		return aligned.matches.reduce((sum, match) => sum + similarity(left[match.from], right[match.to]), 0)
			/ Math.max(left.length, right.length, 1);
	}
	if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
		return keys.reduce((sum, key) => sum + (Object.hasOwn(left, key) && Object.hasOwn(right, key)
			? similarity(left[key], right[key]) : 0), 0) / Math.max(keys.length, 1);
	}
	return 0;
}

function lcsPairs(before, after) {
	const n = before.length;
	const m = after.length;
	if (n * m > 4_000_000) {
		const positions = new Map();
		for (let j = 0; j < m; j++) {
			const key = signature(after[j]);
			const queue = positions.get(key) ?? [];
			queue.push(j);
			positions.set(key, queue);
		}
		const pairs = [];
		let last = -1;
		for (let i = 0; i < n; i++) {
			const queue = positions.get(signature(before[i]));
			const at = queue?.findIndex((index) => index > last) ?? -1;
			if (at !== -1) {
				last = queue[at];
				pairs.push({ from: i, to: last });
			}
		}
		return pairs;
	}
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
		const at = i * width + j;
		table[at] = signature(before[i]) === signature(after[j])
			? table[(i + 1) * width + j + 1] + 1
			: Math.max(table[(i + 1) * width + j], table[at + 1]);
	}
	const pairs = [];
	for (let i = 0, j = 0; i < n && j < m;) {
		if (signature(before[i]) === signature(after[j])) { pairs.push({ from: i++, to: j++ }); }
		else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
		else j++;
	}
	return pairs;
}

function reorderedPairs(before, after) {
	const positions = new Map();
	for (let j = 0; j < after.length; j++) {
		const key = signature(after[j]);
		const queue = positions.get(key) ?? [];
		queue.push(j);
		positions.set(key, queue);
	}
	const pairs = [];
	for (let i = 0; i < before.length; i++) {
		const queue = positions.get(signature(before[i]));
		if (queue?.length) pairs.push({ from: i, to: queue.shift() });
	}
	const moved = new Set();
	let maxTo = -1;
	let maxPair;
	for (const pair of pairs) {
		if (pair.to < maxTo) {
			moved.add(pair.from);
			moved.add(maxPair.from);
		} else if (pair.to > maxTo) {
			maxTo = pair.to;
			maxPair = pair;
		}
	}
	// Mark earlier items crossed by a later item too (the first item in an inversion).
	let minTo = Infinity;
	let minPair;
	for (let i = pairs.length - 1; i >= 0; i--) {
		const pair = pairs[i];
		if (pair.to > minTo) {
			moved.add(pair.from);
			moved.add(minPair.from);
		} else if (pair.to < minTo) {
			minTo = pair.to;
			minPair = pair;
		}
	}
	return pairs.filter((pair) => moved.has(pair.from));
}

/** Exact LCS anchors plus only high-confidence changed pairs; ambiguous gaps stay add/delete. */
function alignSequence(before, after) {
	const moved = reorderedPairs(before, after);
	const movedBefore = new Set(moved.map((pair) => pair.from));
	const movedAfter = new Set(moved.map((pair) => pair.to));
	const anchors = lcsPairs(before, after).filter((pair) => !movedBefore.has(pair.from) && !movedAfter.has(pair.to));
	const matches = [];
	let previous = { from: -1, to: -1 };
	for (const anchor of [...anchors, { from: before.length, to: after.length }]) {
		const oldGap = Array.from({ length: anchor.from - previous.from - 1 }, (_, index) => previous.from + 1 + index)
			.filter((index) => !movedBefore.has(index));
		const newGap = Array.from({ length: anchor.to - previous.to - 1 }, (_, index) => previous.to + 1 + index)
			.filter((index) => !movedAfter.has(index));
		let pair = null;
		if (oldGap.length === 1 && newGap.length === 1 && similarity(before[oldGap[0]], after[newGap[0]]) >= 0.18) {
			pair = { from: oldGap[0], to: newGap[0] };
		} else if (oldGap.length === 1 && newGap.length > 1) {
			const candidates = newGap.map((to) => ({ from: oldGap[0], to, score: similarity(before[oldGap[0]], after[to]) })).sort((a, b) => b.score - a.score);
			if (candidates[0].score >= 0.65 && candidates[0].score - (candidates[1]?.score ?? 0) >= 0.1) pair = candidates[0];
		} else if (newGap.length === 1 && oldGap.length > 1) {
			const candidates = oldGap.map((from) => ({ from, to: newGap[0], score: similarity(before[from], after[newGap[0]]) })).sort((a, b) => b.score - a.score);
			if (candidates[0].score >= 0.65 && candidates[0].score - (candidates[1]?.score ?? 0) >= 0.1) pair = candidates[0];
		}
		if (pair) matches.push(pair);
		if (anchor.from < before.length) matches.push(anchor);
		previous = anchor;
	}
	return { matches, moved, movedBefore, movedAfter };
}

function insertionOrder(index, matches) {
	const previous = matches.filter((match) => match.to < index).at(-1);
	const next = matches.find((match) => match.to > index);
	if (previous && next) return (previous.from + next.from) / 2;
	if (next) return next.from - 0.5;
	if (previous) return previous.from + 0.5;
	return 0;
}

function withAfterPath(diff, beforePath, afterPath) {
	return { ...diff, path: beforePath ?? afterPath, ...(beforePath === afterPath ? {} : { afterPath }) };
}

/** Enumerate recursive differences, aligning arrays before descending. */
function allDiffs(before, after, path = "", afterPath = path, alignments = []) {
	if (typeof before !== typeof after || Array.isArray(before) !== Array.isArray(after) || (before === null) !== (after === null)) {
		return [withAfterPath({ kind: "type-or-shape", before: brief(before), after: brief(after) }, path, afterPath)];
	}
	if (Array.isArray(before)) {
		const { matches, moved, movedBefore, movedAfter } = alignSequence(before, after);
		const pairs = new Map(matches.map((match) => [match.from, match]));
		const events = [];
		for (let from = 0; from < before.length; from++) {
			if (movedBefore.has(from)) {
				const move = moved.find((item) => item.from === from);
				events.push({ order: from, diff: withAfterPath({ kind: "reordered-array-item", from, to: move.to }, `${path}[${from}]`, `${afterPath}[${move.to}]`) });
			} else if (pairs.has(from)) {
				const { to } = pairs.get(from);
				alignments.push({ path: `${path}[${from}]`, afterPath: `${afterPath}[${to}]`, unchanged: signature(before[from]) === signature(after[to]) });
				for (const diff of allDiffs(before[from], after[to], `${path}[${from}]`, `${afterPath}[${to}]`, alignments)) events.push({ order: from, diff });
			} else events.push({ order: from, diff: withAfterPath({ kind: "missing-array-item", before: brief(before[from]), after: "<absent>" }, `${path}[${from}]`, null) });
		}
		for (let to = 0; to < after.length; to++) {
			if (!movedAfter.has(to) && !matches.some((match) => match.to === to)) {
				events.push({ order: insertionOrder(to, matches), diff: withAfterPath({ kind: "added-array-item", before: "<absent>", after: brief(after[to]) }, null, `${afterPath}[${to}]`) });
			}
		}
		return events.sort((a, b) => a.order - b.order).map((event) => event.diff);
	}
	if (before && typeof before === "object") {
		const beforeKeys = Object.keys(before);
		const afterKeys = Object.keys(after);
		const commonBefore = beforeKeys.filter((key) => Object.hasOwn(after, key));
		const commonAfter = afterKeys.filter((key) => Object.hasOwn(before, key));
		const out = [];
		if (commonBefore.join("\0") !== commonAfter.join("\0")) {
			out.push(withAfterPath({ kind: "key-order", before: commonBefore, after: commonAfter }, path, afterPath));
		}
		for (const key of beforeKeys) {
			if (!Object.hasOwn(after, key)) out.push(withAfterPath({ kind: "missing-key", before: brief(before[key]), after: "<absent>" }, `${path}.${key}`, null));
			else out.push(...allDiffs(before[key], after[key], `${path}.${key}`, `${afterPath}.${key}`, alignments));
		}
		for (const key of afterKeys) if (!Object.hasOwn(before, key)) {
			out.push(withAfterPath({ kind: "added-key", before: "<absent>", after: brief(after[key]) }, null, `${afterPath}.${key}`));
		}
		return out;
	}
	return before === after ? [] : [withAfterPath({ kind: "value", before: brief(before), after: brief(after) }, path, afterPath)];
}

function elementPath(element, section) {
	return section === "messages" ? `messages[${element.index}]` : `system[${element.index}]`;
}

function diffElement(before, after, section, alignments) {
	const beforePath = elementPath(before, section);
	const afterPath = elementPath(after, section);
	const label = before.label === after.label ? before.label : `${before.label} -> ${after.label}`;
	alignments.push({ path: beforePath, afterPath, unchanged: signature(before.value) === signature(after.value) });
	return allDiffs(before.value, after.value, beforePath, afterPath, alignments).map((diff) => ({ ...diff, label }));
}

function compareSequences(before, after, section, alignments) {
	const { matches, moved, movedBefore, movedAfter } = alignSequence(before.map((item) => item.value), after.map((item) => item.value));
	const pairByFrom = new Map(matches.map((match) => [match.from, match]));
	const events = [];
	for (let from = 0; from < before.length; from++) {
		if (movedBefore.has(from)) {
			const move = moved.find((item) => item.from === from);
			events.push({ order: from, diff: { path: elementPath(before[from], section), afterPath: elementPath(after[move.to], section),
				label: `${before[from].label} -> ${after[move.to].label}`, kind: "reordered", from: before[from].index, to: after[move.to].index } });
		} else if (pairByFrom.has(from)) {
			const { to } = pairByFrom.get(from);
			for (const diff of diffElement(before[from], after[to], section, alignments)) events.push({ order: from, diff });
		} else events.push({ order: from, diff: { path: elementPath(before[from], section), label: before[from].label, kind: "missing-element",
			before: brief(before[from].value), after: "<absent>" } });
	}
	for (let to = 0; to < after.length; to++) if (!movedAfter.has(to) && !matches.some((match) => match.to === to)) {
		events.push({ order: insertionOrder(to, matches), diff: { afterPath: elementPath(after[to], section), label: after[to].label, kind: "added-element",
			before: "<absent>", after: brief(after[to].value) } });
	}
	return events.sort((a, b) => a.order - b.order).map((event) => event.diff);
}

function selectedPrefix(expected, actual) {
	const { matches, moved } = alignSequence(expected.map((item) => item.value), actual.map((item) => item.value));
	const selected = [...matches, ...moved];
	const last = Math.max(-1, ...selected.map((match) => match.to));
	return actual.slice(0, last + 1);
}

function comparePrefixSequences(before, after, expected, section, alignments) {
	return compareSequences(selectedPrefix(expected, before), selectedPrefix(expected, after), section, alignments);
}

function systemElements(body, normalized) {
	const system = Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [];
	return system.map((value, index) => ({ index, label: `system[${index}]`, value: normalized ? withoutCacheControl(value) : value }))
		.filter(({ value }) => !normalized || !String(value.text ?? "").startsWith(BILLING_HEADER));
}

function compareView(beforeBody, afterBody, normalized, prefixOnly, prefixBody) {
	const clean = normalized ? withoutCacheControl : (value) => value;
	const beforeSystem = systemElements(beforeBody, normalized);
	const afterSystem = systemElements(afterBody, normalized);
	const beforeMessages = beforeBody.messages.map((message, index) => ({ index, label: `messages[${index}] ${message.role}/${kinds(message)}`,
		value: normalized ? contentAsString(clean(message)) : message }));
	const afterMessages = afterBody.messages.map((message, index) => ({ index, label: `messages[${index}] ${message.role}/${kinds(message)}`,
		value: normalized ? contentAsString(clean(message)) : message }));
	const expectedSystem = prefixBody ? systemElements(prefixBody, normalized) : prefixOnly ? beforeSystem : null;
	const expectedMessages = prefixBody ? requestElements(prefixBody, normalized).filter((item) => item.label.startsWith("messages[")).map((item) => ({
		index: item.index, label: item.label, value: item.value,
	})) : prefixOnly ? beforeMessages : null;
	const alignments = [];
	const toolsDiff = allDiffs(clean(beforeBody.tools ?? []), clean(afterBody.tools ?? []), "tools", "tools", alignments);
	const systemDiff = expectedSystem
		? comparePrefixSequences(beforeSystem, afterSystem, expectedSystem, "system", alignments)
		: compareSequences(beforeSystem, afterSystem, "system", alignments);
	const messageDiff = expectedMessages
		? comparePrefixSequences(beforeMessages, afterMessages, expectedMessages, "messages", alignments)
		: compareSequences(beforeMessages, afterMessages, "messages", alignments);
	const aligned = [...toolsDiff.map((diff) => ({ ...diff, label: "tools" })), ...systemDiff, ...messageDiff];
	const reordered = aligned.filter((diff) => diff.kind === "reordered" || diff.kind === "reordered-array-item");
	return { beforeElements: requestElements(beforeBody, normalized).length, afterElements: requestElements(afterBody, normalized).length, aligned, reordered, alignments };
}

export function compareRequestBodies(before, after, { prefixOnly = false, prefixBody } = {}) {
	return {
		raw: compareView(before, after, false, prefixOnly, prefixBody),
		normalized: compareView(before, after, true, prefixOnly, prefixBody),
	};
}
