---
title: Main flows from issue to merge
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="04-main-flows"></a>

## Main flows from issue to merge

This section follows one unit of work from a raw idea to a merged PR. An idea becomes a grilled issue through the intake procedure and the grill sub-loop. The main agent then dispatches a `dev-loop` coordinator. The coordinator runs `loop startup`, opens a draft PR, and runs the draft\_gate. The coordinator continues at a routine `nextAction` and hands back a typed packet at a stop or at the routine-boundary cap, and the orchestrator dispatches a fresh coordinator from an emitted work order. After a clean draft\_gate the PR goes ready, Copilot reviews it, the pre\_approval gate runs, and `merge-pr.mjs` merges it under a recorded human approval. The diagrams below are derived from the CLI route table in `cli/index.mjs`, the scripts it routes to, the pure state modules in `packages/core/src/loop/`, and the contracts under `skills/docs/`. No diagram shows measured counts.

<a id="d46"></a>

### End-to-end commands from issue to merge

Type: `flowchart`

The main path as the skills, CLI subcommands and scripts that carry it, grouped by owner. The insight is that the coordinator steps are routed `dev-loops` subcommands, the intake steps are skills, and the merge is a direct script that only the orchestrator runs. `merge-pr.mjs` has no CLI route. Derived from `SUBCOMMAND_ROUTES` in `cli/index.mjs`, the orchestrator-owned list in `skills/docs/main-agent-contract.md`, `skills/loop-grill/SKILL.md`, and `scripts/github/merge-pr.mjs`.

```mermaid
flowchart LR
  subgraph Op["Operator"]
    idea["idea or issue"]
    approve["approve merge line (escalated only)"]
  end
  subgraph Grill["Intake and grill"]
    enq["loop-enqueue skill"]
    grill["loop-grill skill"]
  end
  subgraph Coord["dev-loop coordinator"]
    st["loop startup"]
    prc["pr create (draft)"]
    gate["draft_gate round"]
    rfr["pr ready-for-review"]
    cop["gate request-copilot"]
    pre["pre_approval round"]
    gc["loop gate-coordination"]
  end
  subgraph Orch["Orchestrator (main agent)"]
    wo["loop coordinator-work-order"]
    mrg["scripts/github/merge-pr.mjs"]
  end
  idea --> enq --> grill --> st
  st --> prc --> gate --> rfr --> cop --> pre --> mrg
  gc -.->|nextAction| gate
  gc -.->|nextAction| pre
  gate -.->|hand-back| wo
  wo -.->|fresh coordinator| st
  approve -.-> mrg
```

<a id="d47"></a>

### Issue intake with the new-idea safety layer

Type: `sequenceDiagram`

How a new idea becomes a tracked issue before any GitHub write. The insight is that classification and proposal run in fresh context, and every mutation waits for operator approval and runs in a second async pass. The quick-capture path through `loop-enqueue` replaces the proposal artifact with an inline confirm, create, and grill step. This flow is contract prose with no single code driver, so the ordering is spec-only; the `issue create` route it ends in is code. Derived from `INTAKE-NEW-IDEA-SAFETY` and `INTAKE-STOP-STATES` in `skills/docs/issue-intake-procedure.md` and the `issue create` route in `cli/index.mjs`.

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant MA as Main agent
  participant Cls as Intake classifier
  participant Mut as Mutation pass
  participant GH as GitHub
  Op->>MA: plain-language idea
  MA->>Cls: dispatch in fresh context
  Cls->>Cls: fan-out proposals, fan-in, artifact scan
  Cls->>MA: proposal.md and proposal.json under tmp/new-idea-intake
  alt overlap or low confidence
    MA->>Op: stop and ask
  else proposal ready
    MA->>Op: awaiting_user_approval
    alt operator approves
      Op->>MA: approve
      MA->>Mut: second async pass with the approved proposal
      Mut->>GH: issue create (self-assigned, create-new only)
      Mut->>MA: post-mutation verification artifact
    else operator rejects
      Op->>MA: reject
      MA->>MA: record stopped_explicit_reject, no GitHub write
    end
  end
```

<a id="d48"></a>

### Intake state machine

Type: `stateDiagram-v2`

The deterministic intake and mutation-gate states with the three stop states. The insight is that `awaiting_user_approval` sits between the proposal and any write, so no path reaches `mutation_executed` without the operator. Derived from the state listing in `skills/docs/issue-intake-procedure.md` (contract prose; no code module implements this list, so it is spec-only). The contract lists the main chain and the three stop states but not where each stop state branches off; the edges into the stop states are inferred from `INTAKE-STOP-STATES`.

```mermaid
stateDiagram-v2
  [*] --> idea_received
  idea_received --> fresh_context_started
  fresh_context_started --> fanout_started
  fanout_started --> fanin_complete
  fanin_complete --> artifact_scan_complete
  artifact_scan_complete --> classified
  classified --> proposal_emitted
  classified --> stopped_overlap_needs_decision
  classified --> stopped_low_confidence
  proposal_emitted --> awaiting_user_approval
  awaiting_user_approval --> ready_for_mutation
  awaiting_user_approval --> stopped_explicit_reject
  ready_for_mutation --> mutation_executed
  mutation_executed --> mutation_verified
  mutation_verified --> done
  done --> [*]
  stopped_overlap_needs_decision --> [*]
  stopped_low_confidence --> [*]
  stopped_explicit_reject --> [*]
```

<a id="d49"></a>

### Grill sub-loop transitions

Type: `stateDiagram-v2`

The closed grill loop that turns an issue body into a refined spec. The insight is that iteration lives in the transition table: `re_grill` either finds a new gap and re-enters `detect_gaps` or reaches the `grill_clean` fixed point, and an uncitable gap ends honestly at `needs_human_handoff`. Any I/O or parse failure fails closed to `blocked_needs_user_decision`. Derived from `GRILL_STATE` and `GRILL_TRANSITIONS` in `packages/core/src/loop/refinement-grill-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> load_target
  load_target --> detect_gaps
  load_target --> blocked_needs_user_decision
  detect_gaps --> await_answers
  detect_gaps --> grill_clean: zero gaps with provenance
  detect_gaps --> needs_human_handoff
  detect_gaps --> blocked_needs_user_decision
  await_answers --> synthesize
  await_answers --> needs_human_handoff
  await_answers --> blocked_needs_user_decision
  synthesize --> re_grill
  synthesize --> blocked_needs_user_decision
  re_grill --> detect_gaps: new answerable gap
  re_grill --> grill_clean: fixed point
  re_grill --> needs_human_handoff
  re_grill --> blocked_needs_user_decision
  grill_clean --> [*]
  needs_human_handoff --> [*]
  blocked_needs_user_decision --> [*]
```

<a id="d50"></a>

### One grill run

Type: `sequenceDiagram`

The calls one `loop-grill` run makes against an issue. The insight is that the synthesized sections go into the body and the results comment, while the raw Q\&A stays in an ephemeral tmp file and never reaches GitHub. The spec-lint runs before the zero-iteration exit, because a size-forecast or contract-matrix finding cancels that exit. Derived from Steps 1 to 4 of `skills/loop-grill/SKILL.md`, `scripts/loop/detect-refinement-grill-state.mjs`, and the `loop spec-lint` route in `cli/index.mjs`.

```mermaid
sequenceDiagram
  autonumber
  participant G as Grill agent
  participant GH as GitHub issue
  participant Det as detect-refinement-grill-state
  participant Lint as loop spec-lint
  participant Tmp as tmp/issues grill file
  G->>GH: fetch body
  G->>Det: --body-file, --repo, --number
  Det->>GH: read comments and body lastEditedAt
  Det-->>G: state and reason
  G->>Lint: --body-file
  Lint-->>G: rule, ADR and size-forecast findings
  alt grill_clean and no blocking lint finding
    G-->>G: emit grill-clean, no write
  else gaps, provenance missing or blocking finding
    loop until fixed point
      G->>G: answer gaps (cited in --auto, asked in interactive)
      G->>G: synthesize AC, DoD matrix, Non-goals, Simplest design
    end
    G->>G: fresh simplicity review on an issue (kiss, yagni)
    G->>Tmp: raw Q&A transcript
    G->>GH: rewrite body
    G->>GH: post Grill / refinement results comment
  end
```

<a id="d51"></a>

### Loop startup and first work order

Type: `sequenceDiagram`

How a trigger becomes a running coordinator. The insight is that the main agent never runs `loop startup`: the coordinator resolves the route, and the orchestrator builds every later dispatch from the startup-output path a coordinator names, through the digest-pinned work order. Derived from the "Dev-loop startup" and "Unit coordinator boundaries" sections of `skills/docs/main-agent-contract.md`, `scripts/loop/resolve-dev-loop-startup.mjs`, `deriveUnitBoundaries` in `packages/core/src/loop/handoff-envelope.mjs`, and `materializeCoordinatorWorkOrder` and `runCli` in `scripts/loop/emit-coordinator-work-order.mjs`.

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator
  participant MA as Main agent
  participant C as dev-loop coordinator
  participant SU as loop startup
  participant EW as coordinator-work-order
  participant Tmp as tmp/coordinator-work-orders
  Op->>MA: start dev loop on an issue
  MA->>C: dispatch dev-loop subagent
  C->>SU: --issue n (optional --claim)
  SU-->>C: selectedStrategy, requiredReads, envelope, unitBoundaries
  C->>C: load requiredReads only, run the route
  Note over C: later, at a run-ending case
  C-->>MA: hand-back naming the startup-output path
  MA->>EW: --input path --harness claude --entry queue
  EW->>EW: build envelope, digest the work order
  EW->>Tmp: order.md and plan.json (atomic write)
  EW-->>MA: workOrderRef, executionIdentity, dispatchPayload
  MA->>C: dispatch the payload unchanged (fresh coordinator)
  C->>Tmp: pull order by ref and digest
```

<a id="d52"></a>

### Route selection order

Type: `flowchart`

The order in which `selectGateForState` picks a gate and the router maps it to an internal strategy. The insight is that blocked, done, merge-authorization and final-approval checks run before any work route, an explicit review request outranks PR ownership, and an issue with a linked PR is re-targeted to that PR first. An issue without a linked PR routes to `issue_intake` unless the target prefers local work. A state that matches no branch fails closed to reconcile. Derived from `selectGateForState`, `toRoutableCanonicalState` and the `selectedGate` branches in `packages/core/src/loop/public-dev-loop-routing.mjs`.

```mermaid
flowchart TD
  S["canonical state"] --> RT["issue with linked PR becomes PR target"]
  RT --> B{"blocked or not authorized?"}
  B -->|yes| N1["none: stop"]
  B -->|no| D{"done?"}
  D -->|yes| N2["none: done"]
  D -->|no| WM{"merge_ready and needs confirmation?"}
  WM -->|yes| N3["none: wait for merge auth"]
  WM -->|no| FA{"approval_ready or merge_ready?"}
  FA -->|yes| FAS["final_approval"]
  FA -->|no| WW{"waiting?"}
  WW -->|yes| WWS["wait_watch"]
  WW -->|no| LI{"local branch or phase?"}
  LI -->|yes| LIS["local_implementation"]
  LI -->|no| II{"issue target?"}
  II -->|prefer_local| LIS
  II -->|yes| IIS["issue_intake"]
  II -->|no| RQ{"review or UI review requested?"}
  RQ -->|yes| RV["review or ui_review"]
  RQ -->|no| PR{"PR owner"}
  PR -->|external human| EXT["external_pr_followup"]
  PR -->|reviewer| RF["reviewer_fixer"]
  PR -->|Copilot| CP["copilot_pr_followup"]
  PR -->|none match| FC["none: fail_closed_reconcile"]
```

<a id="d53"></a>

### Coordinator round-boundary hand-back

Type: `sequenceDiagram`

The fixed order at a stop: a gate-round end or a fix-pass end whose `nextAction` is not routine, or the routine-boundary cap. A routine `nextAction` continues in the same run. The insight is that the coordinator joins every worker, validates the typed packet, and releases its runner claim before the one `SubagentHandback`, and the replacement re-derives all gate state from detectors instead of from the predecessor's text. Derived from `COORDINATOR-ROUND-BOUNDARY-HANDBACK` and `COORDINATOR-HANDBACK-ONE-REPORT` in `skills/docs/main-agent-contract.md`, the `loop validate-handback` route in `cli/index.mjs`, `scripts/loop/validate-coordinator-handback.mjs`, `scripts/loop/_coordinator-handback.mjs`, and `scripts/loop/emit-coordinator-work-order.mjs`.

```mermaid
sequenceDiagram
  autonumber
  participant C1 as Coordinator (run N)
  participant W as Reviewer or fixer workers
  participant V as validate-handback
  participant MA as Orchestrator
  participant EW as coordinator-work-order
  participant C2 as Coordinator (run N+1)
  participant GC as loop gate-coordination
  C1->>GC: read nextAction after the verdict
  Note over C1,GC: routine nextAction below the cap: run it in this run, no hand-back
  C1->>W: join every dispatched worker
  W-->>C1: done
  C1->>V: --packet with pr, head, nextAction, workerRunning
  alt refused (missing_fields, worker_running, verdict_refusal_route or routine_boundary)
    V-->>C1: exit 1
    C1->>C1: fix cause and re-run the check
  else valid
    V-->>C1: exit 0
    C1->>C1: release runner claim
    C1-->>MA: SubagentHandback (status gate_round_end or fix_pass_end)
  end
  MA->>EW: --input startup-output path
  EW-->>MA: dispatchPayload
  MA->>C2: dispatch unchanged
  C2->>C2: loop startup --pr n
  C2->>GC: re-derive round count, verdict, open findings
```

<a id="d54"></a>

### Hand-back packet validation

Type: `flowchart`

The decision `validateCoordinatorHandback` makes on one packet. The insight is that a packet with a running worker is refused even when every field is valid, so a coordinator cannot hand back mid-round. A packet with a `verdictRefusal` is refused unless it carries `reason: "ci_red"`, a non-empty `actListPath` and `nextAction` `fix_ci_failure`. A packet with a round-boundary or missing `status`, a routine `nextAction` and `routineBoundaries` below the cap is refused as `routine_boundary`. Derived from `FIELD_CHECKS` and `validateCoordinatorHandback` in `scripts/loop/_coordinator-handback.mjs` and the exit-code rule in `scripts/loop/validate-coordinator-handback.mjs`.

```mermaid
flowchart TD
  P["hand-back packet"] --> F{"pr positive integer, head is a 40 or 64 hex SHA, nextAction non-empty, workerRunning boolean?"}
  F -->|any field fails| R1["refusal: missing_fields (lists the fields)"]
  F -->|all pass| W{"workerRunning true?"}
  W -->|yes| R2["refusal: worker_running"]
  W -->|no| VR{"verdictRefusal present?"}
  VR -->|no| RB{"status gate_round_end, fix_pass_end or missing, routine nextAction, routineBoundaries below the cap?"}
  RB -->|yes| R4["refusal: routine_boundary (with recovery)"]
  RB -->|no| OK["ok: true, exit 0"]
  VR -->|"ci_red, actListPath and fix_ci_failure"| OK
  VR -->|any other form| R3["refusal: verdict_refusal_route (with recovery)"]
  R1 --> X["exit 1, fix and re-run"]
  R2 --> X
  R3 --> X
  R4 --> X
```

<a id="d55"></a>

### Coordinator runs across one PR

Type: `timeline`

The chain of fresh coordinators that one issue passes through on one path. The insight is that before ADR 0325 each run ended at the first gate-round end or fix-pass end (a run now continues at routine boundaries up to the cap), and the `draft_pr_opened` report point never ends a run. In this path one draft\_gate round has findings and Copilot raises none, so the PR passed through five coordinator runs on the pre-ADR-0325 path. This is an illustrative sequence of run-ending cases, not measured data. Derived from `UNIT_BOUNDARY` and `deriveUnitBoundaries` in `packages/core/src/loop/handoff-envelope.mjs` and the run-ending case list in `skills/docs/main-agent-contract.md`.

```mermaid
timeline
  title Coordinator runs for one issue (illustrative, pre-ADR-0325 path)
  Run 1 : loop startup --issue : implement and open draft PR : report point draft_pr_opened, continue : draft_gate verdict : hand-back gate_round_end
  Run 2 : loop startup --pr : fix pass on the act list : push and CI wait : hand-back fix_pass_end
  Run 3 : draft_gate re-round : clean verdict : hand-back gate_round_end
  Run 4 : mark ready, request Copilot : Copilot review converges : pre_approval verdict : hand-back gate_round_end
  Run 5 : nextAction await_final_human_approval : hand-back final_approval_ready
```

<a id="d56"></a>

### Draft gate to merge

Type: `sequenceDiagram`

The PR path after the draft PR exists. The insight is that `pr ready-for-review` refuses without clean draft\_gate evidence and a passing size budget, Copilot only reviews a ready PR, and `merge-pr.mjs` refuses without a named human approver. `gate request-copilot` returns `suppressed_draft` on a draft PR. Only a lightweight PR is auto-added to the board at creation; a tracker-backed PR never calls the board there. Derived from `PR_CHECKPOINT_ACTION` in `packages/core/src/loop/pr-gate-coordination.mjs`, `scripts/github/create-pr.mjs`, `scripts/github/ready-for-review.mjs`, `scripts/github/request-copilot-review.mjs`, the `gate` routes in `cli/index.mjs`, and `scripts/github/merge-pr.mjs`.

```mermaid
sequenceDiagram
  autonumber
  participant C as Coordinator
  participant R as Reviewers and judge
  participant GH as GitHub PR
  participant CP as Copilot
  participant MA as Orchestrator
  actor Op as Operator
  C->>GH: pr create (always draft)
  C->>R: draft_gate fan-out
  R-->>C: consolidate-fanin, judge-pass
  C->>GH: upsert-verdict (draft_gate)
  C->>GH: pr ready-for-review (gate evidence, size budget, ADR tripwire)
  C->>GH: gate request-copilot
  C->>CP: probe-copilot until review lands
  CP-->>GH: review threads
  C->>GH: capture-threads, fix, reply-resolve
  C->>R: pre_approval fan-out
  R-->>C: verdict
  C->>GH: upsert-verdict (pre_approval)
  C-->>MA: hand-back at final_approval_ready
  alt escalated merge class
    Op->>GH: approve merge line pinned to head SHA (hook-posted from the approval question under Claude Code)
  end
  MA->>GH: merge-pr.mjs --human-approved-by login
```

<a id="d57"></a>

### Gate-coordination next action priority

Type: `flowchart`

A simplified view of the order in which `evaluatePrGateCoordination` picks the next action for an open PR. The insight is that CI, merge conflicts and open review threads all outrank a new gate round, and `CONFLICT_FORBIDDEN_ACTIONS` blocks every gate and Copilot action while the head conflicts with the base. The view omits the blocked, UI e2e and designer-review branches. Derived from the return order in `evaluatePrGateCoordinationCore` and `CONFLICT_FORBIDDEN_ACTIONS` in `packages/core/src/loop/pr-gate-coordination.mjs`.

```mermaid
flowchart TD
  A["PR state"] --> M{"merged or closed?"}
  M -->|yes| DONE["report_done"]
  M -->|no| CI{"CI pending?"}
  CI -->|yes| WCI["wait_for_ci"]
  CI -->|no| CF{"conflict or stale base?"}
  CF -->|yes| RMC["resolve_merge_conflicts"]
  CF -->|no| DR{"draft?"}
  DR -->|no clean draft_gate| RDG["run_draft_gate"]
  DR -->|clean draft_gate| MRR["mark_ready_for_review"]
  DR -->|ready| CR{"Copilot reviewed head?"}
  CR -->|Copilot disabled, internal-only or unavailable| PA
  CR -->|not requested| RQC["request_copilot_review"]
  CR -->|threads open| ARF["address_review_feedback"]
  CR -->|threads fixed| RRT["reply_resolve_review_threads"]
  CR -->|converged| PA{"pre_approval clean?"}
  PA -->|no| RPG["run_pre_approval_gate"]
  PA -->|yes| AFA["await_final_human_approval"]
```

<a id="d58"></a>

### Merge class and approval

Type: `flowchart`

How `merge-pr.mjs` decides which approval satisfies a merge. The insight is that a standing authorization covers only a drain merge, while a stable release, an escalated or blocked size outcome, or a T1 path forces a fresh human approval on the current head. A fresh approval is a head-pinned APPROVED review by the named login, else a head-pinned "approve merge" comment by that login, else an "approve merge" comment by that login whose patch-id matches the current diff; a bot login never satisfies it. Under Claude Code the hook posts that line from the operator's yes answer to the approval question. Derived from `MERGE_CLASS`, `resolveMergeClass` and `verifyFreshHumanApproval` in `packages/core/src/loop/merge-approval.mjs`, `GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE` in `skills/docs/gate-review-sub-loop-contract.md`, and the usage text and argument parser in `scripts/github/merge-pr.mjs`.

```mermaid
flowchart TD
  IN["merge-pr.mjs --human-approved-by login"] --> V{"login valid?"}
  V -->|no| REF["parse error, no merge"]
  V -->|yes| SR{"stable release?"}
  SR -->|yes| ESC["escalated"]
  SR -->|no| SZ{"size outcome escalate or block?"}
  SZ -->|yes| ESC
  SZ -->|no| T1{"touches T1 path?"}
  T1 -->|yes| ESC
  T1 -->|no| DRN["drain"]
  DRN --> AD{"--standing-authorization (humanMergeOnly false) or fresh approval?"}
  ESC --> AE{"fresh APPROVED review, approve merge line on head SHA, or patch-id line matching the diff?"}
  AD -->|yes| PRE["preconditions: CI, gate evidence, Copilot convergence, ADR tripwire, secret scan, base integrated"]
  AE -->|yes| PRE
  AD -->|no| STOP["refuse"]
  AE -->|no| STOP
  PRE --> MERGE["merge"]
```

<a id="d59"></a>

### Operator journey from idea to merge

Type: `journey`

What the operator does and feels along the main path. The insight is that the operator acts at three points only: approving the intake proposal, answering escalations or decision stops, and approving an escalated merge (the approval question under Claude Code, the approve merge line under Pi). Scores are synthetic, chosen by the analyst to show effort, and no command produced them. Derived from `skills/docs/issue-intake-procedure.md`, `skills/loop-grill/SKILL.md`, the operator-question and escalation rules in `skills/docs/main-agent-contract.md`, and `OPERATOR-OWNED-LINE` in `skills/docs/decision-record-contract.md`.

```mermaid
journey
  title Operator path from idea to merge (synthetic scores)
  section Intake
    Describe the idea: 4: Operator
    Review the proposal: 3: Operator, Main agent
    Approve the mutation: 4: Operator
  section Grill
    Answer open grill questions: 2: Operator, Grill agent
    Read the results comment: 4: Operator
  section Loop
    Start the dev loop: 5: Operator, Main agent
    Watch draft PR and gate verdicts: 4: Operator, Coordinator
    Answer an escalation or decision stop: 2: Operator, Main agent
  section Merge
    Approve the merge on head SHA: 3: Operator
    Merge and read the retro: 4: Main agent, Operator
```

