import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectUnitTests } from "./lib/select-unit-tests.mjs";

const repo = new Map([
	["src/index.ts", 'import { a } from "./a.js";\n'],
	["src/a.ts", 'import { b } from "./b.js";\n'],
	["src/b.ts", "export const b = 1;\n"],
	["src/lone.ts", "export const lone = 1;\n"],
	["diag/capture-proxy.mjs", 'import { diff } from "./lib/diff.mjs";\n'],
	["diag/lib/diff.mjs", "export const diff = 1;\n"],
	["tests/unit-index.mjs", 'const mod = await import("../src/index.js?isolated-child");\n'],
	["tests/unit-a.mjs", 'import { a } from "../src/a.js";\n'],
	["tests/unit-lone.mjs", 'import { lone } from "../src/lone.js";\n'],
	["tests/unit-proxy.mjs", 'spawn(process.execPath, ["diag/capture-proxy.mjs", "--port", "0"]);\n'],
	["tests/unit-gone.mjs", 'import { gone } from "../src/gone.js";\n'],
	["tests/lib/mock-pi.mjs", "export const mock = 1;\n"],
]);
const select = (...changed) => selectUnitTests({ changed, sourceByPath: repo });

describe("selectUnitTests", () => {
	it("follows imports transitively instead of only the test's direct imports", () => {
		assert.deepEqual(select("src/b.ts"), { kind: "some", tests: ["tests/unit-a.mjs", "tests/unit-index.mjs"] });
	});

	it("leaves out tests that never reach the change instead of running all of them", () => {
		assert.deepEqual(select("src/lone.ts"), { kind: "some", tests: ["tests/unit-lone.mjs"] });
	});

	it("selects an edited test file even though nothing imports it", () => {
		assert.deepEqual(select("tests/unit-a.mjs"), { kind: "some", tests: ["tests/unit-a.mjs"] });
	});

	it("follows a repo-root path a test spawns instead of missing non-import references", () => {
		assert.deepEqual(select("diag/lib/diff.mjs"), { kind: "some", tests: ["tests/unit-proxy.mjs"] });
	});

	it("still runs a test whose dependency was deleted instead of dropping it", () => {
		assert.deepEqual(select("src/gone.ts"), { kind: "some", tests: ["tests/unit-gone.mjs"] });
	});

	it("runs no tests for a docs-only change instead of the whole suite", () => {
		assert.deepEqual(select("README.md", "CHANGELOG.md"), { kind: "some", tests: [] });
	});

	for (const shared of ["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml", "tests/lib/mock-pi.mjs", "tests/fixtures/pi-history-310.jsonl"]) {
		it(`runs every test when ${shared} changes instead of narrowing`, () => {
			assert.deepEqual(select("src/lone.ts", shared), { kind: "all", reason: `shared file changed: ${shared}` });
		});
	}
});
