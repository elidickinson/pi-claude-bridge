/**
 * Compaction and branch summaries run one SDK query each. The usage that query reports
 * must reach the done message, or pi records and shows "0 tokens billed".
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";

// $1/M input, $10/M output so the cost assertions are exact.
const model = { id: "claude-sonnet-4-6", name: "Controlled bridge", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 } };
const callUsage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 };
const callTotal = 1000 + 200 + 3000 + 500;
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const context = {
	systemPrompt: "You are an advisor.",
	messages: [{ role: "user", content: [{ type: "text", text: "Summarize." }], timestamp: 0 }],
};

function fakeQuery(messages) {
	return () => {
		async function* gen() { yield* messages; }
		const q = gen();
		q.interrupt = async () => {};
		q.close = () => {};
		return q;
	};
}

const assistant = (usage, text = "summary") => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage } });
const result = (fields) => ({ type: "result", subtype: "success", is_error: false, result: "summary", ...fields });

describe("isolated summary usage", () => {
	afterEach(() => __test.setQuery(null));

	it("takes the result's usage and prices it", async () => {
		__test.setQuery(fakeQuery([result({ usage: callUsage })]));
		const message = await __test.isolatedStreamFn(model, context, { cacheRetention: "none" }).result();
		assert.equal(message.stopReason, "stop");
		assert.deepEqual({ ...message.usage, cost: undefined }, { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 500, totalTokens: callTotal, cost: undefined });
		assert.ok(Math.abs(message.usage.cost.total - (1000 * 1 + 200 * 10 + 3000 * 0.1 + 500 * 1.25) / 1e6) < 1e-12);
	});

	it("does not count the assistant message and the result twice", async () => {
		// The assistant message's output_tokens can be a placeholder; the result's are final.
		__test.setQuery(fakeQuery([assistant({ ...callUsage, output_tokens: 1 }), result({ usage: callUsage })]));
		const message = await __test.isolatedStreamFn(model, context, { cacheRetention: "none" }).result();
		assert.equal(message.usage.input, 1000);
		assert.equal(message.usage.output, 200);
		assert.equal(message.usage.totalTokens, callTotal);
	});

	it("falls back to the assistant message when the result has no usage", async () => {
		__test.setQuery(fakeQuery([assistant(callUsage), result({})]));
		const message = await __test.isolatedStreamFn(model, context, { cacheRetention: "none" }).result();
		assert.equal(message.usage.totalTokens, callTotal);
	});

	it("keeps the usage of an error result", async () => {
		__test.setQuery(fakeQuery([result({ subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: callUsage })]));
		const message = await __test.isolatedStreamFn(model, context, { cacheRetention: "none" }).result();
		assert.equal(message.stopReason, "error");
		assert.equal(message.usage.totalTokens, callTotal);
	});
});

for (const operation of ["compaction", "branch summary"]) {
	it(`native ${operation} persists the query's usage`, { timeout: 10000 }, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-summary-usage-"));
		let session;
		t.after(async () => {
			await session?.extensionRunner.emit({ type: "session_shutdown" });
			session?.dispose();
			__test.setQuery(null);
			rmSync(cwd, { recursive: true, force: true });
		});
		let calls = 0;
		__test.setQuery(() => {
			calls++;
			async function* gen() {
				yield assistant(callUsage, "Controlled native summary");
				yield result({ result: "Controlled native summary", usage: callUsage });
			}
			const q = gen();
			q.interrupt = async () => {};
			q.close = () => {};
			return q;
		});
		const manager = SessionManager.inMemory(cwd);
		const ids = [];
		for (let turn = 0; turn < 4; turn++) {
			ids.push(manager.appendMessage({ role: "user", content: `turn ${turn} ` + "context ".repeat(200), timestamp: turn * 2 }));
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(200) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: zeroCost }, timestamp: turn * 2 + 1 });
		}
		const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 50 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [activate],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: "all", model }));
		await session.bindExtensions({ onError: error => { throw new Error(error.error); } });

		if (operation === "compaction") await session.compact();
		else await session.navigateTree(ids[0], { summarize: true });

		assert.ok(calls > 0);
		const entry = manager.getEntries().find(e => e.type === (operation === "compaction" ? "compaction" : "branch_summary"));
		assert.ok(entry, `no ${operation} entry was persisted`);
		// A compaction that splits a turn runs two queries, and pi sums their usage.
		assert.equal(entry.usage.input, calls * 1000);
		assert.equal(entry.usage.output, calls * 200);
		assert.equal(entry.usage.cacheRead, calls * 3000);
		assert.equal(entry.usage.cacheWrite, calls * 500);
	});
}
