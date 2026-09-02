#!/usr/bin/env node
// Can we make the cached prefix stable across git-status transitions while
// keeping the claude_code preset? Live probes against the installed CC/SDK.
//
// Phases, each baseline → git transition → resume, with a control turn where
// nothing changes so "cache held" is measured against the right baseline:
//
//   A. excludeDynamicSections:true — the git block relocates to messages[0].
//      Test: is it regenerated on resume (and does that bust the cache)?
//   B. CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 — removes the block entirely.
//   C. settings:{ includeGitInstructions:false } — the documented per-query
//      setting; works only if the inline settings object applies when the
//      bridge passes no settingSources.
//
//   node diag/capture-proxy.mjs --port 8787 --out DIR &
//   node diag/probe-dynamic-sections.mjs REPO
//   node diag/probe-dynamic-sections.mjs --report DIR

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROXY = "http://127.0.0.1:8787";
const MODEL = "claude-haiku-4-5";
const GIT_ANCHOR = "gitStatus:";

const ENV = {
	...process.env,
	ANTHROPIC_BASE_URL: PROXY,
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
};

async function turn(repo, label, opts = {}) {
	const q = query({
		prompt: "Reply with exactly: OK",
		options: {
			cwd: repo,
			model: MODEL,
			tools: [],
			permissionMode: "bypassPermissions",
			env: { ...ENV, ...(opts.env ?? {}) },
			systemPrompt: opts.systemPrompt ?? {
				type: "preset", preset: "claude_code",
				...(opts.excludeDynamicSections ? { excludeDynamicSections: true } : {}),
			},
			...(opts.settings ? { settings: opts.settings } : {}),
			...(opts.resume ? { resume: opts.resume } : {}),
		},
	});
	let sessionId = null;
	for await (const message of q) {
		if (message.type === "result") { sessionId = message.session_id; break; }
	}
	console.error(`turn ${label}: done (session ${sessionId?.slice(0, 8)})`);
	return sessionId;
}

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function setupRepo(dir) {
	rmSync(dir, { recursive: true, force: true });
	execFileSync("git", ["init", "-q", dir]);
	git(dir, "config", "user.email", "probe@example.com");
	git(dir, "config", "user.name", "probe");
	writeFileSync(join(dir, "a.txt"), "baseline\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "initial");
}

/** baseline → untracked file → resume-after-transition → control resume. */
async function phase(repo, name, opts) {
	console.error(`== phase ${name} ==`);
	const s = await turn(repo, `${name}1 baseline`, opts);
	writeFileSync(join(repo, `${name}-new.txt`), "untracked\n");
	console.error(`--- git now: ${JSON.stringify(git(repo, "status", "--short"))}`);
	await turn(repo, `${name}2 resume after git transition`, { ...opts, resume: s });
	await turn(repo, `${name}3 control resume`, { ...opts, resume: s });
}

async function main(repo) {
	setupRepo(repo);
	await phase(repo, "A", { excludeDynamicSections: true });
	await phase(repo, "B", { env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" } });
	await phase(repo, "C", { settings: { includeGitInstructions: false } });
}

// ---- report ----

const msgText = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? "").join("");

function firstDivergence(a, b) {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i === limit && a.length === b.length ? -1 : i;
}

function describeRequest(entry, dir) {
	const request = JSON.parse(readFileSync(join(dir, `req-${String(entry.n).padStart(4, "0")}.json`), "utf8"));
	const sysBlocks = Array.isArray(request.system) ? request.system : [];
	const sysText = sysBlocks.map((b) => b.text ?? "").join("\n");
	const userText = request.messages?.[0] ? msgText(request.messages[0]) : "";
	return {
		n: entry.n, usage: entry.usage, msgs: request.messages?.length ?? 0,
		sysText, sysLen: sysText.length,
		cachedOn: sysBlocks.map((b, i) => b.cache_control ? `[${i}]` : null).filter(Boolean).join(","),
		sysGit: sysText.indexOf(GIT_ANCHOR),
		userGit: userText.indexOf(GIT_ANCHOR), userLen: userText.length, userText,
	};
}

function report(dir) {
	const index = readFileSync(join(dir, "index.jsonl"), "utf8")
		.trim().split("\n").map((line) => JSON.parse(line))
		.filter((entry) => entry.path.startsWith("/v1/messages") && entry.usage);

	let previous = null;
	for (const entry of index) {
		const r = describeRequest(entry, dir);
		const { cacheRead, cacheWrite } = r.usage;
		console.log(`\n#${r.n}  cacheRead=${cacheRead}  cacheWrite=${cacheWrite}  msgs=${r.msgs}`);
		console.log(`  system len=${r.sysLen} cache_control:${r.cachedOn || "none"} gitStatus ${r.sysGit === -1 ? "ABSENT" : `@${r.sysGit}`}`);
		console.log(`  messages[0] len=${r.userLen} gitStatus ${r.userGit === -1 ? "ABSENT" : `@${r.userGit}`}`);

		if (previous) {
			console.log(`  vs #${previous.n}:`);
			console.log(`    system ${previous.sysText === r.sysText ? "IDENTICAL" : `CHANGED at byte ${firstDivergence(previous.sysText, r.sysText)}`}`);
			console.log(`    messages[0] ${previous.userText === r.userText ? "IDENTICAL" : `CHANGED (${previous.userLen} -> ${r.userLen})`}`);
			const readTotal = cacheRead + cacheWrite;
			const prevTotal = previous.usage.cacheRead + previous.usage.cacheWrite;
			console.log(`    prefix total: ${prevTotal} -> ${readTotal} (read ${cacheRead}, wrote ${cacheWrite})`);
			if (previous.userText !== r.userText && previous.userGit !== -1 && r.userGit !== -1) {
				const d = firstDivergence(previous.userText, r.userText);
				console.log(`    msg[0] diff @${d}: ${JSON.stringify(previous.userText.slice(d, d + 40))} -> ${JSON.stringify(r.userText.slice(d, d + 40))}`);
			}
		}
		previous = r;
	}
}

const args = process.argv.slice(2);
if (args[0] === "--report") report(args[1]);
else await main(args[0]);
