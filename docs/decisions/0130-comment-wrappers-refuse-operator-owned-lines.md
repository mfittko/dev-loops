# 0130. Comment wrappers refuse operator-owned lines

## Status

Accepted — 2026-10-07 ([PR 2703](https://github.com/mfittko/dev-loops/pull/2703))

## Context

Related: [0052](./0052-adr-tripwire-fail-closed.md) and [0119](./0119-standing-authorization-for-adr-tripwire-waivers.md). This record amends neither.

Two comment lines are operator-owned: `approve merge <sha>` and `adr-tripwire:allow ...`. An agent that writes either line authorizes its own merge or waiver. Agents posted the approval marker through raw `gh` comment calls. The epic that denies raw `gh` leaves the comment wrappers as the only agent comment path. See [issue 2695](https://github.com/mfittko/dev-loops/issues/2695).

## Decision

`comment-issue.mjs` and `edit-comment.mjs` refuse a body with a line that opens with `approve merge` or `adr-tripwire:allow`. The refusal exits 1 with `OPERATOR-OWNED-LINE` and makes no GitHub call. The wrappers have no override flag. Operators post the approval line themselves. Waiver lines also come from `dev-loops pr waive-adr-tripwire` under ADR 0119 standing authorization, which writes the PR body and not a comment, so the wrappers refuse them too.

Rejected alternative: an override flag for orchestrators (an agent-usable flag defeats the refusal).

## Consequences

The comment path closes before the raw `gh` deny lands. Mid-line mentions of the phrases post normally. Obfuscated lines such as zero-width characters are not detected.
