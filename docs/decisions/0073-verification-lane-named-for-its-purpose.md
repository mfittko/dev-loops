# 0073. The verification lane is named for its purpose, not for Copilot

## Status

Proposed — 2026-09-16 (spike)

Explored on the inspect-viewer spike stack so the vocabulary is validated against a
running surface before it is accepted. The migration seam in this record is
implemented; the call-site and prose migrations it stages are not yet.

## Context

The dev-loop vocabulary names one lane after a vendor: `copilot_verification`
(strategy), `copilot_loop` (loop family), `handoff_to_copilot_loop` /
`reenter_copilot_loop` (outer states), `waiting_for_copilot_review` (lane state).
About 6,100 `copilot` occurrences span 275 files.

An operator audit of the inspect viewer surfaced the cost. On a self-authored draft
PR that Copilot had never touched, the dashboard reported outer state
`handoff_to_copilot_loop`, action `reenter_copilot_loop`, and "Copilot loop needs
action" — three Copilot claims about a PR with no Copilot involvement at all. The
copy defects were fixed separately; the naming remained.

Two facts make a blind find-and-replace wrong.

**The name covers two different Copilot roles.** Copilot-as-author drives
`ASSIGNED_TO_COPILOT` ownership (`classifyOwnership`), the bootstrap-PR detector
(`detect-initial-copilot-pr-state.mjs`) and session-activity detection
(`detect-copilot-session-activity.mjs`); when Copilot is the assignee, routing must
NOT hand off, because that agent is the live owner. Copilot-as-reviewer drives the
request/wait/fix cycle in `copilot-loop-state.mjs`. Only the second is the lane.

**"Reviewer" is already taken twice.** `draft_gate` is our own gate review,
`reviewer-unit-bound.mjs` bounds our internal fan-out reviewer units,
`REVIEWER_STATE` is the human reviewer lane, and `pre_approval_gate` is an evidence
check. A rename to "review agent" would collide with at least two of them and make
the vocabulary less clear, not more.

**The lane is wider than any review.** A first attempt named it for the external
review actor (`external_review_loop`). A viewer audit across five lifecycle points
disproved that: `lifecyclePhaseForCopilotState` maps `pr_draft` to `implementation`
and `pr_ready_no_feedback` to `draft_gate`, while external review does not enter
until `feedback_resolution`. Routing hands a draft PR to this lane whose next step
is OUR draft gate, so a lane named for the external review announced a wait on an
actor that had not been asked for anything yet — the same error as the vendor name,
one level in. The lane owns the whole post-implementation PR follow-up:

    implementation → draft_gate → feedback_resolution → pre_approval_gate → merge
                        ↑              ↑
                  our gate review   external review

What distinguishes the lane is its PURPOSE: establishing that a change is fit to
merge. The external wait keeps its own honest name as a lane STATE.

Two candidates were rejected on the way. `pr_followup` names WHEN the lane runs
("after the PR exists") rather than why — it is how the existing skill name was
built, and it says nothing. `merge_readiness` was rejected on a sharper ground:
this lane hands off to a separate `final_approval` strategy, and approval is about
ACCOUNTABILITY — a human accepting responsibility for the merge — not about
establishing facts. `final-approval` is described as "the final human approval and
merge gate", and its routing summary REQUIRES the `pre_approval_gate` evidence
this lane produces. The two divide cleanly by kind:

    this lane       establishes the facts      verification
    final_approval  a human accepts the risk   accountability

"Merge readiness" blurs that back together by naming a judgment about the merge
decision rather than about the evidence. Remediation is not a counter-example:
fixing what a verification loop finds is the ordinary meaning of the term, the
way a test-fix loop is still about testing.

`verification` sits near the existing `validation` vocabulary (315 prose uses,
mostly "the smallest honest local validation"). They are a hierarchy, not a
synonym pair: a VALIDATION is an act (running the checks); the VERIFICATION LOOP
is the lane that contains those acts alongside external review, remediation and
evidence. Prose must not swap one for the other.

**`reenter_` becomes `enter_`, in both lanes.** The outer actions claimed a
re-entry on a FIRST handoff with zero completed rounds — the same class of untrue
statement as the vendor name, and visible to an operator on the dashboard's very
first load. `enter_` is true on a first entry and still true on a later one.
Both `reenter_copilot_loop` and `reenter_reviewer_loop` drop the prefix together,
because correcting one lane and leaving its sibling reading `reenter_` would
leave the vocabulary half-fixed in exactly the way this record exists to end.

## Decision

Name the lane for the lane. Keep the vendor name wherever the behavior really is
vendor-specific.

Renamed (the lane — actor-neutral):

| Current | New |
| --- | --- |
| `copilot_verification` (strategy) | `verification` |
| `copilot_loop` (`LOOP_FAMILY`) | `verification_loop` |
| `handoff_to_copilot_loop` (outer state) | `handoff_to_verification_loop` |
| `waiting_for_copilot_review` (lane state) | `waiting_for_external_review` |
| `review_request_unavailable` wording in lane copy | unchanged token, lane-neutral prose |

Unchanged (genuinely Copilot-specific):

- The review-actor adapter: `request-copilot-review.mjs`,
  `probe-copilot-review.mjs`, `withdraw-copilot-review-request.mjs`,
  `isCopilotLogin`, `copilot-helpers.mjs`. These drive GitHub's Copilot reviewer
  assignment and nothing else.
- Round metrics: `copilotReviewRounds`, `copilotReviewComments`,
  `copilotReviewRequests`. Every input is filtered by `isCopilotLogin`
  (`copilot-loop-iterations.mjs`), so they count exactly Copilot's rounds. A
  neutral name would overclaim. A lane is generic; the metric names the actor that
  produced the rounds.
- Copilot-as-author: `ASSIGNED_TO_COPILOT`, `detect-initial-copilot-pr-state.mjs`,
  `detect-copilot-session-activity.mjs`, `watch-initial-copilot-pr.mjs`.

Deliberately NOT decided here:

- File names and package export paths (`@dev-loops/core/loop/copilot-loop-state`).
  Renaming those breaks consumer imports and needs its own compatibility window.
  Token renames do not, so they go first.

## Compatibility

Every token above is persisted: checkpoint artifacts carry `outerAction` and lane
state, and gate artifacts quote them. Readers therefore accept BOTH vocabularies
for at least one minor release; writers emit only the new one.
`normalizeLoopVocabularyToken` (`@dev-loops/core/loop/loop-vocabulary`) is the one
place that mapping lives, and it is total: an unknown token passes through
unchanged rather than being coerced, so a token this table does not know can never
be silently rewritten into one it does.

## Staging

The prose half collides with the in-flight skill-prose PRs, so it lands last.

1. Compatibility seam plus the new constants (this record's implementation).
2. Code call sites: `packages/core/src`, `scripts`, `lib`, `extension`, and their
   tests. No `skills/` prose, so no collision with the prose work.
3. After the prose PRs merge: `skills/`, `docs/`, the `copilot-pr-followup` skill
   directory, and regenerated `.claude` assets.
4. Separately, once a second review actor exists: generalize `isCopilotLogin` into
   a configured actor set. Until then the adapter honestly names one actor.

## Consequences

- The dashboard stops attributing work to Copilot on PRs Copilot never touched.
- The lane, our gate review, the human reviewer lane and the pre-approval gate stop
  competing for the word "review".
- Two vocabularies coexist for a release, which the normalizer confines to one
  module and one test surface.
- The rename is staged across at least three PRs. Until stage 3 lands, code says
  `verification_*` while some prose still says Copilot, which the deprecated-term
  window below makes legal rather than silent.
- `skills/docs/stop-conditions.md` defines BOTH `waiting_for_external_review` and a
  deprecated `waiting_for_copilot_review` term for the transition. The term
  registry is what forces this: a term is either defined or it is not, and every
  prose use must resolve, so without the deprecated entry the prose half could not
  be staged separately at all.
