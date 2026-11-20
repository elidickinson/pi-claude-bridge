/** Assess whether normalized request changes are limited to the mutation target. */
export function assessMutationAttribution(name, diffs, invariants = {}, { targetObserved: observedOverride } = {}) {
	const shapePath = /^messages\[\d+\]\.content\[\d+\]\.content$/;
	const keyPath = /^messages\[\d+\]\.content\[\d+\]$/;
	const toolResultTextPath = /^messages\[\d+\]\.content\[\d+\]\.content\[\d+\]\.text$/;
	const messageContentPath = /^messages\[\d+\]\.content$/;
	// Dropping an attachment Claude Code renders inside a shared message shortens
	// that message rather than removing an element; one that leaves a message a
	// single text block shows as array -> string in the normalized view.
	const removal = (diff) => ["missing-array-item", "missing-element"].includes(diff.kind)
		|| (diff.kind === "value" && typeof diff.before?.length === "number" && diff.after?.length < diff.before.length)
		|| (diff.kind === "type-or-shape" && messageContentPath.test(diff.path ?? "") && diff.before?.type === "array" && diff.after?.type === "string");
	const targetKinds = {
		"tool-result-content-shape": (diff) => diff.kind === "type-or-shape" && shapePath.test(diff.path ?? ""),
		"tool-result-key-order": (diff) => diff.kind === "key-order" && keyPath.test(diff.path ?? ""),
		"tool-result-trailing-newline": (diff) => diff.kind === "value" && toolResultTextPath.test(diff.path ?? ""),
		"user-content-single-block-to-string": (diff) => diff.kind === "type-or-shape" && messageContentPath.test(diff.path ?? ""),
		"drop-context-attachments": removal,
		"drop-total-tokens-reminders": removal,
		"edit-attachment-date": (diff) => diff.kind === "value",
		"edit-total-tokens-reminder": (diff) => diff.kind === "value",
		// The target is outside the prompt (metadata); any prompt difference is a side effect.
		"rotate-session-id": () => false,
	};
	const isTarget = targetKinds[name] ?? (name.startsWith("drop-attachment-") ? removal : undefined);
	if (!isTarget) throw new Error(`unknown session mutation: ${name}`);
	const sideEffects = diffs.filter((diff) => !isTarget(diff));
	// Rotation's target (metadata) is outside the prompt: there is no prompt diff to align.
	const targetDiffObserved = name === "rotate-session-id" ? Boolean(observedOverride) : diffs.some(isTarget);
	const targetObserved = observedOverride ?? targetDiffObserved;
	const reasons = [];
	if (!targetObserved) reasons.push("target-wire-change-not-observed");
	else if (!targetDiffObserved) reasons.push("target-diff-not-aligned");
	const checks = {
		modelSame: "model-mismatch", toolsSame: "tools-mismatch", thinkingSame: "thinking-mismatch",
		normalizedSystemSame: "normalized-system-changed", controlHistoryComplete: "control-history-incomplete",
		changedHistoryComplete: "changed-history-incomplete", resumeSessionSame: "resume-session-mismatch",
	};
	for (const [key, reason] of Object.entries(checks)) if (invariants[key] === false) reasons.push(reason);
	// Top-level body fields and request headers sit outside the diffed prompt; any change confounds.
	for (const change of invariants.configChanges ?? []) reasons.push(`config-changed:${change.key}`);
	for (const change of invariants.headerChanges ?? []) reasons.push(`header-changed:${change.key}`);
	if (sideEffects.length) reasons.push("normalized-history-changes-outside-target");
	return {
		status: !targetObserved ? "not-attributed-no-target-wire-change" : reasons.length ? "confounded" : "valid",
		targetObserved,
		reasons,
		sideEffects,
	};
}

/** Compare measured read loss only against the prefix length actually cached by the seed. */
export function compareCacheUsage(control, changed, targetObserved, { validityIssues = [] } = {}) {
	const rawReadDifference = control.cacheRead === null || changed.cacheRead === null ? null : control.cacheRead - changed.cacheRead;
	const expectedPrefix = control.expected ?? changed.expected ?? null;
	const expectedMismatch = control.expected !== null && changed.expected !== null && control.expected !== changed.expected;
	const readLoss = rawReadDifference === null || expectedPrefix === null ? null
		: Math.min(control.cacheRead, expectedPrefix) - Math.min(changed.cacheRead, expectedPrefix);
	const writeIncrease = control.cacheWrite === null || changed.cacheWrite === null ? null : changed.cacheWrite - control.cacheWrite;
	const controlCoversExpectedPrefix = expectedPrefix > 0 && control.cacheRead !== null && control.cacheRead >= expectedPrefix;
	let status;
	if (!targetObserved) status = "not-attributed-no-target-wire-change";
	else if (expectedPrefix === null || readLoss === null) status = "inconclusive-usage-missing";
	else if (expectedPrefix <= 0) status = "inconclusive-seed-cached-nothing";
	else if (expectedMismatch) status = "inconclusive-expected-prefix-mismatch";
	else if (!controlCoversExpectedPrefix) status = "inconclusive-control-prefix-incomplete";
	else if (validityIssues.length) status = "confounded";
	else if (readLoss > 0) status = "measured-cache-read-loss";
	else if (readLoss < 0) status = "changed-arm-read-more";
	else status = "no-cache-read-change";
	return { status, expectedPrefix, controlCoversExpectedPrefix, rawReadDifference, readLoss, writeIncrease, validityIssues };
}
