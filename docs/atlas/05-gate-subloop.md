---
title: "Gate sub-loop: fan-out, fan-in, judge, fixer"
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="05-gate-subloop"></a>

## Gate sub-loop: fan-out, fan-in, judge, fixer

A `draft_gate` or `pre_approval_gate` round is a fixed pipeline of deterministic scripts around four kinds of agents. The context writer builds one neutral bundle. Independent reviewers run one dispatch unit per angle group, in bounded waves. Fan-in consolidates their per-angle artifacts without disposing any finding. A judge disposes each finding cluster as `act`, `defer` or `reject`. A fixer pushes the act list in the `full` phase. A new head always starts a new full round that judges the fix, so the loop ends on a clean verdict, the body-only converged post, or a typed blocker for the operator. The diagrams below are derived from the pure core modules under `packages/core/src/loop/` and the CLI scripts under `scripts/loop/` and `scripts/github/`.

<a id="d60"></a>

### One gate round, end to end

Type: `flowchart`

The full round as the coordinator drives it, from the context bundle to the re-gate. The insight is that every agent step sits between two deterministic scripts, and every push passes through the delta review first. Derived from `cli/index.mjs` (the `gate` and `loop` subcommand routes), `scripts/github/write-gate-context.mjs`, `scripts/github/emit-fanout-dispatch.mjs`, `scripts/loop/wait-for-gate-units.mjs`, `scripts/loop/consolidate-fanin.mjs`, `scripts/loop/judge-pass.mjs`, `scripts/loop/emit-fixer-work-order.mjs` and `scripts/loop/check-pre-push-delta.mjs`.

```mermaid
flowchart TD
  A["write-gate-context<br/>(bundle, wave plan)"] --> CF{"Head bump?"}
  CF -->|yes| CFP["resolve-angle-carry-forward<br/>(carry plan)"]
  CF -->|"first round"| B
  CFP --> B["emit-fanout-dispatch<br/>(one prompt per unit)"]
  B --> R["Reviewer units<br/>(wave by wave)"]
  R --> W["gate wait-for-units"]
  W --> C["gate consolidate-fanin"]
  C -->|"blocked"| X["Stop: escalate to operator"]
  C --> J["Judge unit<br/>(act / defer / reject)"]
  J --> JP["gate judge-pass<br/>(act list)"]
  JP --> L["gate write-findings-log"]
  L --> U["gate upsert-verdict"]
  U -->|"empty act list"| OK["Gate passes"]
  U -->|"act items"| F2["emit-fixer-work-order<br/>--phase full"]
  F2 --> P["Push, replies, CI"]
  P --> A
```

<a id="d61"></a>

### Coordinator conversation for one round

Type: `sequenceDiagram`

The same round as a message exchange. The coordinator is the only actor that talks to every role, and each child is joined by `gate wait-for-units` before the next script reads its output. The judge never sees a raw finding list; it sees clusters. Derived from `scripts/github/emit-fanout-dispatch.mjs`, `scripts/loop/wait-for-gate-units.mjs`, `scripts/loop/emit-judge-work-order.mjs`, `scripts/loop/judge-pass.mjs`, `scripts/loop/emit-fixer-work-order.mjs` and `scripts/loop/check-pre-push-delta.mjs`.

```mermaid
sequenceDiagram
  participant Co as Coordinator
  participant Rv as Reviewer units
  participant Ju as Judge
  participant Fx as Fixer
  participant De as Delta reviewer
  participant GH as GitHub
  Co->>Rv: dispatch payloads (wave of at most M units)
  Rv-->>Co: per-angle findings artifacts
  Co->>Co: gate wait-for-units, then consolidate-fanin
  Co->>Ju: judge work order (clusters, round, mediumFixWindow)
  Ju-->>Co: judge verdict (dispositions, scopeDrift)
  Co->>Co: gate judge-pass (act list), write-findings-log
  Co->>GH: gate upsert-verdict (checkpoint comment)
  alt act list non-empty
    Co->>Fx: commit_only work order
    Fx-->>Co: candidate commit, site coverage
    loop at most 3 delta invocations
      Co->>De: delta input (base head to candidate)
      De-->>Co: delta result
      opt needs_fix with a fresh result
        Co->>Fx: commit_only work order (residue)
        Fx-->>Co: new candidate commit
      end
    end
    Co->>Fx: full work order (push grant)
    Fx->>GH: push, thread replies
    GH-->>Co: CI result on new head
  else act list empty
    Co->>GH: gate passes at this head
  end
```

<a id="d62"></a>

### Fan-out dispatch: units, waves and retries

Type: `flowchart`

How the resolved angles become dispatch units and waves, and what a dispatch failure does. A transient error (429 or 5xx) retries the same unit first, and the halving signal turns on only at attempt index 2. A hard 4xx escalates at once. The unit split and the wave plan run in scripts. The retry and halving helpers are pure exports with no script caller: `grep -rln "planDispatchRetry\|backoffMaxConcurrent" scripts cli packages skills` finds only `gate-fanin.mjs`, its tests and the contract, so the coordinator applies `GATE-EXEC-DISPATCH-RETRY-BACKOFF` from contract prose. The defaults (5 angles per unit, 5 units per wave) were read with `grep -n "REVIEWER_UNIT_MAX_ANGLES =" packages/core/src/loop/reviewer-unit-bound.mjs` and `grep -n "maxConcurrent: z" packages/core/src/config/config.mjs`. Derived from `scheduleFanoutWaves`, `backoffMaxConcurrent` and `planDispatchRetry` in `packages/core/src/loop/gate-fanin.mjs` and the unit split in `scripts/github/emit-fanout-dispatch.mjs`.

```mermaid
flowchart TD
  G["Resolved angles<br/>minus carried angles"] --> S["Group into units<br/>(gates.fanout.groups)"]
  S --> SP{"Unit larger than<br/>unit bound?"}
  SP -->|yes| PN["Split into name-part1, -part2"]
  SP -->|no| WV
  PN --> WV{"fanout.sequential?"}
  WV -->|true| W1["1 unit per wave"]
  WV -->|false| WM["maxConcurrent units per wave"]
  W1 --> DSP["Dispatch wave"]
  WM --> DSP
  DSP --> E{"Dispatch error?"}
  E -->|none| NX["Next wave"]
  E -->|"429 or 5xx"| RT["Retry same unit<br/>(same artifact path)"]
  RT --> EX{"Attempt index 2 or more?"}
  EX -->|no| DSP
  EX -->|yes| HV["Retry and halve batch<br/>(floor, min 1)"]
  HV --> DSP
  E -->|"other 4xx"| ESC["Escalate to operator"]
```

<a id="d63"></a>

### Same-unit retry delay per attempt

Type: `xychart-beta`

The retry delay that `planDispatchRetry` returns for each prior failed attempt on one unit. The delay holds at 120 s after the third attempt, and the batch-halving signal turns on at attempt index 2. The helper has no script caller (see the fan-out caption). The values are the frozen constant read with `grep -n "DISPATCH_RETRY_BACKOFF_SCHEDULE_MS = " packages/core/src/loop/gate-fanin.mjs`; attempts 3 and 4 show the hold. Derived from `packages/core/src/loop/gate-fanin.mjs`.

```mermaid
xychart-beta
  title "Retry delay by attempt index (seconds)"
  x-axis "Prior failed attempts" ["0", "1", "2", "3", "4"]
  y-axis "Delay (s)" 0 --> 140
  bar [30, 60, 120, 120, 120]
```

<a id="d64"></a>

### Default angle catalog sizes per gate

Type: `xychart-beta`

How many reviewer angles each shipped gate catalog declares, and how many named fan-out groups exist. The draft catalog declares more angles than the pre-approval catalog. The pre-approval catalog holds the design-principle angles (`dry`, `kiss`, `yagni`, `srp` and the SOLID set). These are declared counts; one round reviews only the angles its config resolves. Counts were produced by `awk '/^  [a-zA-Z]+:$/{sec=$1} /^ +- name:/{c[sec]++} END{for(s in c) print s, c[s]}' packages/core/src/config/extension-defaults.yaml`. Derived from `packages/core/src/config/extension-defaults.yaml`.

```mermaid
xychart-beta
  title "Entries per catalog in extension-defaults.yaml"
  x-axis ["draft angles", "preApproval angles", "fanout groups", "spike angles"]
  y-axis "Count" 0 --> 25
  bar [22, 16, 7, 2]
```

<a id="d65"></a>

### Fan-in verdict and posted verdict

Type: `flowchart`

Fan-in decides a provisional verdict from severities only and leaves every finding `unjudged`. A per-angle artifact with verdict `blocked` fails `validateAngleResult`, which accepts only `clean` or `findings_present`, so it counts as malformed. Any malformed artifact gives the fan-in verdict `blocked`, and the CLI wrapper then exits 1. A duplicate angle name across artifact files is a separate CLI check that throws before consolidation. The posted verdict comes from the judge's act list on a fully judged round. A partly judged round keeps the fan-in verdict unless an act item is open, and `blocked` is never lowered. The default blocking severity set is `["high"]`. Derived from `consolidateFanin`, `validateAngleResult`, `isFullyJudged` and `composeReviewVerdict` in `packages/core/src/loop/gate-fanin.mjs` and the exit-code table in `scripts/loop/consolidate-fanin.mjs`.

```mermaid
flowchart TD
  IN["Per-angle artifacts"] --> DUP{"Duplicate angle name?"}
  DUP -->|yes| EX1["CLI throws, exit 1"]
  DUP -->|no| M{"Any malformed artifact<br/>or blocked angle?"}
  M -->|yes| BL["fan-in verdict: blocked"]
  BL --> EX2["CLI exit 1;<br/>blocked never lowered"]
  M -->|no| SEV{"Any finding in<br/>blockCleanOnFindingSeverities?"}
  SEV -->|yes| FP["fan-in verdict: findings_present"]
  SEV -->|no| CL["fan-in verdict: clean"]
  FP --> CRV
  CL --> CRV
  CRV{"Open act item?"} -->|yes| PF["Posted: findings_present"]
  CRV -->|no| FJ{"Non-empty and<br/>every finding judged?"}
  FJ -->|yes| PC["Posted: clean"]
  FJ -->|no| KEEP["Posted: fan-in verdict"]
```

<a id="d66"></a>

### Judge disposition coercion per cluster

Type: `flowchart`

What `applyJudgeDispositions` does with one cluster disposition before the fixer sees it. A `defer` on a cluster with a `high`, a `question` or only `nit` members fails the judge pass closed. An `act` on a low/nit-only cluster is coerced by gate and round (`GATE-EXEC-LOW-ROUND-FLOOR`), a `defer` on a low cluster from draft round 2 rejects the same way unless the judge sets `lowException`, and `failOpen` promotes a low to medium. Any undisposed cluster also fails closed. Derived from `applyJudgeDispositions`, `neverDeferredSeverity` and `validateJudgeVerdict` in `packages/core/src/loop/gate-fanin.mjs`, `scripts/github/write-gate-context.mjs` (`resolveDraftRoundCap`) and `scripts/loop/judge-pass.mjs`.

```mermaid
flowchart TD
  D["Judge disposition<br/>for one cluster"] --> K{"Kind?"}
  K -->|defer| NV{"Cluster has high or question,<br/>or is all nit?"}
  NV -->|yes| FAIL["Throw: fail closed"]
  NV -->|no| DEF["defer + followUpDraft"]
  K -->|reject| REJ["reject"]
  K -->|act| LN{"Only low or nit members?"}
  LN -->|no| ACT["act"]
  LN -->|yes| FO{"failOpen and has a low?"}
  FO -->|yes| PRO["act, severity promoted to medium"]
  FO -->|no| AN{"All nit?"}
  AN -->|yes| R1{"draft_gate round 1?"}
  R1 -->|yes| ACT
  R1 -->|no| REJ2["reject (low_floor)"]
  AN -->|no| PA{"pre_approval_gate?"}
  PA -->|yes| DEF2["defer (low_floor)"]
  PA -->|no| LF{"draft round 2 or later<br/>and no lowException?"}
  LF -->|yes| REJ2
  LF -->|no| ACT
  ACT --> AL["Fixer act list"]
  PRO --> AL
```

<a id="d67"></a>

### Fix sequence state machine

Type: `stateDiagram-v2`

The frozen transition table for one fix sequence at a PR head. Every state reaches a terminal (`full_gate_round` or `stopped`), and any foreign commit moves the sequence to `head_moved`, which exits to a full round. A `residue` delta verdict re-enters `commit_only_emitted`. `stopped` is reached from the operator stop flag, not from a table edge. Derived from `FIX_LOOP_TRANSITIONS` and `interpretFixLoopState` in `packages/core/src/loop/fix-loop-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> act_pending
  act_pending --> commit_only_emitted
  commit_only_emitted --> candidate_committed
  commit_only_emitted --> no_commit
  commit_only_emitted --> head_moved
  no_commit --> full_gate_round
  candidate_committed --> delta_review
  candidate_committed --> head_moved
  delta_review --> full_emitted: clear or bounded_out
  delta_review --> commit_only_emitted: residue
  delta_review --> head_moved
  full_emitted --> pushed
  full_emitted --> head_moved
  pushed --> ci_green
  pushed --> ci_red
  pushed --> head_moved
  ci_red --> act_pending: CI failure source
  ci_red --> head_moved
  ci_green --> disposition_complete
  ci_green --> delivery_incomplete
  ci_green --> head_moved
  delivery_incomplete --> disposition_complete
  delivery_incomplete --> full_gate_round
  delivery_incomplete --> head_moved
  disposition_complete --> full_gate_round
  disposition_complete --> head_moved
  head_moved --> full_gate_round
  head_moved --> disposition_complete: descendant carry
  full_gate_round --> [*]
  stopped --> [*]
```

<a id="d68"></a>

### Pre-push delta review bound

Type: `stateDiagram-v2`

The decision after each delta invocation. A fresh, valid `locally_clear` result grants the push. Below the bound a stale result re-reviews the current head and a fresh failing one goes back to the fixer. At the third invocation the sequence ends `bounded_out`: it pushes into the normal gate path and claims no success. The bound of 3 was read with `grep -n "DELTA_MAX_INVOCATIONS =" packages/core/src/loop/pre-push-delta-review.mjs`. Derived from `resolveDeltaTrigger`, `deriveDeltaOutcome` and `decideDeltaNextStep` in `packages/core/src/loop/pre-push-delta-review.mjs` and `scripts/loop/check-pre-push-delta.mjs`.

```mermaid
stateDiagram-v2
  [*] --> Trigger
  Trigger --> NoDelta: no act or thread items, or already pushed
  Trigger --> Invocation: committed, not pushed
  Invocation --> Push: valid, fresh, locally_clear
  Invocation --> Bound: not clear
  state Bound <<choice>>
  Bound --> BoundedOut: invocation is 3
  Bound --> Stale: below bound, stale
  Bound --> NeedsFix: below bound, fresh
  Stale --> Invocation: rereview_current_head
  NeedsFix --> Invocation: fix_and_rereview
  Push --> [*]
  BoundedOut --> [*]: push_to_gate
  NoDelta --> [*]
```

<a id="d69"></a>

### Draft-gate round cap and exits

Type: `flowchart`

How a `draft_gate` round ends under the round cap. Rounds 1 to the cap run and a clean round stops early. Round cap+1 is the scoped final round of `GATE-EXEC-CAP-BRAKES`, and its clean verdict is the only draft exit after the cap round. A later round goes to the operator. Below the cap, act items go to the fixer and the next full round runs. At the cap, only a named human decision blocks (`pastCapBlockers`); every other act list goes to the fixer. A body-only act list converges through the body-only post at every round up to the cap, and a blocker in it blocks at any round. A cap of 0 disables the cap, because `isRoundRefused` and `isCapRound` both require `cap > 0`. The growth stop (`growth_past_forecast`) is enforced: `resolveCapBrakes` reads the forecast and `decideCapRound` stops the lane. Derived from `packages/core/src/loop/review-round-cap.mjs`, `pastCapBlockers` in `packages/core/src/loop/gate-fanin.mjs`, `composeBodyOnlyConvergedDraftGate` in `packages/core/src/loop/pre-push-delta-review.mjs`, and `countCompletedRounds` in `scripts/github/write-gate-context.mjs`.

```mermaid
flowchart TD
  N["Round n posted<br/>(n = closed rounds + 1)"] --> RF{"n greater than cap?"}
  RF -->|"yes, n = cap+1"| SCP["Scoped final round"]
  RF -->|"yes, later round"| HUM
  SCP --> SCL{"Posted clean?"}
  SCL -->|yes| RDY
  SCL -->|no| HUM
  RF -->|no| CLN{"Posted clean?"}
  CLN -->|yes| PASS["Stop early: gate passes"]
  CLN -->|no| CAP{"n equals cap?"}
  CAP -->|no| FIX["Fixer, then next full round<br/>(a body-only list takes the body-only post)"]
  CAP -->|yes| BLK{"pastCapBlockers non-empty?"}
  BLK -->|yes| HUM["blocked: round_cap_reached<br/>(operator decision)"]
  BLK -->|no| BODY{"All PR-body items,<br/>body edited?"}
  BODY -->|yes| BCONV["Body-only converged"]
  BODY -->|no| CFIX["Fixer on cap-round items"]
  RDY["mark_ready_for_review,<br/>then pre_approval_gate"]
  BCONV --> RDY
  CFIX --> SCP
  GROW["Growth stop<br/>(growth_past_forecast)"] --> HUM
```

<a id="d70"></a>

### Cap-round blocker test per finding

Type: `flowchart`

How `pastCapBlockers` classifies one ledger finding at or after the draft-gate cap round. Only a named human decision blocks, and each blocker carries the kind `round_cap_reached` with the reason `new_act`, `resurfaced` or `severity_disagreement`. A `high` act item with a non-blank `judgeFix` goes to the fixer at the cap round and blocks only after it. Medium, low and nit act items never block. Derived from `pastCapBlockers`, `isOpenActItem` and `JUDGE_DISPOSITIONS` in `packages/core/src/loop/gate-fanin.mjs`.

```mermaid
flowchart TD
  F["Ledger finding"] --> OA{"Open act item?"}
  OA -->|yes| SV{"Severity text present?"}
  SV -->|no| SD1["Blocker: severity_disagreement"]
  SV -->|yes| Q{"question, or high without<br/>(cap round and judgeFix)?"}
  Q -->|yes| RS{"resurfaces set?"}
  RS -->|yes| B1["Blocker: resurfaced"]
  RS -->|no| B2["Blocker: new_act"]
  Q -->|no| FX["No blocker: fixer"]
  OA -->|no| VD{"Valid disposition<br/>and severity?"}
  VD -->|no| SD2["Blocker: severity_disagreement"]
  VD -->|yes| CL{"defer or reject with<br/>failOpen or high?"}
  CL -->|yes| SD3["Blocker: severity_disagreement"]
  CL -->|no| OK["No blocker"]
```

<a id="d71"></a>

### Artifacts that cross each seam

Type: `classDiagram`

The data shapes passed between the steps of a round. Fan-in adds `angle` and the `unjudged` disposition; the judge keys dispositions by cluster id; the delta result binds to the candidate head. The insight is that each seam has one validator that fails closed. Derived from the shape comments and validators in `packages/core/src/loop/gate-fanin.mjs` (`validateAngleResult`, `validateJudgeVerdict`), `packages/core/src/loop/finding-cluster.mjs` (`computeRootCauseKey`), and `packages/core/src/loop/pre-push-delta-review.mjs` (`deltaResultShapeErrors`).

```mermaid
classDiagram
  class AngleResult {
    angle
    verdict
    headSha
    findings[]
  }
  class ConsolidatedFinding {
    severity
    angle
    summary
    file
    line
    disposition = unjudged
    clusterId
  }
  class JudgeVerdict {
    headSha
    scopeDrift
    dispositions[]
  }
  class Disposition {
    index = clusterId
    disposition
    rationale
    failOpen
    followUpDraft
  }
  class DeltaResult {
    candidateHead
    actionableItems[]
    newFindings[]
    outcome
  }
  AngleResult "1" --> "*" ConsolidatedFinding : consolidateFanin
  ConsolidatedFinding "*" --> "1" Disposition : one per cluster
  JudgeVerdict "1" *-- "*" Disposition
  ConsolidatedFinding ..> DeltaResult : act items checked
```

