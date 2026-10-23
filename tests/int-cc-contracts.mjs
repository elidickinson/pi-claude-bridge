#!/usr/bin/env node
// Executable contracts for the undocumented Claude Code / Agent SDK behavior the
// bridge is built on.
//
// Everything here is asserted against the *installed* CC + SDK rather than
// against the bridge's handling of it, so a version bump that invalidates an
// assumption fails here first, in one named test, instead of surfacing later as
// a deadlock, a lost tool result, or an empty error message.
//
// Each test is independent and cheap: haiku, short prompts, most close the query
// as soon as the message they care about arrives. Run the whole file on every
// @anthropic-ai/claude-agent-sdk or Claude Code bump.
//
// Verified against: SDK 0.3.308 / Claude Code 2.1.308. package.json declares
// ^0.3.308 and package-lock.json resolves 0.3.308.
//
// Assumptions that are NOT covered here, and why:
//   - DISABLE_AUTO_COMPACT=1 stops CC-side autocompaction. Provoking it needs a
//     near-full context window, which no cheap probe can build. Rests on the CC
//     source only.
//   - `priority: "next"` steers are drained at CC's next tool boundary.
//     tests/int-tool-message.mjs is the tripwire for that one.
//   - rate_limit_event / rate_limit_info shape: needs a real rate limit.
//
// Requires: ANTHROPIC_API_KEY or CC logged in. Must run OUTSIDE the sandbox —
// CC persists session state under ~/.claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession, deleteSession, getProjectDir, openSession, repairToolPairing } from "cc-session-io";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";
// Claude Code's own extension to the MCP tools/call params, not part of the MCP
// spec. Set in claude-code-rip src/services/mcp/client.ts. src/mcp-server.ts
// throws when it is absent, so this key is load-bearing for every tool call.
const TOOL_USE_ID_META = "claudecode/toolUseId";

/** Options every provider-path query shares, so a test only states its own subject. */
function providerOptions(extra = {}) {
	return {
		cwd: CWD,
		model: MODEL,
		tools: [],
		permissionMode: "bypassPermissions",
		env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
		extraArgs: { "strict-mcp-config": null },
		maxTurns: 6,
		...extra,
	};
}

/** Bare MCP server serving `tools` and recording every tools/call it receives.
 *  Deliberately not src/mcp-server.ts — these tests pin CC's behavior, not ours. */
function toolServer(tools, calls) {
	const server = new McpServer({ name: "custom-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push({ name: request.params.name, meta: request.params._meta ?? null, args: request.params.arguments });
		return { content: [{ type: "text", text: `${request.params.name}-VALUE` }] };
	});
	return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server } };
}

const noArgTool = (name) => ({ name, description: `Returns the ${name} value.`, inputSchema: { type: "object", properties: {} } });

/** Every tool_use block CC emitted, plus every tool_result it fed back. */
async function collect(q) {
	const toolUses = [];
	const toolResults = [];
	const assistantUuids = [];
	let init = null;
	let result = null;
	for await (const message of q) {
		if (message.type === "system" && message.subtype === "init") init = message;
		if (message.type === "assistant") {
			assistantUuids.push(message.uuid);
			for (const block of message.message?.content ?? []) {
				if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name });
			}
		}
		if (message.type === "user" && Array.isArray(message.message?.content)) {
			for (const block of message.message.content) {
				if (block.type === "tool_result") toolResults.push(block);
			}
		}
		if (message.type === "result") result = message;
	}
	return { init, result, toolUses, toolResults, assistantUuids };
}

/** Run only far enough to read the init message, then kill the CLI. */
async function initOnly(options) {
	const q = query({ prompt: "Say OK.", options });
	try {
		for await (const message of q) {
			if (message.type === "system" && message.subtype === "init") return message;
		}
	} finally {
		q.close();
	}
	throw new Error("no system/init message arrived");
}

// --- The MCP tool-call pairing scheme ---

test("tools/call carries _meta[claudecode/toolUseId] equal to its own tool_use id", { timeout: 120_000 }, async () => {
	// Parallel calls are the case that matters: CC derives the id from
	// assistantMessage.message.content[0], which is only ever the right block
	// because CC splits a multi-block assistant message into one message per
	// block. If that splitting ever stops, both calls get the first id and every
	// result is mispaired — silently, which is worse than the throw in
	// src/mcp-server.ts. Assert the pairing, not just the key's presence.
	const calls = [];
	const { toolUses } = await collect(query({
		prompt: "Call both the alpha tool and the beta tool at the same time, in a single assistant message with two parallel tool calls. Then report both values.",
		options: providerOptions({ mcpServers: toolServer([noArgTool("alpha"), noArgTool("beta")], calls) }),
	}));

	assert.ok(calls.length >= 1, "CC dispatched no tool call — the test proved nothing");
	for (const call of calls) {
		const id = call.meta?.[TOOL_USE_ID_META];
		assert.equal(typeof id, "string", `tools/call for ${call.name} has no _meta["${TOOL_USE_ID_META}"]: ${JSON.stringify(call.meta)}`);
		const match = toolUses.find((use) => use.id === id);
		assert.ok(match, `_meta id ${id} matches no tool_use CC emitted: ${JSON.stringify(toolUses)}`);
		assert.equal(match.name, `mcp__custom-tools__${call.name}`,
			`tools/call ${call.name} was stamped with the id of ${match.name} — results would be mispaired`);
	}
});

test("tools/call names the bare tool, not the mcp__server__tool alias", { timeout: 120_000 }, async () => {
	// src/mcp-server.ts looks handlers up by pi's own tool name. CC advertises
	// the tool prefixed and calls it unprefixed; if that ever flips, every call
	// hits the "Unknown tool" throw.
	const calls = [];
	await collect(query({
		prompt: "Call the alpha tool once, then stop.",
		options: providerOptions({ mcpServers: toolServer([noArgTool("alpha")], calls) }),
	}));

	assert.deepEqual(calls.map((c) => c.name), ["alpha"]);
});

// --- `tools: []` and the unserved-tool premise ---

test("tools: [] exposes no builtin tools — only what we serve over MCP", { timeout: 60_000 }, async () => {
	const init = await initOnly(providerOptions({ mcpServers: toolServer([noArgTool("alpha")], []) }));
	assert.deepEqual(init.tools, ["mcp__custom-tools__alpha"],
		`CC exposed tools beyond our MCP server: ${JSON.stringify(init.tools)}`);
});

test("a tool_use naming an unserved tool is answered by CC, never dispatched to us", { timeout: 120_000 }, async () => {
	// The premise of the fix in 122914dd. Whether the model takes the bait is up
	// to the model, so the always-true half (never dispatched) is asserted
	// unconditionally and the rejection shape only when the bait was taken.
	const calls = [];
	const { toolUses, toolResults } = await collect(query({
		prompt: "You have a tool registered under the plain name `Bash`. Invoke `Bash` (exactly that name) with command `echo hi`. Do not use any mcp__ prefixed name. Try it even if you doubt it exists.",
		options: providerOptions({ mcpServers: toolServer([{ name: "bash", description: "Run a shell command.", inputSchema: { type: "object", properties: { command: { type: "string" } } } }], calls) }),
	}));

	assert.deepEqual(calls.filter((c) => c.name !== "bash"), [],
		`CC dispatched a tool we do not serve: ${JSON.stringify(calls.map((c) => c.name))}`);

	const bogus = toolUses.filter((use) => !use.name.startsWith("mcp__custom-tools__"));
	if (bogus.length === 0) return; // model declined the bait; nothing more to pin
	for (const use of bogus) {
		const rejection = toolResults.find((block) => block.tool_use_id === use.id);
		assert.ok(rejection?.is_error && String(rejection.content).includes("No such tool available"),
			`CC did not self-answer the unserved tool_use ${use.name} [${use.id}]: ${JSON.stringify(rejection)}`);
	}
	// Anything CC did dispatch came from a different tool_use block, so a result
	// keyed to the rejected id can never release the real handler — which is why
	// forwarding the rejected call deadlocked the turn.
	const dispatchedIds = new Set(calls.map((c) => c.meta?.[TOOL_USE_ID_META]));
	for (const use of bogus) {
		assert.ok(!dispatchedIds.has(use.id), `rejected tool_use ${use.id} was also dispatched`);
	}
});

// --- Result shapes ---

test("is_error can be true on a result whose subtype is still success", { timeout: 120_000 }, async () => {
	// What src/index.ts resultErrorText branches on. CC reports API-level failures
	// (prompt-too-long here; 429 and overload take the same shape) this way, while
	// the dedicated error subtypes carry `errors` instead.
	let result = null;
	let threw = null;
	const assistantMessages = [];
	const streamEventTypes = [];
	try {
		for await (const message of query({
			prompt: `Summarize this in one word:\n${"banana ".repeat(220_000)}`,
			options: providerOptions({ maxTurns: 1, persistSession: false, includePartialMessages: true }),
		})) {
			if (message.type === "stream_event") streamEventTypes.push(message.event?.type);
			if (message.type === "assistant") assistantMessages.push(message);
			if (message.type === "result") result = message;
		}
	} catch (error) {
		threw = error;
	}

	assert.ok(result, "no result message arrived");
	assert.equal(result.subtype, "success", `expected a success-shaped failure, got subtype=${result.subtype}`);
	assert.equal(result.is_error, true);
	assert.match(result.result, /too long/i, `expected the API's own text in result.result, got: ${result.result}`);
	// The SDK then rejects the generator, which is why the provider's catch path
	// has to prefer the text consumeQuery already recorded off the result.
	assert.match(threw?.message ?? "", /too long/i, `SDK swallowed the cause: ${threw?.message}`);

	// CC prefixes the failure with a `<synthetic>` assistant message carrying the
	// same text — its own report, not model output. src/index.ts keys its
	// keep-off-the-stream branch (issue #162) on model === "<synthetic>". With
	// partial messages on, the failure is not preceded by content stream_events
	// (message_start is fine; the branch drops abandoned blocks if one slipped
	// through), so a synthetic report after a stalled stream is still handled.
	assert.ok(assistantMessages.length > 0, "no assistant message preceded the failure result");
	assert.ok(streamEventTypes.every((t) => t === "message_start" || t === "ping"),
		`stream_events preceded the failure: ${JSON.stringify(streamEventTypes)}`);
	for (const { message } of assistantMessages) {
		assert.equal(message.model, "<synthetic>", `failure report is not synthetic: model=${message.model}`);
		assert.ok((message.content ?? []).some((b) => b.type === "text" && /too long/i.test(b.text ?? "")),
			`synthetic message lost the failure text: ${JSON.stringify(message.content)?.slice(0, 200)}`);
	}
});

test("result.modelUsage reports the served context window", { timeout: 120_000 }, async () => {
	// The only place the runtime entitlement is observable — model.contextWindow
	// is what pi registered, not what the account actually got (issue #18).
	const { result } = await collect(query({ prompt: "Reply with just: OK", options: providerOptions({ maxTurns: 1, persistSession: false }) }));
	const entries = Object.values(result?.modelUsage ?? {});
	assert.ok(entries.length > 0, `result carried no modelUsage: ${JSON.stringify(Object.keys(result ?? {}))}`);
	assert.ok(entries.every((usage) => typeof usage.contextWindow === "number"),
		`modelUsage entries missing contextWindow: ${JSON.stringify(result.modelUsage)}`);
});

// --- Streaming ---

test("includePartialMessages yields the stream_event shapes processStreamEvent destructures", { timeout: 120_000 }, async () => {
	const events = new Set();
	const contentBlocks = new Set();
	const deltas = new Set();
	const calls = [];
	for await (const message of query({
		prompt: "Think briefly about what 17 * 23 is, then call the alpha tool once, then state the number.",
		options: providerOptions({ includePartialMessages: true, effort: "medium", mcpServers: toolServer([noArgTool("alpha")], calls) }),
	})) {
		if (message.type !== "stream_event") continue;
		const event = message.event;
		events.add(event?.type);
		if (event?.content_block?.type) contentBlocks.add(event.content_block.type);
		if (event?.delta?.type) deltas.add(event.delta.type);
	}

	for (const type of ["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"]) {
		assert.ok(events.has(type), `no ${type} stream_event arrived — got ${JSON.stringify([...events])}`);
	}
	for (const type of ["text", "thinking", "tool_use"]) {
		assert.ok(contentBlocks.has(type), `no ${type} content_block — got ${JSON.stringify([...contentBlocks])}`);
	}
	for (const type of ["text_delta", "thinking_delta", "signature_delta", "input_json_delta"]) {
		assert.ok(deltas.has(type), `no ${type} delta — got ${JSON.stringify([...deltas])}`);
	}
});

test("message_delta usage carries thinking tokens nested under output_tokens_details", { timeout: 120_000 }, async () => {
	// The bridge maps this onto pi's `usage.reasoning`. The nesting is the whole
	// contract: updateUsage previously read a flat `usage.thinking_tokens` plus a
	// `usage.reasoning_tokens` that exists in no SDK version, so it silently reported
	// nothing on every thinking turn. If CC ever flattens or renames the field, this
	// fails here instead of going quiet again.
	const deltaUsages = [];
	for await (const message of query({
		prompt: "Think briefly about what 17 * 23 is, then state just the number.",
		options: providerOptions({ includePartialMessages: true, effort: "medium", maxTurns: 1, persistSession: false }),
	})) {
		if (message.type === "stream_event" && message.event?.type === "message_delta" && message.event.usage) {
			deltaUsages.push(message.event.usage);
		}
	}

	assert.ok(deltaUsages.length > 0, "no message_delta carried usage");
	const withThinking = deltaUsages.filter((u) => typeof u.output_tokens_details?.thinking_tokens === "number");
	assert.ok(withThinking.length > 0,
		`no message_delta reported output_tokens_details.thinking_tokens — got ${JSON.stringify(deltaUsages)}`);
	for (const usage of withThinking) {
		assert.ok(usage.output_tokens_details.thinking_tokens > 0, "a thinking turn must report a positive count");
		assert.ok(usage.output_tokens_details.thinking_tokens <= usage.output_tokens,
			`thinking_tokens must stay a subset of output_tokens: ${JSON.stringify(usage)}`);
		assert.equal(usage.thinking_tokens, undefined, "a flat thinking_tokens would mean the shape changed");
		assert.equal(usage.reasoning_tokens, undefined, "reasoning_tokens has never existed; a value means the shape changed");
	}
});

test("a streamed prompt keeps the query open past result until the input generator ends", { timeout: 120_000 }, async () => {
	// Passing an AsyncIterable makes isSingleUserTurn false, so the SDK no longer
	// closes the CLI's stdin on the first result. That parked generator is what
	// lets deliverToolResults write a steer mid-turn — and is why consumeQuery
	// must call promptStream.end() itself or the query never terminates.
	const HOLD_MS = 5_000;
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	async function* prompt() {
		yield { type: "user", message: { role: "user", content: "Reply with just: OK" }, parent_tool_use_id: null };
		await held;
	}

	const q = query({ prompt: prompt(), options: providerOptions({ maxTurns: 1, persistSession: false }) });
	let resultAt = null;
	let exitAt = null;
	const started = Date.now();
	for await (const message of q) {
		if (message.type === "result" && resultAt === null) {
			resultAt = Date.now() - started;
			setTimeout(release, HOLD_MS);
		}
	}
	exitAt = Date.now() - started;

	assert.ok(resultAt !== null, "no result message arrived");
	assert.ok(exitAt - resultAt >= HOLD_MS * 0.8,
		`the SDK closed stdin on its own ${exitAt - resultAt}ms after result — a streamed prompt no longer parks the query, so steering is dead`);
});

// --- The in-process MCP server ---

test("the SDK treats our McpServer as an opaque endpoint — it only calls connect", { timeout: 120_000 }, async () => {
	// src/mcp-server.ts serves JSON Schema verbatim and never sends
	// tools/list_changed, which is only safe while the SDK ignores everything on
	// the instance except connect(). A new property read here is the early warning.
	const touched = new Set();
	const calls = [];
	const servers = toolServer([noArgTool("alpha")], calls);
	const real = servers["custom-tools"].instance;
	servers["custom-tools"].instance = new Proxy(real, {
		get(target, prop, receiver) {
			if (typeof prop === "string") touched.add(prop);
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	await collect(query({ prompt: "Call the alpha tool once, then stop.", options: providerOptions({ mcpServers: servers }) }));

	assert.ok(calls.length > 0, "no tool call happened — the proxy was never exercised");
	assert.deepEqual([...touched], ["connect"],
		`the SDK now inspects the McpServer instance beyond connect(): ${JSON.stringify([...touched])}`);
});

test("JSON Schema is served verbatim — nested objects and anyOf/const survive", { timeout: 120_000 }, async () => {
	// The reason src/mcp-server.ts bypasses createSdkMcpServer: its Zod round trip
	// flattened nested objects and dropped anyOf/const, so Claude saw only the top
	// level of any structured tool.
	const calls = [];
	const inputSchema = {
		type: "object",
		properties: {
			edit: {
				type: "object",
				properties: {
					path: { type: "string" },
					replacement: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
				},
				required: ["path", "replacement"],
			},
			kind: { anyOf: [{ const: "fast" }, { const: "slow" }] },
		},
		required: ["edit"],
	};
	await collect(query({
		prompt: "Call apply_edit with edit.path='a.txt', edit.replacement.from='X', edit.replacement.to='Y', kind='fast'.",
		options: providerOptions({ mcpServers: toolServer([{ name: "apply_edit", description: "Apply a structured edit.", inputSchema }], calls) }),
	}));

	assert.equal(calls.length, 1, `expected one apply_edit call, got ${calls.length}`);
	assert.deepEqual(calls[0].args, { edit: { path: "a.txt", replacement: { from: "X", to: "Y" } }, kind: "fast" },
		"the nested schema did not reach the model intact");
});

// --- Session transcripts and --resume ---

test("--resume re-reads the JSONL from disk on every call", { timeout: 180_000 }, async () => {
	// Plain resumes must read the named transcript, not a process-local cached copy.
	const sessionId = randomUUID();
	const seed = (token) => {
		const session = createSession({ sessionId, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
		session.clear();
		session.addUserMessage(`Please remember: the token is ${token}.`);
		session.addAssistantMessage([{ type: "text", text: `Got it, the token is ${token}.` }]);
		session.save();
	};
	const ask = async () => {
		const answers = [];
		for await (const message of query({
			prompt: "What token did I ask you to remember? Reply with just the word.",
			options: { resume: sessionId, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions", tools: [], maxTurns: 2 },
		})) {
			if (message.type === "assistant") for (const block of message.message?.content ?? []) if (block.type === "text") answers.push(block.text);
		}
		return answers.join("");
	};

	seed("FOXGLOVE");
	assert.match(await ask(), /foxglove/i);
	seed("SANDPIPER");
	const second = await ask();
	assert.match(second, /sandpiper/i, `rewrite between resumes was ignored: ${second}`);
	assert.doesNotMatch(second, /foxglove/i, `CC served stale content for the same UUID: ${second}`);
});

test("arbitrary sanitized tool_use ids in an imported transcript resume fine", { timeout: 120_000 }, async () => {
	// convert.ts sanitizeToolId only strips characters outside [A-Za-z0-9_-]; the
	// result keeps pi's own id shape rather than CC's toolu_* form.
	const sessionId = randomUUID();
	const session = createSession({ sessionId, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	session.importMessages(repairToolPairing([
		{ role: "user", content: "Read the vault file." },
		{ role: "assistant", content: [{ type: "tool_use", id: "pi_call_0__weird", name: "Read", input: { file_path: "/tmp/vault.txt" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "pi_call_0__weird", content: "The vault code is PLATYPUS." }] },
	]));
	session.save();

	let answer = "";
	for await (const message of query({
		prompt: "What was the vault code from the file you read? One word.",
		options: { resume: sessionId, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions", tools: [], maxTurns: 2 },
	})) {
		if (message.type === "assistant") for (const block of message.message?.content ?? []) if (block.type === "text") answer += block.text;
	}
	assert.match(answer, /platypus/i, `CC did not resume a transcript with non-toolu_ ids: ${answer}`);
});

test("CC writes each tool result of a parallel turn as its own transcript record", { timeout: 120_000 }, async () => {
	// Corrects the premise recorded in src/convert.ts, which says CC "puts every
	// result for an assistant turn in a single user message". It does not — CC's
	// own transcript is one record per result, and one record per assistant
	// content block. The single-message shape convertPiMessages emits is a
	// requirement of repairToolPairing (next test), not a copy of what CC writes.
	const calls = [];
	const { init } = await collect(query({
		prompt: "Call both the alpha tool and the beta tool at the same time, in a single assistant message with two parallel tool calls. Then report both values.",
		options: providerOptions({ mcpServers: toolServer([noArgTool("alpha"), noArgTool("beta")], calls) }),
	}));
	assert.equal(calls.length, 2, `expected two parallel tool calls, got ${calls.length}`);

	const jsonlPath = openSession({ sessionId: init.session_id, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR }).jsonlPath;
	const records = readFileSync(jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const perRecord = records
		.map((record) => (record.type === "user" && Array.isArray(record.message?.content) ? record.message.content.filter((b) => b.type === "tool_result").length : 0))
		.filter((count) => count > 0);

	assert.deepEqual(perRecord, [1, 1],
		`CC's transcript layout for parallel results changed: ${JSON.stringify(perRecord)}`);
});

test("repairToolPairing keeps every result only when they share one user message", { timeout: 30_000 }, () => {
	// The actual constraint behind convertPiMessages collecting a turn's results.
	// Session.importMessages runs this unconditionally, so it cannot be opted out
	// of: split across messages, all but one result is replaced by a placeholder.
	const ids = ["t1", "t2", "t3"];
	const assistant = { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })) };
	const resultsOf = (messages) =>
		repairToolPairing(messages).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [])).map((b) => b.content);

	const split = resultsOf([{ role: "user", content: "go" }, assistant,
		...ids.map((id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `RESULT-${id}` }] }))]);
	const single = resultsOf([{ role: "user", content: "go" }, assistant,
		{ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: `RESULT-${id}` })) }]);

	assert.deepEqual(single, ["RESULT-t1", "RESULT-t2", "RESULT-t3"]);
	assert.ok(split.some((content) => !String(content).startsWith("RESULT-")),
		`repairToolPairing now tolerates split results (${JSON.stringify(split)}) — convertPiMessages could stop collecting them`);
});

// --- Environment suppression ---

test("ENABLE_CLAUDEAI_MCP_SERVERS=0 suppresses claude.ai cloud MCP servers", { timeout: 120_000 }, async (t) => {
	// Cloud servers are a separate code path from filesystem MCP and are blocked
	// by neither --strict-mcp-config nor settingSources.
	const withoutVar = { ...process.env, DISABLE_AUTO_COMPACT: "1" };
	delete withoutVar.ENABLE_CLAUDEAI_MCP_SERVERS;
	const isCloud = (server) => server.name.startsWith("claude.ai ");

	const before = await initOnly({ cwd: CWD, model: MODEL, tools: [], permissionMode: "bypassPermissions", env: withoutVar, maxTurns: 1 });
	const cloud = (before.mcp_servers ?? []).filter(isCloud);
	if (cloud.length === 0) {
		t.skip("no claude.ai cloud MCP servers configured for this account — nothing to suppress");
		return;
	}

	const after = await initOnly({ cwd: CWD, model: MODEL, tools: [], permissionMode: "bypassPermissions", env: { ...withoutVar, ENABLE_CLAUDEAI_MCP_SERVERS: "0" }, maxTurns: 1 });
	assert.deepEqual((after.mcp_servers ?? []).filter(isCloud), [],
		`cloud MCP servers survived the env gate: ${JSON.stringify(after.mcp_servers)}`);
});

test("--strict-mcp-config suppresses filesystem MCP servers", { timeout: 120_000 }, async (t) => {
	const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };
	const base = { cwd: CWD, model: MODEL, tools: [], permissionMode: "bypassPermissions", env, maxTurns: 1 };

	const before = await initOnly(base);
	if ((before.mcp_servers ?? []).length === 0) {
		t.skip("no filesystem MCP servers configured — nothing to suppress");
		return;
	}

	const after = await initOnly({ ...base, extraArgs: { "strict-mcp-config": null } });
	assert.deepEqual(after.mcp_servers ?? [], [],
		`filesystem MCP servers survived --strict-mcp-config: ${JSON.stringify(after.mcp_servers)}`);
});

test("--thinking-display summarized is still an accepted flag value", { timeout: 120_000 }, async () => {
	// The bridge appends this whenever an effort level is set. It is only a
	// liveness check: an invalid value makes the CLI exit 1 (`full` does), and on
	// CC 2.1.141 the flag has no observable effect on which models stream
	// thinking — haiku streams it without the flag, opus streams none with it.
	const { result } = await collect(query({
		prompt: "Reply with just: OK",
		options: providerOptions({ effort: "medium", maxTurns: 1, persistSession: false, extraArgs: { "strict-mcp-config": null, "thinking-display": "summarized" } }),
	}));
	assert.equal(result?.subtype, "success", `CC rejected --thinking-display summarized: ${JSON.stringify(result)}`);
});

// --- Captured request contracts ---

/** One-turn stub API: records every /v1/messages body, answers a canned "OK" SSE.
 *  Lets a contract assert on the exact request CC builds, at zero API cost.
 *  `paths` records every request line; `overloadFirst` answers that many
 *  /v1/messages posts with a 529 first, which CC retries. */
function stubApi(requests, { paths, overloadFirst = 0, toolCallsFirst = [], stall = false } = {}) {
	const server = createServer((req, res) => {
		const chunks = [];
		paths?.push(`${req.method} ${req.url}`);
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method === "POST" && req.url.includes("/v1/messages") && overloadFirst > 0) {
				overloadFirst--;
				res.writeHead(529, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
			} else if (req.method === "POST" && req.url.includes("/v1/messages")) {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				requests.push(body);
				const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
				const tools = requests.length === 1 ? toolCallsFirst : [];
				const blocks = tools.length ? tools.map((name, i) => ({ type: "tool_use", id: `toolu_stub_${i}`, name, input: {} })) : [{ type: "text", text: "" }];
				const contentEvents = blocks.map((block, index) =>
					event("content_block_start", { type: "content_block_start", index, content_block: block })
					+ event("content_block_delta", { type: "content_block_delta", index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "OK" } })
					+ event("content_block_stop", { type: "content_block_stop", index })).join("");
				const start = event("message_start", { type: "message_start", message: { id: `msg_stub_${requests.length}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (stall) { res.write(start + contentEvents); return; }
				res.end(
					start
					+ event("ping", { type: "ping" })
					+ contentEvents
					+ event("message_delta", { type: "message_delta", delta: { stop_reason: tools.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
					+ event("message_stop", { type: "message_stop" }));
			} else {
				res.writeHead(404).end();
			}
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => server.close(),
	})));
}

test("resumeSessionAt + forkSession keeps the cut UUIDs and leaves the ancestor untouched", { timeout: 120_000 }, async () => {
	const requests = [];
	const api = await stubApi(requests);
	const cwd = mkdtempSync(join(tmpdir(), "cc-fork-contract-"));
	const source = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	const forkId = randomUUID();
	try {
		source.addUserMessage("Remember KEPT-FORK-MARKER.");
		source.addAssistantMessage([{ type: "text", text: "Remembered KEPT-FORK-MARKER." }]);
		source.save();
		const kept = source.records.map((r) => r.uuid);
		const cut = kept.at(-1);
		source.addUserMessage("Remember DROPPED-FORK-MARKER instead.");
		source.addAssistantMessage([{ type: "text", text: "Remembered DROPPED-FORK-MARKER." }]);
		source.save();
		const dropped = source.records.slice(kept.length).map((r) => r.uuid);
		const before = readFileSync(source.jsonlPath);
		const mtime = statSync(source.jsonlPath).mtimeMs;
		const promptUuid = randomUUID();
		async function* prompt() {
			yield { type: "user", message: { role: "user", content: "Reply OK to FORK-CONTRACT-PROMPT." }, parent_tool_use_id: null, uuid: promptUuid };
		}
		const { init, result } = await collect(query({
			prompt: prompt(),
			options: providerOptions({
				cwd, maxTurns: 1, resume: source.sessionId, resumeSessionAt: cut, forkSession: true, sessionId: forkId,
				env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_ELEGANT_MEADOW: "0" },
			}),
		}));
		assert.equal(init?.session_id, forkId, "fork must honor its pre-minted target id");
		assert.equal(result?.subtype, "success", JSON.stringify(result));
		assert.ok(forkId && forkId !== source.sessionId, "fork must have a new session id");
		const fork = openSession({ sessionId: forkId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		const ids = fork.records.filter((r) => r.uuid).map((r) => r.uuid);
		assert.deepEqual(ids.slice(0, kept.length), kept, "kept record UUIDs must survive the fork");
		assert.ok(dropped.every((id) => !ids.includes(id)), "discarded record UUIDs survived the cut");
		const next = fork.records.find((r) => r.uuid === promptUuid);
		assert.equal(next?.parentUuid, cut, "supplied prompt UUID must be parented on the cut");
		const body = requests.find((r) => JSON.stringify(r.messages).includes("FORK-CONTRACT-PROMPT"));
		assert.ok(body, "CC sent no fork request");
		assert.match(JSON.stringify(body.messages), /KEPT-FORK-MARKER/);
		assert.doesNotMatch(JSON.stringify(body.messages), /DROPPED-FORK-MARKER/);
		assert.deepEqual(readFileSync(source.jsonlPath), before, "fork mutated the ancestor bytes");
		assert.equal(statSync(source.jsonlPath).mtimeMs, mtime, "fork touched the ancestor mtime");
	} finally {
		api.close();
		deleteSession(source.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
		deleteSession(forkId, cwd, process.env.CLAUDE_CONFIG_DIR);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a truncating fork preserves parallel results outside the leaf's parent path", { timeout: 120_000 }, async () => {
	const requests = [];
	const api = await stubApi(requests, { toolCallsFirst: ["mcp__custom-tools__alpha", "mcp__custom-tools__beta"] });
	const cwd = mkdtempSync(join(tmpdir(), "cc-parallel-fork-"));
	const calls = [];
	const options = providerOptions({
		cwd, maxTurns: 3,
		mcpServers: toolServer([noArgTool("alpha"), noArgTool("beta")], calls),
		env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_ELEGANT_MEADOW: "0" },
	});
	try {
		const seed = await collect(query({ prompt: "Call alpha and beta in parallel.", options }));
		assert.equal(seed.result?.subtype, "success", JSON.stringify(seed.result));
		assert.equal(calls.length, 2);
		const source = openSession({ sessionId: seed.init.session_id, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		const cut = seed.assistantUuids.at(-1);
		const byId = new Map(source.records.map((r) => [r.uuid, r]));
		const parentPath = new Set();
		for (let record = byId.get(cut); record; record = byId.get(record.parentUuid)) parentPath.add(record.uuid);
		const results = source.records.filter((r) => r.type === "user" && Array.isArray(r.message.content) && r.message.content.some((b) => b.type === "tool_result"));
		assert.equal(results.length, 2);
		assert.ok(results.some((r) => !parentPath.has(r.uuid)), "the seed must exercise sibling result records");
		const before = readFileSync(source.jsonlPath);
		for (const forkCut of [results.at(-1).uuid, cut]) {
			const marker = `PARALLEL-FORK-${forkCut}`;
			const forked = await collect(query({ prompt: `Reply OK to ${marker}.`, options: { ...options, resume: seed.init.session_id, resumeSessionAt: forkCut, forkSession: true } }));
			assert.equal(forked.result?.subtype, "success", JSON.stringify(forked.result));
			const fork = openSession({ sessionId: forked.init.session_id, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			assert.ok(results.every((r) => fork.records.some((f) => f.uuid === r.uuid)), "fork dropped a sibling result record");
			const sent = requests.find((r) => JSON.stringify(r.messages).includes(marker));
			assert.ok(sent, "fork sent no request");
			for (const value of ["alpha-VALUE", "beta-VALUE"]) assert.ok(JSON.stringify(sent.messages).includes(value), `fork dropped ${value}`);
			assert.deepEqual(readFileSync(source.jsonlPath), before);
		}
	} finally {
		api.close();
		rmSync(getProjectDir(cwd, process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a steer replayed after a completed turn has its own user record after that assistant", { timeout: 120_000 }, async () => {
	const requests = [];
	const api = await stubApi(requests);
	const cwd = mkdtempSync(join(tmpdir(), "cc-late-steer-"));
	const sessionId = randomUUID();
	const steerUuid = randomUUID();
	const promptUuid = randomUUID();
	let release;
	const completed = new Promise((resolve) => { release = resolve; });
	async function* prompts() {
		yield { type: "user", message: { role: "user", content: "Reply OK to FIRST-TURN." }, parent_tool_use_id: null, uuid: promptUuid };
		await completed;
		yield { type: "user", message: { role: "user", content: "Reply OK to LATE-STEER." }, parent_tool_use_id: null, uuid: steerUuid, priority: "next" };
	}
	try {
		const messages = [];
		let results = 0;
		for await (const message of query({
			prompt: prompts(),
			options: providerOptions({
				cwd, sessionId,
				extraArgs: { "strict-mcp-config": null, "replay-user-messages": null },
				env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_ELEGANT_MEADOW: "0" },
			}),
		})) {
			messages.push(message);
			if (message.type === "result") { assert.equal(message.subtype, "success"); if (++results === 1) release(); }
		}
		assert.equal(results, 2, "both turns must complete");
		assert.ok(messages.some((m) => m.type === "user" && m.isReplay && m.uuid === promptUuid), "CC must replay-acknowledge the initial supplied UUID");
		const firstAssistant = messages.find((m) => m.type === "assistant");
		const replay = messages.find((m) => m.type === "user" && m.isReplay && m.uuid === steerUuid);
		assert.ok(firstAssistant && replay, "the late steer must be replay-acknowledged");
		assert.ok(messages.indexOf(firstAssistant) < messages.indexOf(replay));
		const session = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		const firstAt = session.records.findIndex((r) => r.uuid === firstAssistant.uuid);
		const promptAt = session.records.findIndex((r) => r.uuid === promptUuid);
		assert.ok(promptAt >= 0 && promptAt < firstAt, "initial replay UUID must name the recorded prompt");
		const steerAt = session.records.findIndex((r) => r.uuid === steerUuid);
		assert.ok(firstAt >= 0 && steerAt > firstAt, "late steer must follow the already completed assistant");
		assert.equal(session.records[steerAt].type, "user", "a later-turn steer is a user record, not a queued_command attachment");
		assert.ok(requests.some((r) => JSON.stringify(r.messages).includes("LATE-STEER")));
	} finally {
		release();
		api.close();
		rmSync(getProjectDir(cwd, process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an initial replay's prompt UUID survives abort once the real child exits", { timeout: 120_000 }, async () => {
	const requests = [];
	const api = await stubApi(requests, { stall: true });
	const cwd = mkdtempSync(join(tmpdir(), "cc-prompt-replay-abort-"));
	const source = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
	source.addUserMessage("Remember the old prefix.");
	source.addAssistantMessage([{ type: "text", text: "Remembered." }]);
	source.save();
	const promptUuid = randomUUID();
	let release, resolveExit, replayed = false;
	const held = new Promise((resolve) => { release = resolve; });
	const exited = new Promise((resolve) => { resolveExit = resolve; });
	async function* prompt() {
		yield { type: "user", message: { role: "user", content: "Replay this prompt before answering." }, parent_tool_use_id: null, uuid: promptUuid };
		await held;
	}
	const q = query({ prompt: prompt(), options: providerOptions({
		cwd, resume: source.sessionId, includePartialMessages: true,
		extraArgs: { "strict-mcp-config": null, "replay-user-messages": null },
		spawnClaudeCodeProcess(options) {
			const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
			child.stderr.on("data", () => {});
			child.once("close", resolveExit);
			return child;
		},
		env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_ELEGANT_MEADOW: "0" },
	}) });
	const watchdog = setTimeout(() => { release(); q.close(); }, 15_000);
	try {
		for await (const message of q) {
			if (message.type === "user" && message.isReplay && message.uuid === promptUuid) {
				replayed = true;
				release();
				void q.interrupt().catch(() => {});
				q.close();
				break;
			}
		}
		assert.ok(replayed, "CC must acknowledge the supplied initial prompt UUID");
	} finally {
		clearTimeout(watchdog);
		q.close();
		release();
		await exited;
		try {
			// A replay proves consumption, not an immediate disk flush.
			const saved = openSession({ sessionId: source.sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			assert.ok(saved.records.some((r) => r.uuid === promptUuid), "replayed prompt must be written by real process exit");
		} finally {
			api.close();
			rmSync(getProjectDir(cwd, process.env.CLAUDE_CONFIG_DIR), { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

// --- Per-query proxy routing ---

test("a path prefix on ANTHROPIC_BASE_URL is kept on every request, retries included", { timeout: 120_000 }, async () => {
	// The bridge's trace mode gives each query its own base URL path,
	// http://proxy/q/<queryId>, and diag/capture-proxy.mjs strips it to tie a
	// request to its query. That only works if CC keeps the prefix on every
	// request it sends — first attempts, retries after a 529, and anything else.
	const requests = [];
	const paths = [];
	const api = await stubApi(requests, { paths, overloadFirst: 1 });
	try {
		const { result } = await collect(query({
			prompt: "Reply OK.",
			options: providerOptions({
				maxTurns: 1, persistSession: false,
				env: { ...process.env, ANTHROPIC_BASE_URL: `${api.url}/q/route-probe`, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
			}),
		}));
		assert.equal(result?.subtype, "success", JSON.stringify(result));
		const posts = paths.filter((p) => p.includes("/v1/messages"));
		assert.ok(posts.length >= 2, `CC did not retry the 529, so the retry path went unchecked: ${JSON.stringify(paths)}`);
		const unrouted = paths.filter((p) => !p.split(" ")[1].startsWith("/q/route-probe/"));
		assert.deepEqual(unrouted, [], `requests lost the base URL prefix: ${JSON.stringify(paths)}`);
	} finally {
		api.close();
	}
});

test("routing through the capture proxy does not change what CC sends", { timeout: 180_000 }, async () => {
	// The cache trace points ANTHROPIC_BASE_URL at diag/capture-proxy.mjs, and
	// Claude Code gates some behavior on the API host (CC source: tool search,
	// thinking-binding beta), so the trace also sets _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
	// (src/cache-trace.ts traceQueryStart). Same prompt, tools and settings
	// with and without the proxy: CC's loaded tools and the prompt size of its first
	// request (input + cache read + cache write) must match, or traced runs do not
	// stand for untraced ones. Reads the size off message_start, which the SDK
	// streams either way.
	const out = mkdtempSync(join(tmpdir(), "cc-proxy-neutral-"));
	const proxy = spawn(process.execPath, ["diag/capture-proxy.mjs", "--port", "0", "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	const url = await new Promise((resolve) => proxy.stderr.on("data", (d) => { log += d; const m = log.match(/capture proxy on (http:\S+)/); if (m) resolve(m[1]); }));
	const run = async (extraEnv) => {
		let tools = null;
		let usage = null;
		const q = query({
			prompt: "Reply OK.",
			options: providerOptions({
				maxTurns: 1, persistSession: false, includePartialMessages: true,
				mcpServers: toolServer([noArgTool("alpha")], []),
				env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", ...extraEnv },
			}),
		});
		for await (const message of q) {
			if (message.type === "system" && message.subtype === "init") tools = [...message.tools].sort();
			if (message.type === "stream_event" && message.event.type === "message_start" && !usage) usage = message.event.message.usage;
		}
		return { tools, size: usage && usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens };
	};
	try {
		const direct = await run({});
		const proxied = await run({ _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ANTHROPIC_BASE_URL: `${url}/q/neutral` });
		assert.ok(direct.size > 0 && proxied.size > 0, "no usage on message_start");
		assert.ok(readFileSync(join(out, "index.jsonl"), "utf8").includes("/v1/messages"), "the proxied run did not go through the proxy");
		assert.deepEqual(proxied.tools, direct.tools, "CC loaded different tools behind the proxy");
		assert.equal(proxied.size, direct.size, "CC's first request is a different size behind the proxy");
	} finally {
		const exited = once(proxy, "exit");
		proxy.kill("SIGTERM");
		await exited; // it writes its end manifest first
		rmSync(out, { recursive: true, force: true });
	}
});

/** cache_control markers are breakpoint directives, not cache-keyed content — CC 2.1.280
 *  moves them (and a 1h ttl) between turns, so payload comparisons strip them. */
const sansCacheControl = (m) => JSON.parse(JSON.stringify(m, (_k, v) => (v === null || v === undefined) ? v : (typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([key]) => key !== "cache_control")) : v)));

// --- Native instruction exclusions ---

test("claudeMdExcludes prevents native AGENTS.md from duplicating forwarded instructions", { timeout: 120_000 }, async () => {
	const requests = [];
	const api = await stubApi(requests);
	const cwd = mkdtempSync(join(tmpdir(), "cc-agents-exclude-"));
	const marker = `project-instructions-${randomUUID()}`;
	writeFileSync(join(cwd, "AGENTS.md"), marker);
	try {
		for (const excluded of [false, true]) {
			const { result } = await collect(query({
				prompt: "Reply OK.",
				options: providerOptions({
					cwd, maxTurns: 1, persistSession: false,
					env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
					settings: { claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**", ...(excluded ? ["**/AGENTS.md"] : [])] },
					systemPrompt: { type: "preset", preset: "claude_code", append: marker },
				}),
			}));
			assert.equal(result?.subtype, "success");
			const request = requests.at(-1);
			assert.ok(request, "CC sent no request");
			const system = JSON.stringify(request.system);
			const messages = JSON.stringify(request.messages);
			assert.equal(system.split(marker).length - 1, 1, "forwarded instructions must remain");
			assert.equal(messages.split(marker).length - 1, excluded ? 0 : 1,
				excluded ? "native AGENTS.md survived the exclusion" : "CC did not load AGENTS.md — check ambient exclusions or native loading changes");
		}
	} finally {
		api.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// --- The gitStatus cache pinning ---

test("includeGitInstructions:false strips gitStatus and keeps the preset static across git transitions", { timeout: 180_000 }, async () => {
	// The claude_code preset embeds a gitStatus snapshot (git status --short +
	// log -n 5), and the bridge re-invokes CC every turn — so a git transition
	// rewrites it and busts the prompt cache for the whole conversation
	// (diag/probe-git-cache.mjs). CC has moved the snapshot between the cached
	// system block and the leading user message before; wherever it rides, the
	// provider's includeGitInstructions:false strips it. Pin both sides: without
	// the setting the snapshot is present AND a git transition moves it (the
	// break itself); with it the snapshot is gone and the system blocks plus the
	// leading user message are byte-identical across a transition. This pins
	// CC's behavior, not the bridge's call site — src/index.ts's provider
	// options are the consumer.
	const requests = [];
	const api = await stubApi(requests);
	const repo = mkdtempSync(join(tmpdir(), "cc-gitpin-"));
	const gitIn = (...args) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "p@x" } });
	const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };

	try {
		gitIn("init", "-q");
		gitIn("commit", "--allow-empty", "-qm", "init");
		const opts = (settings, resume) => providerOptions({
			cwd: repo, maxTurns: 1, settings, env,
			systemPrompt: { type: "preset", preset: "claude_code" },
			...(resume ? { resume } : {}),
		});
		const sysText = (body) => (body.system ?? []).map((b) => b.text ?? "").join("\n");
		// Filter to our own requests by a preset anchor: if CC ever adds
		// background side requests, slicing the last two off the raw log could
		// compare those and pass for the wrong reason.
		const presetReqs = () => requests.filter((b) => sysText(b).includes("You are a Claude agent, built on Anthropic's Claude Agent SDK"));

		// Control: default preset carries the git snapshot, and a git transition
		// moves it — the very break this test's positive side pins away. Grep the
		// whole request body rather than a specific block: CC 2.1.280 delivers the
		// snapshot as a <system-reminder> in the leading user message instead of
		// the system blocks, and it may move again. Both turns are fresh (no
		// resume): a resumed conversation echoes msg[0] from session start, while
		// the bridge's rebuild path re-invokes fresh and recomputes it — the shape
		// where the break lives.
		await collect(query({ prompt: "Reply OK.", options: opts({}) }));
		const ctrlFirst = requests.at(-1);
		assert.ok(JSON.stringify(ctrlFirst).includes("gitStatus"),
			"the preset no longer carries a gitStatus block — this test's negative side is obsolete");
		writeFileSync(join(repo, "ctrl-new.txt"), "x\n");
		await collect(query({ prompt: "Reply OK.", options: opts({}) }));
		const [c1, c2] = [presetReqs().at(-2), presetReqs().at(-1)];
		assert.ok(JSON.stringify(c1.messages[0]).includes("gitStatus") && JSON.stringify(c2.messages[0]).includes("gitStatus"),
			"git snapshot no longer rides in the leading user message — re-point this control");
		assert.notDeepEqual(sansCacheControl(c1.messages[0]), sansCacheControl(c2.messages[0]),
			"a git transition did not move the git snapshot without the setting — the break this test guards no longer exists");

		// With the setting: baseline, then a git transition, then resume.
		const base = await collect(query({ prompt: "Reply OK.", options: opts({ includeGitInstructions: false }) }));
		assert.equal(base.result?.subtype, "success");
		writeFileSync(join(repo, "untracked.txt"), "x\n");
		await collect(query({ prompt: "Reply OK.", options: opts({ includeGitInstructions: false }, base.result?.session_id) }));

		const [turn1, turn2] = presetReqs().slice(-2);
		for (const body of [turn1, turn2]) {
			assert.ok(!JSON.stringify({ system: body.system, messages: body.messages }).includes("gitStatus"),
				"a gitStatus block survived includeGitInstructions:false");
		}
		// The prompt cache keys the whole request body: the system blocks and the
		// leading user message must be byte-identical across the transition.
		// (Block 0 of `system` is a per-request billing header, hence slice(1);
		// later blocks may legitimately carry moved cache_control markers, which are
		// breakpoint directives, not cache-keyed content.)
		assert.deepEqual(sansCacheControl(turn1.system).slice(1), sansCacheControl(turn2.system).slice(1),
			"system prompt changed across a git transition despite includeGitInstructions:false");
		assert.deepEqual(sansCacheControl(turn1.messages[0]), sansCacheControl(turn2.messages[0]),
			"leading user message changed across a git transition despite includeGitInstructions:false");
	} finally {
		api.close();
		rmSync(repo, { recursive: true, force: true });
	}
});
