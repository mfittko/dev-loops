---
title: Development process
status: snapshot
snapshot_date: 2026-11-19
---
<a id="11-dev-process"></a>

## Development process

dev-loops runs its own development through the same machinery it ships. A GitHub Projects board orders the work, and the driver picks only from the `Next Up` column. Every unit of work starts from exactly one authoritative artifact: a GitHub issue, a markdown plan file, or the PR body on the lightweight path. A refinement grill must bring an issue to a clean spec before it can enter `Next Up`. When `workflow.requireRetrospective` is true (this repo's `.devloops` sets it), each merge carries a retrospective obligation that `merge-pr` enforces on the next merge. Stable releases trigger a combined retro and a fixed sequence of audit issues. The diagrams below come from the queue, startup, grill and retrospective modules and their contracts. Card names and counts in example data are synthetic unless a caption names the command that produced them.

<a id="d143"></a>

### Queue board columns

Type: `kanban`

The four canonical Status columns from `QUEUE-COLUMN-CANONICAL`, filled with synthetic cards. The driver never picks from Backlog. Promotion to Next Up is the deliberate prioritization step, and a blocked or failed item returns to Backlog. Derived from `skills/docs/projects-queue-contract.md`, `packages/core/src/loop/queue-board-sync.mjs` and `packages/core/src/loop/queue-driver.mjs`.

```mermaid
kanban
  backlog[Backlog]
    b1[Unrefined idea A]
    b2[Parked: missing matrix]
    b3[Blocked item back from run]
  nextup[Next Up]
    n1[Refined issue X, position 1]
    n2[Refined issue Y, position 2]
  inprogress[In Progress]
    p1[Draft PR in draft_gate]
    p2[PR waiting for Copilot review]
    p3[PR at final approval]
  done[Done]
    d1[Merged PR Z]
    d2[Closed issue W]
```

<a id="d144"></a>

### Loop state to board column

Type: `flowchart`

The stateless mapping in `boardColumnForLoopState`. Every loop state resolves to a logical column and then to a display name. `ready_for_review` falls back to In Progress unless the operator configures that opt-in column. An unmapped state lands in In Progress as the safe default. Derived from `packages/core/src/loop/queue-board-sync.mjs` and `skills/docs/projects-queue-contract.md`.

```mermaid
flowchart LR
  subgraph pre["Pre-PR states"]
    s1["issue_opened / issue_intake"]
    s2["refinement / no_pr"]
  end
  subgraph flight["In-flight states"]
    s3["pr_draft / implementation"]
    s4["waiting_for_copilot_review / waiting_for_ci"]
    s5["blocked_needs_user_decision"]
    s6["unmapped state"]
  end
  subgraph final["Approval states"]
    s7["pre_approval_gate / final_approval_ready"]
  end
  subgraph end_["Terminal states"]
    s8["merge / merged / issue_closed / done"]
  end
  s1 --> NU["next_up: Next Up"]
  s2 --> NU
  s3 --> IP["in_progress: In Progress"]
  s4 --> IP
  s5 --> IP
  s6 --> IP
  s7 --> RFR["ready_for_review"]
  RFR -->|"default"| IP
  RFR -->|"opt-in statusColumns"| RR["Ready for Review"]
  s8 --> DN["done: Done"]
```

<a id="d145"></a>

### Queue pickup from Next Up

Type: `flowchart`

The two pickup paths. The queue driver (`queue run`) checks the Next Up order against the local queue file. Bare `/loop-continue` checks In Progress first, then walks Next Up with an ownership gate that skips items assigned to another human and claims unassigned ones. Both read Next Up by position ascending, and neither falls back to Backlog or local queue order. The reason strings come from the `REASON_*` constants. Derived from `packages/core/src/loop/queue-driver.mjs`, `packages/core/src/loop/queue-board-ordering.mjs`, `scripts/projects/resolve-active-board-item.mjs` and `skills/docs/projects-queue-contract.md`.

```mermaid
flowchart TD
  subgraph drv["queue run (queue driver)"]
    A["resolveNextUpOrder"] --> B{"Board query ok?"}
    B -->|"no"| X1["stop: board-query-error"]
    B -->|"yes"| E{"Next Up empty?"}
    E -->|"yes"| X3["idle: next-up-empty"]
    E -->|"no"| F{"Every target has a local entry?"}
    F -->|"no"| X4["stop: next-up-target-missing-locally"]
    F -->|"yes"| G["dispatch Next Up entries by position"]
  end
  subgraph lc["/loop-continue"]
    C{"In Progress count"}
    C -->|"1"| R1["continue that item"]
    C -->|"more than 1"| X2["fail closed: pass explicit #N"]
    C -->|"0"| N{"Next Up empty?"}
    N -->|"yes"| X5["fail: empty-queue reason"]
    N -->|"no"| O{"Next item owner"}
    O -->|"other human"| SK["skip, try next item"]
    SK --> O
    O -->|"unassigned"| CL["claim, re-read, tiebreak"]
    O -->|"viewer or Copilot"| PK["pick item"]
    CL --> PK
    O -->|"all foreign"| X6["fail closed: all owned by others"]
  end
```

<a id="d146"></a>

### Local queue entry lifecycle

Type: `stateDiagram-v2`

The `VALID_TRANSITIONS` table for entries in `.pi/dev-loop-queue.json`. `done` is terminal. `failed` can only return to `queued`, and only the `RECOVERABLE_FAILURES` (`timeout`, `round_cap_reached`, `acceptance_report_parse_failure`) are retried, up to `reDispatchMaxRetries`; any other failure goes to `blocked`. Board sync moves the card to In Progress on `running`, to Done on `done`, and to `queue.nonSuccessStatus` (default Backlog) on a throw. Derived from `packages/core/src/loop/queue-state.mjs` and `packages/core/src/loop/queue-driver.mjs`.

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  queued --> blocked
  running --> waiting_review
  running --> blocked
  running --> failed
  running --> done
  waiting_review --> running
  waiting_review --> gates_passing
  waiting_review --> blocked
  waiting_review --> failed
  waiting_review --> done
  gates_passing --> merging
  gates_passing --> blocked
  gates_passing --> failed
  gates_passing --> done
  merging --> done
  merging --> failed
  merging --> blocked
  blocked --> queued
  blocked --> running
  blocked --> failed
  failed --> queued
  done --> [*]
```

<a id="d147"></a>

### Artifact authority mode selection

Type: `flowchart`

How startup selects the authoritative artifact. `strategy` in `.devloops` sets only the routing preference. The explicit startup flag selects the artifact for each run. `--lightweight` composes only with `--issue`, is rejected with `--plan-file`, and used alone requires light mode and an in-threshold change unless `localImplementation.issueless` is set. Derived from `scripts/loop/resolve-dev-loop-startup.mjs`, `packages/core/src/config/config.mjs` and `skills/docs/artifact-authority-contract.md`.

```mermaid
flowchart TD
  S["resolve-dev-loop-startup"] --> CFG{"strategy in .devloops"}
  CFG -->|"local-first (shipped default)"| PL["targetPreference: prefer_local"]
  CFG -->|"tracker-first or github-first alias"| PG["targetPreference: prefer_github_first"]
  CFG -->|"other value"| FC["config error: needs_reconcile"]
  PL --> FL{"Startup flag"}
  PG --> FL
  FL -->|"--plan-file"| LP["Local-planning: plan file is spec"]
  FL -->|"--issue"| TF["Tracker-first: issue is spec"]
  FL -->|"--issue --lightweight"| LW1["Lightweight: PR body is spec, Closes #N required"]
  FL -->|"--lightweight alone"| LWE{"issueless set?"}
  FL -->|"--lightweight --plan-file"| REJ["reject: opposites"]
  LWE -->|"yes"| LW2["Issue-less PR-first, any scope"]
  LWE -->|"no"| ELI{"light mode on and change within cap?"}
  ELI -->|"yes"| LW2
  ELI -->|"no"| ERR["throw: light_mode_disabled / scope_detection_failed / over_threshold / config_source_touch / size_outcome_unavailable"]
```

<a id="d148"></a>

### Lightweight PR body invariants

Type: `requirementDiagram`

The invariants a lightweight PR body must carry under `ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS`. The closing reference is conditional: required when an issue backs the work, forbidden on the issue-less path. The validator fails closed with a distinct reason per violated invariant. Derived from `scripts/loop/validate-pr-body-spec.mjs`, `packages/core/src/loop/issue-refinement-artifact.mjs` and `skills/docs/artifact-authority-contract.md`.

```mermaid
requirementDiagram
  requirement body_sections {
    id: R1
    text: "Objective, scope, non-goals, AC, DoD, risks"
    risk: high
    verifymethod: test
  }
  requirement closes_link {
    id: R2
    text: "Closes N required when issue-backed"
    risk: medium
    verifymethod: test
  }
  requirement no_closes {
    id: R3
    text: "No closing ref when issue-less"
    risk: medium
    verifymethod: test
  }
  element pr_body {
    type: "PR description"
  }
  element validator {
    type: "validate-pr-body-spec"
  }
  pr_body - satisfies -> body_sections
  pr_body - satisfies -> closes_link
  pr_body - satisfies -> no_closes
  validator - verifies -> body_sections
  validator - verifies -> closes_link
  validator - verifies -> no_closes
```

<a id="d149"></a>

### Enqueue refinement gate

Type: `sequenceDiagram`

What happens when an issue is enqueued into the pickup column under `QUEUE-ENQUEUE-REFINEMENT-GATE`. The gate reuses `detectIssueRefinementArtifact`, the same check the draft gate uses. Without `--auto` the enqueue throws `MISSING_REFINEMENT_ARTIFACT` (exit 4). With `--auto` it diverts the issue to the `queue.nonSuccessStatus` park column, which must differ from Next Up. The grill and re-enqueue steps belong to the orchestration layer: the contract requires them, and `add-queue-item.mjs` does not run them. Derived from `scripts/projects/add-queue-item.mjs`, `packages/core/src/projects/move-queue-item.mjs`, `packages/core/src/loop/issue-refinement-artifact.mjs` and `skills/docs/projects-queue-contract.md`.

```mermaid
sequenceDiagram
  participant O as Orchestrator
  participant Q as queue add --next-up
  participant D as detectIssueRefinementArtifact
  participant B as Board
  participant G as loop-grill --auto
  O->>Q: enqueue issue
  Q->>D: check issue body and grill comments
  alt matrix and non-goals present, spec unchanged since grill
    D-->>Q: complete
    Q->>B: place in Next Up
  else missing or malformed matrix, or spec_changed_since_grill
    D-->>Q: finding
    alt without --auto
      Q-->>O: fail closed MISSING_REFINEMENT_ARTIFACT
    else with --auto
      Q->>B: divert to park column
      Q-->>O: diversion reason
      O->>G: grill parked issue
      G-->>O: grill-clean
      O->>Q: re-enqueue
    end
  end
```

<a id="d150"></a>

### Refinement grill sub-loop

Type: `stateDiagram-v2`

The bounded grill state machine. Iteration lives in the transition graph: synthesis always re-grills until it reaches a fixed point or hands off. The three terminal states have no outgoing edges. Derived from `packages/core/src/loop/refinement-grill-state.mjs`, `scripts/loop/detect-refinement-grill-state.mjs` and `skills/loop-grill/SKILL.md`.

```mermaid
stateDiagram-v2
  [*] --> load_target
  load_target --> detect_gaps
  load_target --> blocked_needs_user_decision
  detect_gaps --> await_answers
  detect_gaps --> grill_clean
  detect_gaps --> needs_human_handoff
  detect_gaps --> blocked_needs_user_decision
  await_answers --> synthesize
  await_answers --> needs_human_handoff
  await_answers --> blocked_needs_user_decision
  synthesize --> re_grill
  synthesize --> blocked_needs_user_decision
  re_grill --> detect_gaps
  re_grill --> grill_clean
  re_grill --> needs_human_handoff
  re_grill --> blocked_needs_user_decision
  grill_clean --> [*]
  needs_human_handoff --> [*]
  blocked_needs_user_decision --> [*]
```

<a id="d151"></a>

### Grill answer sources

Type: `mindmap`

Where the grill gets its answers and which gap kinds it must detect. In `--auto` mode an answer with only an inferred source and no citation is flagged unresolved. Some spec-lint findings can never be disposed in the results comment and block `grill-clean` until the body is fixed. Derived from `skills/loop-grill/SKILL.md` and `scripts/loop/spec-lint.mjs`.

```mermaid
mindmap
  root((loop-grill))
    Targets
      Issue
      PR body
      Plan file
    Gap detectors
      Missing AC
      Missing scope boundary
      Unresolved primary actor
      Undocumented irreversible decision
    Auto answer sources
      codebase
      docs
      context
      inferred needs citation
    Non-disposable lint
      size_forecast_missing
      size_forecast_split_required
      size_forecast_malformed
      simplest_design_missing
      contract_doc_not_in_matrix
    Verdict
      grill-clean
      N unresolved items
```

<a id="d152"></a>

### Retrospective checkpoint states

Type: `flowchart`

How a fresh session maps `.pi/dev-loop-retrospective-checkpoint.json` to a checkpoint state. The whole check runs only when `workflow.requireRetrospective` is true. An absent file never blocks. The identity and newer-merge checks live in `resolvePendingRetrospectives`, which startup and `merge-pr` share. Any broken, stale, identity-less or inline record maps to MISSING. Startup routes a MISSING state normally and reports `pendingRetrospectives`; `merge-pr` refuses the next merge until the cycle is discharged. Derived from `packages/core/src/loop/retrospective-checkpoint.mjs`, `scripts/loop/resolve-dev-loop-startup.mjs`, `scripts/github/merge-pr.mjs` and `skills/docs/retrospective-checkpoint-contract.md`.

```mermaid
flowchart TD
  F["checkpoint file"] --> A{"Present?"}
  A -->|"absent or state none"| NONE["NONE"]
  A -->|"present"| P{"Parses to a known state?"}
  P -->|"no"| M["MISSING"]
  P -->|"required / missing"| M
  P -->|"complete / skipped"| I{"Has identity?"}
  I -->|"no"| M
  I -->|"yes"| N{"Newer PR merged into base?"}
  N -->|"yes or unverifiable"| M
  N -->|"no"| K{"complete with fresh-context provenance?"}
  K -->|"complete, yes"| C["COMPLETE"]
  K -->|"complete, no"| M
  K -->|"skipped"| SK["SKIPPED"]
  M --> PR["pendingRetrospectives reported"]
  PR --> MG["merge-pr refuses retrospective_checkpoint"]
```

<a id="d153"></a>

### Post-release process

Type: `flowchart`

The fixed sequence after every stable release (spec-only: the rules live in the release runbook and a contract test pins the prose; no script drives the order). A combined retro runs first and folds the per-merge retros. Then the orchestrator files five issues in the next milestone and drives them in order. Issues get a milestone through the `--milestone` flag of the issue wrapper. The operator keeps the tag, publish and approval decisions. Derived from `skills/docs/release-runbook.md`, `test/contracts/release-post-release-steps-contract.test.mjs` and `scripts/github/create-issue.mjs`.

```mermaid
flowchart LR
  T["Operator tags stable release"] --> R["Combined release retro"]
  R --> S1["1 Prose cleanup"]
  S1 --> S2["2 Contract and codebase audit"]
  S2 --> S3["3 Outdated files audit"]
  S3 --> S4["4 Tests audit"]
  S4 --> S5["5 Memory cleanup"]
  S5 --> W["Feature work in next milestone"]
  R -.->|"skip reason names retro"| PM["Per-merge retro checkpoints"]
```

<a id="d154"></a>

### Release timeline

Type: `timeline`

Selected releases from `CHANGELOG.md`. Dates for entries without a date in the changelog come from `git log -1 --format=%cs <tag>`. The project moved from 0.x through seven release candidates to 1.0.0, then shipped 1.0.x patch releases roughly weekly and is now on 1.0.12 pre-releases. Derived from `CHANGELOG.md` and the release tags.

```mermaid
timeline
  title dev-loops releases
  section 0.x
    2026-06-16 : 0.1.0
    2026-06-24 : 0.2.0
    2026-06-28 : 0.5.0
    2026-07-05 : 0.7.0
    2026-07-09 : 0.9.0
  section Release candidates
    2026-07-14 : 1.0.0-rc.1
    2026-08-16 : 1.0.0-rc.6
    2026-08-27 : 1.0.0-rc.7
  section 1.0.x
    2026-09-04 : 1.0.0 : 1.0.1
    2026-09-09 : 1.0.2
    2026-10-01 : 1.0.5
    2026-10-16 : 1.0.6
    2026-11-04 : 1.0.9
    2026-11-11 : 1.0.11
  section 1.0.12 pre
    2026-11-12 : 1.0.12-pre.1
    2026-11-17 : 1.0.12-pre.5
```

<a id="d155"></a>

### Changelog entries per 1.0.x release

Type: `xychart-beta`

The number of top-level bullets in each 1.0.x stable changelog section. The counts come from `awk '/^## /{v=$2} /^- /{c[v]++} END{for(k in c) print k, c[k]}' CHANGELOG.md`. Release size peaked at 1.0.6 with 112 entries. 1.0.10 and 1.0.11 are smaller, at 14 and 34 entries. 1.0.1 has no bullets in that output, so the chart omits it. Derived from `CHANGELOG.md`.

```mermaid
xychart-beta
  title "Changelog bullets per release"
  x-axis ["1.0.0", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6", "1.0.7", "1.0.8", "1.0.9", "1.0.10", "1.0.11"]
  y-axis "Bullets" 0 --> 120
  bar [15, 16, 45, 68, 88, 112, 19, 74, 77, 14, 34]
```

<a id="d156"></a>

### Process artifacts and their links

Type: `erDiagram`

The artifacts the process connects. An issue or plan file is the spec in tracker-first and local-planning modes; on the lightweight path the PR body is the spec. A board item tracks an issue or PR. A local queue entry mirrors a board item only when a board is configured. A merged PR creates one retrospective checkpoint cycle, and a gate audit reads both verdict surfaces of a PR. Derived from `skills/docs/artifact-authority-contract.md`, `packages/core/src/loop/queue-state.mjs`, `packages/core/src/loop/retrospective-checkpoint.mjs` and `scripts/github/audit-gate-evidence.mjs`.

```mermaid
erDiagram
  ISSUE ||--o| PULL_REQUEST : "closed by"
  PLAN_FILE ||--o| PULL_REQUEST : "promoted in"
  PULL_REQUEST ||--o{ GATE_VERDICT : "carries"
  ISSUE ||--o{ GRILL_RESULT : "has"
  BOARD_ITEM }o--|| ISSUE : "tracks"
  QUEUE_ENTRY |o--o| BOARD_ITEM : "mirrors"
  PULL_REQUEST ||--o| RETRO_CHECKPOINT : "opens cycle"
  GATE_AUDIT }o--|| PULL_REQUEST : "reads verdicts of"
  ISSUE {
    string acDodMatrix
    string nonGoals
  }
  PULL_REQUEST {
    string body
    bool draft
  }
  QUEUE_ENTRY {
    string status
    string target
  }
  RETRO_CHECKPOINT {
    string state
    string mergeCommit
  }
```

