/**
 * verifyWrittenSession warns if the JSONL file doesn't round-trip (missing file,
 * record-count mismatch, sessionId drift).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWrittenSession } from "../src/session-verify.js";

describe("verifyWrittenSession", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-session-"));
	const path = join(dir, "session.jsonl");
	const SID = "abc-123";
	const rec = (sessionId, i) => JSON.stringify({ sessionId, idx: i });
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("no warnings when file round-trips correctly", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1), rec(SID, 2)].join("\n") + "\n");
		assert.deepEqual(verifyWrittenSession(path, SID, 3), []);
	});

	it("warns when file is missing", () => {
		const missing = join(dir, "nope.jsonl");
		const warnings = verifyWrittenSession(missing, SID, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /file missing/);
	});

	it("warns on record count mismatch", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 5);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /record count mismatch.*expected=5.*actual=2/);
	});

	it("warns on sessionId drift", () => {
		writeFileSync(path, [rec(SID, 0), rec("different-sid", 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /sessionId drift/);
	});

	it("warns on malformed JSONL", () => {
		writeFileSync(path, "not json\n");
		const warnings = verifyWrittenSession(path, SID, 1);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /malformed JSONL/);
	});
});
