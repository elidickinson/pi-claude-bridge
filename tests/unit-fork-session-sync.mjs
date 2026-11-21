import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath, openSession } from "cc-session-io";
import { stateFor } from "./lib/session-state.mjs";
import { digestMessages } from "../src/message-digests.js";

const { __test } = await import("../src/index.js");
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, provider: "claude-bridge", timestamp: 1 });
const say = (text) => assistant([{ type: "text", text }]);
const calls = (...ids) => assistant(ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })));
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `result-${id}` }], isError: false, timestamp: 1 });
let cwd, oldClaudeDir;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fork-session-sync-"));
	oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(cwd, "cc");
	__test.resetSharedSession();
});
afterEach(() => {
	__test.resetSharedSession();
	if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
	rmSync(cwd, { recursive: true, force: true });
});
const sync = (messages, continuation = false) => __test.syncSharedSession(messages, cwd, new Map(), "sonnet", "pi", undefined, "", continuation);
function seed(messages) {
	const session = createSession({ projectPath: cwd, model: "sonnet" });
	const state = stateFor(session, messages, "sonnet");
	session.save();
	__test.setSharedSession("pi", state);
	return { session, state };
}

describe("fork history regressions", () => {
	// Context folding fires no rewrite event; import the shortened history (#77).
	it("imports a compressed history instead of starting with none", () => {
		seed([user("a"), say("b"), user("c"), say("d"), user("e"), say("f")]);
		const compressed = [user("[summary] earlier work"), say("Noted.")];
		const synced = sync([...compressed, user("next")]);
		assert.ok(synced.sessionId);
		assert.deepEqual(synced.recorded.digests, digestMessages(compressed));
		assert.equal(openSession({ sessionId: synced.sessionId, projectPath: cwd }).messages.length, 2);
	});
	it("a continuation prefix-writes equal history instead of resuming CC's tail (#274)", () => {
		const priors = [user("read"), calls("A"), result("A")];
		const { session } = seed(priors);
		const continued = sync(priors, true);
		assert.notEqual(continued.sessionId, session.sessionId, "reuse would resume whatever CC wrote after the result");
		assert.equal(continued.forkAt, undefined, "a fork's resumeSessionAt marks a rewind, which CC does not continue");
		const records = readFileSync(getSessionPath(continued.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR), "utf8").trim().split("\n").map(JSON.parse);
		const last = records.filter((r) => r.type === "user" || r.type === "assistant").at(-1);
		assert.equal(last.message.content[0].type, "tool_result", "the file ends at the tool result CC resumes from");
		assert.equal(sync(priors).sessionId, session.sessionId, "an ordinary turn still reuses");
	});
});
