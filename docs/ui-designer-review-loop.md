# Designer + vision review loop for UI slices

This document defines the bounded designer-persona review loop introduced for issue #122 under umbrella issue #97.

A sibling loop, the [Slides Content & Storytelling Review Loop](./slides-story-review-loop.md), judges a deck's narrative rather than its pixels; both run behind `dev-loop`.

## Public entrypoint and dependency boundary

- `dev-loop` remains the single public entrypoint.
- This review loop is an internal capability behind `dev-loop`; it does not introduce a second public workflow name.
- The loop depends on the reusable harness from [UI Smoke Harness](./ui-smoke-harness.md) and the artifact contract from [UI Artifact Contract](./ui-artifact-contract.md).
- The loop is a **consumer** of those earlier slices. It does not redefine browser capture, artifact naming, or when UI e2e is required (that is path-triggered and fail-closed — see [UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md)).
- This loop is an **optional** design-review pass; it is distinct from the required, auto-scoped UI e2e gate.

## Purpose

The designer-persona review loop turns deterministic UI artifacts into a repeatable next-iteration handoff.

This contract now also defines an opt-in **vision-model** review mode behind the same `dev-loop` boundary for UI slices that request `uiReviewMode: vision`.

It exists for UI-heavy work where code correctness and smoke-test success are necessary but not sufficient to answer:
- what visual or interaction problems remain
- which named UI states still miss the intended bar
- what the next UI-fix iteration should focus on
- when the design-review side is satisfied enough to stop iterating

## Required input bundle

The loop requires all of the following inputs before it may run:

1. **Acceptance criteria**
   - the slice-level UI acceptance criteria the review is judging
2. **Short review brief**
   - one bounded note describing what the designer-persona should pay extra attention to
3. **Deterministic artifact bundle** from the reusable harness/artifact path
   - `sliceId`
   - optional report root such as `playwright-report/ui-smoke/<sliceId>/index.html`
   - one or more named states under `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/`
   - for each named state:
     - `stateName`
     - `screenshotPath`
     - `statePath`
     - `snapshotPath`
     - `axePath`
     - `consolePath`

If any required part of this bundle is missing, incomplete, or ambiguous, the loop fails closed instead of guessing.

## Accessibility findings come from axe, not pixels

Computable accessibility facts — color contrast, missing accessible names/roles,
and similar — are **asserted from `axe.json`**, not judged from the screenshot by
the reviewer. Each named state carries an `axe.json` (raw `@axe-core/playwright`
results, or JSON `null` when axe could not run). A reviewer grounds every
accessibility finding in an axe violation and maps its `impact` to a finding
severity with a fixed mapping:

- `critical` → `high`
- `serious` → `high`
- `moderate` → `medium`
- `minor` → `low`
- unranked / unknown impact → `medium`

This mapping is codified and tested in `scripts/loop/ui-designer-review-contract.mjs`
(`mapAxeImpactToFindingSeverity`); the vision template no longer instructs the
reviewer to eyeball contrast.

## Console and network errors are review findings

Each named state also carries a `console.json` (raw console errors and failed
network requests attributed to that state, or JSON `null` when none were
captured). A captured console error or failed network request — a swallowed 500,
an uncaught page error — is a **mechanical fail-closed signal**, never silently
dropped: it flips the drive's `ok` to false and is anchored to its source line by
the diagnose stage, independent of the review mode or the LLM. These errors are
sliced from the live drive's walk-level capture per state for attribution WITHOUT
being removed from that walk-level gate, so `console.json` and the mechanical
failure set are two views of the same error; the final report dedups so it is
never posted twice.

## Four lenses over one bundle, converged deterministically

A review pass judges ONE enriched named-state bundle through four parallel
**lenses**, each grounded in a different artifact:

- `a11y` — computable accessibility facts, grounded in `axe.json`
- `layout-geometry` — layout, spacing, clipping, overlap, grounded in `snapshot.json`/geometry
- `visual` — visual hierarchy, callouts, state-transition clarity, grounded in the screenshot
- `interaction` — console errors, failed network requests, interaction-state signals, grounded in `console.json`

Lens **execution** stays in the review route (designer/vision): each lens is a
named producer that takes the enriched bundle and returns a findings array. The
vision template emits one FLAT `findings[]`, each finding tagged with its `lens`;
the route hands that array (with the acceptance-criteria list + `checkedCriteria`)
to `convergeUiReviewRouteFindings(findings, { acceptanceCriteria, checkedCriteria })`,
which groups it by lens (seeding an empty bucket for each of the four canonical
lenses, so an all-clean lens is still present), passes the acceptance-criteria list
+ `checkedCriteria` through, and calls the **pure converge seam**,
`convergeUiReviewLenses(lensResults, { acceptanceCriteria, checkedCriteria }) -> { findings, outcome, coverage }`, in
`scripts/loop/ui-review-lenses.mjs`. The seam is deterministic and
harness-agnostic — no browser, no model.

- **Dedupe key.** Two findings from any lenses are the same defect when they
  share a normalized `(stateName, region/selector, category/rule)` triple; they
  collapse to one representative and every contributing lens is recorded on
  `lenses`.
- **Precedence.** When two lenses report the same defect the worse severity wins
  (ladder: `must-fix` > `high` > `medium` > `low`); on a severity tie the earlier
  canonical lens (`a11y` > `layout-geometry` > `visual` > `interaction`) supplies
  the representative's descriptive fields, so the merge is independent of input
  order. A `blocking` signal from any contributing lens survives the merge.
- **Stable ordering.** Findings are ordered by `stateName`, then severity
  (worst first), then region, then category.
- **Outcome mapping** (the existing enum, unchanged): any `blocking` finding ⇒
  `blocked_needs_human_decision`; else any must-fix finding (severity `must-fix`
  or `high`) ⇒ `continue_ui_fix_loop`; else any acceptance criterion left
  uncovered (see the coverage gate below) ⇒ `continue_ui_fix_loop`; else ⇒
  `ui_review_satisfied`.
- **Fail-closed.** `validateUiReviewLensResults` rejects a set that is missing a
  lens, carries an unknown/duplicate lens, holds a malformed finding, is missing
  the acceptance-criteria list, or holds a finding whose `acceptanceCriterionRef`
  does not map to a criterion; the converge seam refuses to merge such a set
  rather than converging a partial or unauditable review.

## Per-criterion coverage gates `ui_review_satisfied`

`ui_review_satisfied` is not a gestalt "looks good enough" call: it is gated on
**per-criterion coverage**, enforced in the same pure fail-closed seam, so
satisfaction is auditable from the emitted result.

- **Every finding maps to a criterion.** Each converged finding carries an
  `acceptanceCriterionRef` — an `AC<n>` token referencing one criterion in the
  provided `acceptanceCriteria` list by 1-based position (`AC1` is the first). A
  finding with a missing or unmappable ref is a fail-closed malformed finding
  (`validateUiReviewLensResults` rejects it; converge throws), never silently
  satisfied.
- **The coverage bar.** A criterion is **covered** when it is referenced by >=1
  converged finding OR by >=1 affirmative **checked** mark over a named state
  (`checkedCriteria[] = { acceptanceCriterionRef, stateName }`, the reviewer's
  affirmative "I checked this criterion and found no problem" pass). The full bar
  (`coverage.satisfiedBarMet`) is met only when EVERY criterion is covered.
- **Merged defects attribute to their primary criterion.** Coverage runs on the
  DEDUPED findings, and the dedupe key `(stateName, region, category)` excludes
  `acceptanceCriterionRef` — so when two cross-lens findings share the triple but
  map to DIFFERENT criteria, they collapse to one representative and only the
  winner's (primary) criterion is credited. A co-flagged loser criterion on a
  merged finding can therefore still read as an uncovered coverage gap and keep
  the loop iterating (`continue_ui_fix_loop`). This is intentional fail-closed
  behavior: it can only flip `satisfied → continue`, never the reverse, so a real
  gap is never hidden. (Reworking the dedupe key is a non-goal.)
- **The gate.** `ui_review_satisfied` is returned only when the coverage bar is
  met AND there are no must-fix/blocking findings. A criterion covered by neither
  a finding nor a check is an unaudited coverage GAP — not a human-decision
  blocker — so it downgrades the outcome to `continue_ui_fix_loop` (the loop keeps
  going until every criterion is audited), never straight to satisfied.
- **Auditable output.** `convergeUiReviewLenses` / `convergeUiReviewRouteFindings`
  emit a `coverage` audit alongside `{findings, outcome}`:
  `coverage.perCriterion[]` (`{ ref, criterion, findingCount, checked, covered }`),
  `coverage.covered[]` / `coverage.uncovered[]` (the `AC<n>` refs), and
  `coverage.satisfiedBarMet`. Which AC each finding maps to, and which criteria are
  covered vs uncovered, are readable straight from the structured result.
- **Fail-closed checks.** A malformed `checkedCriteria` mark (missing `stateName`,
  or an `acceptanceCriterionRef` that does not map) fails closed — the converge
  seam throws rather than letting a bad mark silently satisfy a criterion.

## Review modes behind `dev-loop`

Two bounded reviewer modes are supported for opted-in UI slices:

- `designer` (default): prompt-driven designer-persona review against the same artifact bundle.
- `vision`: screenshot-first review using the reusable prompt template at `skills/dev-loop/templates/ui-vision-review.md` (model target: `gpt-5.4`).

Both modes must return the same structured outcome set and follow the same fail-closed input contract.

## Required output bundle

Every review pass (designer or vision) must produce a bounded structured result with:
- **Findings**
  - what is visually or interaction-wise wrong or unclear
  - which named state it affects
  - the evidence path(s) that support the finding
- **Corrective actions**
  - what should be changed next
- **Next-iteration focus areas**
  - the small set of UI items the fixer/developer should prioritize next
- **Outcome**
  - exactly one of:
    - `continue_ui_fix_loop`
    - `ui_review_satisfied`
    - `blocked_needs_human_decision`

## Outcome semantics

### `continue_ui_fix_loop`

Use this when findings remain and a normal UI fix iteration should continue.

The handoff goes back to the fixer/developer with:
- the findings
- the corrective actions
- the next-iteration focus areas
- the same acceptance criteria and artifact contract for the next pass

### `ui_review_satisfied`

Use this when:
- the named states in scope satisfy the review brief and acceptance criteria closely enough to stop iterating on the UI/design side
- any remaining issues are minor enough that they do not justify another dedicated UI-fix pass

This outcome is gated on **per-criterion coverage** (see "Per-criterion coverage
gates `ui_review_satisfied`" above): the seam returns it only when every
acceptance criterion is covered by a finding or an affirmative check and no
must-fix/blocking findings remain. It is auditable, not a gestalt call.

This does **not** replace normal engineering validation; it only means the designer-persona review loop is satisfied.

### `blocked_needs_human_decision`

Use this when the loop finds a genuine design/product decision that cannot be resolved by another normal UI-fix iteration alone.

Examples:
- conflicting acceptance cues
- a tradeoff that requires a product or design decision
- artifacts that expose a scope contradiction rather than a normal implementation defect

## Fail-closed behavior

The loop fails closed when:
- required acceptance criteria are missing
- the review brief is missing or empty
- the artifact bundle is missing
- the artifact bundle has no named states
- a named state lacks `screenshotPath`, `statePath`, `snapshotPath`, `axePath`, or `consolePath`
- vision mode is requested but a named state screenshot path does not end with `screenshot.png`
- vision mode is requested but a named-state `statePath` does not end with `state.json`
- vision mode is requested but a named-state `snapshotPath` does not end with `snapshot.json`
- vision mode is requested but a named-state `axePath` does not end with `axe.json`
- vision mode is requested but a named-state `consolePath` does not end with `console.json`
- the work is not actually a UI slice \(the loop returns a skip outcome rather than failing closed\)
- an unsupported `uiReviewMode` value (anything other than `designer` or `vision`) fails closed with `blocked_unsupported_review_mode`

When the work is non-UI, the loop does not trigger for non-UI work; it returns a skip outcome instead of pretending to review unrelated artifacts.

## Handoff sequence under `dev-loop`

1. Run or reuse the deterministic local UI smoke path.
2. Collect the named-state artifact bundle from `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/` and the optional HTML report.
3. Route by review mode:
   - `designer` → run designer-persona review
   - `vision` → run the vision review template at `skills/dev-loop/templates/ui-vision-review.md`
4. Run the selected review mode against the acceptance criteria and review brief.
5. If the outcome is `continue_ui_fix_loop`, hand findings back to the fixer/developer.
6. Regenerate the artifact bundle after the fix iteration.
7. Re-run the selected review mode until the outcome is `ui_review_satisfied` or `blocked_needs_human_decision`.

## Current minimal validation seam

The pure validation helper at `scripts/loop/ui-designer-review-contract.mjs` codifies the fail-closed entry conditions for this loop:
- non-UI or not-requested work is skipped
- missing required inputs are blocked
- incomplete artifact bundles are blocked
- only a complete artifact bundle is eligible for routed review (`ready_for_designer_review` or `ready_for_vision_review`)

This keeps the boundary testable before any later higher-level reviewer orchestration is layered on top.

The pure lens-converge seam at `scripts/loop/ui-review-lenses.mjs` codifies the
deterministic tail:
- `UI_REVIEW_LENSES` names the four lenses and the artifact each is grounded in
- `validateUiReviewLensResults` rejects a missing/unknown/duplicate lens, a malformed finding, a missing acceptance-criteria list, or a finding whose `acceptanceCriterionRef` does not map, fail-closed
- `convergeUiReviewLenses(lensResults, { acceptanceCriteria, checkedCriteria })` merges the four findings arrays into one deduped set, computes the per-criterion `coverage` audit, and maps it to the unchanged outcome enum — `ui_review_satisfied` only when every criterion is covered and no must-fix/blocking finding remains
- `convergeUiReviewRouteFindings` is the route's entrypoint: it groups the vision template's flat `findings[]` (each tagged with its `lens` and its `acceptanceCriterionRef`) into the four-lens result set and passes the acceptance-criteria list + `checkedCriteria` passes through to `convergeUiReviewLenses`, so the template output and the seam meet at one documented, fail-closed boundary
