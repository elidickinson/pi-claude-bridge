#!/usr/bin/env node

/**
 * SDK prompt snapshot staleness.
 *
 * SDK 0.3.282 semantics (sdk.d.ts:2356-2383): with `snapshot` omitted or true, the
 * conversation's system prompt is recorded on the first request and reused verbatim
 * on every later request and `resume`/`continue` — a changed `append` passed on a
 * later launch is ignored until compaction or a new session. The bridge re-invokes
 * Claude Code per turn and re-derives the append from pi's prompt capture each time,
 * so a recorded prompt would freeze pi's projected instructions at the first turn.
 *
 * The provider path constructs its systemPrompt object inline in src/index.ts, so
 * this pins the construction literally at source level: the main preset object must
 * carry `snapshot: false`. (Snapshot capture is rolling out; setting the flag is
 * documented safe everywhere, including Bedrock/Vertex/Foundry where it is inert.)
 *
 * AskClaude keeps its own separate construction in promptAndWait and is NOT changed
 * by the snapshot fix; this test pins that separation so the two do not drift silently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("SDK systemPrompt snapshot", () => {
	it("provider path renders the preset systemPrompt fresh every turn (snapshot:false)", () => {
		// The provider query's preset construction (unique by its `append` reuse of
		// systemPromptAppend): object must explicitly opt out of prompt recording.
		assert.match(
			source,
			/type: "preset", preset: "claude_code",\s*\n\s*append: systemPromptAppend \? systemPromptAppend : undefined,\s*\n[^}]*snapshot: false,/,
			"main provider systemPrompt object must carry snapshot: false",
		);
	});

	it("AskClaude keeps its own construction and is not swept by the snapshot change", () => {
		// promptAndWait's preset literal is untouched; assert its exact shape is
		// unchanged apart from the provider block above.
		assert.match(
			source,
			/systemPrompt: \{ type: "preset", preset: "claude_code", append: skillsBlock \}/,
			"AskClaude preset literal must stay unchanged",
		);
	});
});
