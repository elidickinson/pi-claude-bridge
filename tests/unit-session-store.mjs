#!/usr/bin/env node
// Unit tests for persisted Claude session state.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deleteSessionState, loadSessionState, saveSessionState } from "../src/session-store.js";

const state = {
	ccSessionId: "cc-1", cwd: "/work", model: "claude-test", digests: ["d1", "d2"],
	uuids: ["u1", null], cuttable: [true, false], dirtyTail: false,
};
let agentDir;
let previousAgentDir;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "session-store-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function sessionFile(id) {
	const dir = join(agentDir, "claude-bridge", "sessions");
	const previous = new Set(existsSync(dir) ? readdirSync(dir) : []);
	saveSessionState(id, state);
	return join(dir, readdirSync(dir).find((file) => !previous.has(file)));
}

function validFile() {
	return {
		version: 1, ccSessionId: state.ccSessionId, cwd: state.cwd, model: state.model,
		digests: state.digests, uuids: state.uuids, cuttable: state.cuttable,
	};
}

describe("session state persistence", () => {
	it("round-trips state, restores dirtyTail, and writes only the versioned state fields", () => {
		saveSessionState("session-1", { ...state, dirtyTail: true });
		const dir = join(agentDir, "claude-bridge", "sessions");
		const file = join(dir, readdirSync(dir)[0]);
		assert.deepEqual(loadSessionState("session-1", assert.fail), { ...state, dirtyTail: true });
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), [
			"ccSessionId", "cuttable", "cwd", "digests", "model", "uuids", "version",
		]);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});

	it("accepts intentional null-uuid omissions and returns null for a missing file", () => {
		assert.equal(loadSessionState("missing", assert.fail), null);
		saveSessionState("omission", { ...state, uuids: [null, "u2"], cuttable: [false, true] });
		assert.deepEqual(loadSessionState("omission", assert.fail), {
			...state, uuids: [null, "u2"], cuttable: [false, true], dirtyTail: true,
		});
	});

	it("rejects malformed and invalid versioned files with a reason", () => {
		const cases = [
			["invalid JSON", "{"],
			["unsupported version", JSON.stringify({ ...validFile(), version: 2 })],
			["missing model", JSON.stringify(Object.fromEntries(Object.entries(validFile()).filter(([key]) => key !== "model")))],
			["model must be a string", JSON.stringify({ ...validFile(), model: 42 })],
			["ccSessionId must not be empty", JSON.stringify({ ...validFile(), ccSessionId: "" })],
			["cwd must not be empty", JSON.stringify({ ...validFile(), cwd: "" })],
			["model must not be empty", JSON.stringify({ ...validFile(), model: "" })],
			["aligned", JSON.stringify({ ...validFile(), uuids: ["u1"] })],
			["Invalid session recording slot 0", JSON.stringify({ ...validFile(), uuids: [null, null] })],
			["Invalid session recording slot 0", JSON.stringify({ ...validFile(), uuids: ["", null] })],
		];
		for (const [index, [reason, contents]] of cases.entries()) {
			const id = `invalid-${index}`;
			const file = sessionFile(id);
			writeFileSync(file, contents);
			const rejected = [];
			assert.equal(loadSessionState(id, (message) => rejected.push(message)), null, reason);
			assert.equal(rejected.length, 1, reason);
			assert.match(rejected[0], new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), reason);
		}
	});

	it("rejects an object version without converting it", () => {
		const file = sessionFile("object-version");
		writeFileSync(file, JSON.stringify({ ...validFile(), version: { toString: "hostile", valueOf: "hostile" } }));
		const rejected = [];
		assert.equal(loadSessionState("object-version", (message) => rejected.push(message)), null);
		assert.deepEqual(rejected, ["Rejected persisted Claude session state: unsupported version; expected 1"]);
	});

	it("surfaces read errors other than a missing file", () => {
		const file = sessionFile("directory");
		rmSync(file);
		mkdirSync(file);
		assert.throws(() => loadSessionState("directory", assert.fail), { code: "EISDIR" });
	});

	it("rejects empty session pointers on save", () => {
		for (const key of ["ccSessionId", "cwd", "model"]) {
			assert.throws(() => saveSessionState(`empty-${key}`, { ...state, [key]: "" }), `${key} must be non-empty`);
		}
	});

	it("keeps IDs independent and encodes hostile or long IDs as safe filenames", () => {
		const hostileId = "../../outside/\0\ud800";
		const longId = "host-session-".repeat(1000);
		saveSessionState(hostileId, state);
		saveSessionState("ordinary", { ...state, ccSessionId: "cc-2" });
		saveSessionState(longId, { ...state, ccSessionId: "cc-long" });
		const dir = join(agentDir, "claude-bridge", "sessions");
		const files = readdirSync(dir);
		assert.equal(files.length, 3);
		assert.ok(files.every((file) => file.endsWith(".json") && !file.includes(sep) && file.length < 255));
		assert.ok(files.every((file) => resolve(dir, file).startsWith(`${resolve(dir)}${sep}`)));
		assert.deepEqual(loadSessionState(hostileId, assert.fail), { ...state, dirtyTail: true });
		assert.equal(loadSessionState("ordinary", assert.fail).ccSessionId, "cc-2");
		assert.equal(loadSessionState(longId, assert.fail).ccSessionId, "cc-long");
		deleteSessionState(hostileId);
		deleteSessionState("absent");
		assert.equal(loadSessionState(hostileId, assert.fail), null);
	});
});
