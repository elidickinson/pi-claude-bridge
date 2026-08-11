#!/usr/bin/env node

/**
 * Which pi modules can drive our provider.
 *
 * Anything pi hands a `streamFn` can route an LLM call through the registered
 * provider — this one — carrying a system prompt we never recorded. Branch
 * summarization did exactly that and nobody noticed until it started failing
 * turns, because a behavioural contract test can only probe the entry points we
 * already know about; it structurally cannot find the one we don't.
 *
 * So inventory the source instead. Claude Code is closed and has to be probed,
 * but pi ships readable JS in node_modules, and a new consumer showing up there
 * is exactly the thing we want to hear about at bump time rather than from a
 * user. Read the *installed* dist, not reference-code/pi-mono, which lags for
 * the same reason AGENTS.md distrusts claude-code-rip.
 *
 * If this fails: a pi upgrade added or moved a streamFn consumer. Work out
 * whether it can reach a bridge model, and either handle it (the way
 * `session_before_compact` and `session_before_tree` are taken over) or add it
 * below with a note on why it is harmless.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Located by path, not require.resolve: the package defines no `exports` main, so
// it cannot be resolved by specifier at all.
const PI_DIST = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core", import.meta.url));

/** Consumers we have accounted for: what keeps each off the provider, and how many
 *  times it mentions `streamFn`. The count matters as much as the filename — a new
 *  entry point added *inside* an already-listed file is exactly the shape of the
 *  branch-summarization miss, and a filename-only inventory would wave it through.
 *  A changed count is not automatically a bug; it means read the diff and re-decide. */
const HANDLED = {
	"agent-session.js": { mentions: 1, why: "the one hand-off: `streamFn: this.agent.streamFunction` into generateBranchSummary" },
	"sdk.js": { mentions: 2, why: "constructs the agent, does not summarize; also installs pi-ai's compat streamSimple as agent-core's default — the route a caller passing no streamFn takes, covered below" },
	"compaction/compaction.js": { mentions: 13, why: "taken over via session_before_compact -> isolatedStreamFn" },
	"compaction/branch-summarization.js": { mentions: 2, why: "taken over via session_before_tree -> isolatedStreamFn" },
};

const mentionsOf = (text) => (text.match(/streamFn/g) ?? []).length;

function jsFilesUnder(dir, prefix = "") {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return jsFilesUnder(full, `${prefix}${name}/`);
		return name.endsWith(".js") ? [{ rel: `${prefix}${name}`, full }] : [];
	});
}

describe("pi streamFn consumers", () => {
	it("are all ones we have accounted for, in the same places", () => {
		assert.ok(existsSync(PI_DIST), `pi's dist is not at ${PI_DIST} — its layout changed, so this inventory is blind`);
		const found = new Map(
			jsFilesUnder(PI_DIST)
				.map(({ rel, full }) => [rel, mentionsOf(readFileSync(full, "utf8"))])
				.filter(([, n]) => n > 0)
				.sort(([a], [b]) => a.localeCompare(b)),
		);

		assert.ok(found.size > 0, `no streamFn consumers found under ${PI_DIST} — did pi's layout change?`);

		const unexpected = [...found.keys()].filter((rel) => !(rel in HANDLED));
		assert.deepEqual(
			unexpected,
			[],
			`pi has streamFn consumers this bridge has never considered: ${unexpected.join(", ")}. `
			+ `Each can route an LLM call through our provider with a system prompt no before_agent_start recorded.`,
		);

		// If one of these disappears, the takeover it justifies is now dead code.
		const missing = Object.keys(HANDLED).filter((rel) => !found.has(rel));
		assert.deepEqual(missing, [], `these no longer consume streamFn — is the takeover still needed? ${missing.join(", ")}`);

		const drifted = [...found].filter(([rel, n]) => HANDLED[rel].mentions !== n)
			.map(([rel, n]) => `${rel}: ${HANDLED[rel].mentions} -> ${n}`);
		assert.deepEqual(
			drifted,
			[],
			`pi changed how often these reference streamFn: ${drifted.join("; ")}. `
			+ `Read the diff — a new call site inside a file we already trust is the case a filename-only inventory misses — then update the counts.`,
		);
	});
});

/**
 * The consumer this inventory could never have found: one that passes no `streamFn`
 * at all. `agentLoop` then falls back to pi-ai's default, which resolves the model's
 * api id against pi-ai's own registry — a list `pi.registerProvider` does not
 * populate. Such a caller exited pi on the unresolved id rather than failing its
 * own call.
 *
 * Probed live against a stand-in api id, so it pins the routing rule the bridge's
 * api-provider registration depends on without spawning Claude Code.
 */
describe("a caller that passes no streamFn", () => {
	it("is routed by api id through pi-ai's api registry", async () => {
		// Located by path, and both from pi's own tree: pi-agent-core is nested under
		// pi-coding-agent with its own pi-ai copy, and it is that pair pi runs. Importing
		// either by specifier would reach this package's top-level copy instead, whose
		// registry the loop never consults.
		const piTree = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works", import.meta.url));
		const { agentLoop } = await import(join(piTree, "pi-agent-core/dist/index.js"));
		const { registerApiProvider, unregisterApiProviders } = await import(join(piTree, "pi-ai/dist/compat.js"));
		// agent-core ships no default of its own — it throws until something installs one.
		// pi does that from this module, so the fallback only exists because pi is loaded.
		await import(fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js", import.meta.url)));

		const api = "claude-bridge-inventory-probe";
		const calls = [];
		const streamSimple = (model) => {
			calls.push(model.api);
			return {
				async *[Symbol.asyncIterator]() {},
				result: () => Promise.resolve({ role: "assistant", content: [], stopReason: "stop" }),
			};
		};
		registerApiProvider({ api, stream: streamSimple, streamSimple }, api);
		try {
			const loop = agentLoop(
				[{ role: "user", content: "probe", timestamp: Date.now() }],
				{ systemPrompt: "probe", messages: [], tools: [] },
				{ model: { id: "probe", api, provider: api, baseUrl: "probe" }, convertToLlm: (messages) => messages },
			);
			await loop.result();
		} finally {
			unregisterApiProviders(api);
		}

		assert.deepEqual(
			calls,
			[api],
			"pi-ai no longer resolves a default-streamFn call by api id — that resolution is how a caller with no streamFn reaches the bridge at all",
		);
	});
});
