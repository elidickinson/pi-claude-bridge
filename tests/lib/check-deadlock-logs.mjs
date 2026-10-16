#!/usr/bin/env node
// Fail a completed integration run on bridge-origin deadlock warnings.
// The per-run log directory prevents old runs from poisoning this check.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEADLOCK = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[[a-z0-9]+\] (?:BUG:|WARNING: \d+ MCP handlers still waiting\b)/;

export function scanDeadlockLogs(dir) {
	const files = readdirSync(dir).filter((name) => name.endsWith("-debug.log")).sort();
	if (!files.length) throw new Error(`No integration debug logs in ${dir}`);
	const findings = [];
	for (const file of files) {
		const lines = readFileSync(join(dir, file), "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (DEADLOCK.test(lines[i])) findings.push(`${file}:${i + 1}: ${lines[i]}`);
		}
	}
	return findings;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const dir = process.argv[2];
	if (!dir) throw new Error("Usage: check-deadlock-logs.mjs <integration-log-dir>");
	const findings = scanDeadlockLogs(dir);
	if (findings.length) {
		console.error(`Bridge deadlock warnings:\n${findings.join("\n")}`);
		process.exitCode = 1;
	} else {
		console.log(`No bridge deadlock warnings in ${dir}`);
	}
}
