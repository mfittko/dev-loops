# 0192. A validation block that differs from the base only in `paths` is admitted

## Status

Accepted — 2026-10-26 ([issue 2852](https://github.com/mfittko/dev-loops/issues/2852), [operator decision](https://github.com/mfittko/dev-loops/issues/2852#issuecomment-6413007272))

Amends [ADR 0137](./0137-validation-modes-and-consumer-configured-commands.md) for its whole-block difference refusal only. All other ADR 0137 decisions are unchanged. The record of ADR 0137 stays unedited. Cites [ADR 0170](./0170-validation-record-node.md) and [ADR 0172](./0172-repo-validation-ci-only.md).

## Context

ADR 0137 refuses any difference between the checkout `.devloops` validation block and the base block. PR 2851 edits only `validation.paths` (22 rules on the base, 24 on the head). The refusal left that PR `incomplete`. The gate never executes `paths`. The `ci-only` branch reads neither the checkout nor the base `paths`. Two gate-side callers derive suites from `paths`. `validation-record.mjs` passes the base block's `paths`. The gate preamble passes `gateSuites` from `resolveTargetedValidation(changedPaths)` as `--suite`, and that function reads the checkout `paths` by default. For a targeted request with differing `paths`, `resolveValidation` recomputes the suites from the base `paths` and runs those in place of the requested ones.

## Decision

- Rule `ADR0192-PATHS-ONLY-ADMIT`. The gate compares the checkout validation block to the base (`origin/HEAD`) block with `paths` left out. Equal blocks admit the difference, and the run resolves as if there were no difference.
- Targeted suites. For a targeted request with differing `paths`, `resolveValidation` selects the suites with `resolveTargetedValidation(changed, base.validation.paths)` and runs those `gateSuites` in place of the requested `--suite` values. They also form the classification, the reuse key and the artifact. When the base paths select full-repository validation for the changed paths or select no gate suite for them, the run resolves typed `incomplete` with `suites: []`.
- Execution source. Execution reads only the base block (`mode`, `fullCommand`, `paths`). The candidate block never supplies a gate mode, command or suite.
- Still refused. A `mode` or `fullCommand` difference, alone or mixed with `paths`, stays typed `incomplete` with `suites: []`. A later slice may add an authenticated operator review receipt. This change adds no receipt mechanism, CLI override, waiver or gate exemption.
- Single owner. `validationDifferenceRefusal` in `scripts/loop/resolve-validation.mjs` owns the comparison. `resolveValidation` and the `local` producer in `scripts/loop/validation-record.mjs` both call it.
- Config-source refusal. The ADR 0137 config-source refusal applies to a PR that edits its own validation block. This change edits no `.devloops` file.

## Consequences

PR 2851's 22-versus-24 `paths` blocks are admitted. A `mode` or `fullCommand` difference still blocks validation until reviewed. Every other behavior of ADR 0137, ADR 0170 and ADR 0172 is unchanged, including the clean-worktree, head, Bun pin and base-block reads.
