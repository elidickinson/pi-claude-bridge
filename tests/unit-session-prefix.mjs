import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { QueryProcess } from "../src/query-process.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";
import { importHistory, LiveRecording } from "../src/session-sync.js";
import { digestMessages } from "../src/message-digests.js";
import { readTranscript, resolveCut, resolveRecordingCut } from "../src/session-transcript.js";
const { __test } = await import("../src/index.js");
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, provider: "claude-bridge", timestamp: 1 });
const say = (text) => assistant([{ type: "text", text }]);
const tool = (id) => ({ type: "toolCall", id, name: "read", arguments: {} });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `value-${id}` }], timestamp: 1 });
let root, oldDir;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prefix-session-"));
	oldDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(root, "cc");
	__test.resetSharedSession();
});
afterEach(() => {
	__test.resetSharedSession();
	if (oldDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = oldDir;
	rmSync(root, { recursive: true, force: true });
});
function seed(messages, carried = []) {
	const session = createSession({ projectPath: root, model: "sonnet" });
	const state = { ...importHistory(session, messages, undefined, carried), ccSessionId: session.sessionId, cwd: root, model: "sonnet", dirtyTail: false };
	session.save();
	__test.setSharedSession("pi", state);
	return { session, state };
}
const sync = (messages) => __test.syncSharedSession([...messages, user("next")], root, undefined, "sonnet", "pi");

it("row6 forks a real history prefix at its attachment run, with a pre-minted fresh id", () => {
	const history = [user("first"), say("answer"), user("second"), say("later")];
	const { session } = seed(history);
	const before = readFileSync(session.jsonlPath);
	const synced = sync(history.slice(0, 2));
	assert.equal(synced.sessionId, session.sessionId);
	assert.notEqual(synced.targetSessionId, session.sessionId);
	assert.equal(synced.forkAt, session.messages[1].uuid);
	assert.equal(synced.created, true);
	assert.deepEqual(synced.recorded.digests, digestMessages(history.slice(0, 2)));
	assert.deepEqual(readFileSync(session.jsonlPath), before);
});

it("row7 retains parallel siblings in its file and the native SDK request", { timeout: 30_000 }, async () => {
	const history = [user("warm"), say("warm answer"), user("parallel"), assistant([tool("X"), tool("Y")]), result("X"), result("Y"), say("SECRET")];
	const source = createSession({ projectPath: root, model: "sonnet" });
	// Model CC's native per-result writes and parent fan-out, not import's merge.
	const uuids = [source.addUserMessage("warm"), source.addAssistantMessage([{ type: "text", text: "warm answer" }]), source.addUserMessage("parallel"), source.addAssistantMessage(["X", "Y"].map((id) => ({ type: "tool_use", id, name: "Read", input: {} })))];
	uuids.push(source.addToolResults([{ toolUseId: "X", content: "value-X" }]));
	uuids.push(source.addToolResults([{ toolUseId: "Y", content: "value-Y" }]));
	const snapshot = source.addAttachment({ type: "prompt_snapshot", systemPrompt: ["kept native snapshot"] });
	uuids.push(source.addAssistantMessage([{ type: "text", text: "SECRET" }]));
	source.save();
	const records = source.records.map((r) => r.uuid === uuids[5] ? { ...r, parentUuid: uuids[3] } : r);
	writeFileSync(source.jsonlPath, records.map((r) => JSON.stringify(r) + "\n").join(""));
	const state = { ccSessionId: source.sessionId, cwd: root, model: "sonnet", dirtyTail: false, digests: digestMessages(history), uuids, cuttable: [true, true, true, false, false, true, true] };
	__test.setSharedSession("pi", state);
	assert.throws(() => resolveCut(readTranscript(state), uuids[4]), /primary parent chain/);
	const before = readFileSync(source.jsonlPath);
	const synced = sync([...history.slice(0, 6), say("REDACTED")]);
	const rewritten = openSession({ sessionId: synced.targetSessionId, projectPath: root });
	assert.notEqual(synced.targetSessionId, source.sessionId);
	assert.equal(synced.forkAt, undefined);
	for (const uuid of [uuids[4], uuids[5], snapshot]) assert.ok(rewritten.records.some((r) => r.uuid === uuid));
	assert.match(JSON.stringify(rewritten.records), /value-X/);
	assert.match(JSON.stringify(rewritten.records), /value-Y/);
	assert.match(JSON.stringify(rewritten.records), /kept native snapshot/);
	assert.doesNotMatch(JSON.stringify(rewritten.records), /SECRET/);
	const suffix = rewritten.records.at(-1);
	assert.equal(suffix.parentUuid, snapshot);
	assert.deepEqual(readFileSync(source.jsonlPath), before);
	assert.deepEqual(synced.recorded.digests, digestMessages([...history.slice(0, 6), say("REDACTED")]));
	const body = await nativeRequest(synced.targetSessionId);
	assert.match(JSON.stringify(body.messages), /value-X/);
	assert.match(JSON.stringify(body.messages), /value-Y/);
	assert.match(JSON.stringify(body.messages), /REDACTED/);
	assert.doesNotMatch(JSON.stringify(body.messages), /SECRET/);
	assert.deepEqual(readFileSync(source.jsonlPath), before);
});

it("row7 carries only suffix @files, rebasing ordinals without duplicating an identical prefix prompt", () => {
	const prompt = "review @fixture";
	const history = [user(prompt), say("SECRET"), user(prompt), say("later answer")];
	const carried = ["early", "late"].map((name, userOrdinal) => ({ userOrdinal, parentText: prompt, attachment: { type: "file", filename: name, content: { type: "text", file: { filePath: name, content: `${name}-bytes` } } } }));
	const { session } = seed(history, carried);
	const synced = sync([history[0], say("REDACTED"), ...history.slice(2)]);
	const rewritten = openSession({ sessionId: synced.targetSessionId, projectPath: root });
	assert.deepEqual(rewritten.attachments.map((r) => r.attachment.filename), ["early", "late"]);
	assert.equal(rewritten.attachments[0].uuid, session.attachments[0].uuid, "prefix attachment is copied, not re-imported");
	assert.notEqual(rewritten.attachments[1].uuid, session.attachments[1].uuid, "suffix attachment is emitted with its new suffix prompt");
});

it("a changed suffix prompt conservatively drops its old @file expansion", () => {
	const history = [user("warm"), say("SECRET"), user("review @file"), say("answer")];
	seed(history, [{ userOrdinal: 1, parentText: "review @file", attachment: { type: "file", filename: "stale" } }]);
	const synced = sync([history[0], say("REDACTED"), user("different prompt"), history[3]]);
	assert.equal(openSession({ sessionId: synced.targetSessionId, projectPath: root }).attachments.length, 0);
});

it("c0 imports ignore an uncommitted (unterminated) ancestor tail", () => {
	const history = [user("SECRET"), say("answer")];
	const { session } = seed(history);
	appendFileSync(session.jsonlPath, '{"unfinished":');
	const before = readFileSync(session.jsonlPath);
	const synced = sync([user("REDACTED"), history[1]]);
	assert.notEqual(synced.targetSessionId, session.sessionId);
	assert.deepEqual(readFileSync(session.jsonlPath), before);
});

it("row6 forks past an uncommitted final append without touching the source", () => {
	const history = [user("a"), say("b")];
	const { session, state } = seed(history);
	state.dirtyTail = true;
	appendFileSync(session.jsonlPath, '{"type":"assistant","uuid":"torn');
	const before = readFileSync(session.jsonlPath);
	assert.equal(sync(history).forkAt, state.uuids.at(-1));
	assert.deepEqual(readFileSync(session.jsonlPath), before);
});

it("a later anchor torn from the file is outside an earlier cut, but a retained one must exist", () => {
	const history = [user("u1"), say("a1"), user("u2"), say("a2")];
	const { session, state } = seed(history);
	const lines = readFileSync(session.jsonlPath, "utf8").split("\n");
	assert.match(lines.at(-2), new RegExp(state.uuids[3]));
	writeFileSync(session.jsonlPath, lines.slice(0, -2).join("\n") + "\n" + lines.at(-2).slice(0, 40));
	const records = readTranscript(state);
	assert.equal(resolveRecordingCut(records, state, 2).uuid, state.uuids[1]);
	assert.throws(() => resolveRecordingCut(records, state, 4), /absent/);
	const synced = sync([history[0], history[1], user("REDACTED"), history[3]]);
	assert.equal(synced.forkAt, undefined);
	assert.deepEqual(synced.recorded.uuids.slice(0, 2), state.uuids.slice(0, 2));
	const written = readFileSync(openSession({ sessionId: synced.targetSessionId, projectPath: root }).jsonlPath, "utf8");
	assert.match(written, /REDACTED/);
	assert.doesNotMatch(written, /"u2"/);
});

it("a malformed committed line fails, whether interior or final", () => {
	for (const torn of ['{"unfinished":\n{"type":"summary"}\n', '{"unfinished":\n']) {
		const history = [user("a"), say("b")];
		const { session, state } = seed(history);
		state.dirtyTail = true;
		appendFileSync(session.jsonlPath, torn);
		assert.throws(() => sync(history), SyntaxError);
	}
});

it("c0 rewrites carry @file expansions of later unchanged prompts, for an early edit and a model change", () => {
	const prompt = "review @fixture";
	const history = [user("SECRET first"), say("answer"), user(prompt), say("later")];
	const file = { type: "file", filename: "fixture", content: { type: "text", file: { filePath: "fixture", content: "fixture-bytes" } } };
	for (const [messages, modelId] of [[[user("REDACTED first"), ...history.slice(1)], "sonnet"], [history, "opus"]]) {
		const { session } = seed(history, [{ userOrdinal: 1, parentText: prompt, attachment: file }]);
		const before = readFileSync(session.jsonlPath);
		const synced = __test.syncSharedSession([...messages, user("next")], root, undefined, modelId, "pi");
		assert.equal(synced.forkAt, undefined);
		const rewritten = openSession({ sessionId: synced.targetSessionId, projectPath: root });
		assert.deepEqual(rewritten.attachments.map((r) => r.attachment.filename), ["fixture"]);
		assert.deepEqual(readFileSync(session.jsonlPath), before);
	}
});

it("a symlinked cwd resolves the same transcript for reuse and fork, not a missing file", () => {
	const real = join(root, "real"), link = join(root, "link");
	mkdirSync(real);
	symlinkSync(real, link);
	const history = [user("a"), say("b")];
	const session = createSession({ projectPath: real, model: "sonnet" });
	const state = { ...importHistory(session, history), ccSessionId: session.sessionId, cwd: link, model: "sonnet", dirtyTail: false };
	session.save();
	__test.setSharedSession("pi", state);
	const reuse = __test.syncSharedSession([...history, user("next")], link, undefined, "sonnet", "pi");
	assert.equal(reuse.created, false);
	assert.equal(reuse.sessionId, session.sessionId);
	state.dirtyTail = true;
	const fork = __test.syncSharedSession([...history, user("next")], link, undefined, "sonnet", "pi");
	assert.equal(fork.sessionId, session.sessionId);
	assert.equal(fork.forkAt, state.uuids.at(-1));
});

it("cut resolution accepts direct later-turn steer UUIDs and absorbed source_uuid attachments, never null", () => {
	const session = createSession({ projectPath: root });
	const prompt = session.addUserMessage("prompt");
	const snapshot = session.addAttachment({ type: "prompt_snapshot", systemPrompt: [] });
	const steer = session.addAttachment({ type: "queued_command", source_uuid: "absorbed-steer", prompt: "steer" });
	const reminder = session.addAttachment({ type: "total_tokens_reminder" });
	session.addAssistantMessage([{ type: "text", text: "answer" }]);
	const direct = session.addUserMessage("later-turn steer");
	session.save();
	const records = readTranscript({ ccSessionId: session.sessionId, cwd: root });
	assert.equal(resolveCut(records, prompt).uuid, snapshot, "prompt attachment run stops before the queued command");
	assert.equal(resolveCut(records, "absorbed-steer").uuid, reminder);
	assert.equal(records[resolveCut(records, "absorbed-steer").index - 1].uuid, steer);
	assert.equal(resolveCut(records, direct).uuid, direct);
	assert.throws(() => resolveCut(records, null), /null or empty/);
	assert.throws(() => resolveCut(records, ""), /null or empty/);
	assert.throws(() => resolveCut(records, "missing"), /absent/);
});


it("a replay acknowledged before result frames retains its later-on-disk steer between parallel pi results", () => {
	const prompt = user("parallel"), call = assistant([tool("X"), tool("Y")]), rx = result("X"), steer = user("steer"), ry = result("Y");
	const history = [prompt, call, rx, steer, ry];
	const source = createSession({ projectPath: root, model: "sonnet" });
	const promptId = source.addUserMessage("parallel");
	const callId = source.addAssistantMessage(["X", "Y"].map((id) => ({ type: "tool_use", id, name: "Read", input: {} })));
	const rxId = source.addToolResults([{ toolUseId: "X", content: "value-X" }]);
	const ryId = source.addToolResults([{ toolUseId: "Y", content: "value-Y" }]);
	const steerId = source.addAttachment({ type: "queued_command", source_uuid: "steer-source", prompt: "steer" });
	const reminder = source.addAttachment({ type: "total_tokens_reminder" });
	source.addAssistantMessage([{ type: "text", text: "unrecorded tail" }]);
	source.save();
	const live = new LiveRecording();
	live.users([prompt], 0, promptId, true);
	live.assistant(digestMessages([call])[0], ["X", "Y"], callId);
	live.results(history);
	live.users(history, 3, "steer-source", false);
	live.acknowledge("steer-source");
	live.result("X", rxId);
	live.result("Y", ryId);
	assert.deepEqual(live.recorded.uuids, [promptId, callId, rxId, "steer-source", ryId], "every live slot retains its own anchor");
	assert.deepEqual(live.recorded.cuttable, [true, false, false, false, true]);
	const state = { ...live.recorded, ccSessionId: source.sessionId, cwd: root, model: "sonnet", dirtyTail: true };
	const records = readTranscript(state);
	assert.equal(resolveRecordingCut(records, state, 5).uuid, reminder);
	assert.equal(records[resolveRecordingCut(records, state, 5).index - 1].uuid, steerId);
	__test.setSharedSession("pi", state);
	assert.equal(sync(history).forkAt, reminder, "the selected cut includes both results and the reordered steer");
});


async function nativeRequest(sessionId) {
	const requests = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
			response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end([
			event("message_start", { message: { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
			event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
			event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ACK" } }),
			event("content_block_stop", { index: 0 }),
			event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
			event("message_stop", {}),
		].join(""));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const child = new QueryProcess();
	let sdk;
	try {
		sdk = query({ prompt: "continue after rewrite", options: {
			cwd: root, resume: sessionId, model: "claude-haiku-4-5", tools: [], settingSources: [], permissionMode: "bypassPermissions", maxTurns: 1,
			spawnClaudeCodeProcess: child.spawn,
			env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "offline-test", ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ELEGANT_MEADOW: "0" },
		} });
		let result;
		for await (const message of sdk) if (message.type === "result") result = message;
		assert.equal(result?.subtype, "success", JSON.stringify(result));
		assert.equal(result?.is_error, false, JSON.stringify(result));
		const body = requests.find((request) => JSON.stringify(request.messages).includes("REDACTED"));
		assert.ok(body, "native CC issued no request with the rewritten suffix");
		return body;
	} finally {
		sdk?.close();
		child.close();
		await child.exited;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}
