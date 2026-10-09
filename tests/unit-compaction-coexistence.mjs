import { it } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

it("bridge leaves session_before_compact ownership to Pi and other extensions", () => {
	const handlers = activateWithMockPi();
	try { assert.equal(handlers.has("session_before_compact"), false); }
	finally { handlers.get("session_shutdown")(); }
});

// Real Pi session, extension runner, native summarizer and bridge provider. Only
// Claude Code query is replaced; no network, credentials or paid subprocesses.
for (const owner of ["extension", "native", "declining-extension", "cancel", "error"]) {
	it(`compaction owner: ${owner}`, { timeout: 10000 }, async () => {
		const calls = [];
		let closed = 0;
		__test.setSummaryQuery(({ prompt, options }) => {
			calls.push({ prompt, options });
			return {
				async *[Symbol.asyncIterator]() {
					yield owner === "error"
						? { type: "result", subtype: "error_during_execution", errors: ["controlled summary failure"] }
						: { type: "result", subtype: "success", result: "Controlled native summary" };
				},
				close() { closed++; },
				async interrupt() {},
			};
		});
		const manager = SessionManager.inMemory(process.env.HOME);
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: `turn ${i} ` + "context ".repeat(200), timestamp: i * 2 });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(200) }], api: "claude-bridge", provider: "claude-bridge", model: "claude-sonnet-4-6", stopReason: "stop", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: i * 2 + 1 });
		}
		const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 50 }, retry: { enabled: false } });
		const observed = [];
		const loader = new DefaultResourceLoader({
			cwd: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR,
			settingsManager: settings, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [activate, (pi) => {
				if (owner !== "native" && owner !== "error") pi.on("session_before_compact", (event) => {
					if (owner === "cancel") return { cancel: true };
					if (owner === "declining-extension") return undefined;
					return { compaction: { summary: "Extension-owned summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { owner: "extension" } } };
				});
				pi.on("session_compact", (event) => observed.push(event));
			}],
		});
		let session;
		try {
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			({ session } = await createAgentSession({ cwd: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: "all", model: { id: "claude-sonnet-4-6", name: "Controlled bridge", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
			if (owner === "cancel" || owner === "error") {
				await assert.rejects(session.compact(), owner === "cancel" ? /cancelled/ : /controlled summary failure/);
				assert.equal(manager.getBranch().filter(e => e.type === "compaction").length, 0);
				assert.equal(observed.length, 0);
			} else {
				const result = await session.compact();
				assert.match(result.summary, owner === "extension" ? /Extension-owned summary/ : /Controlled native summary/);
				assert.equal(observed.length, 1);
				assert.equal(observed[0].fromExtension, owner === "extension");
				assert.equal(manager.getBranch().find(e => e.type === "compaction").fromHook, owner === "extension");
			}
			if (owner === "extension" || owner === "cancel") assert.equal(calls.length, 0);
			else {
				if (owner === "error") assert.equal(calls.length, 1, "stop after failed history summary");
				else assert.equal(calls.length, 2, "split-turn native compaction uses separate history and turn-prefix summaries");
				for (const { options } of calls) {
					assert.equal(options.persistSession, false);
					assert.deepEqual(options.tools, []);
					assert.equal(options.systemPrompt.type, "preset");
					assert.equal(options.systemPrompt.preset, "claude_code");
					assert.match(options.systemPrompt.append, /summarization/);
					assert.equal(options.systemPrompt.snapshot, false);
				}
				assert.equal(closed, calls.length);
			}
		} finally {
			if (session) await session.extensionRunner.emit({ type: "session_shutdown" });
			session?.dispose();
			__test.setSummaryQuery(null);
		}
	});
}
