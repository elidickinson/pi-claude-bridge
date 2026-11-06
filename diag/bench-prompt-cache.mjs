#!/usr/bin/env node
// node --expose-gc --import tsx diag/bench-prompt-cache.mjs [path/to/prompt-capture.ts]
// Run each revision in a fresh process. Measures live JS heap, not process RSS.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(typeof global.gc, "function", "run with --expose-gc");
const source = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("../src/prompt-capture.ts", import.meta.url);
const { PromptCaptures } = await import(source.href);
const count = 256;
const chars = 32768;

// Reconstruct equal, independently allocated UTF-16 strings, as separate pi
// prompt assembly and provider lookup do. No slices retaining a larger buffer.
function prompt(seed) {
	const data = new Uint16Array(chars);
	for (let i = 0; i < data.length; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		data[i] = 0x1000 + (seed % 0x5000);
	}
	return Buffer.from(data.buffer).toString("utf16le");
}
function heap() {
	for (let i = 0; i < 3; i++) global.gc();
	return process.memoryUsage().heapUsed;
}
function record(cache) {
	for (let i = 1; i <= count; i++) cache.record(prompt(i), { contextFiles: [], skills: [] });
}
function lookup(cache) {
	const times = [];
	for (let i = 1; i <= count; i++) {
		const key = prompt(i);
		const at = performance.now();
		const found = cache.resolveOrDerive(key);
		times.push(performance.now() - at);
		assert.equal(found.assembledPrompt, key);
	}
	return times.sort((a, b) => a - b)[Math.floor(count * 0.95)];
}
const cache = new PromptCaptures(count);
const before = heap();
record(cache);
const afterRecord = heap();
const lookupP95Ms = lookup(cache);
const afterLookup = heap();
assert.equal(cache.size, count);
console.log(JSON.stringify({ node: process.version, count, chars, before, afterRecord, afterLookup,
	recordedHeapMiB: (afterRecord - before) / 2 ** 20,
	lookedUpHeapMiB: (afterLookup - before) / 2 ** 20, lookupP95Ms }, null, 2));
