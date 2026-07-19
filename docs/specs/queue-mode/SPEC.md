# SPEC: Outer dev-loop queue mode

**Issue:** [#556](https://github.com/mfittko/dev-loops/issues/556)
**Status:** Partially implemented — the board pickup source (Next Up) is the live shipped path; the autonomous queue driver described below remains deliberately unwired (no-op adapter)
**Branch:** `issue/556-queue-mode`

## 1. Overview

Add `dev-loop queue` as a first-class subcommand that drives multiple issues/PRs end-to-end in order. The queue processes items sequentially by default, supports explicit opt-in parallelism, persists durable state, self-heals on failures, and files discovered workflow bugs as new queue entries.

## 2. Scope

### In scope

1. **`dev-loop queue <issue-or-PR:number>...`** — CLI subcommand accepting ordered issue/PR numbers
2. **Sequential execution** — one item at a time through full lifecycle (refine → implement → gates → merge)
3. **Autonomous merge** — when pre-authorized by operator, merge on all-gates-pass without re-prompting
4. **Per-merge retrospectives** — write retrospective checkpoint after each merge
5. **Bug detection + queue injection** — auto-file workflow issues discovered during gate review, push to end of queue
6. **Durable queue state** — `.pi/dev-loop-queue.json` tracks entries, status, PR links, run IDs
7. **Dependency ordering** — `--after <issue>` for chained dependencies; queue respects topological order
8. **`--parallel` flag** — opt-in parallel execution with adaptive file-overlap detection
9. **Queue self-healing** — re-dispatch on acceptance-report parse failures; continue to pre-approval on round-cap hits; pause blocked entries but continue remaining
10. **Re-routing** — queue re-dispatches on timeout/blocker; no unattended subagents

### Out of scope

- Queue UI (CLI only)
- Automatic dependency detection (operator specifies `--after`)
- Replacing single-issue `dev-loop` workflow
- Queue persistence across machine restarts (Git-tracked `.pi/dev-loop-queue.json` is sufficient)
- Parallel fan-out beyond the `--parallel` flag (no adaptive workload distribution)

## 3. Architecture

### 3.1 CLI surface

```
dev-loop queue <number...> [--parallel] [--after <issue>...]
```

- Positional args: ordered issue/PR numbers
- `--parallel`: enable parallel execution (opt-in)
- `--after <issue>`: declare dependency (repeatable); queue respects topological order

### 3.2 Queue state schema (`.pi/dev-loop-queue.json`)

```json
{
  "version": 1,
  "entries": [
    {
      "target": 556,
      "kind": "issue",
      "status": "queued",
      "dependsOn": [],
      "pr": null,
      "runId": null,
      "retrospectiveWritten": false
    }
  ]
}
```

**Entry states:** `queued` → `running` → `waiting_review` → `gates_passing` → `merging` → `done` | `blocked` | `failed`

### 3.3 Execution loop (per entry)

```
for each entry in order:
  1. Resolve dependencies (block until dependsOn entries are done)
  2. Run dev-loop startup resolver → determine current state
  3. Route to correct strategy (issue_intake, copilot_pr_followup, etc.)
  4. Execute through gates: draft_gate → pre_approval_gate → merge
  5. Write retrospective checkpoint after merge
  6. If bug/workflow issue discovered during gates → auto-file issue → append to queue
  7. On failure: classify (recoverable → re-dispatch; blocked → pause entry, continue queue)
  8. Update .pi/dev-loop-queue.json after each state transition
```

### 3.4 Parallel execution (`--parallel`)

When `--parallel` is set:
1. Compute file-touch overlap matrix for all queued items (uses `git diff --stat` projections or issue body file hints)
2. Items with no overlap → dispatch in parallel (up to a configurable concurrency cap)
3. Items with overlapping files → serialize within overlap groups
4. Dependency chains (`--after`) → always serialize within chain
5. Queue state tracks parallel run IDs

### 3.5 Self-healing rules

| Failure mode | Action |
|---|---|
| Acceptance-report parse failure | Re-dispatch entry |
| Round cap reached | Continue to pre-approval gate (don't block queue) |
| PR blocked by human comment | Pause entry, continue remaining entries |
| CI failure (non-fixable) | Pause entry, continue remaining entries |
| Timeout (review wait expired) | Re-dispatch entry once; pause on second timeout |

### 3.6 Bug detection + injection

During any gate review (draft_gate, pre_approval_gate):
- Detect workflow bugs, contract violations, or tool failures
- Auto-file issue via `gh issue create --repo mfittko/dev-loops --assignee @me`
- Append new issue to end of queue
- Update `.pi/dev-loop-queue.json`

## 4. Implementation phases

### Phase 1: Queue state + CLI (infrastructure)

- [ ] `dev-loops queue parse` — parse queue arguments, validate issue/PR numbers
- [ ] `.pi/dev-loop-queue.json` read/write module (`packages/core/src/loop/queue-state.mjs`)
- [ ] `dev-loop queue` subcommand registered in CLI (`cli/index.mjs`)
- [ ] Queue state machine: entry lifecycle transitions
- [ ] Tests: queue state CRUD, CLI arg parsing

### Phase 2: Sequential queue driver

- [ ] `dev-loops loop run-queue` — thin driver that iterates entries, calls startup resolver per entry
- [ ] Per-entry routing through existing `dev-loop` strategies
- [ ] Dependency resolution (`dependsOn` check before starting entry)
- [ ] State persistence after each entry transition
- [ ] Tests: sequential execution mock, dependency blocking

### Phase 3: Autonomous merge + retrospectives

- [ ] Pre-authorized merge: when queue started with merge authorization, merge on all-gates-pass
- [ ] Per-merge retrospective checkpoint write (`checkpoint-contract.mjs --state complete`)
- [ ] Merge gate evidence check (`detect-checkpoint-evidence.mjs`) before each merge
- [ ] Tests: merge flow, retrospective write

### Phase 4: Self-healing + bug injection

- [ ] Failure classification: acceptance-report parse failure, round cap, blocked, CI failure, timeout
- [ ] Re-dispatch logic for recoverable failures
- [ ] Bug detection hook during gate reviews → `gh issue create` + queue append
- [ ] Pause-entry logic for blocked entries (continue remaining)
- [ ] Tests: each failure mode, injection

### Phase 5: Parallel execution

- [ ] File-overlap detection (`git diff --stat` against each queued issue's target files)
- [ ] Overlap matrix computation
- [ ] Parallel dispatch with concurrency cap
- [ ] Serialization within overlap groups and dependency chains
- [ ] Tests: overlap detection, parallel dispatch orchestration

### Phase 6: Integration + hardening

- [ ] End-to-end queue run with real issues
- [ ] Queue state recovery on interrupted runs
- [ ] Edge cases: empty queue, invalid issue numbers, PR numbers, mixed issue+PR entries
- [ ] `npm run verify` green

## 5. Acceptance criteria (refined)

- [ ] `dev-loop queue <number...>` subcommand exists, accepts issue and PR numbers
- [ ] Queue processes items sequentially in declared order
- [ ] Queue merges autonomously when operator pre-authorized merge and all gates pass
- [ ] Queue writes retrospective checkpoint after every merge
- [ ] Workflow bugs discovered during gate review are auto-filed as issues and appended to queue end
- [ ] `--parallel` flag enables opt-in parallel execution with file-overlap detection
- [ ] `--after <issue>` enforces dependency ordering
- [ ] Queue state persists to `.pi/dev-loop-queue.json` and is updated after every state transition
- [ ] Queue self-heals: re-dispatches on parse failures, continues on round-cap, pauses on human blocks
- [ ] `npm run verify` green
- [ ] No unattended subagents — queue re-dispatches on timeout/blocker

## 6. Verification strategy

| Layer | What |
|---|---|
| Unit tests | Queue state CRUD, CLI arg parsing, failure classification, overlap detection |
| Integration tests | Sequential driver with mocked issue/PR lifecycle, dependency resolution |
| Contract tests | Queue state schema compliance, retrospective checkpoint contract |
| Smoke test | `dev-loop queue <real-issue-numbers>` with merge authorization |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Queue state corruption | Atomic writes, backup before each mutation |
| Parallel dispatch conflicts | File-overlap detection + serialization groups |
| Unattended subagents after timeout | Queue re-dispatch on each cycle; run ID tracking |
| Merge without proper gate evidence | Mechanical `detect-checkpoint-evidence.mjs` before every merge |
| Queue grows unbounded from bug injection | Cap auto-filed issues per queue run (configurable) |

## 8. Config

```yaml
# .devloops additions
queue:
  maxParallel: 3           # concurrency cap for --parallel
  maxAutoFiledIssues: 10   # cap on bug-injected issues per queue run
  reDispatchMaxRetries: 1  # max re-dispatches for recoverable failures
```

## 9. File manifest

| File | Purpose |
|---|---|
| `cli/index.mjs` | Register `dev-loop queue` subcommand |
| `packages/core/src/loop/queue-state.mjs` | Queue state read/write/transition machine |
| `packages/core/src/loop/queue-driver.mjs` | Sequential queue driver |
| `packages/core/src/loop/queue-parallel.mjs` | Parallel execution + overlap detection |
| `scripts/loop/run-queue.mjs` | Thin CLI wrapper for queue driver |
| `.pi/dev-loop-queue.json` | Durable queue state (created at runtime) |
| `packages/core/test/queue-state.test.mjs` | Queue state tests |
| `packages/core/test/queue-driver.test.mjs` | Queue driver tests |
| `test/loop/queue-mode.test.mjs` | Integration tests |
