# Designer + vision review loop for UI slices

Canonical owner for the bounded designer-persona and vision review loop.

A sibling loop, the [Slides Content & Storytelling Review Loop](./slides-story-review-loop.md), judges a deck's narrative rather than its pixels; both run behind `dev-loop`.

## Public entrypoint and dependency boundary

- `dev-loop` remains the single public entrypoint. This review loop is an internal capability behind it and adds no second public workflow name.
- The loop consumes the harness from [UI Smoke Harness](./ui-smoke-harness.md) and the bundle from [UI Artifact Contract](./ui-artifact-contract.md). It does not redefine browser capture, artifact naming, or when UI e2e is required. [UI e2e scoping step](./ui-e2e-scoping-step.md) owns that path-triggered, fail-closed rule.
- This loop is a required, fail-closed **recorded-evidence** pass on the rendered-HTML paths that already gate smoke (`docs/articles/*.html`, `docs/presentations/*.html`). The review records its artifact bundle and review outcome. The gate blocks unless that evidence is present and the recorded outcome is `ui_review_satisfied` (ADR 0041, UI half, issue #1443). This gate is distinct from the required, auto-scoped UI e2e gate. Light/spike relaxed-gate carve-outs still exempt the recorded-evidence requirement.

## Purpose

The designer-persona review loop turns deterministic UI artifacts into a repeatable next-iteration handoff. For UI slices that request `uiReviewMode: vision`, this contract also defines the vision-model review mode behind the same `dev-loop` boundary.

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

The reviewer asserts computable accessibility facts from each named state's `axe.json` and does not judge them from the screenshot. Every accessibility finding is grounded in an axe violation. Its severity comes from the fixed `impact` mapping in [UI Artifact Contract](./ui-artifact-contract.md#axejson-contract). `mapAxeImpactToFindingSeverity` in `scripts/loop/ui-designer-review-contract.mjs` codifies and tests that mapping.

## Console and network errors are review findings

Each named state's `console.json` holds the console errors and failed network requests attributed to it. A captured error is a **mechanical fail-closed signal** and is never silently dropped. It flips the drive's `ok` to false, and the diagnose stage anchors it to its source line, independent of the review mode or the LLM. The per-state slice leaves the walk-level gate intact. The `ui-review-report` stage posts only the diagnosed findings and does not read `console.json`. The [UI Artifact Contract](./ui-artifact-contract.md#consolejson-contract) owns both views of these events.

## Four lenses over one bundle, converged deterministically

A review pass judges ONE enriched named-state bundle through four parallel **lenses**, each grounded in a different artifact:

- `a11y` — computable accessibility facts, grounded in `axe.json`
- `layout-geometry` — layout, spacing, clipping, overlap, grounded in `snapshot.json`/geometry
- `visual` — visual hierarchy, callouts, state-transition clarity, grounded in the screenshot
- `interaction` — console errors, failed network requests, interaction-state signals, grounded in `console.json`

Lens **execution** stays in the review route (designer or vision). The vision template emits one FLAT `findings[]`, and each finding carries its `lens` and `acceptanceCriterionRef`. The route passes that array, the acceptance-criteria list and `checkedCriteria` to `convergeUiReviewRouteFindings(findings, { acceptanceCriteria, checkedCriteria })`. It groups the findings by lens, seeds an empty bucket for each of the four canonical lenses so an all-clean lens is still present, and calls the **pure converge seam** `convergeUiReviewLenses(lensResults, { acceptanceCriteria, checkedCriteria }) -> { findings, outcome, coverage }` in `scripts/loop/ui-review-lenses.mjs`. `UI_REVIEW_LENSES` in the same file names the four lenses and their artifacts. The seam is deterministic and harness-agnostic: no browser, no model.

- **Dedupe key.** Two findings from any lenses are the same defect when they share a normalized `(stateName, region/selector, category/rule)` triple. They collapse to one representative, and every contributing lens is recorded on `lenses`.
- **Precedence.** When two lenses report the same defect, the worse severity wins (ladder: `must-fix` > `high` > `medium` > `low`). On a severity tie, the earlier canonical lens (`a11y` > `layout-geometry` > `visual` > `interaction`) supplies the representative's descriptive fields, so the merge is independent of input order. A `blocking` signal from any contributing lens survives the merge.
- **Stable ordering.** Findings are ordered by `stateName`, then severity (worst first), then region, then category.
- **Outcome mapping** (the existing enum, unchanged): any `blocking` finding ⇒ `blocked_needs_human_decision`; else any must-fix finding (severity `must-fix` or `high`) ⇒ `continue_ui_fix_loop`; else any acceptance criterion left uncovered (see the coverage gate below) ⇒ `continue_ui_fix_loop`; else ⇒ `ui_review_satisfied`.
- **Fail-closed.** `validateUiReviewLensResults` rejects a set that is missing a lens, carries an unknown/duplicate lens, holds a malformed finding, is missing the acceptance-criteria list, or holds a finding whose `acceptanceCriterionRef` does not map to a criterion. The converge seam refuses to merge such a set.

## Per-criterion coverage gates `ui_review_satisfied`

`ui_review_satisfied` is gated on **per-criterion coverage** in the same pure fail-closed seam, so satisfaction is auditable from the emitted result.

- **Every finding maps to a criterion.** Each converged finding carries an `acceptanceCriterionRef`: an `AC<n>` token for one criterion in the `acceptanceCriteria` list by 1-based position (`AC1` is the first). A finding with a missing or unmappable ref is a fail-closed malformed finding (`validateUiReviewLensResults` rejects it; converge throws).
- **The coverage bar.** A criterion is **covered** when >=1 converged finding references it OR >=1 affirmative **checked** mark over a named state references it (`checkedCriteria[] = { acceptanceCriterionRef, stateName }`, the reviewer's "I checked this criterion and found no problem" pass). The full bar (`coverage.satisfiedBarMet`) is met only when EVERY criterion is covered.
- **Merged defects attribute to their primary criterion.** Coverage runs on the DEDUPED findings, and the dedupe key excludes `acceptanceCriterionRef`. When two cross-lens findings share the triple but map to DIFFERENT criteria, only the winner's criterion is credited. The loser criterion can then read as uncovered and keep the loop at `continue_ui_fix_loop`. This can only flip `satisfied → continue`, never the reverse.
- **The gate.** `ui_review_satisfied` is returned only when the coverage bar is met AND there are no must-fix/blocking findings. A criterion covered by neither a finding nor a check is an unaudited coverage GAP, not a human-decision blocker. It downgrades the outcome to `continue_ui_fix_loop`, never straight to satisfied.
- **Auditable output.** `convergeUiReviewLenses` / `convergeUiReviewRouteFindings` emit a `coverage` audit alongside `{findings, outcome}`: `coverage.perCriterion[]` (`{ ref, criterion, findingCount, checked, covered }`), `coverage.covered[]` / `coverage.uncovered[]` (the `AC<n>` refs), and `coverage.satisfiedBarMet`.
- **Fail-closed checks.** A malformed `checkedCriteria` mark (missing `stateName`, or an `acceptanceCriterionRef` that does not map) fails closed: the converge seam throws.

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

The seam returns this outcome only under the per-criterion coverage gate above. It does **not** replace normal engineering validation; it only means the designer-persona review loop is satisfied.

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
- vision mode is requested but a named-state path does not end with its artifact file name: `screenshotPath` with `screenshot.png`, `statePath` with `state.json`, `snapshotPath` with `snapshot.json`, `axePath` with `axe.json`, or `consolePath` with `console.json`
- an unsupported `uiReviewMode` value (anything other than `designer` or `vision`) fails closed with `blocked_unsupported_review_mode`

Non-UI work does not trigger the loop. It returns a skip outcome instead of failing closed or reviewing unrelated artifacts.

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

## Entry validation seam

The pure helper `scripts/loop/ui-designer-review-contract.mjs` codifies the fail-closed entry conditions for this loop:
- non-UI or not-requested work is skipped
- missing required inputs are blocked
- incomplete artifact bundles are blocked
- only a complete artifact bundle is eligible for routed review (`ready_for_designer_review` or `ready_for_vision_review`)
