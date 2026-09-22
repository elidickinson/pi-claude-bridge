#!/usr/bin/env node
// Context size probe: for each model id (bare and [1m]), ask the Claude Agent
// SDK for one trivial turn and record the context window Anthropic actually
// serves (from the `result` message's modelUsage), independent of pi/bridge
// config.
//
// Run on the current subscription tier, then re-run after changing tiers; the
// saved JSON/MD lets you compare served context sizes across plans and model ids.
//
//   node diag/context-size.mjs pro        # current tier label (pro | max)
//   node diag/context-size.mjs --compare  # diff latest pro-* vs max-* JSON
//
// Uses the same subscription OAuth the bridge uses (do NOT set ANTHROPIC_API_KEY).
// Each turn is a tiny "reply yes" prompt; some combos may error or spend metered
// credits — both are useful signal. Results save to .test-output/context-size/.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(DIR, ".test-output", "context-size");
mkdirSync(OUTDIR, { recursive: true });

const MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-fable-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];
const VARIANTS = ["bare", "1m"];
const PER_CALL_MS = 120_000;
const PROMPT = 'Reply with just the word "yes".';

// Read SDK + bundled CC version for the saved report.
let sdkVersion = "?", claudeCodeVersion = "?";
try {
	const pkg = JSON.parse(readFileSync(join(DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
	sdkVersion = pkg.version;
	claudeCodeVersion = pkg.claudeCodeVersion ?? "?";
} catch {}

function iso() { return new Date().toISOString().replace(/[:.]/g, "-"); }

async function probe(requestedId) {
	const cwd = mkdtempSync(join(tmpdir(), "context-size-"));
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PER_CALL_MS);
	const started = Date.now();
	let result = null;
	let error = null;
	const messageTypes = [];
	let rateLimitEvent = null;
	let assistantError = null;
	try {
		for await (const msg of query({
			prompt: PROMPT,
			options: {
				cwd,
				model: requestedId,
				settingSources: [],
				tools: [],
				strictMcpConfig: true,
				maxTurns: 1,
				persistSession: false,
				abortController: ac,
			},
		})) {
			messageTypes.push(msg.subtype ? `${msg.type}:${msg.subtype}` : msg.type);
			if (msg.type === "rate_limit_event") rateLimitEvent = msg.rate_limit_info ?? null;
			if (msg.type === "assistant" && msg.error) assistantError = { error: msg.error, text: msg.message?.content?.[0]?.text ?? null };
			if (msg.type === "result") { result = msg; break; }
		}
	} catch (e) {
		error = e?.message ? `${e.name}: ${e.message}` : String(e);
	} finally {
		clearTimeout(timer);
		rmSync(cwd, { recursive: true, force: true });
	}
	const elapsed = Date.now() - started;
	if (!result) {
		return { requestedId, status: error ? "error" : "timeout", error: error ?? "no result message", elapsedMs: elapsed, messageTypes };
	}
	const mu = result.modelUsage ?? {};
	const served = Object.entries(mu).map(([k, v]) => ({
		servedModel: k,
		contextWindow: v.contextWindow,
		maxOutputTokens: v.maxOutputTokens,
		inputTokens: v.inputTokens,
		outputTokens: v.outputTokens,
		cacheReadInputTokens: v.cacheReadInputTokens,
		costUSD: v.costUSD,
	}));
	return {
		requestedId,
		status: result.is_error ? `error(is_error:${result.subtype})` : (result.subtype === "success" ? "success" : `error:${result.subtype}`),
		isError: !!result.is_error,
		stopReason: result.stop_reason ?? null,
		apiErrorStatus: result.api_error_status ?? null,
		resultText: result.result ?? null,
		terminalReason: result.terminal_reason ?? null,
		elapsedMs: elapsed,
		durationApiMs: result.duration_api_ms ?? null,
		totalCostUsd: result.total_cost_usd ?? null,
		errors: result.errors ?? [],
		rateLimitEvent,
		assistantError,
		messageTypes,
		served,
	};
}

function mdTable(rows) {
	const head = "| model | variant | requested id | status | served model | context | max out | error |";
	const sep  = "|---|---|---|---|---|---|---|---|";
	const body = rows.map((r) => {
		const [m, v] = r.requestedId.includes("[1m]") ? [r.requestedId.replace("[1m]", ""), "[1m]"] : [r.requestedId, "bare"];
		const served = (r.served ?? []).map((s) => `${s.servedModel}@${s.contextWindow}/${s.maxOutputTokens}`).join(" ") || "—";
		const errParts = [];
		if (r.error) errParts.push(String(r.error));
		if (r.apiErrorStatus != null) errParts.push(`http ${r.apiErrorStatus}`);
		if (r.resultText && r.isError) errParts.push(`"${String(r.resultText).slice(0, 60)}"`);
		if (r.errors?.length) errParts.push(r.errors.join("; "));
		const err = errParts.join(" · ").slice(0, 120);
		return `| ${m} | ${v} | ${r.requestedId} | ${r.status} | ${served} | ${r.served?.[0]?.contextWindow ?? "—"} | ${r.served?.[0]?.maxOutputTokens ?? "—"} | ${err} |`;
	});
	return [head, sep, ...body].join("\n");
}

async function run(plan) {
	const combos = [];
	for (const id of MODELS) for (const v of VARIANTS) combos.push(v === "1m" ? `${id}[1m]` : id);
	const rows = [];
	for (const requestedId of combos) {
		process.stdout.write(`  ${requestedId} ... `);
		const r = await probe(requestedId);
		rows.push(r);
		const served = (r.served ?? []).map((s) => `${s.contextWindow}`).join(",") || "—";
		const errParts = [];
		if (r.error) errParts.push(String(r.error).slice(0, 60));
		if (r.apiErrorStatus != null) errParts.push(`http ${r.apiErrorStatus}`);
		if (r.resultText && r.isError) errParts.push(`"${String(r.resultText).slice(0, 50)}"`);
		console.log(`${r.status} served=${served}${errParts.length ? ` err=${errParts.join(" · ")}` : ""}`);
	}
	const stamp = iso();
	const report = {
		plan, timestamp: new Date().toISOString(),
		sdkVersion, claudeCodeVersion,
		apiKeySet: !!process.env.ANTHROPIC_API_KEY,
		models: MODELS, variants: VARIANTS,
		rows,
	};
	const jsonPath = join(OUTDIR, `${plan}-${stamp}.json`);
	const mdPath = join(OUTDIR, `${plan}-${stamp}.md`);
	writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
	writeFileSync(mdPath, `# Context size — plan=${plan} @ ${report.timestamp}\n\nSDK ${sdkVersion} (CC ${claudeCodeVersion}), ANTHROPIC_API_KEY=${report.apiKeySet}\n\n${mdTable(rows)}\n`);
	console.log(`\nsaved ${jsonPath}`);
	console.log(`saved ${mdPath}\n`);
	console.log(mdTable(rows));
}

function latestJson(prefix) {
	const files = readdirSync(OUTDIR).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json")).sort();
	return files.length ? join(OUTDIR, files[files.length - 1]) : null;
}

function compare() {
	const pro = latestJson("pro");
	const max = latestJson("max");
	if (!pro || !max) { console.log(`need both a pro-* and max-* JSON (found pro=${!!pro} max=${!!max})`); process.exit(1); }
	const a = JSON.parse(readFileSync(pro, "utf8"));
	const b = JSON.parse(readFileSync(max, "utf8"));
	const lookup = (rep) => Object.fromEntries(rep.rows.map((r) => [r.requestedId, r]));
	const A = lookup(a), B = lookup(b);
	console.log(`compare pro @ ${a.timestamp}  vs  max @ ${b.timestamp}\n`);
	console.log("| requested id | pro context | max context | pro status | max status |");
	console.log("|---|---|---|---|---|");
	for (const id of [...new Set([...Object.keys(A), ...Object.keys(B)])]) {
		const pa = A[id], pb = B[id];
		const pc = pa?.served?.[0]?.contextWindow ?? "—";
		const mc = pb?.served?.[0]?.contextWindow ?? "—";
		console.log(`| ${id} | ${pc} | ${mc} | ${pa?.status ?? "—"} | ${pb?.status ?? "—"} |`);
	}
}

const arg = process.argv[2];
if (arg === "--compare") compare();
else run(arg ?? "pro");
