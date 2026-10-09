# Recorded edited-file attachment

`edited-text-file.jsonl` is a sanitized excerpt from an existing local Claude Code
transcript archive, recorded by Claude Code 2.1.100. No new provider call was made.
This is transcript capture evidence, not a captured HTTP request and not a claim
about the currently installed Claude Code version.

## Provenance checks before sanitization

The assistant tool-use record had a real, nonempty `requestId`, a non-synthetic
`message.id` (not `msg_syn_*`), and no `req_syn_*` request ID. Its tool-use ID
matched the subsequent user tool-result block, whose record had a `promptId`.
The attachment's parent chain reached that result through a `hook_success`
attachment. Assistant records were checked by logical `message.id`; this selected
tool-use block belongs to that live message, not an imported synthetic message.
The directory name alone was not used as evidence of Claude Code provenance.

The recorded tool was `Bash`, not `Edit`. This excerpt establishes the attachment
shape and parent chain, not that every edited-file snapshot follows native Edit,
nor that the preceding tool necessarily caused the external file change.

## Sanitization

- Selected only the assistant tool-use block, corresponding user result, and
  attachment parent chain. Removed unrelated messages and file contents.
- Replaced record UUIDs, message/request/prompt/tool IDs consistently; cut the
  excerpt's external parent link to null. Replacement IDs are fixture labels,
  not actual session identifiers.
- Removed session IDs, timestamps, working directories, branch names, slugs,
  user/entrypoint metadata, tool-use result metadata and other unused fields.
- Replaced tool arguments, result text, filename, snippet and hook text/command
  fields with public-safe placeholders; normalized hook duration to zero.
- Preserved record order, parent relationships within the excerpt, attachment
  types, tool name, version, content block types, error flag, hook event/exit code,
  and direct caller shape.

The test supplies controlled Pi history with `toolu.fixture`, which converts to
the fixture's CC ID `toolu_fixture`. That Pi history is synthetic test input, not
part of the recorded capture. It verifies the ID-map direction while the fixture
provides the real recorded attachment chain. Other unit cases are synthetic edge
cases, explicitly not additional capture evidence.
