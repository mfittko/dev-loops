# 0054. Provable interactivity for review submit-modes

## Status

Accepted — 2026-09-02 ([issue 1888](https://github.com/mfittko/dev-loops/issues/1888))

## Context

The `#1840` guard kept headless review runs off GitHub-native `APPROVE`/`REQUEST_CHANGES` review events by refusing `--submit approve|request-changes` when `--auto` was passed. But `--auto` is a caller self-identification flag: the default posture (no `--auto`) permitted those modes, so a headless/agent caller could simply omit the flag and POST a branch-protection signal that satisfies required-approvals or blocks merge, independent of any dev-loops gate. The stated guarantee — "automation can never auto-approve or auto-block a PR" — held only if every headless caller honestly self-identified; nothing structural enforced it. `process.stdin.isTTY` probing was rejected because agent shells are non-TTY even in genuinely interactive sessions, so it would break the real interactive path while remaining spoofable by a crafted argv.

## Decision

- `--submit approve|request-changes` on `--gate review` requires an explicit interactive-confirmation token, `--interactive-confirm` — the same shape as `ui-review-teardown.mjs`'s `--confirm`. The absence of `--auto` proves nothing; the token is the only structural proof of a deliberate interactive choice (the review skill's multiple-choice submit step passes it after a human pick).
- The token is enforced at BOTH entry layers: CLI parse time (`parseUpsertCheckpointVerdictCliArgs`) and structurally in the `upsertCheckpointVerdict()` runtime entry, so direct callers cannot bypass the parser — the runtime entry re-refuses with the identical semantics.
- `--auto` still refuses those modes even WITH the token (the `--auto` refusal is checked first at both layers, so the more specific headless error wins): the token is not a headless license.
- The token parses fail-safe, mirroring `--confirm`: an explicit `=false`/`=0`/`=no` (case-insensitive) or an empty/whitespace-only inline value (the `--flag=$VAR` unset-expansion shape) does NOT confirm. Unrecognized non-falsy values confirm (the precedent's narrow falsy set is kept; a shared helper across the three copies is future work, tracked in the PR's follow-up issue).
- `--submit pending`/`--submit comment` are unchanged — headless runs keep exactly the two safe modes.

## Consequences

- The fail-closed guarantee becomes structural rather than honor-system: a headless caller cannot reach a branch-protection review event by omitting `--auto`, by passing `=false`-shaped values, or by calling the runtime entry directly.
- The interactive path is unchanged in behavior but now carries the token on every documented approve/request-changes re-invocation (`skills/review/SKILL.md` phase-4, leave-pending bullet included), making the human choice an explicit, grepable argv fact.
- Known ceiling, disclosed: a caller that controls its own argv can still pass the bare token — the token proves the invocation came through the interactive submit step's documented command shape, not that a human was physically present. This is the same ceiling the `--confirm` precedent accepts; strengthening beyond it would need a challenge-response mechanism, out of scope.
- `GATE-REVIEW-SUBMIT-MODES` in `skills/docs/gate-review-comment-contract.md` records the tightened rule; this decision is its ADR.
