<!--
Canonical conformant PR-body skeleton for a TRACKER-BACKED PR.

Copy the sections below into the PR description. The body must pass
`validate-pr-body-spec` (the shared `validateTrackerBackedPrBodySpec`) at BOTH
`node <dev-loops-package-root>/cli/index.mjs pr create` and `gh pr ready`.

Required sections (each must be present and non-empty):
  - Objective / Why (any of: Objective, Why, Goals, Summary, Problem)
  - In scope (or Scope)
  - Acceptance criteria — at least one `- [ ]` checklist item
  - Definition of done — at least one `- [ ]` checklist item
  - Non-goals (or Out of scope)
  - A closing reference: `Closes #N` (or Fixes/Resolves #N) matching the issue

State gate and merge outcomes (for example "draft_gate and pre_approval_gate
pass on the final head; merge only on a full gate pass") as prose, never as an
AC/DoD checkbox. The gates and merge-pr enforce them, and an unchecked box
blocks the pre_approval_gate that would satisfy it.

The PR body is the portable, tracker-agnostic spec-of-record: keep it
self-contained. Do not embed private consumer repo names or PR numbers. An
issue-less `--lightweight` PR omits the closing reference and additionally
carries an Open questions/risks section (see the lightweight PR-body-as-spec
path); this skeleton is the tracker-backed shape.
-->

## Objective

What this PR changes and why. One or two sentences of the problem it solves.

## In scope

- The specific surfaces this PR changes.

## Acceptance criteria

- [ ] A testable, observable outcome that proves the change works.
- [ ] Another outcome, mapped to its completion evidence below.

## Definition of done

- [ ] The concrete completion evidence (tests, docs, regenerated assets) for each acceptance criterion.
- [ ] Validation run and green.

## Non-goals

- What this PR deliberately does NOT do.

## Validation

- Targeted local checks: `<command>` — pass.
- Full current-head CI or sanctioned full-validation evidence: `<check/artifact>` — pass or incomplete.
- Record each validation command or named check with its stable pass/fail outcome only. Do NOT paste volatile aggregate test/assertion/asset counts, durations, or timestamps (OPS-PR-VALIDATION-STABLE-EVIDENCE); those live in the head-stamped gate artifacts.

Closes #N
