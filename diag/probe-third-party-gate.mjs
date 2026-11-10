#!/usr/bin/env node
// Does a system prompt trip Anthropic's third-party gate on the bridge's route?
//
// Anthropic bills some system prompts to Extra Usage even with plan limits left,
// or refuses them with "You're out of extra usage" when Extra Usage is off
// (diag/EXTRA-USAGE-400.md). Each arm is one Agent SDK query shaped like a bridge
// turn (src/index.ts provider path: no tools, user settings, `claude_code` preset)
// with the arm's prompt as the preset's append, the way the bridge forwards pi's
// prompt parts. Haiku 4.5, "Reply with just: OK".
//
//   node --import tsx diag/probe-third-party-gate.mjs control diag/third-party-gate/pi-1.5.1.txt ...
//   node --import tsx diag/probe-third-party-gate.mjs --render <pi-bin> <out.txt>
//
// An arm is `control` (no append) or a prompt file. Interleave arms and repeat
// them; results append to .test-output/third-party-gate/results.jsonl.
// --render writes the default system prompt a pi binary renders in an empty
// project with an empty agent dir (no context files or skills), with install
// and project paths normalized so only pi's wording differs between versions.
//
// Reading a row: billed to Extra Usage shows as `overageInUse: true` with
// `isUsingOverage: false` (CC sets the latter only for a rejected plan window),
// `rateLimitType: "overage"` and no `unifiedWindows`. With Extra Usage off the
// same prompt fails 400 with no rate_limit_event.
//
// Costs: a gated request with Extra Usage on is real money (about $0.015 for the
// first, cache reads after). Run it with a small Extra Usage cap.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ccChildEnv, CLAUDE_MD_EXCLUDES } from "../src/cc-child.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(ROOT, ".test-output", "third-party-gate");
const args = process.argv.slice(2);

if (args[0] === "--render") {
	const [, piBin, outArg] = args;
	const out = resolve(outArg);
	const scratch = mkdtempSync(join(tmpdir(), "gate-render-"));
	mkdirSync(join(scratch, "project"));
	const project = realpathSync(join(scratch, "project"));
	const dump = join(scratch, "dump.ts");
	// Exits in before_agent_start whatever happens: pi reports a handler's throw and
	// carries on to the provider request.
	writeFileSync(dump, `import { writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("before_agent_start", (event: any) => {
		try { writeFileSync(${JSON.stringify(out)}, event.systemPrompt); process.exit(0); }
		catch (error) { console.error(error); process.exit(1); }
	});
}
`);
	// The dummy key only gets pi to before_agent_start. No other Anthropic credential
	// reaches it: the agent dir is empty and the ANTHROPIC_* env is dropped.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")));
	execFileSync(piBin, ["--no-session", "-ne", "-e", dump, "--model", "anthropic/claude-haiku-4-5", "-p", "hi"], {
		cwd: project, stdio: "inherit",
		env: { ...env, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", ANTHROPIC_API_KEY: "sk-ant-dummy" },
	});
	const rendered = readFileSync(out, "utf8")
		.replace(/\/\S*?\/node_modules\/@earendil-works\/pi-coding-agent/g, "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent")
		.replaceAll(project, "/tmp/project");
	writeFileSync(out, rendered);
	console.log(`wrote ${out} (${rendered.length} chars)`);
	process.exit(0);
}

const env = ccChildEnv();
// Subscription login only: an API key or gateway would bill elsewhere. A parent
// SDK's attribution would mislabel the request; the SDK stamps its own when unset.
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];
const cwd = mkdtempSync(join(tmpdir(), "gate-probe-"));
mkdirSync(OUTDIR, { recursive: true });

for (const arm of args) {
	const append = arm === "control" ? undefined : readFileSync(arm, "utf8");
	const record = { arm: arm === "control" ? arm : basename(arm), at: new Date().toISOString(), rateLimits: [] };
	try {
		for await (const m of query({
			prompt: "Reply with just: OK",
			options: {
				cwd, env,
				tools: [],
				permissionMode: "bypassPermissions",
				settingSources: ["user"],
				settings: { claudeMdExcludes: CLAUDE_MD_EXCLUDES, includeGitInstructions: false, outputStyle: "default" },
				systemPrompt: { type: "preset", preset: "claude_code", append },
				model: "claude-haiku-4-5",
				strictMcpConfig: true,
				persistSession: false,
				maxTurns: 1,
			},
		})) {
			if (m.type === "system" && m.subtype === "init") Object.assign(record, { apiKeySource: m.apiKeySource, ccVersion: m.claude_code_version });
			else if (m.type === "rate_limit_event") record.rateLimits.push(m.rate_limit_info);
			else if (m.type === "result") Object.assign(record, {
				isError: m.is_error, apiErrorStatus: m.api_error_status, result: String(m.result ?? "").slice(0, 300),
				usage: m.usage, sdkCostUsd: m.total_cost_usd,
			});
		}
	} catch (error) {
		// The SDK throws after an error result; the result is already recorded.
		record.thrown = String(error?.message ?? error).slice(0, 300);
	}
	appendFileSync(join(OUTDIR, "results.jsonl"), JSON.stringify(record) + "\n");
	const rl = record.rateLimits.map((r) => `${r.rateLimitType}:${r.status} overageInUse=${r.overageInUse ?? false} isUsingOverage=${r.isUsingOverage}${r.overageDisabledReason ? ` (${r.overageDisabledReason})` : ""}`).join("; ") || "no rate_limit_event";
	console.log(`${record.arm.padEnd(14)} ${record.isError ? `ERROR ${record.apiErrorStatus ?? ""} ${record.result}` : "ok"} | ${rl} | sdk $${record.sdkCostUsd ?? 0}`);
}
