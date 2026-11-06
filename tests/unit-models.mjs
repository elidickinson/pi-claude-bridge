/**
 * Tests for MODELS construction.
 * Pins: catalog-driven picker excludes pi-ai's dated snapshot aliases, projection strips
 * pi-ai's baseUrl/api/provider/headers, extra ids from
 * CLAUDE_BRIDGE_EXTRA_MODELS register after the catalog and only when set, and
 * the runtime policy gates [1m] ids on measurement and plan settings.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applyLongContext, buildExtraModels, buildModels, claudeCodeModelId, resolveClaudeCodeRuntimeModel } from "../src/models.js";
import { getModels } from "@earendil-works/pi-ai/compat";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id, extra = {}) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
	...extra,
});

const oneM = (id) => mockPiAiModel(id, { contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("driven by pi-ai's real anthropic catalog, minus dated snapshot aliases", () => {
		const models = buildModels(getModels("anthropic"));
		for (const m of models) {
			assert.doesNotMatch(m.id, /-20\d{6}$/, "no dated snapshot ids in the picker");
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
		// Spot-check coverage of every current family.
		assert.ok(find(models, "claude-opus-5"), "opus-5 present");
		assert.ok(find(models, "claude-fable-5-1"), "fable-5-1 present");
		assert.ok(find(models, "claude-haiku-4-5"), "haiku present");
	});

	it("sorts newest generation first within each family", () => {
		const models = buildModels([
			oneM("claude-opus-4-7"), oneM("claude-opus-5"),
			oneM("claude-sonnet-5"), oneM("claude-opus-4-6"),
		]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"]);
	});

	it("drops dated aliases in favor of bare ids", () => {
		const models = buildModels([mockPiAiModel("claude-opus-4-5-20251101"), mockPiAiModel("claude-opus-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-5"]);
	});

	it("sinks unknown families below the known shortcut families", () => {
		const models = buildModels([oneM("claude-proxy-x"), oneM("claude-opus-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-proxy-x"]);
	});

	it("forwards pi-ai's thinkingLevelMap verbatim", () => {
		const withMap = () => mockPiAiModel("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const models = buildModels([withMap(), mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		assert.equal(find(models, "claude-haiku-4-5")?.thinkingLevelMap, undefined, "no fabricated default");
	});
});

describe("Claude Code runtime policy", () => {
	it("measured-1M ids send [1m] on every plan", () => {
		for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
			assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM(id), PRO), { cliModelId: `${id}[1m]`, contextWindow: 1000000 });
		}
	});

	it("unmeasured ids serve bare at 200K even when pi-ai declares 1M (sonnet-4-5)", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-5"), PRO), { cliModelId: "claude-sonnet-4-5", contextWindow: 200000 });
	});

	it("declared 200K maps to bare id", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-haiku-4-5"), PRO), { cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("measured exception: opus-4-6 1M is plan-gated", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), PRO), { cliModelId: "claude-opus-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), MAX), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), EXTRA), { cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
	});

	it("measured exception: sonnet-4-6 1M requires extra usage", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), PRO), { cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
		assert.deepEqual(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), EXTRA), { cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1000000 });
	});

	it("forceTwoHundredK overrides an optimistic 1M declaration", () => {
		assert.deepEqual(
			resolveClaudeCodeRuntimeModel(oneM("claude-future-9"), { ...PRO, forceTwoHundredK: ["claude-future-9"] }),
			{ cliModelId: "claude-future-9", contextWindow: 200000 },
		);
	});

	it("unknown model falls back to bare id at 200K", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-future-9-9"), PRO), { cliModelId: "claude-future-9-9", contextWindow: 200000 });
	});
});

describe("applyLongContext", () => {
	const models = buildModels(getModels("anthropic"));

	it("registers 1M for measured-1M models", () => {
		const registered = applyLongContext(models, PRO);
		assert.equal(find(registered, "claude-opus-5").contextWindow, 1000000);
		assert.equal(find(registered, "claude-opus-4-7").contextWindow, 1000000);
		assert.equal(find(registered, "claude-fable-5-1").contextWindow, 1000000);
	});

	it("leaves unmeasured sonnet-4-5 at 200K", () => {
		assert.equal(find(applyLongContext(models, PRO), "claude-sonnet-4-5").contextWindow, 200000);
	});

	it("plan gates only the measured exceptions", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-4-6").contextWindow, 200000);
		assert.equal(find(pro, "claude-sonnet-4-6").contextWindow, 200000);

		const max = applyLongContext(models, MAX);
		assert.equal(find(max, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(max, "claude-sonnet-4-6").contextWindow, 200000);

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-opus-4-6").contextWindow, 1000000);
		assert.equal(find(extra, "claude-sonnet-4-6").contextWindow, 1000000);

		// Does not mutate the source table used for id resolution.
		assert.equal(find(models, "claude-opus-4-6").contextWindow, 1000000);
	});

	it("labels exactly the registered 1M models", () => {
		const pro = applyLongContext(models, PRO);
		assert.equal(find(pro, "claude-opus-5").name, "Claude Opus 5 1M");
		assert.equal(find(pro, "claude-opus-4-6").name, "Claude Opus 4.6");
		assert.equal(find(pro, "claude-haiku-4-5").name, "Claude Haiku 4.5 (latest)");

		const extra = applyLongContext(models, EXTRA);
		assert.equal(find(extra, "claude-sonnet-4-6").name, "Claude Sonnet 4.6 1M");
	});
});

it("claude-opus-5-5 requests 1M on Pro", () => {
	assert.deepEqual(resolveClaudeCodeRuntimeModel({ id: "claude-opus-5-5" }, PRO), { cliModelId: "claude-opus-5-5[1m]", contextWindow: 1000000 });
});

// The model list is composed at import time, so a fresh process is the honest
// probe: in-process the env var is read before any test could set it, and the
// provider is already registered.
function registeredModelsInChild(extraModels) {
	const env = { ...process.env };
	delete env.CLAUDE_BRIDGE_DEBUG;
	if (extraModels === undefined) delete env.CLAUDE_BRIDGE_EXTRA_MODELS;
	else env.CLAUDE_BRIDGE_EXTRA_MODELS = extraModels;
	const src = new URL("../src/index.ts", import.meta.url).href;
	const probe = `
		const { default: activate } = await import(${JSON.stringify(src)});
		let models;
		activate({
			on: () => {},
			registerProvider: (_name, config) => { models = config.models; },
			registerTool: () => {},
		});
		console.log(JSON.stringify(models));
	`;
	const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
		env, encoding: "utf8", timeout: 60_000,
	});
	return JSON.parse(out);
}

describe("CLAUDE_BRIDGE_EXTRA_MODELS", () => {
	const catalogIds = () => buildModels(getModels("anthropic")).map((m) => m.id);
	// id, window and cap of each registered extra — the exact id is what the
	// colon-splitting bug got wrong, so every case pins it.
	const extra = (spec) => buildExtraModels(spec).map((m) => [m.id, m.contextWindow, m.maxTokens]);

	it("registers the catalog alone when the variable is unset", () => {
		const registered = registeredModelsInChild(undefined);
		const expected = applyLongContext(buildModels(getModels("anthropic")), PRO);
		assert.deepEqual(registered, JSON.parse(JSON.stringify(expected)));
	});

	it("registers the listed ids after the catalog", () => {
		const registered = registeredModelsInChild("my-model,my-long-model:128000:8192");
		const catalogLength = catalogIds().length;
		assert.deepEqual(registered.slice(0, catalogLength).map((m) => m.id), catalogIds());
		assert.deepEqual(registered.slice(catalogLength), [
			{
				id: "my-model", name: "my-model", reasoning: false, input: ["text"],
				contextWindow: 200000, maxTokens: 32000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "my-long-model", name: "my-long-model", reasoning: false, input: ["text"],
				// A declared window and cap survive registration: the [1m]/200K policy
				// is measured Claude behavior and must not rewrite a foreign id.
				contextWindow: 128000, maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
	});

	it("adds nothing for a blank list, and skips repeats and catalog ids", () => {
		assert.deepEqual(buildExtraModels(undefined), []);
		assert.deepEqual(buildExtraModels(""), []);
		assert.deepEqual(buildExtraModels(" , ,"), []);
		assert.deepEqual(buildExtraModels("my-model,my-model").map((m) => m.id), ["my-model"]);
		assert.deepEqual(buildExtraModels("my-model", ["my-model"]), []);
	});

	// Zero and empty limit fields fall back to the defaults rather than asking for
	// a zero-token model; a non-numeric field is not a window at all (below).
	it("keeps the documented defaults for a zero window or cap", () => {
		const [model] = buildExtraModels("my-model:0:0");
		assert.equal(model.id, "my-model");
		assert.equal(model.contextWindow, 200000);
		assert.equal(model.maxTokens, 32000);
	});

	// Served ids carry colons: splitting on every one of them registered the last
	// segment as the id (`free`) and left the variant unselectable.
	it("registers colon-bearing variants under their complete ids", () => {
		assert.deepEqual(
			extra("meta-llama/llama-3.2-3b-instruct:free,anthropic/claude-opus-5:nitro"),
			[
				["meta-llama/llama-3.2-3b-instruct:free", 200000, 32000],
				["anthropic/claude-opus-5:nitro", 200000, 32000],
			],
		);
	});

	it("takes one or two trailing numeric limits off a colon-bearing id", () => {
		assert.deepEqual(extra("anthropic/claude-opus-5:nitro:128000:8192"), [["anthropic/claude-opus-5:nitro", 128000, 8192]]);
		// One numeric field is the window; the cap keeps its default.
		assert.deepEqual(extra("meta-llama/llama-3.2-3b-instruct:free:64000"), [["meta-llama/llama-3.2-3b-instruct:free", 64000, 32000]]);
		// A non-numeric field before the limit is a variant suffix, so it stays in the id.
		assert.deepEqual(extra("my-model:beta:200000"), [["my-model:beta", 200000, 32000]]);
	});

	it("treats an empty or zero limit field as unset", () => {
		assert.deepEqual(extra("my-model::8192"), [["my-model", 200000, 8192]]);
		assert.deepEqual(extra("my-model:0:0"), [["my-model", 200000, 32000]]);
		assert.deepEqual(extra("my-model:"), [["my-model", 200000, 32000]]);
	});

	// The flat syntax has no escape: a numeric last field is read as a limit even
	// when it is part of the served id, and a non-numeric one joins the id.
	it("reads a numeric id suffix as a limit", () => {
		assert.deepEqual(extra("gateway/model:200000"), [["gateway/model", 200000, 32000]]);
		assert.deepEqual(extra("my-model:200k:0"), [["my-model:200k", 200000, 32000]]);
	});
});
