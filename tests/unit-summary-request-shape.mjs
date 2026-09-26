#!/usr/bin/env node

/**
 * Isolated summary request shape.
 *
 * The isolated summary path (runIsolatedSummary, src/index.ts) used to send the
 * summary's own system prompt text as a bare string `systemPrompt` — a custom
 * prompt, which Anthropic classifies as third-party app usage drawing from
 * extra usage at API rates, not plan limits (live-probed 2026-09-26, SDK
 * 0.3.280; see diag/EXTRA-USAGE-400.md). These one-off summaries fire
 * automatically on every compaction / tree / bug summary even in the default
 * append mode, so they must stay on the subscription-preserving
 * preset+append lane like the main provider.
 *
 * The construction is inline in src/index.ts and runIsolatedSummary needs a
 * real SDK child to drive, so this pins the construction literally at source
 * level (same pattern as tests/unit-snapshot-flag.mjs).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("isolated summary request shape", () => {
	it("summary queries use the claude_code preset with the summary system prompt appended, not a string systemPrompt", () => {
		// The exact text the bare string carried must reappear as the append —
		// "preserving the rest of the construction exactly", only the shape changes.
		assert.match(
			source,
			/systemPrompt: \{[^}]*?type: "preset" as const,[\s\S]*?preset: "claude_code" as const,\s*\n\s*append: context\.systemPrompt,[\s\S]*?snapshot: false,\s*\n\s*\},/,
			"runIsolatedSummary must send {type:'preset', preset:'claude_code', append: promptText, snapshot:false}",
		);
	});

	it("the summary construction sits inside the isolated query's options (persistSession:false, maxTurns:1 block)", () => {
		// The summary sdkQuery is the only block pairing persistSession:false
		// with a systemPrompt construction — pin them as neighbors.
		assert.match(
			source,
			/persistSession: false,[\s\S]{0,1500}systemPrompt: \{\s*\n\s*type: "preset" as const,/,
			"preset+append must be inside the isolated summary query options",
		);
	});

	it("summary queries no longer send a bare string systemPrompt", () => {
		assert.doesNotMatch(
			source,
			/systemPrompt: context\.systemPrompt,/,
			"a string systemPrompt = custom prompt = third-party usage lane; must be gone",
		);
	});
});
