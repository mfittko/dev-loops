# Issue intake procedure

Canonical owner for the routed `issue_intake` procedure behind the public `dev-loop` façade: preflight, normalization, async refinement, epic decomposition, and Copilot handoff.

Use it together with:
- [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md)
- [Public Dev Loop Contract](./public-dev-loop-contract.md) — owner of `FACADE-LINKED-PR-SINGLE-ARTIFACT`, `FACADE-BOOTSTRAP-WATCH-ROUTE`, `FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION`
- [Retrospective Checkpoint Contract](./retrospective-checkpoint-contract.md) when the current step depends on async start/resume/status or retrospective enforcement
- [Stop Conditions](./stop-conditions.md) — owner of `STOP-INITIAL-COPILOT-001` and the other strategy-wide stop/wait rules this procedure operationalizes
- [Merge Preconditions](./merge-preconditions.md) — the merge gate this procedure defers to before `gh pr merge`

When routed work is issue-first rather than already in active PR follow-up, use the procedure below before entering the shared post-PR loop. Treat this document as the issue-refinement specialist procedure for the routed `issue_intake` seam.

## New-idea safety layer (default contract in this repo)

<!-- rule: INTAKE-NEW-IDEA-SAFETY -->
For **all new ideas** that are not already anchored to an existing issue (including abstract ideas such as plain-language requests without an issue number or plan-doc path), the procedure MUST apply this intake contract before any GitHub mutation:

- procedure owns classification; human operator gates all mutations
- run classification in fresh context by default
- run classification asynchronously when practical
- run async fan-out / fan-in proposal generation by default when practical
- emit a proposal artifact before any GitHub state-changing mutation, including create/edit/retitle/collapse/link operations
- default to create-new over overwrite/update when a new tracked artifact is justified
- do not repurpose/retitle/collapse/overwrite an existing issue unless that exact mutation is explicitly proposed and explicitly approved
- after approval, run a second async mutation pass (dispatched via the procedure) instead of mutating directly from inherited context
- verify post-mutation artifact state and record what actually changed

**Quick-capture exemption:** board quick-capture enqueue (the `/loop-enqueue` freeform
path — freeform text turned directly into a minimal issue, gated on explicit human
approval, then grilled inline and added to the board) MAY defer the up-front proposal
artifact, the async classification pass, the async fan-out/fan-in proposal generation, and
the second async mutation pass; its inline confirm→create→grill steps stand in for them,
with grilling supplying classification/refinement after creation. The human-gated-mutation
and create-new-only safeties still apply — it always creates a new issue and never
repurposes/overwrites an existing one.

Deterministic intake + mutation-gate state machine:

```text
idea_received
  -> fresh_context_started
  -> fanout_started
  -> fanin_complete
  -> artifact_scan_complete
  -> classified
  -> proposal_emitted
  -> awaiting_user_approval
  -> ready_for_mutation
  -> mutation_executed
  -> mutation_verified
  -> done

stop states:
- stopped_overlap_needs_decision
- stopped_low_confidence
- stopped_explicit_reject
```

Proposal artifact contract:
- human-readable Markdown proposal
- machine-readable JSON snapshot
- write temporary artifacts under `Proposal` (`tmp/new-idea-intake/<run-id>/proposal.md`) and `tmp/new-idea-intake/<run-id>/proposal.json`

<!-- rule: INTAKE-STOP-STATES -->
If the Phase 1 preflight verdict is `pause_for_clarification`, the procedure MUST stop and ask.
If the intake state machine stops at `stopped_overlap_needs_decision` or `stopped_low_confidence`, the procedure MUST stop and ask.
If the intake state machine stops at `stopped_explicit_reject`, the procedure MUST stop and record that the proposal was rejected; it MUST NOT mutate GitHub.

After approval, start a separate async mutation pass (dispatched via the procedure) that consumes the approved proposal and emits a post-mutation verification artifact. Emit a concise post-mutation verification artifact and record what the mutation pass actually changed and verify the resulting issue/artifact state.

## Unattended issue-first execution and automatic re-entry

When the user explicitly authorizes unattended execution for a specific issue/PR scope, continue through the normal loop mutations for that scope without stopping at every intermediate phase boundary.

Under that unattended execution contract:
- automatically detect the current lifecycle entrypoint from existing GitHub state
- use the deterministic helper/state-machine surface as the authority for current-state routing and next-step selection
- if local facts, GitHub facts, and helper/state-machine output do not agree, or the state is materially unclear, contradictory, off-trail, or not cleanly covered, stop and ask for human direction rather than guessing
- a pre-existing PR is not a stop-by-default condition
- If a PR already exists, classify the post-assignment seam before follow-up
- `waiting_for_initial_copilot_implementation`: keep waiting
- `linked_pr_ready_for_followup`: route to the existing PR follow-up path immediately; resume from that PR
- when routing leaves bootstrap wait for `linked_pr_ready_for_followup`, follow [FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION](public-dev-loop-contract.md): re-enter the same PR follow-up from a safe isolated checkout/worktree instead of stopping solely because local isolation is required
- When the draft PR appears, classify whether it is still the bootstrap-only Copilot draft before entering normal follow-up
- if a child async run exits while the deterministic state is still non-terminal (for example `waiting_for_copilot_review`), automatically resume/restart follow-up when continuation is feasible instead of requiring manual operator restart
- continue unattended until the human approval checkpoint unless a genuine stop condition is reached
- stop for a human approval decision by default
- after approval, report `waiting_for_merge_authorization` and stop again unless merge has been explicitly authorized
- this does **not** imply unattended merge by default

Issue-first shorthand such as `auto dev loop on issue <n>` should preserve this same stop boundary and human approval checkpoint default.

## Phase 1 — Preflight intake

Before any automation, answer these questions:
1. smallest executable work item
2. existing issue check
3. scope clarity
4. acceptance criteria
5. verification path
6. active PR check

Accepted input types:
- GitHub issue number or URL
- plan-doc path
- abstract roadmap idea

Preflight verdicts:
- `proceed`
- `proceed_with_assumptions`
- `pause_for_clarification`

## Phase 2 — Input normalization

### From a GitHub issue number or URL

- if the input is a full GitHub issue URL, parse `<owner/name>` and `<number>`
- fetch with `node scripts/github/view-issue.mjs --repo <owner/name> --issue <number> --json number,title,body,state,labels,assignees,milestone`
- If the issue is closed, stop for a user decision before proceeding
- detect an existing linked PR with the deterministic linked-PR helper:
  `node <resolved-skill-scripts>/github/detect-linked-issue-pr.mjs --repo <resolved-repo> --issue <number>`
- treat the helper output as authoritative for linked-PR detection/selection
- <!-- rule: INTAKE-LINKED-PR-HELPER-DELEGATION --> `INTAKE-LINKED-PR-HELPER-DELEGATION`: Agents MUST NOT re-implement linked-event query behavior, pagination, repo filtering, or tie-break logic, and MUST NOT rely only on PR title/body containing a literal issue number.
- treat an open linked PR as the active implementation for this issue
- once an open linked PR exists, attach follow-up work to it per `FACADE-LINKED-PR-SINGLE-ARTIFACT` (owned in [Public Dev Loop Contract](public-dev-loop-contract.md)) for the `issue_intake` strategy
- **follow-up-capture rule:** when a follow-up is discovered while working a PR/loop, note it on the originating issue (or the PR body); file a standalone issue only if the follow-up is genuinely independent of the PR **and** outlives it (a real separate bug/feature that would be lost as a note on a soon-closed issue). Prefer noting PR-scoped follow-ups on the originating artifact over spinning up standalone tracker items for work that is part of the same effort or will be resolved imminently. See [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md).
- if a PR already exists, classify bootstrap-wait versus follow-up:
  `node <resolved-skill-scripts>/loop/detect-initial-copilot-pr-state.mjs --repo <resolved-repo> --issue <number>`
- `waiting_for_initial_copilot_implementation`: keep waiting; in durable-auto mode use:
  ```sh
  node <resolved-skill-scripts>/loop/watch-initial-copilot-pr.mjs --repo <resolved-repo> --issue <number>
  ```
  - durable-auto ownership of this seam (the dedicated watcher + its default 1-hour watch budget) is owned by [FACADE-BOOTSTRAP-WATCH-ROUTE](public-dev-loop-contract.md); this procedure does not restate that rule
  - quiet/no-activity watch observations alone are non-terminal
  - `ready_for_followup`: linked PR has become substantive; resume from that PR
  - `timed_out`: observational first; refresh authoritative state
  - if refreshed state is still `waiting_for_initial_copilot_implementation`, remain attached to the same durable wait seam and continue waiting
  - <!-- rule: INTAKE-TIMEOUT-ROUTE-ON-SEAM-EXIT --> `INTAKE-TIMEOUT-ROUTE-ON-SEAM-EXIT`: if the refreshed state exits this seam, route based on that refreshed state instead of surfacing timeout attention
  - when the refreshed state is `linked_pr_ready_for_followup`, re-enter normal PR follow-up per [FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION](public-dev-loop-contract.md): if the follow-up handoff carries `conductorRouting.handoffEnvelope.requiresLocalIsolation=true`, perform the expected isolated-checkout/worktree handoff and continue
  - <!-- rule: INTAKE-TIMEOUT-SURFACE-BUDGET-EXHAUSTED --> `INTAKE-TIMEOUT-SURFACE-BUDGET-EXHAUSTED`: only surface timeout attention when the seam's durable watch budget is actually exhausted
  - for explicit inspect/status requests, report the still-waiting state and exit normally
- carry that resolved repo slug through every later GitHub issue/PR command
- before invoking `resolve-dev-loop-startup.mjs --issue <number>` for local implementation on this directly-targeted issue, claim ownership: `dev-loops issue edit --repo <resolved-repo> --issue <number> --add-assignee @me` (skip if already assigned to the viewer; source-repo fallback: `node scripts/github/edit-issue.mjs ...`). The resolver's single-contributor ownership gate fails closed on a foreign or unclaimed assignee — see [Public Dev Loop Contract](public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup)

### From a plan-doc path

- <!-- rule: INTAKE-REPO-SLUG-RESOLVE-FIRST --> `INTAKE-REPO-SLUG-RESOLVE-FIRST`: Resolve the target repository slug for this work item before any GitHub search or mutation
- default to the current repository slug
- if the plan-doc reference explicitly points at another GitHub repository, resolve `<resolved-repo>` first
- search existing issues with:
  ```sh
  gh issue list --repo <resolved-repo> --state all --search "<title keywords>"
  ```
- If a matching issue exists:
  - if the matching issue is closed, stop for a user decision before proceeding
  - if that matching issue turns out to be closed, stop for a user decision
  - if a PR already exists, classify bootstrap-wait versus follow-up
- if a governing plan doc or roadmap section actually applies, follow the plan-doc normalization path above

### From an abstract idea

- otherwise search existing issues directly
- if a matching issue exists, follow the issue-number/URL normalization path
- resolve `<resolved-repo>` for this work item using the same rule as the plan-doc path

## Phase 3 — Async issue refinement

Before updating or assigning the issue, refine it asynchronously when practical. Keep issue refinement separate from the phase-scoped refiner used by the local implementation workflow. Use the `refiner` agent for this review-only issue-refinement chain, including the consolidation/fan-in step; do not route those comparison/synthesis steps through `dev-loop` + `local_implementation` (the strategy loaded by `skills/local-implementation`).

When issue refinement would benefit from structural/slop discovery and the likely code/doc surface is knowable, run the bounded audit first.
- write the issue-refinement audit artifact to `tmp/issues/issue-<number>/audit/refinement-audit-summary.json`
- use the same audit artifact shape as local phase refinement
- keep the audit bounded to the named files/areas for this issue; do not widen into a full-repo scan
- pass a concise audit summary into refiner fan-out and fan-in
- require the issue-refinement write-up to translate audit findings into scope, AC/DoD, risks, and explicit non-goals without silently broadening the issue

## Phase 3b — Epic decomposition with GitHub sub-issue trees

When the work item is an umbrella/epic issue that must be decomposed into bounded child slices,
use **real GitHub sub-issue trees** as the default durable output — not body checklists, not
a manual follow-up linking step.

Prefer real sub-issue linkage over parent-body checklists when a work tree is intended.
A parent issue body should stay lean once the tree exists: keep scope, acceptance criteria, and
non-goals there, but do **not** duplicate the ordered child list in the body.

Full decomposition flow:

1. refine umbrella issue framing (scope, acceptance criteria, non-goals)
2. define bounded child slices — each slice must be independently closable
3. create child issues with `gh issue create --repo <resolved-repo> --assignee @me`
4. attach each child as a real sub-issue:
   ```sh
   node <resolved-skill-scripts>/github/manage-sub-issues.mjs add \
     --repo <resolved-repo> --issue <parent-number> --child <child-number>
   ```
5. set execution order (highest priority first):
   ```sh
   node <resolved-skill-scripts>/github/manage-sub-issues.mjs reorder \
     --repo <resolved-repo> --issue <parent-number> --order <n1,n2,...>
   ```
6. verify the resulting tree:
   ```sh
   node <resolved-skill-scripts>/github/manage-sub-issues.mjs verify \
     --repo <resolved-repo> --issue <parent-number> --expected <n1,n2,...> [--ordered]
   ```
7. keep the parent issue body lean — sequencing and progress now live in the sub-issue tree

To inspect the current tree at any time:
```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs list \
  --repo <resolved-repo> --issue <parent-number>
```

Ad-hoc bypass of `manage-sub-issues.mjs` and duplicating the tree in the parent body are owned
by `SUBISSUE-NO-ADHOC-BYPASS` and `SUBISSUE-LEAN-BODY-NO-DUPLICATE` in
[Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md); this procedure does not
restate those rules.

For the full `manage-sub-issues.mjs` contract, use [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md) when working in the `dev-loops` source repository. That contract is a source-repo reference, not part of the bundled installed skill-doc surface. For installed or normalized skill copies, inspect the target repository docs/source directly instead of assuming a bundled shared-doc copy exists.

When an existing sub-issue tree needs **scope alignment, AC/DoD contracts, and delegation boundary refinement** across all levels (parent → children → grandchildren), use the [Epic Tree Refinement Procedure](./epic-tree-refinement-procedure.md) — it owns the deterministic depth-first, top-down-then-bottom-up refinement protocol.

## Phase 4 — Copilot handoff and bootstrap wait

Before updating the GitHub issue body, show the diff and get explicit confirmation. Then use:
```sh
dev-loops issue edit --repo <resolved-repo> --issue <number> --body-file <updated-body-file>
dev-loops issue edit --repo <resolved-repo> --issue <number> --add-assignee copilot-swe-agent
```
(source-repo fallback: `node scripts/github/edit-issue.mjs ...`)
Verify assignment with:
```sh
node scripts/github/view-issue.mjs --repo <resolved-repo> --issue <number> --json assignees
```

When the linked PR becomes substantive, keep the shared loop scoped to the resolved repo, for example:
```sh
node <resolved-skill-scripts>/loop/copilot-pr-handoff.mjs --repo <resolved-repo> --pr <number>
gh pr edit <pr-number> --repo <resolved-repo> --title "..." --body-file <body-file>
gh pr ready <pr-number> --repo <resolved-repo>
gh pr review <pr-number> --repo <resolved-repo> --approve --body "..."
node <resolved-skill-scripts>/github/detect-checkpoint-evidence.mjs --repo <resolved-repo> --pr <pr-number>
```

The merge itself is gated, not implied by the lines above. Before any `gh pr merge`, follow [Merge Preconditions](./merge-preconditions.md): all preconditions (green CI, clean `draft_gate` + current-head `pre_approval_gate`, zero unresolved threads, explicit merge authorization) must hold. Critically, when `autonomy.humanMergeOnly: true` is set, merge is a fixed human-only action — `resolveEffectiveMergeAuthorized` fails closed, the agent **never** runs `gh pr merge`, and instead reports merge-ready + gate evidence and hands off to a human. Only when **not** `humanMergeOnly` and merge is explicitly authorized may the agent run:
```sh
gh pr merge <pr-number> --repo <resolved-repo> --squash --delete-branch
```

Bootstrap-wait interpretation remains fail-closed and observational-first — same seam as Phase 2's `waiting_for_initial_copilot_implementation` handling above: `ready_for_followup` resumes from the now-substantive linked PR; `timed_out` is observational first; refresh authoritative state and re-apply the Phase 2 branching (still-waiting vs. seam-exit) rather than re-deriving it here.

## Cross-references

See the "Use it together with" list at the top; additionally, [Epic Tree Refinement Procedure](./epic-tree-refinement-procedure.md) refines an existing sub-issue tree, while this procedure creates it (Phase 3b).

