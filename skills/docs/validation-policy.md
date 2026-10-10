# Validation policy

Canonical owner for validation requirements across all workflow families.

## Default validation

<!-- rule: VALIDATE-TARGETED-FIRST -->
`VALIDATE-TARGETED-FIRST`: Workers use `resolveTargetedValidation(changedPaths)` from `@dev-loops/core/loop/validation-classify`, which reads the repo's `.devloops` `validation.paths` map (no built-in layout), to run the narrowest deterministic check for the changed surface and record the command and stable outcome. Its `commands` are local worker checks; each `gateSuites` entry is an explicit package-domain `--suite` for the gate artifact. Unknown or mixed surfaces require full-validation ownership; an empty check is never a pass. Only `node <dev-loops-package-root>/cli/index.mjs gate resolve-validation` may launch a local full-repository run, bound to the exact head SHA, requested profile, and pinned Bun 1.4.1 toolchain. Missing full evidence is incomplete, never permission to run `bun run verify` directly. The full `bun run verify` suite and CI aggregate keep their existing coverage; CI on the current head or sanctioned full evidence supplies full-repository evidence at the applicable gate. The `.devloops` `validation.mode` selects the full-validation authority (ADR 0137): `ci-only` (the consumer default) runs no local suite and records a `status: "complete"` artifact with `authority: "ci-authoritative"` when current-head CI is green, `failed` on red CI, and typed `incomplete` on pending, missing or wrong-head CI; `local` (this repo) runs the declared `validation.fullCommand`, else the `package.json` `verify` script. Configured commands come only from the repo's `.devloops`, never from PR content. Node `>=24` packaged-consumer checks and npm registry/pack/publish/provenance checks remain required where their boundary is under test.

## Gate-specific requirements

| Gate | Validation required |
|---|---|
| `draft_gate` | CI green on current head, or the bounded zero-suite exception: first read and apply the [CI owner](copilot-ci-status-contract.md#zero-suite-local-validation-exception), including its unavailable CLI input. |
| `pre_approval_gate` | CI green on current head + resolved review threads + clean re-review |

## Coverage requirements

<!-- rule: VALIDATE-COVERAGE-THRESHOLD -->
`VALIDATE-COVERAGE-THRESHOLD`: Changed files SHOULD maintain ≥90% coverage for lines, statements, functions, and branches (not enforced by the shipped verify config; treat it as the working target), and non-trivial logic MUST be test-first.

## Coverage-request admission

<!-- rule: VALIDATE-COVERAGE-ADMISSION -->
`VALIDATE-COVERAGE-ADMISSION`: A request to add test coverage is actionable only when it names three things: the observable behavior or risk it protects, why the existing evidence fails to cover that behavior, and the cheapest authoritative seam that closes the gap. One authoritative test layer is the default. An additional unit, integration, CLI, package, or harness layer is justified only by a distinct boundary failure — argument parsing, transport, serialization, packaging, or actual harness routing — never by an equivalent permutation of an already-covered behavior. A demand that offers only a coverage percentage, only the absence of a test, only an equivalent permutation, only a generated-mirror duplicate, or only a harness label is non-actionable; the ≥90% target in VALIDATE-COVERAGE-THRESHOLD is diagnostic, not sufficient grounds for a finding. A representative check MAY stand in for equivalent error paths, but every independent uncertainty mechanism that could accept unsafe input stays covered. A coverage finding that fails this rule is dispositioned `reject`, so the existing judge act-list filter keeps it out of fixer dispatch; a repeated coverage demand stays `reject` until new evidence names a distinct behavior or boundary risk, compared against the prior-round judge ledgers rather than a new rejection registry. Demonstrated fail-open, security, acceptance-criterion, and public-contract defects remain actionable, and justified expansion that changes approved scope routes through the spec-authority / operator-approval path. The scope-drift signal is supporting evidence for this judgment, not a new gate.

## Cross-references

- [Merge preconditions](merge-preconditions.md)
- [Stop conditions](stop-conditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
