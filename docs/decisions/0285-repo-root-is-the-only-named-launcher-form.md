# 0285. The --repo-root form is the only named launcher form

## Status

Accepted — 2026-11-16 ([PR 3226](https://github.com/mfittko/dev-loops/pull/3226)).

Amends [0117](./0117-self-hosting-gates-run-the-review-root-toolchain.md). It changes which launcher form emitters and rules name. The toolchain resolution of ADR 0117 is unchanged.

## Context

ADR 0117 left two launcher forms valid: `dev-loops-run --repo-root <checkout> <script>` and `cd <checkout> && dev-loops-run <script>`. Under the Claude harness, the `cd` prefix breaks the `Bash(dev-loops-run:*)` allow rule match and prompts the operator. Naming two forms also let emitters and rules drift apart. This is slice 11 of issue 3105.

## Decision

1. With the Claude harness marker set, emitters and rules name `dev-loops-run --repo-root <checkout> <script>` as the only launcher form (`WORKTREE-SCRIPT-LAUNCHER-CWD` in `skills/docs/worktree-guidance.md`).
2. No emitter or rule names `cd <checkout> && dev-loops-run <script>` any more. The form still works. It is not sanctioned.
3. The sentinel line of the gate review sub-loop contract follows the same rule.

## Consequences

- Operators see one launcher form and the allow rule matches it.
- Existing `cd` invocations keep working. New guidance and emitted commands do not name them.
