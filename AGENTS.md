# Agent Guidelines

## Changelog

Add an entry to an `## UNRELEASED` section at the top of `CHANGELOG.md` for
every non-docs change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes.

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

Do **not** auto-commit.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
