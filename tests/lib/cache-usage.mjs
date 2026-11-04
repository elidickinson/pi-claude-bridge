/**
 * Prompt-cache usage per turn from pi RPC events, and the cache-hit check of
 * the fork cache test.
 *
 * A turn's conversation tokens are its input total (input + cacheRead +
 * cacheWrite) minus the input total of the session's first request, which is
 * roughly the system prompt and tools. The first request after an event (tree
 * navigation, reload, restart, fork) hits the cache when it reads at least 90%
 * of the reference turn's input total from cache and writes less than 25% of
 * the reference turn's conversation tokens. A miss still reads the system
 * prompt and tools (about 20K to 33K tokens), so the check is only meaningful
 * when the reference turn carries at least MIN_CONVERSATION_TOKENS.
 */
import { writeFileSync } from "node:fs";

export const MIN_CONVERSATION_TOKENS = 30_000;
const MIN_READ_SHARE = 0.9;
const MAX_WRITE_SHARE = 0.25;

/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Usage */

/** @param {Usage} usage */
export const inputTotal = (usage) => usage.input + usage.cacheRead + usage.cacheWrite;

/**
 * Send one prompt and collect the usage of every assistant message it produced.
 * Fails on an errored or aborted assistant message, so a usage row never comes
 * from a failed request.
 * @returns {Promise<{ usages: Usage[], first: Usage, last: Usage, endedAt: number }>}
 */
export async function promptUsage(harness, message, timeout) {
	const usages = [];
	const failures = [];
	const remove = harness.addListener((msg) => {
		if (msg.type !== "message_end" || msg.message?.role !== "assistant") return;
		const m = msg.message;
		if (m.stopReason === "error" || m.stopReason === "aborted") failures.push(`${m.stopReason}: ${m.errorMessage ?? ""}`);
		const { input, output, cacheRead, cacheWrite } = m.usage;
		usages.push({ input, output, cacheRead, cacheWrite });
	});
	try {
		const ended = harness.waitForEvent("agent_end", timeout);
		await harness.send({ type: "prompt", message }, timeout);
		await ended;
	} finally {
		remove();
	}
	if (failures.length) throw new Error(`assistant message failed (${failures.join("; ")})`);
	if (!usages.length) throw new Error("prompt produced no assistant message");
	return { usages, first: usages[0], last: usages.at(-1), endedAt: Date.now() };
}

/** @param {Usage} turn @param {Usage} sessionFirst */
export const conversationTokens = (turn, sessionFirst) => inputTotal(turn) - inputTotal(sessionFirst);

/**
 * @param {{ after: Usage, reference: Usage, sessionFirst: Usage }} args
 *   after: first assistant message after the event; reference: the turn whose
 *   prefix should be cached; sessionFirst: the session's first request.
 */
export function cacheHit({ after, reference, sessionFirst }) {
	const referenceInput = inputTotal(reference);
	const conversation = conversationTokens(reference, sessionFirst);
	const readShare = after.cacheRead / referenceInput;
	const writeShare = after.cacheWrite / conversation;
	return {
		referenceInput,
		conversation,
		readShare,
		writeShare,
		largeEnough: conversation >= MIN_CONVERSATION_TOKENS,
		hit: readShare >= MIN_READ_SHARE && writeShare < MAX_WRITE_SHARE,
	};
}

/**
 * Write one markdown row per case. Holds usage numbers and decision rows only,
 * never conversation text.
 * @param {string} path
 * @param {string} title
 * @param {{ name: string, rows: string, seconds: number, after: Usage, check: ReturnType<typeof cacheHit> }[]} cases
 */
export function writeUsageReport(path, title, cases) {
	const pct = (x) => `${(x * 100).toFixed(1)}%`;
	const lines = [
		`# ${title}`,
		"",
		`Hit: cacheRead at least ${pct(MIN_READ_SHARE)} of the reference input and cacheWrite below ${pct(MAX_WRITE_SHARE)} of the reference conversation tokens (at least ${MIN_CONVERSATION_TOKENS}).`,
		"",
		"| Case | Sync rows | Seconds after reference | Reference input | Reference conversation | Input | Cache read | Cache write | Read share | Write share | Hit |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...cases.map(({ name, rows, seconds, after, check }) =>
			`| ${name} | ${rows} | ${seconds.toFixed(0)} | ${check.referenceInput} | ${check.conversation} | ${after.input} | ${after.cacheRead} | ${after.cacheWrite} | ${pct(check.readShare)} | ${pct(check.writeShare)} | ${check.hit && check.largeEnough ? "yes" : "no"} |`),
		"",
	];
	writeFileSync(path, lines.join("\n"));
}
