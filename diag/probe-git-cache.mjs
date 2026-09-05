#!/usr/bin/env node
// Does a git-status change in the working tree bust the prompt cache?
//
// Issue #73 asserts that CC's `claude_code` preset embeds a git-status block in
// the cached system block, so any working-tree edit invalidates the cached
// prefix. This probe settles it against the installed CC/SDK instead of by
// reading the source or the debug log.
//
//   node diag/capture-proxy.mjs --port 8787 --out /tmp/gitcache-capture &
//   node diag/probe-git-cache.mjs /tmp/gitcache-repo
//   node diag/probe-git-cache.mjs --phase2 /tmp/gitcache-repo
//   node diag/probe-git-cache.mjs --report /tmp/gitcache-capture
//
// Each turn is a fresh one-shot query() with no resume, which is what a bridge
// turn is: CC re-invoked from scratch. That isolates the system prompt from the
// cold-resume finding in diag/AUDIT.md, which would otherwise swamp it.
//
// Findings, against CC 2.1.141 / SDK 0.2.141:
//   - The git block is the trailing suffix of system[2], which carries
//     cache_control ephemeral 1h. CC recomputes it on every invocation.
//   - Editing a file already listed dirty leaves system[2] byte-identical and
//     hits cache fully. "Any working-tree edit breaks the cache" is false.
//   - A status *transition* (new untracked path, git add, new commit) changes
//     the block and truncates cacheRead back to the tools prefix. Everything
//     from the system prompt onward is re-written.
//   - system[0] carries `x-anthropic-billing-header: ... cch=<hex>`, has no
//     cache_control, changes every request, and is ignored by the cache key.
//
// The request must be BRIDGE-SHAPED or the result is an artifact. The prefix is
// ordered tools -> system[0..2] -> messages, and system[1] is only 62 chars, so
// with a couple of small tools the first breakpoint falls under the minimum
// cacheable length and cacheRead can only ever read 0 — which looks like a total
// miss and hides where the break actually lands. The fat tool set and append
// below exist to put that breakpoint above the threshold, as a real turn does.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const PROXY = process.env.PROBE_PROXY ?? "http://127.0.0.1:8787";
const MODEL = "claude-haiku-4-5";
const GIT_ANCHOR = "gitStatus:";

const filler = (n, seed) => Array.from({ length: n },
	(_, i) => `${seed} clause ${i}: the operand must be a well-formed path relative to the workspace root and is validated before dispatch.`).join(" ");

const PROBE_TOOLS = Array.from({ length: 11 }, (_, i) =>
	tool(`fat_tool_${i}`, `Tool ${i}. ${filler(40, `t${i}`)}`, {
		path: z.string().describe(`Path argument. ${filler(6, `p${i}`)}`),
		mode: z.string().describe(`Mode argument. ${filler(6, `m${i}`)}`),
	}, async () => ({ content: [{ type: "text", text: "ok" }] })),
);
const APPEND = `# Appended agent instructions\n${filler(300, "append")}`;

async function turn(repo, label) {
	const q = query({
		prompt: "Reply with exactly: OK",
		options: {
			cwd: repo,
			model: MODEL,
			tools: [],
			permissionMode: "bypassPermissions",
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: PROXY,
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1",
			},
			mcpServers: { probe: createSdkMcpServer({ name: "probe", tools: PROBE_TOOLS }) },
			systemPrompt: { type: "preset", preset: "claude_code", append: APPEND },
		},
	});
	// An unreachable proxy still yields a `result`, so a bare break on it reports
	// success for a turn that never hit the API and captured nothing.
	for await (const message of q) {
		if (message.type !== "result") continue;
		if (message.is_error || message.subtype !== "success") {
			throw new Error(`turn ${label} failed: ${message.subtype} ${JSON.stringify(message.result ?? "").slice(0, 300)}`);
		}
		break;
	}
	console.error(`turn ${label}: done`);
}

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** Does a *new* path appearing in `git status` break the cache? */
async function phase1(repo) {
	await turn(repo, "1 baseline (writes cache)");
	await turn(repo, "2 control (no git change)");

	writeFileSync(join(repo, "probe-new-file.txt"), "created between turn 2 and 3\n");
	console.error(`--- created probe-new-file.txt: ${git(repo, "status", "--short")}`);

	await turn(repo, "3 test (untracked file added)");
	await turn(repo, "4 control (no further change)");
}

/** Does editing an *already-dirty* file break it? The status line does not move,
 *  which separates "any edit" from "a status transition". */
async function phase2(repo) {
	await turn(repo, "5 baseline");

	appendFileSync(join(repo, "a.txt"), "more content, file was already modified\n");
	console.error(`--- appended to already-dirty a.txt: ${JSON.stringify(git(repo, "status", "--short"))}`);
	await turn(repo, "6 test (edit to already-dirty file)");

	git(repo, "add", "a.txt");
	console.error(`--- staged a.txt: ${JSON.stringify(git(repo, "status", "--short"))}`);
	await turn(repo, "7 test (staged, ' M' -> 'M ')");

	git(repo, "commit", "-qm", "probe commit");
	console.error(`--- committed: ${JSON.stringify(git(repo, "log", "--oneline", "-n", "1"))}`);
	await turn(repo, "8 test (new commit)");
}

/** The system prompt as one string, minus the billing-header block. That block
 *  changes every request and is provably ignored by the cache key, so including
 *  it reports a divergence on every pair and hides the real signal. */
function systemText(request) {
	const system = request.system;
	if (typeof system === "string") return system;
	return (system ?? [])
		.filter((block) => !(block.text ?? "").startsWith("x-anthropic-billing-header:"))
		.map((block) => block.text ?? "").join("\n");
}

/** First byte offset at which two strings differ, or -1 when identical. */
function firstDivergence(a, b) {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i === limit && a.length === b.length) return -1;
	return i;
}

function report(dir) {
	const index = readFileSync(join(dir, "index.jsonl"), "utf8")
		.trim().split("\n").map((line) => JSON.parse(line))
		.filter((entry) => entry.path.startsWith("/v1/messages") && entry.usage);

	let previous = null;
	let fullPrefix = 0;
	for (const entry of index) {
		const request = JSON.parse(readFileSync(join(dir, `req-${String(entry.n).padStart(4, "0")}.json`), "utf8"));
		const text = systemText(request);
		const tools = JSON.stringify(request.tools ?? []);
		const gitAt = text.indexOf(GIT_ANCHOR);
		const { cacheRead, cacheWrite } = entry.usage;
		fullPrefix = Math.max(fullPrefix, cacheRead);

		console.log(`\n#${entry.n}  cacheRead=${cacheRead}  cacheWrite=${cacheWrite}  tools=${request.tools?.length ?? 0}`);
		console.log(`  gitStatus: ${gitAt === -1 ? "ABSENT" : `${text.length - gitAt} chars at byte ${gitAt} of ${text.length}`}`);

		if (previous) {
			const divergence = firstDivergence(previous.text, text);
			const changed = divergence !== -1;
			console.log(`  vs #${previous.n}: system ${changed ? `diverges at byte ${divergence}` : "IDENTICAL"}`
				+ `, tools ${tools === previous.tools ? "identical" : "CHANGED"}`);
			if (changed) {
				console.log(`    divergence is ${divergence >= gitAt ? "INSIDE" : "BEFORE"} the git block`);
				console.log(`    prev: ${JSON.stringify(previous.text.slice(divergence, divergence + 70))}`);
				console.log(`    curr: ${JSON.stringify(text.slice(divergence, divergence + 70))}`);
			}
			// A system-prompt change truncates the read back to the tools prefix
			// rather than zeroing it, so `cacheRead > 0` is not evidence of a hit.
			console.log(`    => ${changed
				? `BREAK — read truncated to the ${cacheRead}-token tools prefix, re-cached ${cacheWrite}`
				: `HIT — read ${cacheRead} of the ${fullPrefix}-token prefix`}`);
		}
		previous = { n: entry.n, text, tools };
	}
}

const args = process.argv.slice(2);
if (args[0] === "--report") report(args[1]);
else if (args[0] === "--phase2") await phase2(args[1]);
else await phase1(args[0]);
