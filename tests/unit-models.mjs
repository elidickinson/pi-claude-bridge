/**
 * Tests for MODELS construction + resolveModel.
 * Pins: catalog-driven picker excludes pi-ai's dated snapshot aliases, family
 * shortcuts resolve newest-first regardless of sort order, projection strips
 * pi-ai's baseUrl/api/provider/headers, and the runtime policy gates [1m] ids
 * on measurement and plan settings.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLongContext, buildModels, claudeCodeModelId, resolveClaudeCodeRuntimeModel, resolveModel } from "../src/models.js";
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

	it("keeps dated aliases from stealing shortcuts from bare ids", () => {
		const models = buildModels([mockPiAiModel("claude-opus-4-5-20251101"), mockPiAiModel("claude-opus-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-5"]);
		assert.equal(resolveModel(models, "opus-4-5")?.id, "claude-opus-4-5");
	});

	it("sinks unknown families below the known shortcut families", () => {
		const models = buildModels([oneM("claude-proxy-x"), oneM("claude-opus-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-proxy-x"]);
	});

	it("forwards pi-ai's thinkingLevelMap verbatim", () => {
		const withMap = () => mockPiAiModel("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const models = buildModels([withMap()]);
		assert.deepEqual(find(models, "claude-sonnet-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
	});

	it("forwards undefined thinkingLevelMap unchanged (no fabricated defaults)", () => {
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.equal(find(models, "claude-haiku-4-5")?.thinkingLevelMap, undefined);
	});
});

describe("resolveModel", () => {
	const models = buildModels(getModels("anthropic"));

	it("opus shortcut resolves to the newest opus in the catalog", () => {
		// buildModels sorts newest-first within a family and resolveModel's partial
		// tiebreak ranks by the same version, so a new Anthropic release (pi-ai 0.87.1
		// added claude-opus-5-5) keeps both green without edits here.
		const newestOpus = models.find((m) => m.id.includes("opus"));
		assert.ok(newestOpus, "catalog contains an opus model");
		assert.equal(resolveModel(models, "opus")?.id, newestOpus.id);
		// Order independence: reversed input puts the oldest opus first, so a resolver
		// that settled for the first partial match would fail here.
		assert.equal(resolveModel([...models].reverse(), "opus")?.id, newestOpus.id);
	});

	it("exact id beats newer partial match (claude-fable-5 → fable-5, not 5-1)", () => {
		assert.equal(resolveModel(models, "claude-fable-5")?.id, "claude-fable-5");
	});
});

describe("Claude Code runtime policy", () => {
	it("measured-1M ids send [1m] on every plan", () => {
		for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5"]) {
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

describe("claudeCodeModelId", () => {
	it("returns the measured SDK request id", () => {
		assert.equal(claudeCodeModelId({ id: "claude-opus-5", contextWindow: 1000000 }, PRO), "claude-opus-5[1m]");
		assert.equal(claudeCodeModelId({ id: "claude-opus-4-7", contextWindow: 1000000 }, PRO), "claude-opus-4-7[1m]");
		assert.equal(claudeCodeModelId({ id: "claude-haiku-4-5", contextWindow: 200000 }, PRO), "claude-haiku-4-5");
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

	it("haiku shortcut and no-match still resolve", () => {
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-4-5");
		assert.equal(resolveModel(models, "gpt-9"), undefined);
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

describe("200K twins", () => {
	const models = buildModels(getModels("anthropic"));
	const pro = applyLongContext(models, PRO);
	const ids = (list) => list.map((m) => m.id);

	it("every 1M model gets a claude-200k-* twin right after it; 200K models get none", () => {
		for (const m of pro.filter((m) => !m.id.startsWith("claude-200k-"))) {
			const twin = find(pro, m.id.replace(/^claude-/, "claude-200k-"));
			if (m.contextWindow === 1000000) {
				assert.ok(twin, `${m.id} has a twin`);
				assert.equal(pro.indexOf(twin), pro.indexOf(m) + 1, `${m.id} twin sits right after it`);
			} else {
				assert.equal(twin, undefined, `${m.id} is 200K, no twin`);
			}
		}
		assert.ok(find(pro, "claude-200k-opus-5-5"));
		assert.equal(find(pro, "claude-200k-haiku-4-5"), undefined);
		assert.equal(find(pro, "claude-200k-sonnet-4-5"), undefined);
	});

	it("twin registers 200K with a 200K label and inherits the rest of its base", () => {
		const base = find(pro, "claude-opus-5-5");
		const twin = find(pro, "claude-200k-opus-5-5");
		assert.equal(base.contextWindow, 1000000);
		assert.equal(base.name, "Claude Opus 5.5 1M");
		assert.equal(twin.contextWindow, 200000);
		assert.equal(twin.name, "Claude Opus 5.5 200K");
		assert.deepEqual(twin.thinkingLevelMap, base.thinkingLevelMap);
		assert.equal(twin.maxTokens, base.maxTokens);
		assert.equal(twin.reasoning, base.reasoning);
	});

	it("twin sends the bare base id with 1M context disabled in CC", () => {
		assert.deepEqual(resolveClaudeCodeRuntimeModel({ id: "claude-200k-opus-5-5" }, PRO), {
			cliModelId: "claude-opus-5-5", contextWindow: 200000, childEnv: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
		});
		assert.equal(claudeCodeModelId({ id: "claude-200k-fable-5-1" }, MAX), "claude-fable-5-1");
		// Base ids keep their current request and carry no extra env.
		assert.deepEqual(resolveClaudeCodeRuntimeModel({ id: "claude-opus-5-5" }, PRO), { cliModelId: "claude-opus-5-5[1m]", contextWindow: 1000000 });
	});

	it("plan-gated models get a twin only when the plan grants 1M", () => {
		assert.equal(find(pro, "claude-200k-opus-4-6"), undefined);
		assert.ok(find(applyLongContext(models, MAX), "claude-200k-opus-4-6"));
		assert.equal(find(applyLongContext(models, MAX), "claude-200k-sonnet-4-6"), undefined);
		assert.ok(find(applyLongContext(models, EXTRA), "claude-200k-sonnet-4-6"));
	});

	it("forceTwoHundredK pins the base and drops its twin", () => {
		const forced = applyLongContext(models, { ...PRO, forceTwoHundredK: ["claude-opus-5-5"] });
		assert.equal(find(forced, "claude-opus-5-5").contextWindow, 200000);
		assert.equal(find(forced, "claude-200k-opus-5-5"), undefined);
		assert.ok(find(forced, "claude-200k-opus-5"), "other twins unaffected");
	});

	it("base ids and their order are unchanged", () => {
		assert.deepEqual(ids(pro.filter((m) => !m.id.startsWith("claude-200k-"))), ids(models));
	});

	it("shortcuts and partial matches never land on a twin", () => {
		for (const input of ["opus", "fable", "sonnet", "haiku", "opus-5-5", "opus-5", "claude-opus", "5-5"]) {
			assert.equal(resolveModel(pro, input)?.id, resolveModel(models, input)?.id, `"${input}" resolves as before`);
			assert.equal(resolveModel([...pro].reverse(), input)?.id, resolveModel(models, input)?.id, `"${input}" order-independent`);
		}
	});

	it("twins resolve by exact id, or by partial input that asks for 200k", () => {
		assert.equal(resolveModel(pro, "claude-200k-opus-5-5")?.id, "claude-200k-opus-5-5");
		assert.equal(resolveModel(pro, "200k-opus-5")?.id, "claude-200k-opus-5-5");
		assert.equal(resolveModel(pro, "200k-opus")?.id, resolveModel(models, "opus")?.id.replace(/^claude-/, "claude-200k-"));
	});

	it("pi's own partial --model match still prefers the base id", () => {
		// Mirrors pi's tryMatchModel partial step: all non-dated matches, highest id
		// by localeCompare wins. A suffixed twin id would win here and steal "opus".
		const piPartial = (list, pattern) => list
			.filter((m) => m.id.includes(pattern) || m.name.toLowerCase().includes(pattern))
			.sort((a, b) => b.id.localeCompare(a.id))[0]?.id;
		for (const pattern of ["opus", "fable", "sonnet", "opus-5-5", "opus 5.5"]) {
			assert.equal(piPartial(pro, pattern), piPartial(models.map((m) => find(pro, m.id)), pattern), `pi "${pattern}"`);
		}
	});
});
