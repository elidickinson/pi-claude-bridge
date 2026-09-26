#!/usr/bin/env node

/**
 * session_before_compact must yield on claude-bridge models.
 *
 * The bridge used to take compaction over (pi's exported compact() through
 * isolatedStreamFn). That takeover could overwrite another extension's
 * session_before_compact result: pi 0.87.1's ExtensionRunner.emit runs handlers
 * in extension load order and the last truthy result wins, so the bridge
 * overwrote an earlier handler's compiled summary, and its own failure path
 * cancelled compaction outright. The bridge now yields — another handler's
 * result stands when present, and pi's native compaction runs when not. The native fallback is safe here: pi marks its summarizer
 * calls cacheRetention:"none" and the provider routes those to the isolated CC
 * summary path (the same fence /bug summarization already goes through).
 *
 * The one bridge-specific obligation that remains is file-op inheritance. pi's
 * native extractFileOperations skips prior-compaction details when the session
 * entry was written by an extension (fromHook:true — "Collect from previous
 * compaction's details (if pi-generated)" in compaction.js). Keep reinjecting
 * them as a pre-mutation of event.preparation so the native fallback and later
 * hooks inherit cumulative file lists. A handler that ran earlier has already
 * compiled its summary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	// registerProvider/registerTool stubs: activate() calls both during setup
	// regardless of what this test exercises (see unit-branch-summary.mjs).
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return handlers;
}

const handlers = activateWithMockPi();

const handler = handlers.get("session_before_compact");
const BRIDGE_MODEL = { baseUrl: "claude-bridge" };
const FOREIGN_MODEL = { baseUrl: "https://api.example.com" };

/** A compact event whose prior compaction entry carries the details schema pi stores. */
const compactEvent = () => ({
	reason: "manual",
	willRetry: false,
	branchEntries: [
		{ id: "m1", type: "message", message: { role: "user", content: "hi" } },
		{
			id: "c1",
			type: "compaction",
			fromHook: true,
			details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
		},
		{ id: "m2", type: "message", message: { role: "user", content: "and more" } },
	],
	preparation: {
		isSplitTurn: false,
		messagesToSummarize: [{ role: "user", content: "and more" }],
		turnPrefixMessages: [],
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	},
	customInstructions: undefined,
	signal: new AbortController().signal,
});

describe("session_before_compact yields", () => {
	it("is registered at all", () => {
		assert.ok(
			handlers.has("session_before_compact"),
			"without registration the hook cannot pre-mutate preparation.fileOps before the owning engine reads it",
		);
	});

	it("yields (undefined) on a claude-bridge model — no compaction result, no cancel, no notify", async () => {
		const notifyCalls = [];
		const result = await handler(compactEvent(), {
			model: BRIDGE_MODEL,
			ui: { notify: (...args) => notifyCalls.push(args) },
		});
		assert.equal(result, undefined, "a truthy return would overwrite another extension's result or cancel compaction");
		assert.deepEqual(notifyCalls, []);
	});

	it("still reinjects prior (fromHook) compaction file ops before yielding", async () => {
		// pi's native path skips prior-compaction details on fromHook entries.
		// Its post-hook compact() call must see the restored sets.
		const event = compactEvent();
		await handler(event, { model: BRIDGE_MODEL });
		assert.deepEqual([...event.preparation.fileOps.read], ["src/a.ts"]);
		assert.deepEqual([...event.preparation.fileOps.edited], ["src/b.ts"]);
	});

	it("does nothing on other providers", async () => {
		const event = compactEvent();
		const result = await handler(event, { model: FOREIGN_MODEL });
		assert.equal(result, undefined);
		// On another provider pi's own extractFileOperations handles a pi-generated
		// prior compaction natively; the hook must not mutate foreign preparations.
		assert.equal(event.preparation.fileOps.read.size, 0);
		assert.equal(event.preparation.fileOps.edited.size, 0);
	});
});

// Real installed pi dispatch/compaction; summary stream is the external boundary.
const { ExtensionRunner } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js");
const { AgentSession } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");

describe("installed pi compaction integration", () => {
	it("preserves an earlier owner's result, including its already-read file lists", async () => {
		const event = { ...compactEvent(), type: "session_before_compact" };
		const owned = { compaction: { summary: "owner summary" } };
		let priorReads;
		const runner = Object.create(ExtensionRunner.prototype);
		runner.createContext = () => ({ model: BRIDGE_MODEL });
		runner.emitError = (error) => assert.fail(JSON.stringify(error));
		runner.extensions = [
			{ handlers: new Map([[event.type, [() => {
				priorReads = [...event.preparation.fileOps.read];
				return owned;
			}]]]) },
			{ handlers: new Map([[event.type, [handler]]]) },
		];
		assert.equal(await runner.emit(event), owned);
		assert.deepEqual(priorReads, [], "later mutation cannot change an earlier snapshot");
		assert.deepEqual([...event.preparation.fileOps.read], ["src/a.ts"]);
	});

	for (const split of [false, true]) {
		it(`native fallback preserves file ops and marks every summary (split=${split})`, async () => {
			const event = compactEvent();
			Object.assign(event.preparation, {
				firstKeptEntryId: "m2", tokensBefore: 1000,
				settings: { reserveTokens: 100 }, isSplitTurn: split,
				turnPrefixMessages: split ? [{ role: "user", content: "prefix", timestamp: 0 }] : [],
			});
			assert.equal(await handler(event, { model: BRIDGE_MODEL }), undefined);
			const calls = [];
			const session = {
				thinkingLevel: "off",
				agent: { streamFunction: (_model, context, options) => {
					calls.push({ context, options });
					return { result: async () => ({
						role: "assistant", content: [{ type: "text", text: "summary" }],
						stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}) };
				} },
				settingsManager: { getRetrySettings: () => ({ enabled: false }) },
				_summarizationRetryCallbacks: () => undefined,
			};
			const result = await AgentSession.prototype._runDefaultCompaction.call(
				session, event.preparation, { ...BRIDGE_MODEL, maxTokens: 1000 },
				undefined, undefined, undefined, event.signal, undefined, "manual",
			);
			assert.equal(calls.length, split ? 2 : 1);
			for (const { options } of calls) {
				assert.equal(options.cacheRetention, "none");
				assert.equal(options.signal, event.signal);
			}
			assert.deepEqual(result.details, { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });
			assert.match(result.summary, /summary/);
			assert.equal(result.firstKeptEntryId, "m2");
		});
	}
});
