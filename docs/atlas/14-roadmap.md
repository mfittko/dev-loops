---
title: Ideas and roadmap (not decided)
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="14-roadmap"></a>

## Ideas and roadmap (not decided)

This section maps what the open backlog proposes. Every item here is not decided. Milestones are planning labels that the operator moves, and an open issue can change scope, move or close without shipping. The v2 epic states that it "defines requirements to qualify, not delivered capabilities", and a search of the repository code finds no v2 runtime (no Octokit and no SQLite store), so every v2 diagram is marked spec-only. The only code hits for "sqlite" are the `--experimental-sqlite` Node flag in `packages/core/src/loop/bash-command-classify.mjs` and its hook and test fixture copies. All issue counts come from one snapshot on 2026-11-23 of `gh issue list --state open --limit 500 --json number,title,milestone`, run in the repository checkout, which returned 237 open issues.
<a id="d182"></a>

### Open issues per milestone

Type: `xychart-beta`

Bar chart of the 237 open issues grouped by milestone label. The insight: the minor milestone v1.1.0 holds 102 issues and the patch milestone v1.0.13 holds 57, together two thirds of the backlog, while v1.0.12 holds only 3 and v2.0.0 holds only 5 planning issues. All counts are from `gh issue list --state open --limit 500 --json number,title,milestone`, grouped by `milestone.title`. Every milestone assignment is not decided. Source: that command output; milestone order follows the version numbers.

```mermaid
xychart-beta
    title "Open issues per milestone (not decided)"
    x-axis ["v1.0.12", "v1.0.13", "v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0", "v1.5.0", "v2.0.0", "Later", "none"]
    y-axis "Open issues" 0 --> 110
    bar [3, 57, 102, 14, 15, 15, 5, 5, 15, 6]
```

<a id="d183"></a>

### Open issues by title type

Type: `pie`

Share of the 237 open issues by the conventional prefix in the title (`fix`, `feat`, `gate` and so on). The insight: fixes (81) are the largest prefix group and outnumber features (30) by more than two to one. The numbers come from `gh issue list --state open --limit 500 --json number,title,milestone` followed by a title-prefix tally (`grep -oE '^[a-zA-Z-]+[(:]'`); "planning" groups epic, rfc, research and design; "other prefix" groups efficiency, refactor, chore, test, fixer, perf, size, recovery, pre-pr, measure, loop, developer and contracts. Not decided.

```mermaid
pie showData
    title Open issues by title prefix
    "fix" : 81
    "feat" : 30
    "gate" : 11
    "docs and audit" : 10
    "planning" : 7
    "other prefix" : 48
    "no prefix" : 50
```

<a id="d184"></a>

### Backlog themes by scope tag

Type: `mindmap`

Mind map of the scope tags in open issue titles, such as `fix(gate)` or `feat(loop)`. The insight: the review gate dominates the backlog (41 titles tagged `gate`, plus 4 tagged `cost` that all target gate token cost), and hooks and loop form the next cluster. Counts come from `gh issue list --state open --limit 500 --json number,title,milestone` and a tally of the parenthesized scope tag in each title. The map shows a selection: untagged titles and other tags (for example `check` 8, `github` 4 and about 20 single-use tags) are left out. Not decided.

```mermaid
mindmap
  root((Open backlog))
    Gate
      "gate 41"
      "cost 4"
      "judge 1"
      "review 2"
      "validation 4"
    Loop runtime
      "loop 12"
      "dispatch 7"
      "coordinator 1"
      "startup 2"
      "work-orders 1"
    Guards
      "hooks 15"
      "guard 1"
      "commit-msg-guard 1"
    PR follow-up
      "copilot 3"
      "fixer 8"
      "merge 5"
    Onboarding
      "bootstrap 3"
      "grill 2"
      "intake 1"
    Harness
      "pi 2"
      "ci 1"
      "ui 1"
```

<a id="d185"></a>

### Horizon versus scope of selected open items

Type: `quadrantChart`

Quadrant chart of twelve selected open issues and epics. The x value is derived from the milestone label (v1.0.12 = 0.1 up to v2.0.0 = 0.95, Later = 0.85). The y value is the analyst's estimate of scope breadth (a single fix is low, an epic or runtime rewrite is high); it is not a measured value. The insight: the broad items (v2 epic 2995, review-expectations epic 2840, bootstrap 2723) all sit on the far horizon, and the near half holds narrow fixes plus two broad items, merge without operator lines 2937 (v1.0.13) and soft round caps 3105 (v1.1.0). Positions are not decided. Source: `gh issue list --state open --limit 500 --json number,title,milestone`.

```mermaid
quadrantChart
    title Horizon vs scope (not decided)
    x-axis Near milestone --> Far milestone
    y-axis Narrow fix --> Broad change
    quadrant-1 Far and broad
    quadrant-2 Near and broad
    quadrant-3 Near and narrow
    quadrant-4 Far and narrow
    Soft round caps 3105: [0.32, 0.62]
    Merge without operator lines 2937: [0.22, 0.55]
    Startup follow-up refusal 3493: [0.08, 0.15]
    Usability study 3131: [0.3, 0.5]
    Gate runbook 3096: [0.2, 0.35]
    Loop board pane 2890: [0.45, 0.3]
    Gate token epic 2268: [0.55, 0.7]
    Work-order brief 2482: [0.65, 0.45]
    Judge owns verdicts 2903: [0.75, 0.6]
    Bootstrap 2723: [0.85, 0.65]
    Review catalog epic 2840: [0.87, 0.8]
    v2 epic 2995: [0.95, 0.95]
```

<a id="d186"></a>

### Milestone horizon with representative items

Type: `timeline`

Timeline of the milestone labels in version order, with two or three representative open titles per milestone. The insight: v1.0.12 through v1.5.0 continue the v1 patch and minor lane (gate cost, judge authority, hook hardening), and v2.0.0 is a separate planning track. Milestone membership comes from `gh issue list --state open --limit 500 --json number,title,milestone`. Dates are not assigned to any milestone in the issue data, so the axis shows order only. Not decided.

```mermaid
timeline
    title Milestone order (not decided)
    v1.0.12 : Verdict poster summary 3347 : Startup follow-up refusal 3493 : Release 3154
    v1.0.13 : Audit cleanup bundles 3468 3474 : Simplicity audit 3213
    v1.1.0 : Usability study 3131 : Soft round caps 3105 : Next-step driver 3097
    v1.2.0 : Loop board pane 2890 : Coordinator-only roles 3143
    v1.3.0 : Gate token epic 2268 : Judge picks gate track 2070
    v1.4.0 : Pulled developer brief 2482 : Hook deny gaps 2968
    v1.5.0 : Judge owns verdicts 2903 : APPROVE submit 2712
    v2.0.0 : v2 epic 2995 : Runtime RFC 2996 : v1 inventory 2993
```

<a id="d187"></a>

### Open work as a board

Type: `kanban`

Board view of a sample of open issues, one column per milestone group. The insight: only the first column is the active release lane; the other columns are parked proposals that the operator can reorder at any time. Membership comes from `gh issue list --state open --limit 500 --json number,title,milestone`. The analyst chose the cards as a sample; their order carries no priority. Not decided.

```mermaid
kanban
  near[v1.0.12 and v1.0.13]
    k2937[Merge without operator lines 2937]
    k3170[Merge through admin bypass 3170]
    k3213[Simplicity-first audit 3213]
  minor[v1.1.0 to v1.2.0]
    k3105[Soft round caps 3105]
    k3200[Human-style review submit 3200]
    k2890[Loop board pane 2890]
  later[v1.3.0 to v1.5.0]
    k2268[Gate token epic 2268]
    k2483[Tooling-emitted coordinator brief 2483]
    k2084[Scaffold PR-body spec 2084]
  far[Later and v2.0.0]
    k2840[Review catalog epic 2840]
    k3085[Loop state outside checkout 3085]
    k2995[v2 runtime epic 2995]
```

<a id="d189"></a>

### v2 required scope areas (spec-only)

Type: `mindmap`

Mind map of the required v2.0.0 scope table in the v2 epic (issue 2995). The insight: v2 moves lifecycle coordination from agent prose into an application with a SQLite store and an Octokit adapter, keeps Claude Code as the primary frontend, and limits deployment to one host per runtime. None of this exists in code: a search of `*.mjs`, `*.js`, `*.ts` and `*.json` files finds no Octokit import and no SQLite store; the only "sqlite" hit is the `--experimental-sqlite` Node flag listed in `packages/core/src/loop/bash-command-classify.mjs`. Spec-only and not decided. Source: v2 epic issue 2995 body (`gh issue view 2995 --json body`).

```mermaid
mindmap
  root((v2 runtime spec-only))
    Execution hosts
      macOS first
      Linux and Linux CI
      Native OS sandbox
    Frontend and backends
      Claude Code primary
      Codex review pairing
      Pi only if qualified
    Runtime
      Restartable foreground app
      SQLite operational store
      Typed start status decision cancel resume
    Lifecycle
      Implement review fix validate
      Merge as separate continuation
      Sub-loops propose work units
    Portability
      No language assumption
      not_configured warns
      Projects board optional
    Limits
      One host per runtime
      No hosted service
```

<a id="d190"></a>

### v2 delivery phases (spec-only)

Type: `flowchart`

Dependency graph of the v2 delivery phases P0 to P5 from the v2 epic. The insight: P0 (architecture baseline) fans out into three parallel tracks, P0-B (trusted v1 delivery proof) must land before substantive slice merges, and the first useful pilot (P3) waits on the executable lifecycle, the runtime probes and shared-target exclusion. The epic states that phases are planning scopes, not existing implementation children. Spec-only and not decided. Source: v2 epic issue 2995, section "Delivery phases".

```mermaid
flowchart LR
    P0["P0 architecture baseline"] --> PB["P0-B trusted v1 delivery"]
    P0 --> P1["P1 executable lifecycle"]
    P0 --> P2["P2 macOS and Linux probes"]
    P0 --> PX["P2-X shared-target exclusion"]
    PB -.->|before slice merges| P1
    PB -.->|before slice merges| P2
    P1 --> P3["P3 useful pilot"]
    P2 --> P3
    PX --> P3
    P3 --> P4["P4 qualification"]
    P4 --> P5["P5 release and adoption"]
```

<a id="d191"></a>

### v2 proposed branch line (spec-only)

Type: `gitGraph`

Git graph of the proposed delivery line in the v2 epic: maintained v1 stays on protected `main`, tested v2 slices land on a protected `integration/v2` branch created from a recorded approved commit after stable v1.0.9, and a protected `maintenance/v1` release path is qualified before v2 replaces v1 on `main`, when adoption still needs it. The insight: v1 patches keep shipping while v2 integrates, and v1 changes reach v2 through reviewed sync PRs. No `integration/v2` branch is created by this plan. Spec-only and not decided; commit labels are synthetic. Source: v2 epic issue 2995, section "Trusted delivery, coexistence and release".

```mermaid
gitGraph
    commit id: "v1.0.9 stable"
    branch integration/v2
    checkout integration/v2
    commit id: "P0 ADR"
    checkout main
    commit id: "v1 patch"
    checkout integration/v2
    commit id: "P1 slice"
    merge main id: "v1 sync"
    commit id: "P3 pilot"
    checkout main
    branch maintenance/v1
    commit id: "v1 fix"
    checkout main
    merge integration/v2 id: "v2 cutover"
```

<a id="d192"></a>

### v2 controller-loss recovery (spec-only)

Type: `sequenceDiagram`

Sequence of the controller-loss scenario that the v2 epic requires the backend contract to survive. The controller persists the operation identity before launch; if it dies after a successful launch but before it records the execution reference, a restarted controller must find the existing execution or establish non-start, and must never start a second mutator. The epic leaves the lookup mechanism open (backend-native lookup or durable supervisor registration), so the "Backend" participant stands for either. The insight: recovery keys on the persisted operation identity, not on the returned reference, and an unresolved launch stays ambiguous and blocks replacement. Spec-only and not decided; v1 has no such runtime. Source: v2 epic issue 2995, section "Work orders, recovery and supervision".

```mermaid
sequenceDiagram
    participant C as Controller
    participant DB as SQLite store
    participant S as Backend
    participant W as Worker
    C->>DB: persist operation id and intent
    C->>S: start(operation id)
    S->>W: launch sandboxed worker
    Note over C: controller dies before saving executionRef
    C->>DB: restart and read open operations
    C->>S: lookup(operation id)
    alt execution found
        S-->>C: existing execution
        C->>S: observe and collect once
    else non-start established
        S-->>C: never started
        C->>S: start(operation id)
    else unresolved
        S-->>C: ambiguous
        C->>C: block replacement, no guess
    end
```
