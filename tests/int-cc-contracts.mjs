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
// Verified against: SDK 0.2.141 / Claude Code 2.1.222.
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
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession, openSession, repairToolPairing } from "cc-session-io";

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
	let init = null;
	let result = null;
	for await (const message of q) {
		if (message.type === "system" && message.subtype === "init") init = message;
		if (message.type === "assistant") {
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
	return { init, result, toolUses, toolResults };
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
	try {
		for await (const message of query({
			prompt: `Summarize this in one word:\n${"banana ".repeat(220_000)}`,
			options: providerOptions({ maxTurns: 1, persistSession: false }),
		})) {
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
	// syncSharedSession's REBUILD path overwrites the session file in place and
	// keeps the same UUID. That is only correct if CC caches nothing by UUID.
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
		.map((record) => (Array.isArray(record.message?.content) ? record.message.content.filter((b) => b.type === "tool_result").length : 0))
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

// --- The gitStatus cache pinning ---

/** One-turn stub API: records every /v1/messages body, answers a canned "OK" SSE.
 *  Lets a contract assert on the exact request CC builds, at zero API cost. */
function stubApi(requests) {
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				requests.push(body);
				const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					event("message_start", { type: "message_start", message: { id: `msg_stub_${requests.length}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
					+ event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
					+ event("ping", { type: "ping" })
					+ event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } })
					+ event("content_block_stop", { type: "content_block_stop", index: 0 })
					+ event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
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

test("includeGitInstructions:false strips gitStatus and keeps the preset static across git transitions", { timeout: 180_000 }, async () => {
	// The claude_code preset embeds a gitStatus snapshot (git status --short +
	// log -n 5) as the trailing suffix of the cached system block, and the
	// bridge re-invokes CC every turn — so a git transition rewrites it and
	// busts the prompt cache for the whole conversation from the system prompt
	// onward (diag/probe-git-cache.mjs). The provider path sets
	// includeGitInstructions:false for this reason; pin both sides: without it
	// the block is present AND a git transition moves it (the break itself),
	// with it the block is gone and the system prompt is byte-identical
	// across a transition. This pins CC's behavior, not the bridge's call
	// site — src/index.ts's provider options are the consumer.
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
		const presetReqs = () => requests.filter((b) => sysText(b).includes("You are an interactive agent"));

		// Control: default preset carries the block, and a git transition moves
		// it — the very break this test's positive side pins away.
		const ctrl = await collect(query({ prompt: "Reply OK.", options: opts({}) }));
		assert.ok(sysText(requests.at(-1)).includes("gitStatus:"),
			"the preset no longer carries a gitStatus block — this test's negative side is obsolete");
		writeFileSync(join(repo, "ctrl-new.txt"), "x\n");
		await collect(query({ prompt: "Reply OK.", options: opts({}, ctrl.result?.session_id) }));
		assert.notDeepEqual(presetReqs().at(-2).system.slice(1), presetReqs().at(-1).system.slice(1),
			"a git transition did not move the system prompt without the setting — the break this test guards no longer exists");

		// With the setting: baseline, then a git transition, then resume.
		const base = await collect(query({ prompt: "Reply OK.", options: opts({ includeGitInstructions: false }) }));
		assert.equal(base.result?.subtype, "success");
		writeFileSync(join(repo, "untracked.txt"), "x\n");
		await collect(query({ prompt: "Reply OK.", options: opts({ includeGitInstructions: false }, base.result?.session_id) }));

		const [turn1, turn2] = presetReqs().slice(-2);
		for (const body of [turn1, turn2]) {
			assert.ok(!JSON.stringify({ system: body.system, messages: body.messages }).includes("gitStatus:"),
				"a gitStatus block survived includeGitInstructions:false");
		}
		// Block 0 is the per-request billing header (cch hex), ignored by the
		// cache key; everything after it must be byte-identical across the
		// transition for the cache to hold.
		assert.deepEqual(turn1.system.slice(1), turn2.system.slice(1),
			"system prompt changed across a git transition despite includeGitInstructions:false");
	} finally {
		api.close();
		rmSync(repo, { recursive: true, force: true });
	}
});
