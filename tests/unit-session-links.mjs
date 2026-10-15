#!/usr/bin/env node
// Unit tests for the persisted pi→CC session links (session-links.ts).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { recordSessionLink, lookupSessionLink } from "../src/session-links.js";

const path = process.env.CLAUDE_BRIDGE_SESSION_LINKS_PATH;

describe("session links", () => {
	beforeEach(() => rmSync(path, { force: true }));

	it("runs against the test path, never the real agent dir", () => {
		assert.ok(path && path.includes("claude-bridge-test-log-"), `unexpected path ${path}`);
	});

	it("returns the CC session a pi session last ran on in the same cwd", () => {
		recordSessionLink("pi-1", "cc-a", "/w");
		recordSessionLink("pi-1", "cc-b", "/w");
		assert.equal(lookupSessionLink("pi-1", "/w"), "cc-b");
	});

	it("does not return a link recorded for another cwd or another pi session", () => {
		recordSessionLink("pi-2", "cc-c", "/w");
		assert.equal(lookupSessionLink("pi-2", "/other"), undefined);
		assert.equal(lookupSessionLink("pi-3", "/w"), undefined);
	});

	it("ignores calls without a pi session id", () => {
		recordSessionLink(null, "cc-d", "/w");
		recordSessionLink(undefined, "cc-d", "/w");
		assert.equal(lookupSessionLink(null, "/w"), undefined);
		assert.throws(() => readFileSync(path));
	});

	it("treats a corrupt file as empty and recovers on the next write", () => {
		writeFileSync(path, "{not json");
		assert.equal(lookupSessionLink("pi-4", "/w"), undefined);
		recordSessionLink("pi-4", "cc-e", "/w");
		assert.equal(lookupSessionLink("pi-4", "/w"), "cc-e");
	});

	it("keeps the file bounded, dropping the oldest links first", () => {
		const many = {};
		for (let i = 0; i < 600; i++) many[`old-${i}`] = { ccSessionId: `cc-${i}`, cwd: "/w", at: i };
		writeFileSync(path, JSON.stringify(many));
		recordSessionLink("pi-new", "cc-new", "/w");
		const kept = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(Object.keys(kept).length, 500);
		assert.equal(kept["pi-new"].ccSessionId, "cc-new");
		assert.equal(kept["old-0"], undefined);
		assert.ok(kept["old-599"]);
	});
});
