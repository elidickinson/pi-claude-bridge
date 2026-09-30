// Token accounting: map Claude Code's SDK usage counters onto pi's AssistantMessage.
// Logging-free like convert.ts — it returns what it derived and index.ts logs it.
// Extracted from index.ts so tests can reach it without activating the extension.

import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

/**
 * The usage counters Claude Code reports, mirroring `Usage` / `MessageDeltaUsage` in
 * @anthropic-ai/sdk. Every field is optional because `message_start`, `message_delta` and a
 * complete assistant message each carry a different subset.
 *
 * Not `Record<string, number | undefined>`: an index signature makes every property access
 * typecheck, which is what hid a read of `usage.reasoning_tokens` — a field no SDK version
 * has — for months.
 */
export type SdkUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
};

/** What updateUsage derived but does not store on the message, for the debug line in index.ts. */
export type UsageReport = {
	/** Cache-read share of the prompt, rounded to a whole percentage; 0 when the prompt is empty. */
	cachePct: number;
	/** Thinking tokens carried by THIS frame, absent when it carried none. Distinct from
	 *  `output.usage.reasoning`, which keeps the last value seen across frames. */
	reasoning?: number;
};

/**
 * Applies one SDK usage frame onto `output.usage`, then recomputes the token total and cost.
 *
 * Counters the frame omits keep their previous value, so the partial frames the three call
 * sites deliver never zero out what an earlier one set.
 */
export function updateUsage(output: AssistantMessage, usage: SdkUsage, model: Model<Api>): UsageReport {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// A subset of output_tokens, never a separate addend in the total or in cost.
	const reasoning = usage.output_tokens_details?.thinking_tokens;
	if (reasoning != null) output.usage.reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const report: UsageReport = { cachePct: promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0 };
	if (reasoning != null) report.reasoning = reasoning;
	return report;
}
