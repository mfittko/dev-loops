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
in the PR's actual worktree/head — the same checkout the reviewers will run in — so the
gitignored, worktree-local `tmp/gate-context` bundle it writes is present for them:

- the context-builder runs in fresh context and emits a NEUTRAL artifact; that artifact (never the parent session's chat history or state) is what each downstream reviewer subagent is later seeded with. **Mandatory:** every gate-review subagent must run `scripts/github/verify-fresh-review-context.mjs --scope <angle> --context-path <path>` at startup and refuse to proceed on contamination or a missing gate-context artifact. Use `--scope <angle>` so each reviewer writes its own sentinel, and `--context-path` to the artifact this phase writes below.
- **Worktree isolation is PROHIBITED for per-angle gate reviewers.** They are read-only
  (they never mutate files), so filesystem isolation buys nothing and actively breaks the
  "build once, seed many" contract: a fresh worktree is checked out from `main`, not the
  PR head, and has no access to the gitignored, worktree-local `tmp/gate-context` bundle
  this phase writes (#1135). Reviewers run in the PR's actual worktree/head — the same
  checkout the preamble ran in.
- the preamble resolves the gate's review angle set: it starts from the configured
  angle pool (`gates.<gate>.angles`) and, when `gates.<gate>.dynamicAngles` is enabled,
  narrows it to the angles relevant to the change at hand (configured pool → resolved
  set). Optional code-review lenses not triggered by the change (for example most code
  lenses for a docs-only change) are dropped, and the reason each angle was dropped is
  recorded as rationale. Angles in `gates.<gate>.mandatoryAngles` form a floor and are
  always included after dynamic selection (filtered only by `excludeAngles`); they are
  never dropped. When `dynamicAngles` is off (or no diff is available), the configured
  static pool is used unchanged. Symmetrically, when `gates.<gate>.additiveAngles` is
  enabled (default **off**), the resolver may also ADD catalog angles that
  change-category heuristics recommend but that are not already in the gate's
  configured pool, drawn from the global lens catalog (the explicit `gates.anglePool`
  override, or — when `anglePool` is not set or is empty — the union of the built-in persona
  registry's angle names and every angle actually configured across this config's
  own `gates.draft`/`gates.preApproval`/`gates.spike` `angles`/`mandatoryAngles`).
  `excludeAngles` remains a hard ceiling on additions — an excluded angle is
  never added, even if the change categories would otherwise recommend it. Additions
  are recorded in the rationale with action `"added"`, with a reason naming either the
  triggering change category or, for always-include lenses, that it is an
  always-include addition. This additive path is off by default, so existing configured angle pools
  are unaffected unless a gate explicitly opts in.
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

Fan out one fresh-context reviewer per gate-specific review angle. The reviewer is the scoped `review` agent ([review agent scoped angle-review mode](../agents/review.agent.md)), spawned once per resolved angle via the plain Agent tool. Reviewers are **independent and seeded with the identical neutral context bundle verbatim** (Phase 1's diff + `adjacentCode`); they do NOT fork from, or inherit the loaded context of, the main agent or a sibling reviewer. Parallelism is capped at `gates.maxFanoutReviewers` (default 8); when the resolved angle set exceeds the cap, the overflow runs in sequential batches (planned by `planFanoutBatches` from `@dev-loops/core/loop/gate-fanin`) and the degradation is recorded in the gate evidence. Each reviewer:

- starts in fresh context. **Mandatory:** run `scripts/github/verify-fresh-review-context.mjs --scope <angle> --context-path <path>` at startup (the same invocation Phase 1 mandates); refuse to proceed on contamination or a missing gate-context artifact. Use `--scope` so parallel reviewers in the same working directory do not trigger false contamination from each other's sentinels, and `--context-path` (pointing at the Phase 1 artifact) so a reviewer in the wrong/isolated checkout fails closed. The sentinel is keyed per review ROUND by the current head SHA (`git rev-parse HEAD`), so a retry at a new head naturally gets a fresh sentinel — see [Sentinel lifecycle](#sentinel-lifecycle). Here "fresh" means the reviewer's context is the neutral builder artifact + its angle, and explicitly NOT the main agent's conversation/state or a prior reviewer session's state: the injected neutral bundle is the intended seed (allowed), while main-agent / cross-session state bleed fails closed.
- is seeded with the neutral context bundle verbatim (diff + `adjacentCode`) as its base, and widens (loads more files) only when its single angle genuinely needs more — it does not re-derive the whole diff/adjacent-code graph
- is scoped to exactly one review angle
- is **read-only**: inspects the diff and returns findings via output artifacts only; never edits files
- runs in the PR's actual worktree/head — **never an isolated worktree** (see the
  prohibition in Phase 1: isolation would both lose the seeded gate-context bundle and
  risk silently reviewing a stale tree). `verify-fresh-review-context.mjs --context-path`
  enforces this mechanically: it fails closed if the seeded artifact isn't present at the
  reviewer's cwd.
- produces a focused findings artifact with verdict (clean/findings_present) and file references
- **completion is detected via the harness completion notification, or by the presence of the reviewer's findings artifact at its deterministic output path — never by reading the reviewer's transcript.** The orchestrator awaits fan-in on those artifact paths (or the completion notification) and joins via `consolidateFanin` (Phase 3); it must not tail/parse a reviewer's JSONL transcript, use `node -e`/`python3` to parse tool JSON, or `sleep`-poll a shell loop for completion (forbidden — see [anti-patterns](../skills/docs/anti-patterns.md)).

Reviewers run in parallel when practical. If parallel execution is impractical
(for example due to tooling or resource constraints), run all reviewers sequentially
and explicitly record why parallel execution was impractical.

**Re-run rule:** In subsequent retry cycles (Phase 5), only re-run reviewers that
produced `findings_present` in the previous pass. Reviewers that returned `clean`
don't need re-review unless their angle's scope overlaps with the fix changes.

#### Sentinel lifecycle

The fresh-context sentinel, written by `verify-fresh-review-context.mjs`, is scoped **per
review round**, keyed by the head SHA. This makes the lifecycle mechanical rather than a
manual chore:

- The round key is the current head SHA (`git rev-parse HEAD`); reviewers keep invoking the
  guard as `--scope <angle>` and get head-keyed isolation for free — no flag to pass. `git
  rev-parse HEAD` yields the same full SHA on every invocation for a given head, so the key is
  deterministic and the same-head guard cannot be defeated by an inconsistent spelling. The
  sentinel filename is therefore `tmp/checkpoint-context-sentinel-<scope>-<headSha>.json` in a
  git worktree. When git is unavailable (non-git worktree, no commits), the head component is
  omitted and the key falls back to the scope-only filename
  `tmp/checkpoint-context-sentinel-<scope>.json` (legacy behavior) — there is no `-<headSha>`
  file in that case.
- **A retry at a new head is never blocked by a prior round's sentinel** — a new head SHA
  produces a new key, so a re-fan-out after a fix commit passes `fresh: true` with **no
  manual clear step**.
- **Within one round the contamination guard is preserved:** a same-scope + same-head
  re-entry still fails closed (`fresh: false`, exit 1) — that is genuine main-agent /
  cross-session state bleed.
- The orchestrator **MUST NOT** need to manually clear sentinels between rounds, and
  **MUST NOT** clear the sentinels of carried-forward clean angles (Phase 5's re-run rule
  only re-invokes angles that produced `findings_present`; their new-head keys are distinct,
  so no cleanup is required).
- Stale pre-round sentinels (the old scope-only name) never collide with a head-keyed round
  and are simply ignored.

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

## Copilot round-cap interplay

The gate chain can complete cleanly at a head that was accepted via round-cap fallback.
If significant post-convergence changes later land on a newer head (product/test logic,
not doc/message/comment-only edits), that opens a new Copilot review cycle and requires
another Copilot round before pre-approval proceeds. The prior cycle's cap does not carry
forward to suppress that new-cycle re-request when regular rounds are already > 0.

## Machine-parseable fields

The sub-loop execution shape can be referenced programmatically via these fields:

| Field | Value | Description |
|---|---|---|
| `subLoopPhases` | `[preamble, fanout, fanin, fix, repeat]` | Ordered sub-loop phases |
| `contextBuilderRequired` | `true` | Preamble phase must include fresh-context context-builder |
| `worktreeIsolationProhibited` | `true` | Per-angle reviewers must run in the PR's actual worktree/head, never an isolated worktree (#1135) |
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
default `inline_single_agent`) via the [Gate comment command](../skills/copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract); inline runs must declare an `--inline-reason`. A `fanout_fanin` verdict passes the structured per-angle review results via `--findings-json` (the per-angle `{angle, verdict, findings}` artifacts that feed `consolidateFanin`, or the flat `toFindingsLogShape` output grouped by `.angle`) so the comment renders a per-angle breakdown; `--findings-summary` is the inline_single_agent fallback only. Fan-out evidence enforcement is **ON by default** (`gates.requireFanoutEvidence`): a clean gate verdict requires the gate to run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA, and the pre-merge evidence check fails closed for a required gate otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`. Live context-builder/fan-out execution (epic #867) is what makes `fanout_fanin` producible — distinct from this contract's own sub-loop phase numbering (preamble / fanout / fanin).

### Fan-out provenance (closing the self-produced-artifact loophole)

`requireFanoutEvidence` is artifact-based: it only proves a `fanout_fanin` verdict
carries a findings-log ledger. A single agent could self-produce every per-angle
artifact + the ledger and label the verdict `fanout_fanin`, satisfying the letter
of the gate while defeating independent parallel review. To close this, the
findings-log ledger can additionally record **fan-out provenance**:

```jsonc
"provenance": {
  "distinctReviewers": 2,               // count of distinct reviewer agents dispatched (<= distinct identities in perAngle)
  "perAngle": [                          // per-angle dispatch provenance
    { "angle": "scope",   "reviewer": "review-a", "dispatchId": "…", "model": "…" },
    { "angle": "safety",  "reviewer": "review-b" }
  ]
}
```

Provenance is written via `write-gate-findings-log.mjs --provenance <json>` (validated
on write; malformed OR self-inconsistent provenance fails the write). It is **optional
and additive** — when omitted, the ledger is byte-identical to before and no enforcement
changes. **Internal-consistency rule** (enforced on both the write path and the
enforcement read path): `perAngle` must be non-empty when `distinctReviewers > 0`, and
`distinctReviewers` must be `<=` the count of DISTINCT reviewer identities actually
recorded in `perAngle` (distinct by `reviewer`, else `dispatchId`; a bare `{angle}` is
not a countable reviewer). You cannot claim more reviewers than you recorded dispatch
entries for — this closes the `{distinctReviewers: 2, perAngle: []}` loophole.

Enforcement is opt-in via **`gates.requireFanoutProvenance`** (default **false**). When
enabled, it layers ON TOP of `requireFanoutEvidence` (it only takes effect while fan-out
evidence enforcement is active): each required `fanout_fanin` gate's ledger must record
internally-consistent provenance with `provenance.distinctReviewers >= 2` (a floor of
**2** is the smallest count that is not a single agent). When the flag is off, behavior is
byte-identical to today (no new failures) — the Claude-Code path, which already honors
child fan-out, is a validated no-op.

**Honest caveat (this is NOT un-forgeable):** recorded provenance is self-reported — it is
written by the same agent whose independence it claims — so a determined single agent can
still forge an internally-consistent blob. This enforcement raises the bar (rejects
malformed/inconsistent provenance and requires distinct recorded dispatch entries) but
does NOT claim un-forgeable enforcement. Un-forgeable recording (the harness attesting who
actually ran each per-angle review) is the Pi-harness bridge — the subagent tool honored
at child depth (see #1084).

### Fail-closed: fan-out unavailable → route to conductor

When a child/agent **cannot** perform real parallel fan-out (e.g. a harness that does not
honor the subagent tool at child depth), the flow MUST fail closed rather than silently
degrade to a single-agent inline review. The canonical, matchable signal is the exported
constant `FANOUT_UNAVAILABLE_MESSAGE` (`@dev-loops/core/loop/gate-fanin`):

> **fan-out unavailable — route to conductor**

`fanoutUnavailableError(detail)` builds an `Error` carrying this prefix plus
`{ routeToConductor: true, code: "FANOUT_UNAVAILABLE" }`. Callers throw it (or check
`err.routeToConductor === true`) to hand the gate review up to the conductor. The
`requireFanoutProvenance` pre-merge failure message references this same contract string.
The full end-to-end driving command that dispatches per-angle review subagents at child
depth is provided by the Pi-harness child (the bridge); this contract specifies only the
recording + enforcement + fail-closed signal that land independently.

## See also

- [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) — visible PR comment evidence format
- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — broader lifecycle state machine
- [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Local Implementation](../skills/local-implementation/SKILL.md) — uses chain pattern for local phase plan audits
