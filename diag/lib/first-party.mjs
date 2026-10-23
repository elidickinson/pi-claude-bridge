// Claude Code treats any ANTHROPIC_BASE_URL other than api.anthropic.com as not
// first-party and changes what it sends: no thinking-binding beta, another model's
// thinking stripped, tool search off, static billing header. The override restores
// those; turning off nonessential traffic (GrowthBook) matches the bridge, which
// sets it for its own children, so flags fall back to their built-in defaults.
// Per-turn reminders still differ: CC gates those on the raw base URL.
export const FIRST_PARTY_ENV = {
	_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
