# Slides content & storytelling review loop for decks

This document defines the bounded slides content & storytelling review loop introduced for issue #929. It is a sibling of the [Designer + Vision Review Loop](./ui-designer-review-loop.md): that loop answers "does it *look* right?"; this one answers "does it *land*?" — it judges a deck's **narrative**, not its pixels.

## Public entrypoint and dependency boundary

- `dev-loop` remains the single public entrypoint.
- This review loop is an internal capability behind `dev-loop`; it does not introduce a second public workflow name.
- It is a sibling of the visual designer/vision loop, not a replacement: visual and design changes remain the [Designer + Vision Review Loop](./ui-designer-review-loop.md)'s job.
- It consumes the deck source (and optionally the captured slide screenshots produced by the [UI Smoke Harness](./ui-smoke-harness.md)) plus acceptance criteria and a storytelling brief. It does not redefine browser capture or artifact naming.

## Purpose

The slides-story review loop turns a deck draft into a repeatable next-iteration handoff for narrative quality.

It exists for presentation work where the deck renders correctly and the UI smoke passes, but those are necessary and not sufficient to answer:
- whether the deck has a story arc a public audience can follow
- which slides carry more than one message or fail to earn their place
- where jargon, forward references, or raw identifiers break a non-insider reader
- when the storytelling side is satisfied enough to stop iterating

## Required input bundle

The loop requires all of the following inputs before it may run:

1. **Acceptance criteria**
   - the slice-level acceptance criteria the review is judging
2. **Storytelling brief**
   - one bounded note: audience, intended takeaway, and what to pay extra attention to
3. **Deck bundle**
   - `deckSourcePath` — required path to the deck source (e.g. the Slidev `.md`)
   - `slideScreenshots[]` — optional captured slides from the UI smoke harness
     - `slideId`
     - `screenshotPath`

If any required part of this bundle is missing, incomplete, or ambiguous, the loop fails closed instead of guessing. Optional slide screenshots, when present, must each carry both `slideId` and `screenshotPath`.

## Review lens (public audience)

- **Arc**: is there a hook → tension → resolution? Does slide 1 make a stranger care?
- **One message per slide**: each slide has a single takeaway; titles state the claim, not the topic.
- **Sequencing**: order builds understanding; no forward references; jargon introduced before it is used.
- **Audience calibration**: a public/non-insider reader can follow it — internal enum names, state-machine identifiers, and pills are translated or earn their keep, not dumped raw.
- **Cut / merge / reorder**: explicit recommendations — which slides to drop, combine, or move.
- **Close**: a memorable takeaway, not a feature list.

The reusable prompt template is at `skills/dev-loop/templates/slides-story-review.md`.

## Required output bundle

Every review pass must produce a bounded structured result with:
- **Findings**
  - what is wrong with the narrative and why
  - which `slideId` it affects
  - the severity (`high` | `medium` | `low`)
- **Corrective actions**
  - what should be changed next (cut / merge / reorder / reword), one per finding
- **Outcome**
  - exactly one of:
    - `story_review_satisfied`
    - `needs_iteration`

## Outcome semantics

### `needs_iteration`

Use this when narrative findings remain and a storytelling pass should continue. The handoff goes back with the findings, the corrective actions, and the same acceptance criteria and storytelling brief for the next pass. When the outcome is `needs_iteration`, the findings list must be non-empty.

### `story_review_satisfied`

Use this when the deck satisfies the storytelling brief and acceptance criteria closely enough to stop iterating on the narrative side, and any remaining issues are minor enough that they do not justify another dedicated storytelling pass. This does not replace normal engineering validation or the visual review.

## Fail-closed behavior

The loop fails closed when:
- required acceptance criteria are missing
- the storytelling brief is missing or empty
- the deck source path is missing
- an optional slide screenshot lacks `slideId` or `screenshotPath`

When the work is not a deck, the loop does not trigger; it returns a skip outcome (`skip_non_slides`) instead of pretending to review unrelated artifacts.

## Handoff sequence under `dev-loop`

1. Draft or update the deck source.
2. Optionally collect the captured slide screenshots from the UI smoke harness.
3. Run the story review against the acceptance criteria and storytelling brief using the template at `skills/dev-loop/templates/slides-story-review.md`.
4. If the outcome is `needs_iteration`, apply the corrective actions (words / order / structure, not the design system) and re-run.
5. Re-run until the outcome is `story_review_satisfied`.

## Current minimal validation seam

The pure validation helpers at `scripts/loop/slides-story-review-contract.mjs` codify the boundary:
- non-deck or not-requested work is skipped (`skip_non_slides`)
- missing required inputs are blocked (`blocked_missing_required_inputs`)
- incomplete optional slide screenshots are blocked (`blocked_incomplete_deck_bundle`)
- a complete bundle is eligible for review (`ready_for_story_review`)
- `validateSlidesStoryReviewResult` enforces the output shape and the `story_review_satisfied` | `needs_iteration` outcome set

This keeps the boundary testable before any later higher-level reviewer orchestration is layered on top.

## First two runs (evidence)

This loop was applied inline to both presentation decks before being formalized here. The recorded passes — findings + corrective actions per deck — are the first two runs:

- `docs/presentations/applied-dev-loops-review-notes.md` (#926)
- `docs/presentations/process-observability-review-notes.md` (#927)
