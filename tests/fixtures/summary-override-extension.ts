// Test extension: stands in for a context-management extension that owns
// compaction and branch summarization itself (pi-observational-memory and
// friends). Loaded *after* the bridge, so `emit` keeps this handler's result —
// the runner assigns every truthy return in order and the last one wins.
//
// SUMMARY_OVERRIDE_MODE=override answers both `session_before_*` events with a
// fixed summary and no model call. `probe` answers neither, and only records
// what pi ended up persisting, so a test can assert that nothing produced a
// summary at all.
//
// Both modes append to SUMMARY_OVERRIDE_MARKER. The post-events carry what was
// actually written to the session (`compactionEntry`, `summaryEntry`), so the
// marker proves the override reached the transcript rather than merely being
// returned from a handler.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COMPACTION_SENTINEL = "OVERRIDE-COMPACTION-SUMMARY-8f21";
export const BRANCH_SENTINEL = "OVERRIDE-BRANCH-SUMMARY-4c07";

const MARKER = process.env.SUMMARY_OVERRIDE_MARKER;
const OVERRIDING = process.env.SUMMARY_OVERRIDE_MODE !== "probe";

function mark(line: string): void {
	if (MARKER) appendFileSync(MARKER, `${line}\n`);
}

export default function (pi: ExtensionAPI) {
	if (OVERRIDING) {
		pi.on("session_before_compact", async (event) => {
			const { firstKeptEntryId, tokensBefore } = event.preparation;
			mark(`before_compact reason=${event.reason} firstKept=${firstKeptEntryId}`);
			return {
				compaction: { summary: COMPACTION_SENTINEL, firstKeptEntryId, tokensBefore },
			};
		});

		pi.on("session_before_tree", async (event) => {
			const { userWantsSummary, entriesToSummarize } = event.preparation;
			if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
			mark(`before_tree entries=${entriesToSummarize.length}`);
			return { summary: { summary: BRANCH_SENTINEL, details: {} } };
		});
	}

	pi.on("session_compact", async (event) => {
		mark(`compacted fromExtension=${event.fromExtension} summary=${JSON.stringify(event.compactionEntry.summary)}`);
	});

	pi.on("session_tree", async (event) => {
		const summary = event.summaryEntry ? JSON.stringify(event.summaryEntry.summary) : "none";
		mark(`navigated fromExtension=${event.fromExtension} summary=${summary}`);
	});
}
