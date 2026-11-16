#!/usr/bin/env node
// Records real Claude Code SDK message streams as replay fixtures.
//
//   node --import tsx tests/lib/record-sdk-streams.mjs [scenario ...]
//
// Costs API calls, so it is not part of `npm test`. Re-run it when the SDK is
// bumped, then read the diff: a changed fixture is the SDK changing shape under
// us, which is the whole reason these are recorded rather than written by hand.
//
// Prompts are deliberately trivial and the tool calls read a scratch file this
// script creates, so no fixture carries repo or conversation content. The SDK's
// own envelope still does: `system/init` reports the absolute cwd and the user's
// entire personal slash-command and agent list, and every message carries live
// uuids. scrub() below strips that, keeping only the fields consumeQuery reads.
// Never commit a fixture that has not been through it.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./rpc-harness.mjs";
import { NARRATION_KIND, signatureBlockKind } from "../../src/narration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "sdk-streams");
const WORKDIR = join(HERE, "..", ".record-workdir");

// One file each, with contents this script owns, so a recorded tool_result is
// fully determined by what we wrote here.
const FILES = {
	"one.txt": "ONE\n",
	"two.txt": "TWO\n",
	"three.txt": "THREE\n",
	// For the narration scenario, which needs enough in each file for the model to write a
	// real note about it: notes under about a hundred characters have always come back as
	// plain text rather than as a progress update.
	"deploy-a.log": "2026-03-02 09:14:07 build started for release 4.2.0\n"
		+ "2026-03-02 09:14:52 unit tests passed (318 tests, 0 failures)\n"
		+ "2026-03-02 09:15:31 docker image pushed to the staging registry\n",
	"deploy-b.log": "2026-03-02 09:16:03 database migration 0042 applied in 3.2s\n"
		+ "2026-03-02 09:16:20 2 warnings: index idx_orders_created is missing on replica 2\n"
		+ "2026-03-02 09:16:41 migration marked complete\n",
	"deploy-c.log": "2026-03-02 09:17:05 rolling restart of 6 web workers finished\n"
		+ "2026-03-02 09:17:30 health check passed on all workers\n"
		+ "2026-03-02 09:17:44 deploy completed in 3m37s\n",
};

const SCENARIOS = {
	// Plain text turn: no tools, no thinking. The baseline shape.
	text: "Reply with exactly the word ALPHA and nothing else.",
	// One tool call, then a text answer — the two-request tool boundary.
	"single-tool": "Read the file one.txt and reply with exactly its contents, nothing else.",
	// The shape that broke rebuilds: several tool_use blocks in one assistant
	// message and several tool_result blocks in one user message.
	"parallel-tools": "Read one.txt, two.txt and three.txt in a single parallel batch, then reply with the three contents separated by commas.",
	// The note a Claude 5 model writes between tool calls. The API returns it as a signed
	// thinking block, not text; only its signature says it is a progress update.
	narration: "Read deploy-a.log, deploy-b.log and deploy-c.log one at a time, each in its own tool call and never in parallel. "
		+ "After each file, write me a note of two or three sentences on what you found in it before you read the next. "
		+ "When you have read all three, reply with a one-sentence verdict on the deploy.",
};

// Progress updates exist only on Claude 5 models (haiku never writes one), and the bridge
// asks for their text only when pi sends a thinking level, so this scenario names both.
const OPTIONS = {
	narration: { model: "claude-bridge/claude-sonnet-5-5", thinking: "low" },
};

// A fixture recorded for a shape has to contain it, or the replay test asserts nothing.
// The model may skip a progress update, so a miss means run the scenario again.
const progressUpdates = (messages) => messages.filter((m) => m.type === "assistant"
	&& m.message.content.some((b) => b.type === "thinking" && b.thinking.trim() && signatureBlockKind(b.signature) === NARRATION_KIND)).length;
const REQUIRED_SHAPE = {
	narration: [(messages) => progressUpdates(messages) >= 2, "two progress updates (thinking blocks signed as narration)"],
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Message, request and tool-use ids belong to the account that recorded: only Anthropic can map
// them back, but a recording has no use for them.
const API_ID = /\b(msg|req|toolu)_[A-Za-z0-9]{16,}\b/g;
// Only the fields consumeQuery actually reads survive from system/init. Everything
// else there is local configuration — slash_commands, agents, output style, the
// real cwd — and describes this machine rather than the SDK's contract.
const SYSTEM_INIT_KEEP = new Set(["type", "subtype", "session_id", "uuid", "model", "permissionMode", "mcp_servers", "tools"]);

// The rate-limit snapshot is this account's usage and plan state, not the SDK's contract.
// Numbers become 0 and reasons a placeholder; the shape and the status words stay.
function scrubAccountUsage(value) {
	if (typeof value === "number") return 0;
	if (Array.isArray(value)) return value.map(scrubAccountUsage);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /Reason$/.test(k) ? "redacted" : scrubAccountUsage(v)]));
	}
	return value;
}

function scrub(message, ids) {
	const fake = (id) => {
		if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
		return ids.get(id);
	};
	const fakeApiId = (id, kind) => {
		if (!ids.has(id)) ids.set(id, `${kind}_${String(ids.size + 1).padStart(24, "0")}`);
		return ids.get(id);
	};
	const walk = (value) => {
		// The home prefix, not just WORKDIR: the model narrates absolute paths inside
		// thinking deltas, and a delta boundary can cut the path in half.
		if (typeof value === "string") return value.replace(UUID, fake).replace(API_ID, fakeApiId).replaceAll(WORKDIR, "/workdir").replaceAll(homedir(), "/home/user");
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
		return value;
	};
	const kept = message.type === "system" && message.subtype === "init"
		? Object.fromEntries(Object.entries(message).filter(([k]) => SYSTEM_INIT_KEEP.has(k)))
		: message.type === "rate_limit_event"
			? { ...message, rate_limit_info: scrubAccountUsage(message.rate_limit_info) }
			: message;
	return walk(kept);
}

const wanted = process.argv.slice(2);
const chosen = wanted.length ? wanted : Object.keys(SCENARIOS);

mkdirSync(FIXTURES, { recursive: true });
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(WORKDIR, { recursive: true });
for (const [name, body] of Object.entries(FILES)) writeFileSync(join(WORKDIR, name), body);

for (const name of chosen) {
	const prompt = SCENARIOS[name];
	if (!prompt) throw new Error(`unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(", ")}`);

	const { model = "claude-bridge/claude-haiku-4-5", thinking } = OPTIONS[name] ?? {};
	const target = join(FIXTURES, `${name}.jsonl`);
	const raw = join(WORKDIR, `${name}.raw.jsonl`);
	rmSync(raw, { force: true });
	writeFileSync(raw, "");

	const harness = createRpcHarness({
		name: `record-${name}`,
		args: ["--model", model, ...(thinking ? ["--thinking", thinking] : [])],
		cwd: WORKDIR,
		env: { CLAUDE_BRIDGE_RECORD_STREAM: raw },
		defaultTimeout: 120_000,
	});
	await harness.startAndWait();
	try {
		const text = await harness.promptAndWait(prompt, 180_000);
		const ids = new Map();
		const messages = readFileSync(raw, "utf8").split("\n").filter(Boolean)
			.map((line) => JSON.parse(line))
			// SessionStart hooks run on whatever machine records this; they say nothing about the SDK.
			.filter((m) => !(m.type === "system" && m.subtype?.startsWith("hook_")))
			.map((message) => scrub(message, ids));
		const required = REQUIRED_SHAPE[name];
		if (required && !required[0](messages)) {
			throw new Error(`${name}: the recording has no ${required[1]}; the model may skip them, so run the scenario again`);
		}
		const body = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
		// A delta can split the home path so no string replacement sees it whole.
		// Refuse to write rather than commit a fixture carrying the username.
		const user = homedir().split("/").filter(Boolean).pop();
		if (user && body.includes(user)) throw new Error(`${name}: "${user}" survived scrubbing — inspect ${raw} and re-run`);
		writeFileSync(target, body);
		console.log(`${name}: ${messages.length} messages recorded — ${text.trim().slice(0, 60)}`);
	} finally {
		await harness.stop();
	}
}

rmSync(WORKDIR, { recursive: true, force: true });
if (!chosen.every((n) => existsSync(join(FIXTURES, `${n}.jsonl`)))) throw new Error("a fixture was not written");
