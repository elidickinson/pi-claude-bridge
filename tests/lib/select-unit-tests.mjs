#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const SHARED_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml"]);
const SHARED_DIRS = ["tests/lib/", "tests/fixtures/"];
const SOURCE_FILE = /\.(ts|mjs|js)$/;
const UNIT_TEST = /^tests\/unit-[^/]+\.mjs$/;
const QUOTED = /["'`]([^"'`\s]+)["'`]/g;

const isShared = (path) => SHARED_FILES.has(path) || SHARED_DIRS.some((dir) => path.startsWith(dir));

// Edges come from every quoted path, not just import specifiers: tests also
// reach files through new URL(), readFileSync() and spawned scripts.
function referencesOf(path, source, isKnown) {
	const refs = new Set();
	for (const [, literal] of source.matchAll(QUOTED)) {
		const spec = literal.split("?")[0];
		const relative = spec.startsWith("./") || spec.startsWith("../");
		if (!relative && !spec.includes("/")) continue;
		const target = normalize(relative ? join(dirname(path), spec) : spec);
		const candidates = target.endsWith(".js") ? [target, target.replace(/\.js$/, ".ts")] : [target];
		const hit = candidates.find(isKnown);
		if (hit) refs.add(hit);
	}
	return refs;
}

export function selectUnitTests({ changed, sourceByPath }) {
	const shared = changed.find(isShared);
	if (shared) return { kind: "all", reason: `shared file changed: ${shared}` };

	const changedSet = new Set(changed);
	const isKnown = (path) => sourceByPath.has(path) || changedSet.has(path);
	const edges = new Map();
	const edgesOf = (path) => {
		if (!edges.has(path)) edges.set(path, sourceByPath.has(path) ? referencesOf(path, sourceByPath.get(path), isKnown) : new Set());
		return edges.get(path);
	};
	const reachesChange = (test) => {
		const seen = new Set([test]);
		const stack = [test];
		while (stack.length) {
			const path = stack.pop();
			if (changedSet.has(path)) return true;
			for (const next of edgesOf(path)) {
				if (!seen.has(next)) {
					seen.add(next);
					stack.push(next);
				}
			}
		}
		return false;
	};
	const tests = [...sourceByPath.keys()].filter((path) => UNIT_TEST.test(path) && reachesChange(path)).sort();
	return { kind: "some", tests };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

function main(base) {
	const untracked = git("ls-files", "--others", "--exclude-standard");
	const files = [...git("ls-files"), ...untracked];
	const sourceByPath = new Map(files.filter((f) => SOURCE_FILE.test(f)).map((f) => [f, readFileSync(f, "utf8")]));
	const unitTests = [...sourceByPath.keys()].filter((f) => UNIT_TEST.test(f)).sort();

	let selection;
	if (!base) selection = { kind: "all", reason: "no base ref given" };
	else {
		const mergeBase = git("merge-base", base, "HEAD")[0];
		selection = selectUnitTests({ changed: [...git("diff", "--name-only", mergeBase), ...untracked], sourceByPath });
	}

	const tests = selection.kind === "all" ? unitTests : selection.tests;
	console.log(selection.kind === "all" ? `Running every unit test: ${selection.reason}` : `Running ${tests.length} of ${unitTests.length} unit tests reached by the change`);
	// node --test with no files falls back to discovering tests on its own.
	if (tests.length === 0) return 0;
	return spawnSync("npm", ["run", "test:unit:files", "--", ...tests], { stdio: "inherit" }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv[2]));
