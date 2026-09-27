# Public dev-loop contract

Canonical owner for the public `dev-loop` entrypoint: routed semantics, accepted shorthand, and the rule that internal strategy names stay behind the façade. Installed layouts read the same contract via [Public Dev Loop Contract](../docs/public-dev-loop-contract.md) from the installed skill directory.

Other repo docs MAY summarize or link this contract; they MUST NOT redefine it.

## Public surface

The single public entrypoint for write-capable workflow activity is `dev-loop`. The `review` route is a sanctioned, separately invocable read-only entrypoint. Its deterministic selector through the public resolver is `loop startup --pr <n> --review`; it does not advance workflow lifecycle state.

`dev-loop` MUST be callable from the user-facing workflow surfaces, including `subagent dev-loop` and `/skill:dev-loop`.

Day-one user-intent forms:

- start dev loop on issue `<n>`
- continue dev loop on PR `<n>`
- start issue `<n>` locally
- start issue `<n>` locally, then continue the loop
- continue the current dev loop
- auto dev loop (durable auto ownership over the detected routed loop)
- auto dev loop on issue `<n>`
- review PR `<n>` in a UI loop
- review PR `<n>`
- what state is the dev loop in?

## Issue-based shorthand auto trigger contract

The shorthand `auto dev loop on issue 112` resolves to the same bounded public `dev-loop` intent: `dev-loop --intent auto_continue_current` with authoritative current state targeting issue 112.

Stop-boundary contract for this shorthand:

1. continue through the normal GitHub/Copilot loop (assignment, PR watch, draft/Copilot review-fix, final pre-approval) unless a genuine stop condition is reached
2. stop at the final human approval decision by default
3. after formal approval, stop again in `waiting_for_merge_authorization` unless merge authorization is explicitly granted for the active issue/PR scope
4. merge only after explicit merge authorization for the active issue/PR scope

## Surfaced-UX deprecation readiness bar

Do not remove surfaced internal loop names until all of the following are true:

1. authoritative routing is explicit and test-backed
2. fresh-session startup/resume/status can route from the bounded authoritative startup bundle
3. former name-shaped variation pressure has a bounded `dev-loop` parameter/settings home
4. surfaced help/discovery/readiness paths already point users to `dev-loop` and supported routed/parameterized forms

Once that bar is met, remove internal seam names from surfaced workflow-choice phrasing, and keep any remaining seam use explicitly internal/runtime-only.

## Workflow-surface taxonomy and guardrails

Use this taxonomy consistently across docs, discovery surfaces, and tests:

| Surface class | Entrypoints | Guardrail |
|---|---|---|
| Public write-capable workflow entrypoint | `dev-loop` | treat as the only intended public workflow entrypoint that advances lifecycle state |
| Sanctioned read-only review entrypoint | `review` via `loop startup --pr <n> --review` | separately invocable for informational review only; never advances lifecycle state or supplies lifecycle gate evidence |
| Internal routed strategy modules | `issue-intake`, `copilot-pr-followup`, `local-implementation`, `final-approval` | keep internal-only behind `dev-loop`; do not expose as executable peer workflow entrypoints |
| Reusable role agents | `developer`, `docs`, `review`, `fixer`, `quality`, `refiner` | keep role-agent use framed as reusable building blocks; the `review` role agent is distinct from the sanctioned read-only review entrypoint above |

<!-- rule: FACADE-COPILOT-INTERNAL-ONLY -->
`FACADE-COPILOT-INTERNAL-ONLY`: Any remaining specialized Copilot behavior stays internal-only behind `dev-loop`.

<!-- rule: FACADE-TAXONOMY-DRIFT-TEST -->
`FACADE-TAXONOMY-DRIFT-TEST`: Regression tests MUST fail if this taxonomy drifts in wording or surfaced entrypoint assets.

## Canonical current state

The public router consumes one canonical current state with these top-level dimensions:

| Field | Meaning |
|---|---|
| `target` | active artifact: `issue` \| `pr` \| `local_branch` \| `local_phase`; issue targets may include `linkedPr` when an existing PR is authoritative |
| `ownership` | durable owner or strategy family currently responsible for the artifact: `local` \| `copilot` \| `external_human` \| `reviewer` \| `maintainer` \| `user` |
| `nextActor` | immediate actor expected to take the next step; it may differ from `ownership` during review, approval, or handoff states |
| `status` | `active` \| `waiting` \| `blocked` \| `approval_ready` \| `merge_ready` \| `done` |
| `authorization` | `authorized` \| `needs_confirmation` \| `not_authorized` |

The authoritative first-slice evaluator, status-report helper (`resolveAuthoritativeDevLoopStatus()`), and startup/resume bundle helper (`resolveAuthoritativeStartupResumeBundle()`) all live in `packages/core/src/loop/public-dev-loop-routing.mjs`. Tests: `packages/core/test/public-dev-loop-routing-*.test.mjs`.

## Authoritative-state-first status reporting contract

Before answering status/progress/readiness/merge-state/next-step questions, consumers must:

1. resolve the authoritative active artifact identity (issue/PR/branch/phase as applicable)
   - for issue targets, this includes authoritative issue↔PR linkage resolution (for example via timeline linkage detection such as `scripts/github/detect-linked-issue-pr.mjs`)
2. resolve artifact state (`open` \| `closed` \| `merged` \| `not_applicable`)
3. resolve current loop state
4. resolve the next action from routed canonical state

Prior chat context is only a hint, never state authority.

<!-- rule: FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED -->
`FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED`: If authoritative identity/state (including issue↔PR linkage when relevant) cannot be resolved confidently, consumers MUST fail closed to reconcile/unknown instead of guessing.
For async/durable-auto flows, do not claim that `dev-loop` has started or is running unless a visible Pi-managed async run id has also been resolved.

When the routed next step requires confirmation for a mutation, the status/startup next action should name that concrete pending mutation (for example issue assignment to `copilot-swe-agent`) instead of generic "approval gate" wording.

## Authoritative startup/resume bundle contract

Fresh-session `continue`, `inspect`, and status-style paths should compose one bounded authoritative startup/resume bundle from the existing routing/status contract fields.

An optional public `intent` may be supplied when the caller needs the bundle to preserve `inspect_state` semantics without re-deriving them in a separate layer.

Required authoritative inputs:

- `currentState` (`target`, `ownership`, `nextActor`, `status`, `authorization`)
- optional `intent`
  - when present, it must be a valid public `dev-loop` intent
  - `inspect_state` preserves the bundle's `inspect` route kind and inspect-style next action
- optional `mode` (`bounded_handoff` \| `durable_auto`)
  - same bounded variation-mode semantics as `evaluatePublicDevLoopRouting`
  - `auto_continue_current` always resolves to `durable_auto`
- `issueLinkageResolution` (`resolved_linked_pr` \| `resolved_no_open_pr` \| `not_applicable`)
  - required when `currentState.target.kind === issue`
- `issueReadiness` (`ready` \| `needs_clarification` \| `not_applicable`) and `issueAssignmentState` (`unassigned` \| `assigned_to_copilot` \| `not_applicable`)
  - both required for Copilot-first issue targets with `issueLinkageResolution=resolved_no_open_pr`
- `artifactState` (`open` \| `closed` \| `merged` \| `not_applicable`)
- explicit resolved `loopState` (`unknown` is not authoritative input)
- required for async/durable-auto startup or status paths: `asyncRun`
  - shape: `{ "kind": "pi_managed_run" | "detached_process", "runId": "<visible-run-id>" | null, "processId": 12345 | null, "visible": true|false, "inspectionState"?: "visible" | "hidden" | "stale" | "uninspectable" | "missing" }`
  - durable-auto success requires `kind=pi_managed_run`, a non-empty visible `runId`, and `visible=true`
  - when `inspectionState` is provided as `hidden`, `stale`, or `uninspectable`, durable-auto must fail closed with that state surfaced in diagnostics
  - detached local processes are diagnostic-only evidence and must fail closed instead of being treated as a successful async start
- refreshed `linked_pr_ready_for_followup` for an issue target with a resolved linked PR: promote stale bootstrap waiting to the linked PR follow-up path, or fail closed if the linked-PR facts are incomplete/contradictory, instead of preserving the old bootstrap wait route
- refreshed `prior_linked_pr_closed_unmerged` for a Copilot-owned issue target with `issueLinkageResolution=resolved_no_open_pr`: fail closed to reconcile instead of treating the issue as a healthy bootstrap wait or fresh issue-intake path

Resolved bundle output shape:

```json
{
  "bundleKind": "resolved | needs_reconcile",
  "activeArtifact": {
    "kind": "issue | pr | local_branch | local_phase",
    "issue": 111,
    "pr": null,
    "branch": null,
    "phase": null
  },
  "artifactState": "open | closed | merged | not_applicable",
  "issueLinkageResolution": "resolved_linked_pr | resolved_no_open_pr | not_applicable",
  "issueAssignmentSeam": "needs_refinement | ready_needs_assignment_confirmation | ready_assign_now | assigned_to_copilot | not_applicable",
  "canonicalState": {
    "target": { "kind": "..." },
    "ownership": "...",
    "nextActor": "...",
    "status": "...",
    "authorization": "..."
  },
  "loopState": "...",
  "routeKind": "route | wait | stop | inspect | needs_reconcile",
  "selectedGate": "...",
  "selectedStrategy": "... | null",
  "executionMode": "bounded_handoff | durable_auto",
  "waitSemantics": "default | auto_healthy_wait",
  "asyncRun": {
    "kind": "pi_managed_run",
    "runId": "run-186",
    "processId": null,
    "visible": true
  },
  "nextAction": "...",
  "reason": "...",
  "contractTrace": {
    "decision": {
      "selectedGate": "...",
      "routeKind": "...",
      "selectedStrategy": "... | null",
      "executionMode": "...",
      "watchRequested": true,
      "contractClassification": "routed_followup | healthy_wait | terminal | blocked | authorization_gated | reconcile | inspect",
      "contractJustification": "..."
    },
    "waitStrategy": {
      "waitMode": "persistent_watch | not_applicable",
      "timeoutPolicyClassification": "... | null",
      "effectiveTimeoutMs": 3600000,
      "effectivePollIntervalMs": null
    },
    "stopReason": {
      "classification": "routed_followup | healthy_wait | terminal | blocked | authorization_gated | reconcile | inspect",
      "terminal": false,
      "reason": "..."
    },
    "stateRefresh": {
      "boundaryKind": "post_watch_or_probe | startup_resume_refresh | authoritative_status_refresh",
      "refreshRequired": true,
      "refreshReason": "..."
    }
  }
}
```

Dev-mode observability requirement:

- saved artifacts MUST preserve the `contractTrace` decision, wait strategy, state-refresh boundary, and stop classification so a fresh session can explain a re-attach, stop, or fail-closed without replaying the run
- wait/watch artifacts MUST record the effective timeout budget and whether the seam ran as `persistent_watch` or `one_shot_probe`; a surface without a poll interval MAY record `effectivePollIntervalMs=null` instead of inventing one

Fail-closed semantics:

- incomplete/invalid/conflicting startup inputs return:
  - `bundleKind = needs_reconcile`
  - `routeKind = needs_reconcile`
  - `selectedStrategy = null` in the canonical bundle (`none` is permitted only as the startup wrapper's display key)
  - `loopState = unknown`
  - `nextAction` must instruct reconciliation before routing/status answers
- `loop build-envelope` MUST accept that intentional null strategy and emit an actionable terminal reconciliation envelope; it MUST NOT coerce the result into a routed strategy
- `executionMode=durable_auto` must fail closed unless a visible Pi-managed async run is already registered
- a detached watcher/background pid is never acceptable evidence of async `dev-loop` startup success
- invalid explicit `intent` also fails closed
- do not introduce additional public degraded states for this slice

Expected answer shape (field names may vary by surface, but semantics must match):

```text
Active issue: <owner/repo>#<n> (when applicable)
Active PR: <owner/repo>#<n> (when applicable)
Artifact state: open|closed|merged|not_applicable
Loop state: <resolved loop state>
Async run: <visible Pi-managed run id>|unknown
Next action: <resolved next action>
```

## Internal strategy families

The public router currently maps to these deterministic internal strategies:

| Strategy | Used for | Public workflow entrypoint exposure |
|---|---|---|
| `local_implementation` | local branch/phase work and explicit local starts | `dev-loop` |
| `issue_intake` | issue-first normalization/intake before PR follow-up | none (internal-only via `dev-loop` routing; implemented by [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](./copilot-loop-operations.md) + [Issue Intake Procedure](./issue-intake-procedure.md)) |
| `copilot_pr_followup` | Copilot-owned PR follow-up | none (internal-only via `dev-loop` routing) |
| `external_pr_followup` | external-human contributor PR follow-up | none |
| `reviewer_fixer` | reviewer/fixer passes on the current PR | none |
| `wait_watch` | waiting/watch states | `dev-loop` |
| `final_approval` | approval-ready gate, or merge-ready with explicit merge authorization | none (canonical procedure lives in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](./copilot-loop-operations.md) Human approval checkpoint; [Final Approval](../final-approval/SKILL.md) is a thin redirect) |
| `ui_review` | explicit UI-review "prove it in the running app" pass on the current PR | `dev-loop` (the deterministic selector is `loop startup --pr <n> --ui-review`; see [UI Review](../ui-review/SKILL.md)) |
| `review` | plain read-only review gate on the current PR | `dev-loop` via `loop startup --pr <n> --review`, and the sanctioned separately invocable read-only [Review](../review/SKILL.md) entrypoint |

`waiting_for_merge_authorization` is part of the gate contract below as a stop gate rather than an internal strategy. Normal orchestration always starts from `dev-loop`.

## Tracker-backed local implementation input-source contract

Tracker-backed local implementation is an input-source addition to the existing `local_implementation` strategy. It does **not** create a new routing mode, strategy family, or public workflow entrypoint.

For tracker-backed local sessions, the tracker issue is canonical. `ARTIFACT-TRACKER-FIRST-NO-DUP` in [Artifact Authority Contract](artifact-authority-contract.md) bars creating a duplicate phase doc.

Deterministic GitHub-backed spec resolution:

1. accept either a full GitHub issue URL or an explicit `<owner/name>` + `<number>` tracker reference
2. parse that reference into one deterministic repo slug + issue number pair
3. resolve the issue through the bounded GitHub helper path (`scripts/github/resolve-tracker-local-spec.mjs`) or the equivalent `node scripts/github/view-issue.mjs --repo <owner/name> --issue <number> --json number,title,body,url,state` call
4. treat the returned issue `title`, `body`, `url`, and `state` as the usable local spec bundle
5. if the tracker reference cannot be resolved into one valid issue payload, fail closed instead of guessing or falling back to a duplicate phase doc

Local branch state and `tmp/` artifacts remain local execution state. Durable scope / acceptance / status changes discovered during local execution SHOULD sync back to the tracker issue. There is no full bidirectional tracker sync and no tracker-provider adapter beyond the bounded GitHub-backed helper path above.

Do not create, read, or update `docs/phases/phase-<n>.md` for the same tracker-backed session. If such a duplicate phase doc already exists, reconcile explicitly before continuing.

## Copilot-first issue-assignment seam (unassigned issues)

For Copilot-first issue flows (`currentState.target.kind=issue`, `ownership=copilot`, and no linked PR), orchestration must resolve this seam from authoritative issue facts before follow-up routing:

1. `issueReadiness=needs_clarification` → ask clarification questions and stop before assignment (`issueAssignmentSeam=needs_refinement`)
2. `issueReadiness=ready` + `issueAssignmentState=unassigned` + `authorization=needs_confirmation` → ask for explicit assignment confirmation (`issueAssignmentSeam=ready_needs_assignment_confirmation`)
3. `issueReadiness=ready` + `issueAssignmentState=unassigned` + `authorization=authorized` → assign `copilot-swe-agent` now before PR/bootstrap/watch follow-up (`issueAssignmentSeam=ready_assign_now`)
4. `issueReadiness=ready` + `issueAssignmentState=assigned_to_copilot` → assignment seam satisfied; proceed to follow-up (`issueAssignmentSeam=assigned_to_copilot`)

Fail closed if those readiness/assignment facts are missing or invalid.

## Single-contributor ownership gate (resolve-dev-loop-startup)

This script-layer gate is a distinct seam from the Copilot-first assignment seam above. `resolve-dev-loop-startup.mjs` enforces the gate after it selects the strategy for the `--issue`/`--pr` start. Through `STRATEGY_OWNERSHIP_GATE` it applies ONLY to code-changing or merge-authoritative strategies (`local_implementation`, `issue_intake`, `copilot_pr_followup`, `external_pr_followup`, `reviewer_fixer`, `final_approval`); an unknown/future strategy defaults to gated (`docs/decisions/0042-ownership-gate-scoped-to-code-changing-strategies.md`). Pure read/observe strategies (`review`, `ui_review`, `wait_watch`) are exempt through explicit `false` entries in `STRATEGY_OWNERSHIP_GATE`, so a reviewer can run `loop startup --pr <n> --review`, the UI-review selector, or wait/watch against work they do not own. For a gated strategy, the artifact (issue or PR) must resolve to a SOLE human owner: the viewer (`gh api user`'s login) and no other human assignee. Anything else fails closed.

The `review` route stays read-only: no assignee claim, no branch push, no fix commit, no board move, and no lifecycle gate evidence. It never satisfies `draft_gate` or `pre_approval_gate`. Every write-capable route stays gated.

- assigned to another human, or co-assigned to the viewer AND another human (contested, not sole): foreign-ownership error naming the OTHER assignee(s), never the viewer; no readiness bundle
- unassigned: not-claimed error naming the exact claim command (`edit-issue.mjs`/`edit-pr.mjs --add-assignee @me`); no readiness bundle
- assigned to the viewer alone: proceed
- assigned to `copilot-swe-agent`: unaffected; the Copilot-first seam above still governs; the viewer login is never resolved for this case
- the PR path also fails closed when the PR's linked issue is assigned to another human; the issue owner owns the whole loop
- the viewer login itself failing to resolve fails closed too (cannot verify or claim ownership)

Claiming is NOT compare-and-swap: `gh issue/pr edit --add-assignee @me` can land two racing contributors as co-assignees. Three layers keep ownership safe:

1. `resolve-active-board-item.mjs` (Next Up pickup) claims an unassigned candidate, then immediately RE-READS its assignees. Sole: proceed. A re-read that shows another human is a GENUINE contest only when the viewer's own claim is verified present in that same re-read (case-insensitive membership check). When the re-read shows only another human and the viewer's `@me` is not yet visible, the pickup best-effort self-unclaims and skips without touching the other assignee (`claim_not_visible_post_read`). A genuine contest resolves through a deterministic tiebreak: the case-insensitive lexicographically-smallest login wins. The **loser** self-unassigns (`--remove-assignee @me`) and skips to the next candidate. The **winner** removes the OTHER contender's login (`--remove-assignee <their login>`) before proceeding, so a loser that raced past its own re-read fails closed as foreign on its next ownership read.
2. The issue-intake procedure claims a directly-targeted issue before invoking startup, with the same claim semantics.
3. Every contributor's own `resolve-dev-loop-startup.mjs` invocation re-derives sole ownership from scratch and fails closed on any contested (non-sole) state. This is the backstop when a pickup-side re-read, tiebreak or removal is interrupted; those failure paths also best-effort self-unassign so an aborted pick does not strand a phantom claim.

Every ownership read that observes contention (contested or foreign) fails closed. Two residual windows remain and are accepted:

- **Both proceed (double work).** Racer A passes pickup and startup as sole owner before racer B's claim lands. B then wins the tiebreak and removes A, but A has already started. A's next ownership read (watch cycle, gate, or restart) sees the contested state and fails A closed.
- **Safe co-assignment.** When both racers' post-claim re-reads land before the other's write propagates, neither observes contention and no tiebreak fires. Both startup gates then fail closed on the co-assigned item, and a human must unassign one login (the documented no-lease/no-automatic-reclamation non-goal).

## Authoritative gate contract

Authoritative route selection is a two-step boundary for this slice:

1. resolve one authoritative canonical current state
2. map that state to one explicit gate, then to the corresponding route/strategy outcome

The shared machine-checkable gate contract is exported from `packages/core/src/loop/public-dev-loop-routing.mjs` as `DEV_LOOP_GATE` and `PUBLIC_DEV_LOOP_GATE_CONTRACT`.

| Gate | Route kind | Strategy | Meaning |
|---|---|---|---|
| `stop_blocked_or_not_authorized` | `stop` | none | blocked or not-authorized canonical state stops for a human decision |
| `stop_done_terminal` | `stop` | none | done canonical state stops as terminal work |
| `final_approval` | `route` | `final_approval` | approval-ready canonical state routes to the human approval checkpoint; merge-ready routes here only when merge authorization is explicit; requires explicit current-head `pre_approval_gate` checkpoint verdict evidence — CI green + resolved threads + clean rereview are not sufficient substitutes |
| `waiting_for_merge_authorization` | `stop` | none | merge-ready canonical state without explicit merge authorization stops and waits for explicit merge authorization |
| `wait_watch` | `wait` | `wait_watch` | waiting canonical state routes to the shared wait/watch strategy |
| `local_implementation` | `route` | `local_implementation` | local branch or local phase canonical state stays on local implementation |
| `issue_intake` | `route` | `issue_intake` | issue canonical state without a linked PR routes to issue intake |
| `external_pr_followup` | `route` | `external_pr_followup` | external-human PR ownership routes to external PR follow-up |
| `reviewer_fixer` | `route` | `reviewer_fixer` | reviewer-owned or reviewer-next PR state routes to reviewer/fixer |
| `copilot_pr_followup` | `route` | `copilot_pr_followup` | Copilot-owned PR state routes to Copilot PR follow-up |
| `ui_review` | `route` | `ui_review` | an explicit UI-review request on a PR target routes to the ui_review running-app review strategy |
| `review` | `route` | `review` | a plain-review request on a PR target routes to the read-only review strategy |
| `fail_closed_reconcile` | `needs_reconcile` | `null` | ambiguous, conflicting, or unsupported canonical state fails closed to reconcile; `none` is only the startup wrapper's display key |

For issue targets, authoritative issue↔PR linkage resolution remains part of state resolution before claiming there is no open linked PR:

- when canonical issue state includes `linkedPr`, route selection first uses that linked PR as the authoritative routable artifact
- when canonical issue state does **not** include `linkedPr`, status/reporting consumers must still require explicit authoritative linkage resolution before asserting there is no open linked PR
- <!-- rule: FACADE-LINKED-PR-SINGLE-ARTIFACT --> `FACADE-LINKED-PR-SINGLE-ARTIFACT`: when authoritative linkage resolves an already-open linked PR, that PR is the only canonical active artifact for the issue during follow-up; startup/status/follow-up MUST reuse it and MUST fail closed against opening another PR until the prior state is explicitly reconciled

## Deterministic routing order

First-match-wins routing posture:

1. blocked or not-authorized state -> stop and ask for a human decision
2. done -> terminal stop
3. merge-ready + `authorization=needs_confirmation` -> `waiting_for_merge_authorization`
4. approval-ready with explicit current-head `pre_approval_gate` evidence, or merge-ready + `authorization=authorized` with the same evidence -> `final_approval`
5. waiting -> `wait_watch`
6. local branch / local phase -> `local_implementation`
7. issue target with `linkedPr` -> route as the linked PR with the same ownership/actor state
8. issue target without `linkedPr` -> `issue_intake`
9. explicit plain-review request (`review_pr` intent) on a PR target -> `review`
10. explicit UI-review request (`review_pr_ui` intent) on a PR target -> `ui_review`
11. PR owned by external human -> `external_pr_followup`
12. PR owned by reviewer or next actor reviewer -> `reviewer_fixer`
13. PR owned by Copilot -> `copilot_pr_followup`
14. anything else -> fail closed to `needs_reconcile`

## Required transitions

The gate graph is stateless per cycle: each `evaluatePublicDevLoopRouting` call re-derives one gate from fresh authoritative state, so every non-terminal (route/wait) gate can be followed by any gate on the next cycle.

- `final_approval` -> any dev-loop gate
- `wait_watch` -> any dev-loop gate
- `local_implementation` -> any dev-loop gate
- `issue_intake` -> any dev-loop gate
- `external_pr_followup` -> any dev-loop gate
- `reviewer_fixer` -> any dev-loop gate
- `copilot_pr_followup` -> any dev-loop gate
- `ui_review` -> any dev-loop gate
- `review` -> any dev-loop gate

Terminal gates (`stop_blocked_or_not_authorized`, `stop_done_terminal`, `waiting_for_merge_authorization`, `fail_closed_reconcile`) have no outgoing transitions; reaching one ends the current evaluation cycle. Their route kind (`stop` / `needs_reconcile`) is the authoritative terminal marker. `validate-state-machine-conformance.mjs` checks this list.

## Conflict reconciliation path (`CONFLICTING` / `DIRTY`)

When an open linked PR reports merge conflict against `main`, treat this as an explicit bounded local-agent reconciliation path, not as a blind merge/update step:

1. keep the route at `needs_reconcile` / `fail_closed_reconcile` until reconciliation is complete
2. before any conflict edit, retrieve authoritative context at minimum:
   - latest `origin/main`
   - current PR head SHA and effective PR diff
   - issue/PR scope and acceptance criteria
   - current-head gate evidence and relevant unresolved review feedback
   - local validation surface for the touched conflict slice
3. <!-- rule: FACADE-CONFLICT-CONTEXT-FAIL-CLOSED --> `FACADE-CONFLICT-CONTEXT-FAIL-CLOSED`: if required authoritative context is missing, stale for the current head, or contradictory, orchestration MUST fail closed to reconcile
4. only when that context is complete for one current head, resolve the conflict locally on the PR branch
5. <!-- rule: FACADE-CONFLICT-REVALIDATE-NEW-HEAD --> `FACADE-CONFLICT-REVALIDATE-NEW-HEAD`: after conflict resolution, orchestration MUST rerun required local validation, gate checks, and required CI checks for the new head before approval/merge evaluation

### Base integration is the deterministic FIRST action of PR pickup

<!-- rule: FACADE-PICKUP-INTEGRATE-BASE-FIRST -->
`FACADE-PICKUP-INTEGRATE-BASE-FIRST`: when the deterministic pickup path (the `loop handoff` / startup-continue route) picks up an existing PR, the FIRST action — before any gate run or CI-wait — is to read the PR's `mergeable` / `mergeStateStatus` and, when the branch is behind base or `CONFLICTING`/`DIRTY`, integrate `origin/<base>` (merge, or the sanctioned `resolve-pr-conflicts.mjs` additive-conflict resolver) and push. Gates / CI-wait proceed only after the branch is mergeable-clean on the current base. The sanctioned pickup path implements this rule (`scripts/loop/copilot-pr-handoff.mjs` `runBasePickupPreflight`).

<!-- rule: FACADE-NEVER-CI-WAIT-WHILE-DIRTY -->
`FACADE-NEVER-CI-WAIT-WHILE-DIRTY`: the pickup path MUST NEVER enter a CI-wait (or Copilot-review wait) while `mergeStateStatus` is `DIRTY` / `mergeable` is `CONFLICTING`. GitHub does not dispatch `pull_request` CI on a conflicted branch. Resolve a conflicted PR first (integrate the base), or fail closed with a clear actionable stop. After integration the loop re-gates at the new head (`FACADE-CONFLICT-REVALIDATE-NEW-HEAD`).

## `auto dev loop` durable auto contract

When the public intent is `auto dev loop`, the router MUST:

1. require canonical current state resolution first
2. route to the same detected internal strategy as normal state-based routing
3. mark execution mode as durable auto ownership (`durable_auto`)
4. keep waiting/watch states in healthy-wait semantics (`auto_healthy_wait`)

In healthy waiting states, quiet watcher observations (for example `timeout` or `idle`) are observational only and MUST NOT be surfaced as attention by themselves. Escalation is still expected for true blocked/authorization/reconcile states.

Bootstrap-only exception to the general blocked-escalation rule for `waiting_for_initial_copilot_implementation`:

| Rule ID | Condition | Outcome |
|---|---|---|
| <!-- rule: FACADE-BOOTSTRAP-WATCH-ROUTE --> `FACADE-BOOTSTRAP-WATCH-ROUTE` | durable-auto ownership of this seam | ownership MUST route to the dedicated `watch-initial-copilot-pr.mjs` watcher with its default 1-hour watch budget |
| <!-- rule: FACADE-BOOTSTRAP-QUIET-NO-EJECT --> `FACADE-BOOTSTRAP-QUIET-NO-EJECT` | quiet/no-activity observation while refreshed state still resolves this seam | durable ownership MUST NOT be ejected; inspect/status intents MAY still summarize that state and exit normally |
| <!-- rule: FACADE-BOOTSTRAP-ACTION-REQUIRED-NONBLOCKING --> `FACADE-BOOTSTRAP-ACTION-REQUIRED-NONBLOCKING` | bootstrap-only linked PR; approval-gated Actions/Copilot run reports `action_required` (a run conclusion, not a lifecycle state) | treated as a non-blocking observational signal (concluded session activity); MUST NOT by itself force stop/escalation |
| <!-- rule: FACADE-BOOTSTRAP-CLOSED-UNMERGED-RECONCILE --> `FACADE-BOOTSTRAP-CLOSED-UNMERGED-RECONCILE` | refreshed bootstrap state resolves `prior_linked_pr_closed_unmerged` | MUST fail closed to reconcile so status/startup surfaces the prior closed-unmerged decision instead of normal watch continuity |
| <!-- rule: FACADE-BOOTSTRAP-FOLLOWUP-REENTRY --> `FACADE-BOOTSTRAP-FOLLOWUP-REENTRY` | refreshed seam state advances to `linked_pr_ready_for_followup` | durable-auto continuation MUST re-enter the same linked PR follow-up path |
| <!-- rule: FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION --> `FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION` | follow-up handoff carries `conductorRouting.handoffEnvelope.requiresLocalIsolation=true` | orchestration SHOULD continue through an isolated checkout/worktree transition rather than treat that boundary as final completion (the runtime surfaces the flag; it does not enforce re-entry) |

Main conductor orchestration MUST treat non-terminal follow-up/wait states (for example `waiting_for_copilot_review`) as continuation boundaries rather than clean completion. If an async child exits before the requested stop boundary and continuation is feasible, re-dispatch via the main session driver; otherwise surface the concrete blocker.

## Single-entrypoint convergence posture

- Documentation and examples SHOULD lead with `dev-loop` and explain routed behavior.
- Workflow branching SHOULD converge into deterministic state-machine/tooling surfaces behind `dev-loop`.
- User-visible variation SHOULD be expressed through the `dev-loop` API/parameters or settings, not multiple public workflow names or legacy compatibility seams.

## Bounded variation parameter contract

Supported workflow variations are expressed as `dev-loop` API parameters or settings rather than as new public workflow names.
Parameters may **steer** `dev-loop`, but must not replace authoritative routing.

### Precedence order (highest → lowest)

1. **Authoritative current state** — primary source of truth for what artifact/state the loop is actually in
2. **Explicit user intent / API parameters** — may choose among supported variation modes for the same public entrypoint
3. **Settings / preferences** — provide defaults only when explicit intent/parameters have not decided

Any conflict that would materially change artifact identity, ownership truth, or gate classification **fails closed** rather than being silently resolved by a parameter or preference.

### First-slice allowed parameters

| Parameter | Allowed values | Behavior |
|---|---|---|
| `mode` | `bounded_handoff` (default) \| `durable_auto` | Steers execution mode; `durable_auto` uses the same durable-auto execution-mode semantics as `auto_continue_current`, without replacing the selected intent |
| `watch` | boolean | Explicitly request wait/watch semantics; fails closed for otherwise-successful non-wait routed results, while preserving authoritative `stop` and `needs_reconcile` outcomes |
| `intent` | any existing public `dev-loop` intent | Disambiguates the supported public intent; maps to existing contract values |
| `targetPreference` | `prefer_local` (default) \| `prefer_github_first` | Steers routing preference; must not override authoritative linked-PR or active-artifact truth |

The bounded allow-list is exported from `packages/core/src/loop/public-dev-loop-routing.mjs` as `DEV_LOOP_VARIATION_PARAMETER_CONTRACT`.

`issueReadiness` and `issueAssignmentState` are **not** part of that bounded variation-parameter allow-list. They are authoritative issue-state facts used only for the Copilot-first unassigned-issue seam during startup/status/routing resolution.

### Explicit non-parameters for this slice

These must **not** become public variation knobs:
- arbitrary ownership override for an already-resolved canonical state
- arbitrary strategy override (e.g. "force copilot-pr-followup")
- arbitrary gate override (e.g. "skip approval gate")
- issue↔PR linkage bypass
- free-form "expert mode" flags that bypass deterministic routing

### Fail-closed rules

The following parameter/state combinations fail closed to `needs_reconcile` instead of silently coercing:

| Conflict | Reason |
|---|---|
| `mode=bounded_handoff` + `intent=auto_continue_current` | `auto_continue_current` always requires durable auto execution mode |
| Unrecognized `mode` value | Value not on the bounded allow-list |
| Unrecognized `targetPreference` value | Value not on the bounded allow-list |
| `watch=true` when an otherwise-successful routed result is not wait/watch-eligible | Watch semantics require a routed wait result (`routeKind=wait`), not just `selectedGate=wait_watch`; `stop`/`needs_reconcile` outcomes stay authoritative |
| Non-boolean `watch` value | Value is outside the bounded boolean allow-list and must fail closed |
| `targetPreference=prefer_local` when authoritative state has a linked PR or active PR artifact | Preference must not override authoritative PR/linked-PR active artifact truth |
| `mode=durable_auto` without authoritative current state | Durable auto requires authoritative current state to route from |

### Representative translations: name-shaped intent → parameterized `dev-loop` form

| Formerly name-shaped or prose-shaped | Parameterized single-entrypoint form |
|---|---|
| "auto dev loop" | `dev-loop --intent continue_current --mode durable_auto` |
| "run dev loop on PR 88 and stay on it" | `dev-loop --intent continue_on_pr --target pr:88 --watch` |
| "prefer the local path for issue 42" | `dev-loop --intent start_on_issue --target issue:42 --target-preference prefer_local` |
| "just inspect current state" | `dev-loop --intent inspect_state` |
| "review PR 88" | `dev-loop --intent review_pr --target pr:88` (deterministic startup selector: `loop startup --pr 88 --review`) |
| "review PR 88 in a UI loop" | `dev-loop --intent review_pr_ui --target pr:88` |

These are parameterized uses of `dev-loop`, not new workflow-facing entrypoints.
