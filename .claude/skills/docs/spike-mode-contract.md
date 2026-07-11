# Spike-mode contract

Canonical owner for spike mode: the time-boxed, exploratory dev-loop run started from a local question with no GitHub issue. Its deliverable is a findings document. When the exploration reaches a recommendation, the operator concludes it with one of two exits: **discard** (drop it with zero tracker artifacts) or **graduate** (emit a #947-style local-first plan file that enters the existing plan→PR promotion path).

This doc is the canonical operator sequence for spike mode and carries a worked example showing both exits. The spike artifact lives outside the tracker; it is exempt from the production-gate ceremony at entry and runs under a relaxed gate profile (`gates.spike`). The [Artifact Authority Contract](artifact-authority-contract.md) owns the local-planning model a graduated spike feeds into.

The spike track shipped across three phases: P1 (#964) the `--spike` intake state machine, P2 (#965) the relaxed gate profile and the discard/graduate exits, P3 (#966) this doc.

## Shipped surfaces

| Stage | Helper script | Pure logic |
|---|---|---|
| Validate | `scripts/refine/validate-spike-file.mjs` | `validateSpikeFile` / `validateSpikeExplorationSections` (in the helper script) |
| Start | `scripts/loop/resolve-dev-loop-startup.mjs --spike <path>` | `buildSpikeInput` (in the script) + `evaluateSpikeIntakeState` (`@dev-loops/core/loop/spike-intake-contract`) |
| Exit | `scripts/refine/exit-spike.mjs` | `evaluateSpikeExit` / `buildGraduatedPlanBody` (`@dev-loops/core/loop/spike-exit-contract`) |

The spike findings artifact carries four authoring sections (`scripts/refine/validate-spike-file.mjs`, `SPIKE_FILE_BASE_SECTIONS`):

- `## Question` — what the spike investigates
- `## Approach` — how the exploration was carried out
- `## Findings` — the evidence gathered
- `## Recommendation` — the exit marker

The first three (`SPIKE_FILE_EXPLORATION_SECTIONS`) are the exploration scaffold required to **start** a spike. `Recommendation` (`SPIKE_FILE_EXIT_MARKER_SECTION`) is filled in during the spike; once it is present and non-empty, the intake state flips to ready-for-exit.

## Intake states

`evaluateSpikeIntakeState` (`packages/core/src/loop/spike-intake-contract.mjs`) classifies the artifact into one of three `SPIKE_INTAKE_STATE` values from two facts — whether the exploration scaffold is valid, and whether a Recommendation is present:

| State | Meaning |
|---|---|
| `spike_in_progress` | Scaffold (Question/Approach/Findings) valid; no Recommendation yet |
| `spike_ready_for_exit` | Scaffold valid and a non-empty Recommendation is present; an exit decision can be made |
| `ambiguous_fail_closed` | Scaffold invalid (a missing or empty base section); fail closed, no routing |

## Operator sequence

### 1. Author the exploration scaffold

Write a findings artifact carrying `## Question`, `## Approach`, and `## Findings` with non-empty bodies. `## Recommendation` is left for the spike to fill in. Check the full set of base sections with the validator:

```
node scripts/refine/validate-spike-file.mjs --input <spike.md> --json
```

The payload is `{ checker: "validate-spike-file", ok, errors }`, with a distinct `missing_*` code per absent or empty section (`missing_question`, `missing_approach`, `missing_findings`, `missing_recommendation`). An in-progress spike reports `missing_recommendation` here and is still startable, because startup gates on the exploration scaffold (`validateSpikeExplorationSections`), which omits the Recommendation.

### 2. Start the spike

Hand the artifact to startup with `--spike` (mutually exclusive with `--issue`, `--pr`, `--input`, `--plan-file`):

```
node scripts/loop/resolve-dev-loop-startup.mjs --spike <spike.md>
```

`buildSpikeInput` (`scripts/loop/resolve-dev-loop-startup.mjs`) reads the file read-only — no tracker mutation, no GitHub call, no issue or PR number.

<!-- rule: SPIKE-STARTUP-SCAFFOLD-GATE -->
Startup MUST require the exploration scaffold: a missing/unreadable file, or one failing `validateSpikeExplorationSections`, MUST throw, and startup MUST fail closed (exit 1, no readiness bundle). On success it builds a `local_phase` startup input with the resolved spike path as the target `phase` and threads `spikeIntakeState` onto the output. A spike with no Recommendation reports `spike_in_progress`. The spike path is exempt from the worktree-isolation guard because there is no issue to key a worktree on (`planFileExempt: true`).

### 3. Run under the relaxed gate profile

A spike runs under `gates.spike`, a lighter angle set than the production draft → pre-approval gates. See [Relaxed gate profile](#relaxed-gate-profile) below.

### 4. Reach a Recommendation, then exit

When the exploration concludes, fill in `## Recommendation`. The intake state is now `spike_ready_for_exit`, and `exit-spike.mjs` can conclude the spike. It recomputes the intake facts (`validateSpikeExplorationSections` for the scaffold, `extractSection` for the Recommendation), runs `evaluateSpikeExit`, and routes to one of two dispositions.

```
node scripts/refine/exit-spike.mjs --spike-file <spike.md> --disposition <discard|graduate> [--plan-file <path>] [--json]
```

<!-- rule: SPIKE-EXIT-ELIGIBILITY -->
`evaluateSpikeExit` (`packages/core/src/loop/spike-exit-contract.mjs`) MUST be eligible only from `spike_ready_for_exit`: from any other state it MUST fail closed with `not_ready_for_exit`, and an unrecognized disposition MUST fail closed with `unknown_disposition`. On a fail-closed path the CLI MUST make zero tracker mutation, write no plan file, and exit 1.

## Exit dispositions

The two dispositions are `SPIKE_EXIT_DISPOSITION.DISCARD` (`"discard"`) and `SPIKE_EXIT_DISPOSITION.GRADUATE` (`"graduate"`).

### discard

<!-- rule: SPIKE-DISCARD-ZERO-MUTATION -->
The recommendation is "don't pursue". Discard MUST drop the spike with zero tracker artifacts — the findings document on disk is the whole record. The CLI MUST write nothing and MUST create no GitHub artifact. `--plan-file` is irrelevant for a discard.

### graduate

<!-- rule: SPIKE-GRADUATE-PLAN-FILE-REQUIRED -->
The recommendation is "pursue this". `buildGraduatedPlanBody` builds a #947-consumable plan-file body from the spike's `Question`, `Approach`, `Findings`, and `Recommendation`, and `exit-spike.mjs` writes it to the required `--plan-file` path — `--plan-file` MUST be present for a graduate exit; the CLI MUST NOT guess an output path. The mapping:

- `Question` + `Approach` become the Objective's context.
- `Recommendation` becomes the In-scope work.
- `Findings` are recorded as supporting evidence.
- A fixed Explicit non-goals block keeps the plan from re-opening the concluded exploration.

The emitted body carries the four plan-file base sections (`## Status`, `## Objective`, `## In scope`, `## Explicit non-goals` — see [Plan-file Contract](plan-file-contract.md)), so it passes `validatePlanFile` and enters the local-first plan→PR promotion path (#952) unchanged: refine it, hold the local human-review checkpoint, then `promote-plan.mjs`. Graduation is idempotent — `buildGraduatedPlanBody` is pure, so re-running reproduces the same plan file, and it fails closed (throws) on an empty required section, so a graduate exit cannot emit a plan the validator would reject.

## Relaxed gate profile

<!-- rule: SPIKE-RELAXED-GATE-PROFILE -->
A spike's deliverable is a findings doc, so it MUST NOT carry the full production draft → pre-approval → Copilot gate set; it runs under `gates.spike`, a relaxed profile shipped in `packages/core/src/config/extension-defaults.yaml`:

```yaml
gates:
  spike:
    angles:
      - scope
      - docs
    excludeAngles: []
    required: false
    requireCi: false
    mandatoryAngles: []
```

| Knob | Spike value | Production draft/pre-approval | Why for a spike |
|---|---|---|---|
| `angles` | `scope`, `docs` | the full production angle set | A findings doc needs a scope check and a docs check, so the angle set is small and docs-first |
| `required` | `false` | `true` | The spike's record is the findings doc, so the gate is advisory and the loop proceeds without a passing verdict |
| `requireCi` | `false` | `true` (CI required by default; both gates honor an opt-out via `requireCi: false`) | A spike produces no production code to run CI against |

`gates.spike` resolves through the same config-merge layering and the same `resolveGateConfig(config, "spike")` path as `draft` and `preApproval` (`packages/core/src/config/config.mjs`) — no new strategy→knob resolver. It is `optional()` in the schema (`packages/core/src/config/config.mjs`, `schemas/dev-loop-config.schema.json`) and absent for non-spike work, so production gates are unaffected. A repo `.devloops` can override any of these knobs.

## Worked example

One spike, `spike-cache.md`, from question to a Recommendation, shown through both exits.

### Authored scaffold

```markdown
# Spike: response cache

## Question

Would an in-process LRU cache on the metadata fetch measurably cut p95 latency?

## Approach

Add a throwaway `@lru_cache` wrapper behind a flag, replay a captured request
trace, and compare p95 with and without the cache.

## Findings

The trace replay shows p95 dropping from 240ms to 90ms with the cache, with a
~3MB steady-state memory cost and no correctness regressions on the replay set.
```

Validation reports the spike is still in progress — the Recommendation is not yet written, so the full-section validator flags it while the scaffold itself is complete:

```
$ node scripts/refine/validate-spike-file.mjs --input spike-cache.md --json
{ "checker": "validate-spike-file", "ok": false, "errors": [ { "code": "missing_recommendation", "message": "..." } ] }
```

Startup accepts it anyway, because the entry gate is the exploration scaffold:

```
$ node scripts/loop/resolve-dev-loop-startup.mjs --spike spike-cache.md
# ... startup output carries spikeIntakeState: "spike_in_progress"
```

### Recommendation reached

The operator fills in the exit marker:

```markdown
## Recommendation

Adopt the cache behind a default-on flag; the latency win is large and the
memory cost is small. Ship it as a follow-up plan.
```

The intake state is now `spike_ready_for_exit`, so the spike is exitable.

### Exit A — discard (leaves nothing behind)

Had the findings come out the other way — say the latency win was within noise — the recommendation would be "don't pursue", and the operator discards:

```
$ node scripts/refine/exit-spike.mjs --spike-file spike-cache.md --disposition discard --json
{ "ok": true, "action": "discard", "spikeFile": "/abs/spike-cache.md" }
```

No plan file is written, no GitHub artifact is created, and no tracker entry is made. The `spike-cache.md` findings doc on disk is the entire record of the exploration.

### Exit B — graduate (emits a plan file)

With the "adopt it" recommendation above, the operator graduates the spike into a plan file:

```
$ node scripts/refine/exit-spike.mjs --spike-file spike-cache.md --disposition graduate --plan-file docs/phases/phase-43.md --json
{ "ok": true, "action": "graduate", "spikeFile": "/abs/spike-cache.md", "planFile": "/abs/docs/phases/phase-43.md" }
```

`docs/phases/phase-43.md` is written with the spike's sections mapped onto the plan-file base sections:

```markdown
# Graduated spike plan

## Status

Draft (graduated from a spike). Needs refinement before promotion.

## Objective

Act on the spike's recommendation. The spike asked: Would an in-process LRU
cache on the metadata fetch measurably cut p95 latency?

Approach explored:

Add a throwaway `@lru_cache` wrapper behind a flag, replay a captured request
trace, and compare p95 with and without the cache.

## In scope

Adopt the cache behind a default-on flag; the latency win is large and the
memory cost is small. Ship it as a follow-up plan.

Supporting findings from the spike:

The trace replay shows p95 dropping from 240ms to 90ms with the cache, with a
~3MB steady-state memory cost and no correctness regressions on the replay set.

## Explicit non-goals

- Re-running the spike's exploration; that question is concluded.
- Work beyond the recommendation above.
```

This plan file passes `validatePlanFile`, so it enters the local-planning flow as a new plan needing refinement: refine it, hold the local human-review checkpoint, then `promote-plan.mjs` opens the draft PR (see the [Local-Planning Worked Example](local-planning-worked-example.md)). Re-running the graduate exit reproduces the same plan body, because `buildGraduatedPlanBody` is pure.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Canonical artifact model; a graduated spike feeds the local-planning tier |
| [Local-Planning Flow](local-planning-flow.md) | The operator sequence a graduated plan file then follows |
| [Local-Planning Worked Example](local-planning-worked-example.md) | One plan file through promotion, where a graduated spike lands |
| [Plan-file Contract](plan-file-contract.md) | Plan-file format and base sections the graduated body satisfies |
| [Public Dev Loop Contract](public-dev-loop-contract.md) | Canonical routing contract; `--spike` is one startup input |

## Non-goals

- Changing spike intake, exit, or gate behavior (this is a docs-only surface).
- Defining a tracker-backed spike — a spike is local by construction.
- A discard that records a tracker artifact — discard is zero-mutation by contract.
