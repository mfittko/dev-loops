# Checkpoint Review Chain Contract

This document defines the reusable checkpoint review chain execution shape shared by the
two dev-loop gate boundaries: `draft_gate` and `pre_approval_gate`.

## Purpose

Both gates share the same execution mechanism: a structured sub-loop that provides
isolation, a build-once neutral context bundle, independent-reviewer fan-out,
fan-in synthesis, and iterative fix-then-retry. Codifying the sub-loop once as a
shared contract avoids inconsistent execution.

### Execution model: build once, seed many (no fork)

The sub-loop does **not** fork reviewers from a parent agent's loaded context, and
it does not depend on any fork primitive or the Workflow tool. Instead:

1. A deterministic **context-builder script** (`scripts/github/write-gate-context.mjs`)
   builds ONE generous, neutral context bundle for the head SHA: the full diff plus
   a structurally-adjacent code bundle (each changed file's 1-hop import in/out-edges)
   with size guards. Because it is a script, the bundle is neutral (it cannot
   editorialize) and deterministic (identical head + diff → identical bundle).
2. Each per-angle reviewer is an **independent fresh-context Agent** that is **seeded
   with that identical neutral bundle verbatim** plus its single review angle, and
   widens only when its angle genuinely needs more. Reviewers never inherit the main
   (orchestrating) agent's conversation or opinions — that independence is the
   anti-bias requirement.
3. Fan-in consolidates the per-angle findings unchanged.

The cost win is **work-dedup**: the diff + adjacent code is built once instead of
re-derived by every reviewer. That saving is guaranteed regardless of caching; a
shared-prefix prompt-cache across reviewers is an opportunistic bonus, not a
requirement.

This contract owns the **execution shape** of gate-review work. It does not own:
- which review angles a specific gate runs (that stays in the skill)
- the visible gate-review PR comment format (owned by [Gate Review Comment Contract](./gate-review-comment-contract.md))
- the broader PR lifecycle sequencing (owned by the workflow skill and [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md))

## Relationship to the checkpoint verdict comment contract

The sub-loop executes the review work. The checkpoint verdict comment contract
([Gate Review Comment Contract](gate-review-comment-contract.md)) defines the visible PR comment evidence that
proves the sub-loop completed for a specific head SHA. Both are required for a gate to
be satisfied, but they address different concerns:
- this contract = **how** the review work is structured and executed
- checkpoint verdict comment contract = **what** visible evidence must exist on the PR

## Separate chains per gate

Each gate (`draft_gate`, `pre_approval_gate`) runs its own independent review chain
with its own review angles, its own disposition ledger, its own fix cycle, and its own
exit conditions. The chains are not interchangeable; each gate's execution is a complete,
self-contained sub-loop pass.

| Property | `draft_gate` chain | `pre_approval_gate` chain |
|---|---|---|
| Review angles | Resolved from `gates.draft.angles` | Resolved from `gates.preApproval.angles` |
| Disposition ledger | Gate-specific findings log | Gate-specific findings log |
| Fix cycle scope | Only findings that block the draft→ready transition | Only findings that block final approval readiness |
| Exit condition | Clean verdict for the reviewed head | Clean verdict for the reviewed head |

## Sub-loop phases

The sub-loop is a single reusable shape. Both gates run it with their own review angles,
but the execution phases are identical.

### Phase 1 — Preamble: context-builder

Before fanning out reviewers, run a preamble pass that produces review handoff context
on an isolated checkout:

- fresh context (the reviewer is seeded with the neutral builder artifact + its angle, never the parent session's chat history or state). **Mandatory:** every gate-review subagent must run `scripts/github/verify-fresh-review-context.mjs` at startup and refuse to proceed on contamination. Use `--scope <angle>` so each reviewer writes its own sentinel.
- `worktree: true` recommended per reviewer/subagent for filesystem isolation; prescribe it but
  do not fail closed if worktrees are unavailable in the current environment
- the preamble resolves the gate's review angle set: it starts from the configured
  angle pool (`gates.<gate>.angles`) and, when `gates.<gate>.dynamicAngles` is enabled,
  narrows it to the angles relevant to the change at hand (configured pool → resolved
  set). Optional code-review lenses not triggered by the change (for example most code
  lenses for a docs-only change) are dropped, and the reason each angle was dropped is
  recorded as rationale. Angles in `gates.<gate>.mandatoryAngles` form a floor and are
  always included after dynamic selection (filtered only by `excludeAngles`); they are
  never dropped. When `dynamicAngles` is off (or no diff is available), the configured
  static pool is used unchanged.
- the preamble produces one or more review handoff artifacts (branch, head SHA, PR/issue
  scope, acceptance criteria, touched files, validation posture). The resolved angle set
  and its rationale are written as a deterministic handoff artifact under
  `tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json` so the fan-out phase
  consumes a stable, auditable briefing per head SHA.
- the preamble ALSO builds the deterministic **neutral context bundle** ONCE: the full
  diff (`scope.diffPath`) plus an adjacent-code bundle (`adjacentCode`) containing each
  changed file and its 1-hop import in/out-edges (callers/callees/imports), with size
  guards (skip lockfiles/generated/binary/minified; cap per-file bytes; truncate the
  long tail) recorded in a `stripped`/`truncated`/`missing` manifest for observability.
  This is the build-once, work-deduped seed handed verbatim to every reviewer; no
  reviewer re-derives the diff + adjacent code from scratch.
- reference the pi-subagents `parallel context-build` technique when applicable:
  run parallel `context-builder` agents from fresh context with distinct output paths
  (e.g. `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`,
  `context-build/validation-and-risks.md`) and synthesize the outputs into the review
  handoff artifacts

### Phase 2 — Fan-out: independent reviewers seeded with the neutral bundle

Fan out one fresh-context reviewer per gate-specific review angle. The reviewer is the scoped `review` agent ([review agent scoped angle-review mode](../agents/review.agent.md)), spawned once per resolved angle via the plain Agent tool. Reviewers are **independent and seeded with the identical neutral context bundle verbatim** (Phase 1's diff + `adjacentCode`); they do NOT fork from, or inherit the loaded context of, the main agent or a sibling reviewer. Parallelism is capped at `gates.maxFanoutReviewers` (resolved via `resolveMaxFanoutReviewers(config)`, default 8); when the resolved angle set exceeds the cap, the overflow runs in sequential batches (planned by `planFanoutBatches` from `@dev-loops/core/loop/gate-fanin`) and the degradation is recorded in the gate evidence. Each reviewer:

- starts in fresh context. **Mandatory:** run `scripts/github/verify-fresh-review-context.mjs --scope <angle>` at startup; refuse to proceed on contamination. Use `--scope` so parallel reviewers in the same working directory do not trigger false contamination from each other's sentinels. Here "fresh" means the reviewer's context is the neutral builder artifact + its angle, and explicitly NOT the main agent's conversation/state or a prior reviewer session's state: the injected neutral bundle is the intended seed (allowed), while main-agent / cross-session state bleed fails closed.
- is seeded with the neutral context bundle verbatim (diff + `adjacentCode`) as its base, and widens (loads more files) only when its single angle genuinely needs more — it does not re-derive the whole diff/adjacent-code graph
- is scoped to exactly one review angle
- is **read-only**: inspects the diff and returns findings via output artifacts only; never edits files
- runs in an isolated worktree when worktrees are available
- produces a focused findings artifact with verdict (clean/findings_present) and file references

Reviewers run in parallel when practical. If parallel execution is impractical
(for example due to tooling or resource constraints), run all reviewers sequentially
and explicitly record why parallel execution was impractical.

**Re-run rule:** In subsequent retry cycles (Phase 5), only re-run reviewers that
produced `findings_present` in the previous pass. Reviewers that returned `clean`
don't need re-review unless their angle's scope overlaps with the fix changes.

### Phase 3 — Consolidation: fan-in synthesis and disposition ledger

Merge the parallel reviewer findings into one consolidated fix plan using the
pure `consolidateFanin` pass from `@dev-loops/core/loop/gate-fanin` (not manual
concatenation). It collates the per-angle artifacts, gates `clean` on
`blockCleanOnFindingSeverities`, returns `blocked` when any per-angle artifact is
malformed/missing, and `toFindingsLogShape` maps the result into the
`write-gate-findings-log.mjs` `--findings` shape:

- collate findings from all review angles
- classify each finding: `must-fix`, `worth-fixing-now`, `defer`
- write the disposition ledger: every finding receives a severity classification and a
  disposition (accepted-for-fix, deferred, disputed, or operator_acknowledged). The disposition ledger is the
  durable record of what the gate found and what was decided.
- produce a merged findings artifact
- determine the overall gate verdict:
  - `clean`: no findings with a severity in the gate's `blockCleanOnFindingSeverities` list remain
  - `findings_present`: one or more findings with a blocking severity remain
  - `blocked`: the gate could not complete or a hard blocker prevented a verdict
- write the durable final-findings log via `write-gate-findings-log.mjs` under
  deterministic `tmp/` paths before posting the visible PR comment

**Disposition ledger rule:** The consolidated findings and their dispositions must be
logged as the durable disposition ledger **before** the visible PR comment is posted.
The ledger is the source of truth for what the gate found; the visible PR comment is a
summary for auditability.

**Post-findings rule:** The consolidated findings must be posted as a visible,
marker-tagged PR comment via `post-gate-findings.mjs` (a consolidated comment listing
each finding grouped by severity, with `file:line` refs) **before** the fix cycle in
Phase 4 begins, so the findings are auditable and Copilot/humans are aware of them.
Fixes must not be applied until the auditable trail exists on the PR. The helper is
idempotent per gate (exactly one comment per gate, updated in place on each run; the
reviewed head is shown in the body) and posts a brief "no findings" note when the set
is empty. This comment
is governed by `gates.postFindingsComments` (resolved via
`resolveGatePostFindingsComments(config)`, default true / opt-out): when it is `false`
the helper no-ops with a `skipped` result and the post step is skipped. The disposition
ledger is written regardless — the opt-out only suppresses the PR comment, never the
durable ledger.

### Phase 4 — Fix

If findings with a severity in the gate's `blockCleanOnFindingSeverities` list are present:

- apply only the accepted narrow fixes on the same branch
- do not broaden scope or touch unrelated files
- run the smallest honest validation for the accepted fix scope
- commit and push fixes on the branch
- the fix cycle covers **all** blocking severities, not only `must-fix`. If
  `blockCleanOnFindingSeverities` includes `worth-fixing-now`, then worth-fixing-now
  findings must also be fixed before the gate can reach `clean`.

### Phase 5 — Repeat until clean

After applying fixes and advancing the head SHA:

- **Re-gate is mandatory:** a new head SHA always requires a fresh full-chain gate pass. Never skip the gate because a previous head was clean.
- rerun the sub-loop from Phase 1 (context-builder preamble for the new head SHA)
- continue the fix-then-retry cycle until the synthesis verdict is `clean`
- on retry, only re-invoke reviewers that previously returned `findings_present`; the context-builder and consolidation always run fresh
- a clean pass means all gate-specific review angles pass and no findings with a severity in `blockCleanOnFindingSeverities` remain

## Exit conditions

Each gate chain exits when one of these conditions is met:

| Condition | Result |
|---|---|
| Consolidated verdict is `clean` (no findings at any blocking severity) | Gate passes; proceed to next boundary |
| `blocked` verdict (gate could not complete) | Stop; escalate to operator |
| Maximum retry cycles exhausted without reaching `clean` | Stop; escalate to operator |
| Fix cycle produces no net progress (same findings after fix attempt) | Stop; escalate to operator |

## Machine-parseable fields

The sub-loop execution shape can be referenced programmatically via these fields:

| Field | Value | Description |
|---|---|---|
| `subLoopPhases` | `[preamble, fanout, fanin, fix, repeat]` | Ordered sub-loop phases |
| `contextBuilderRequired` | `true` | Preamble phase must include fresh-context context-builder |
| `worktreeRecommended` | `true` | Worktree isolation recommended but not hard-required |
| `fixRetryUntilClean` | `true` | Blocking-severity findings trigger fix → retry until synthesis is clean |
| `separateChains` | `true` | Each gate runs an independent chain with its own disposition ledger |

## Gate-specific configuration

Each gate configures the sub-loop with its own review angles and blocking severities.
The execution phases are identical; only the review angles and blocking severity policy differ.

| Gate | Review angles | Blocking severities | Owned by |
|---|---|---|---|
| `draft_gate` | Resolved from config (`resolveGateAngles(config, "draft")`) | Resolved from config (`resolveGateConfig(config, "draft").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../skills/copilot-pr-followup/SKILL.md) |
| `pre_approval_gate` | Resolved from config (`resolveGateAngles(config, "preApproval")`) | Resolved from config (`resolveGateConfig(config, "preApproval").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../skills/copilot-pr-followup/SKILL.md) |

## Non-substitution rule

A clean sub-loop pass for one gate does not satisfy the other gate. Each gate requires
its own complete sub-loop execution with its own review angles, its own disposition ledger,
and its own visible checkpoint verdict comment on the PR for the reviewed head SHA.

## Disposition ledger and durable logging

Every gate pass writes a durable final-findings log via `write-gate-findings-log.mjs`:

```sh
node scripts/github/write-gate-findings-log.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <sha> \
  --verdict <clean|findings_present|blocked> \
  --findings '[{"severity":"must-fix","angle":"scope","summary":"...","disposition":"accepted-for-fix"}]'
```

The log is written under `tmp/gate-findings/<repo-slug>/pr-<N>/<gate>-<headSha>.json`.
Each log entry records the full disposition: severity, angle, summary, affected files, and
resolved-in SHA (for findings resolved in a later pass).

## Execution mode and fan-out evidence enforcement

Each gate verdict records an `executionMode` (`fanout_fanin` or `inline_single_agent`,
default `inline_single_agent`) via the [Gate comment command](../skills/copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract); inline runs must declare an `--inline-reason`. Fan-out evidence enforcement is **ON by default** (`gates.requireFanoutEvidence`): a clean gate verdict requires the gate to run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA, and the pre-merge evidence check fails closed for a required gate otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`. Live context-builder/fan-out execution (epic #867) is what makes `fanout_fanin` producible — distinct from this contract's own sub-loop phase numbering (preamble / fanout / fanin).

## See also

- [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) — visible PR comment evidence format
- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — broader lifecycle state machine
- [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Local Implementation](../skills/local-implementation/SKILL.md) — uses chain pattern for local phase plan audits
