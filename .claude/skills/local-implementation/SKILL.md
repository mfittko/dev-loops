---
name: "local-implementation"
description: "Internal routed strategy behind `dev-loop` for local phase-bounded implementation. Use it when authoritative startup/resume routing selects the `local_implementation` strategy so the child agent can own phase planning, artifact discipline, test-first implementation, and local validation in fresh context."
allowed-tools: Read Bash Edit Write Agent
user-invocable: false
---
<!-- GENERATED from skills/local-implementation/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Local Implementation

This skill is the canonical internal `local_implementation` route behind the public `dev-loop` façade.

Use it only after the public dispatcher has already resolved `selectedStrategy: local_implementation`. This skill owns the local phase procedure and artifact discipline for that route; it does not redefine the shipped runtime semantics of helper CLIs, shared loop logic, or extension commands.

Read the authoritative public routing contract at [Public Dev Loop Contract](../docs/public-dev-loop-contract.md) and keep any repository-specific decisions grounded in [Project Plan](../../PLAN.md), durable phase docs, source, tests, config, and actual validation commands.
For UI validation under `dev-loop`, see [UI Validation Contract](../../docs/ui-validation-contract.md), [UI Smoke Harness](../../docs/ui-smoke-harness.md), [UI Artifact Contract](../../docs/ui-artifact-contract.md), and [UI Designer Review Loop](../../docs/ui-designer-review-loop.md) (designer + `uiReviewMode: vision`) (these are repo-level docs present in the source checkout; they are not part of the bundled `../docs/` runtime contract surface for installed skill copies).

## Minimal required project inputs

For a new project, the only required inputs are:

1. [Project Plan](../../PLAN.md)
2. [this skill file](./SKILL.md)

Everything else is optional and may be bootstrapped by this skill.

## Required startup reads

Read the canonical entrypoint briefing first: [Entrypoint Strategies](../docs/entrypoint-strategies.md#local-implementation). Then read only what the current step needs:

- [Agent Instructions](../../AGENTS.md) (repo constitution)
- [Public Dev Loop Contract](../docs/public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md) (when async state applies)
- [Project Plan](../../PLAN.md) and phase/tracker docs when relevant
- Relevant issue/PR, validation surface, and task files

Treat missing optional files as normal bootstrap conditions, not errors.

### Tracker-backed local implementation

Local implementation supports these spec-of-record inputs. The first two are durable/committed artifacts; the third is a spec-of-record that is NOT a durable committed artifact:

Durable/committed spec artifacts:

- phase-doc-backed local sessions ([Phase Plan](../../docs/phases/phase-x.md) is canonical)
- tracker-backed local sessions (the tracker issue is canonical)

Non-durable spec-of-record (no committed plan artifact):

- lightweight PR-body-as-spec sessions (`--lightweight`; the PR description is the canonical spec-of-record but NOT a durable committed artifact — the resolver output carries `canonicalSpecSource: pr_body` and the derived handoff envelope carries `specSource: pr_body`; no phase/plan doc minted or committed). Same gate sequence as the phase-doc path; only the backing artifact differs. See [Artifact Authority Contract](../docs/artifact-authority-contract.md) "Lightweight (PR-body-as-spec)".

Tracker-backed local implementation stays inside the existing `local_implementation` path. For sub-issue tree decomposition, see [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md) (this is a source-repo reference; it is not part of the bundled `../docs/` runtime contract surface for installed skill copies). It does not introduce a new routing mode.

When the local spec already lives in a tracker issue:

- resolve the tracker reference deterministically from a GitHub issue URL or explicit `<owner/name>` + issue number
- use the bounded GitHub helper `scripts/github/resolve-tracker-local-spec.mjs` when you need a machine-readable spec bundle
- treat the tracker issue title/body/url/state as the durable local spec bundle
- the no-duplicate-phase-doc rule is owned by `ARTIFACT-TRACKER-FIRST-NO-DUP` in [Artifact Authority Contract](../docs/artifact-authority-contract.md); do not read [Phase Plan](../../docs/phases/phase-x.md) for that same tracker-backed session either
- sync durable scope / acceptance / status changes back to the tracker issue rather than maintaining a duplicate local phase doc
- keep `tmp/` as temporary local execution state only; it does not become a second durable spec surface
- for tracker-backed sessions, the handoff path is always: push the working branch → open a PR → merge via GitHub
- <!-- rule: LOCAL-PR-CREATE-CANONICAL --> for tracker-backed sessions, you MUST open PRs through the canonical `dev-loops pr create` path — always draft and always assigned — self-assigned by default (`--assignee @me` when none is given; honors an explicit `--assignee <login>` / `-a <login>`) — and MUST NOT open them via raw `gh pr create`. The PR body MUST contain `Closes #N` (or `Fixes #N`) for the linked issue so GitHub auto-closes it on merge. When `.devloops` sets `workflow.requireDraftFirst` to true, use `dev-loops pr create --assignee @me ...`; the always-draft creation mechanism is owned by [`OPS-DRAFT-FIRST-PR`](../docs/copilot-loop-operations.md) — `create-pr.mjs` is unconditionally draft-only regardless of the toggle, which separately governs whether the draft-gate boundary is enforced before ready.
- <!-- rule: LOCAL-TRACKER-NO-DIRECT-MERGE --> `LOCAL-TRACKER-NO-DIRECT-MERGE`: for tracker-backed sessions, agents MUST NOT suggest a direct local-main merge and MUST NOT merge the working branch into local `main` at phase completion

## Primary execution rules

### Step 0: Pre-flight gate (mandatory for local_implementation)

<!-- rule: LOCAL-PREFLIGHT-GATE-MANDATORY -->
For the `local_implementation` strategy, before any planning or implementation mutation, you MUST run the pre-flight gate:

```sh
node scripts/loop/pre-flight-gate.mjs --expected-branch <working-branch> --check-subagents
```

Before creating or reusing a worktree for local implementation, use the canonical lifecycle entrypoint (`WORKTREE-CREATE-PROVISION`, see [Worktree usage guidance](../../docs/worktree-guidance.md#create-or-reuse--provision-ensure-worktreemjs)):

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <main> --issue <n>
```

This validates worktree isolation (current directory under `tmp/worktrees/`) and branch identity (current branch matches the working branch); `--check-subagents` only reports subagent availability and is advisory (fails-open, does not block the gate). If the gate fails, **stop and fix the violation** before proceeding — do not bypass it in normal workflow execution.

This gate does **not** apply to other routed strategies (`copilot_pr_followup`, `external_pr_followup`, `reviewer_fixer`, `wait_watch`, `final_approval`, `issue_intake`); those strategies have their own execution rules and may edit code from any checkout as needed. The development-only bypass (`DEVLOOPS_PREFLIGHT_BYPASS=1`) exists for testing the gate itself and MUST NOT be used in production workflow runs — it is a testing convenience, not an operational escape hatch.

## Narrow failure-triage fast path

<!-- rule: LOCAL-FAILURE-TRIAGE-ORDER -->
When resuming local implementation with dirty work or an observed failing command, you MUST follow this ordered path before broad discovery:

1. run startup once from the relevant worktree/context
2. inspect current state with `git status` and the changed files
3. reproduce or identify the failing command
4. run an exact-pattern search in changed files for the suspect call site
5. patch the minimum call sites
6. run focused smoke checks for that failure
7. run default verification

Follow [Anti-patterns](../docs/anti-patterns.md) for the general tooling-internals and duplicate-broad-search prohibition; this local fast path owns only the ordered failure-triage procedure above.

### Step 1

- <!-- rule: LOCAL-PHASE-ONE-AT-A-TIME --> You MUST implement **one phase at a time** and MUST NOT refine later phases in detail before the current phase is complete.
- Use the `refiner` agent for phase-refinement work when subagents are available; escalate RFC-worthy technical decisions to the parent session / human operator.
- <!-- rule: LOCAL-TEST-FIRST-COVERAGE --> You MUST work **test-first** for all non-trivial logic; coverage thresholds are owned by [VALIDATE-COVERAGE-THRESHOLD](../docs/validation-policy.md).
- Log detailed iteration artifacts under `tmp/` using the required structure below.
- Spec-of-record split (phase-doc-backed vs. tracker-backed vs. lightweight): see [Tracker-backed local implementation](#tracker-backed-local-implementation) above.
- When a phase changes durable product truth in ways `PLAN.md` should express (for example command surface, accepted product decisions, resolved open questions, or scope changes), update [Project Plan](../../PLAN.md) before closing the phase.
- Branch, commit, pre-approval-gate, and finalization mechanics: see [Branch / review / merge policy](#branch--review--merge-policy), [Commit policy](#commit-policy), and [Implementation loop for the phase](#implementation-loop-for-the-phase) below.
- When subagents are used, log what each subagent was asked to do and what it concluded.
- If [Project Plan](../../PLAN.md) is too rough or ambiguous to safely start the current phase, do not guess: run a clarification/interview step with the user first.

## Structural quality

Apply [Structural Quality](../docs/structural-quality.md) from the `deep` review angle.

## Light mode (small changes)

<!-- rule: LOCAL-LIGHT-MODE-CONFIG-SURFACE -->
`localImplementation.lightMode` (`.devloops` field; this repo sets `maxLines: 20`, `maxFiles: 2`) is this skill's config surface for light-mode gate dispatch. Gate-collapse mechanics, escalation, and dispatch resolution (`resolveGateDispatchMode`, `scripts/loop/resolve-gate-dispatch.mjs`) are owned by [Light-mode inline acceptance](../../docs/gate-review-sub-loop-contract.md#light-mode-inline-acceptance-under-threshold-micro-prs); this skill MUST NOT redefine them.

Use `scripts/loop/detect-change-scope.mjs` to determine scope:
```sh
node scripts/loop/detect-change-scope.mjs
```

## Deterministic logging structure

Treat the workflow as three layers:
- [Project Plan](../../PLAN.md) = strategic product and architecture truth
- [Phase Plan](../../docs/phases/phase-x.md) or the canonical tracker issue = durable per-phase plan and acceptance criteria for the active local session
- `tmp/` = temporary local execution audit trail and machine-friendly continuation state

Maintain the core paths below while the phase is active locally, and create optional artifacts only when they are actually used:

Core paths:
- for phase-doc-backed local sessions: [Phase Plan](../../docs/phases/phase-x.md)
- `tmp/phases/index.json`
- `tmp/phases/phase-x/manifest.json`
- `Variant A` (`tmp/phases/phase-x/variant-a.md`)
- `Variant B` (`tmp/phases/phase-x/variant-b.md`)
- `Merged Plan` (`tmp/phases/phase-x/merged-plan.md`)
- `Phase Review` (`tmp/phases/phase-x/review.md`)
- `Phase Summary` (`tmp/phases/phase-x/summary.md`)
- `Retrospective` (`tmp/phases/phase-x/retrospective.md`)

Optional when used:
- `Variant C` (`tmp/phases/phase-x/variant-c.md`)
- `tmp/phases/phase-x/subagents/`
- `tmp/phases/phase-x/subagents/raw/`
- `tmp/phases/phase-x/bash-exit-1.jsonl`
- `Clarification Log` (`tmp/phases/phase-x/clarification.md`)
- in dev mode: `tmp/phases/phase-x/dev-mode-context.json`
- in dev mode: `Dev Mode Review` (`tmp/phases/phase-x/dev-mode-review.md`) as optional analytical notes when they help shape the retrospective
- in dev mode: `Dev Mode Retrospective` (`tmp/phases/phase-x/dev-mode-retrospective.md`)
- in dev mode: `Dev Mode Skill Changes` (`tmp/phases/phase-x/dev-mode-skill-changes.md`)

Use the templates in `../dev-loop/templates/` (the sibling `skills/dev-loop/templates/` directory in this repo).

Use deterministic helper scripts from `../dev-loop/scripts/` (the sibling `skills/dev-loop/scripts/` directory in this repo; in installed-skill layouts these live at `../dev-loop/scripts/` relative to this skill file, not inside this skill's own directory) for repeatable support tasks such as phase initialization, phase-file updates, template materialization, bash-exit logging, and dev-mode context collection.

## Bootstrap missing support files

If these files are missing, create them from the `../dev-loop/templates/` directory before continuing:

- missing [Agent Instructions](../../AGENTS.md) -> create from [Bootstrap Agents Template](../dev-loop/templates/bootstrap-agents.md)
- missing [Implementation State](../../docs/IMPLEMENTATION_STATE.md) -> create from [Bootstrap Implementation State Template](../dev-loop/templates/bootstrap-implementation-state.md)
- missing [Implementation Workflow](../../docs/IMPLEMENTATION_WORKFLOW.md) -> create from [Bootstrap Implementation Workflow Template](../dev-loop/templates/bootstrap-implementation-workflow.md)
- missing [Phase Plan](../../docs/phases/phase-x.md) for the active phase -> create from [Phase Doc Template](../dev-loop/templates/phase-doc.md)
- missing `tmp/phases/index.json` -> create or reinitialize it

The bootstrap files are support infrastructure. [Project Plan](../../PLAN.md) remains the product source of truth. For phase-doc-backed local sessions, [Phase Plan](../../docs/phases/phase-x.md) is the durable source of truth for the current phase's plan and acceptance boundary. For tracker-backed local sessions, the tracker issue is that durable source of truth, and no duplicate local phase doc should be bootstrapped.

For bootstrap/setup phases, do not mark the phase `completed` or `awaiting-finalization` until the expected durable support files for the chosen workflow contract actually exist in the repository. Temporary `tmp/` execution artifacts do not need to be committed.
## Plan sufficiency check

Before phase planning, check whether [Project Plan](../../PLAN.md) contains enough information to proceed safely.

At minimum, the current phase needs enough information to infer:
- the goal of the phase
- the main constraints
- the intended scope or boundaries
- at least rough acceptance criteria or success shape

If that information is missing or too ambiguous, pause implementation and run a clarification/interview step.

## Clarification / interview step

When the plan is insufficient, use one of these modes:

### Mode A — interactive clarification
- ask only the missing high-value questions needed to safely refine the current phase
- prefer a short interview or wizard-style sequence over one giant question dump
- record the answers in `Clarification Log` (`tmp/phases/phase-x/clarification.md`)
- update [Phase Plan](../../docs/phases/phase-x.md) with clarified durable phase intent, scope, or acceptance criteria
- update [Project Plan](../../PLAN.md) only if the clarified information is durable product/project truth beyond the current phase
- update [Implementation State](../../docs/IMPLEMENTATION_STATE.md) if the clarification changes the next phase boundary

### Mode B — auto clarification
Use this when the user explicitly asks for an auto option, says to just proceed, or is clearly optimizing for speed over discussion.

In auto mode:
- infer the smallest safe defaults for the current phase only
- prefer conservative assumptions over ambitious ones
- never auto-resolve product, security, or architecture decisions that could materially change scope
- write all assumptions to `Clarification Log` (`tmp/phases/phase-x/clarification.md`)
- mark them clearly as `auto-assumptions`
- surface the assumptions in the phase plan audit so they can be challenged later
- if an assumption is too risky to make safely, stop and ask the user anyway

Do not begin fan-out planning until the current phase is sufficiently specified, either by user clarification or safe auto-assumptions.

## Determine where to resume

Read [Implementation State](../../docs/IMPLEMENTATION_STATE.md) and identify the next unfinished phase.
Read [Phase Plan](../../docs/phases/phase-x.md) for that phase if it exists.

If `tmp/phases/index.json` exists locally, use it as a fast index for prior artifacts.
If the durable phase doc, the state file, and the tmp index disagree, trust docs first and note the mismatch in the phase plan audit log.

If the state file is ambiguous, resolve ambiguity conservatively:
- prefer the earliest clearly unfinished phase
- do not skip ahead
- note the ambiguity in the phase plan audit log under `tmp/`
- if this is a first-run bootstrap, start from the earliest phase implied by [Project Plan](../../PLAN.md)

## Phase planning loop

For the **current phase only**, run this loop before implementation.

### 1. Create or update the durable phase doc and tmp scaffold

**Lightweight (PR-body-as-spec) exception:** when the session is lightweight — the resolver output carries `canonicalSpecSource: pr_body` and the derived handoff envelope carries `specSource: pr_body` (started via `resolve-dev-loop-startup.mjs --issue <n> --lightweight`) — SKIP the durable phase-doc mint entirely. The PR description is the spec-of-record; do NOT create or commit any `docs/phases/*.md` for this session. The ephemeral `tmp/phases/` scaffold may still be used for local execution state. All other steps (read prior learning, plan, implement) proceed unchanged, and the gate sequence (draft → pre-approval fanout → detect-evidence → human merge) is identical. See [Artifact Authority Contract](../docs/artifact-authority-contract.md) "Lightweight (PR-body-as-spec)".

Otherwise (default phase-doc path), create or update the durable phase doc.

Use paths like:
- `docs/phases/phase-0.md`
- `tmp/phases/phase-0/`
- `docs/phases/phase-1.md`
- `tmp/phases/phase-1/`

Create or update:
- [Phase Plan](../../docs/phases/phase-x.md)
- `tmp/phases/phase-x/manifest.json`
- `tmp/phases/index.json`

Prefer the deterministic helper:
- `../dev-loop/scripts/init-phase.mjs`

Use `../dev-loop/scripts/phase-files.mjs` only when you need a narrower manifest/index update without regenerating the standard phase-planning scaffold.

### 2. Read the previous phase's learning before planning the next one

If a previous phase exists, read:
- its `summary.md`
- its `retrospective.md`
- any relevant subagent summaries

Use those lessons to improve the current phase plan.

### 2b. Optional bounded refinement audit

Before variant fan-out, optionally run one bounded audit when the active phase would benefit from slop-risk discovery, structural drift discovery, or adjacent cleanup discovery.

When used:
- run one bounded audit before variant fan-out
- write the audit artifact to `tmp/phases/phase-x/audit/refinement-audit-summary.json`
- use `node scripts/loop/run-refinement-audit.mjs --paths ... --output tmp/phases/phase-x/audit/refinement-audit-summary.json`
- pass a concise audit summary into every refiner briefing
- keep the audit opt-in; do not turn it into a mandatory precondition
- preserve prioritized findings, the highest-value follow-up candidates, and an explicit statement of what this phase will not rewrite or broaden in the merged plan and review artifacts

### 3. Fan out short plan variants

Write 2-3 short variants:
- `Variant A` (`tmp/phases/phase-x/variant-a.md`) = smallest safe implementation
- `Variant B` (`tmp/phases/phase-x/variant-b.md`) = best practical UX/developer-experience option within phase scope
- `Variant C` (`tmp/phases/phase-x/variant-c.md`) = safest boundary/risk-reduction option when useful

When subagents are available, the default refinement path should use the `refiner` role and **parallel fresh-context subagents** so the variants are independently generated rather than serially contaminated by one another. Pass each refiner a concise written briefing summary instead of relying on forked parent-session context.

For future refinement hardening, treat the `variant-a` / `variant-b` pattern as the stable inner fan-out shape for a given persona or review angle. Do not switch personas halfway through one `a/b` pair. Instead, when more hardening is needed, run multiple fresh-context fan-out passes with different personas or angles, each with its own consistent `a/b` pair, and then merge across those persona-specific passes.

Each refiner variant should make room for:
- explicit non-goals
- complete acceptance criteria
- a complete definition of done
- risks and unresolved questions
- when a bounded audit artifact exists: prioritized findings, highest-value follow-up candidates, and what the phase will not rewrite or broaden
- RFC escalation notes when technical decisions should go to the parent session / human operator
- for watcher/predicate-heavy phases: explicit negative-case tests and timeout semantics, including any zero-timeout or single-check contract

Use the template in [Phase Variant Template](../dev-loop/templates/phase-variant.md).

Each variant should cover only:
- scope for this phase
- files/modules touched
- tests to add first
- implementation order
- acceptance criteria
- risks/non-goals

When a phase includes a bounded audit, inventory, or scan:
- treat the scan as a first-class deliverable rather than an implicit side note
- require prioritized findings, not an unbounded dump
- state explicitly what the scan does **not** authorize or rewrite in the current phase

If subagents generate the variants:
- run them in parallel with clean context when practical
- give each variant generator a concise briefing summary that includes phase objective, in-scope work, constraints, known risks, and required outputs
- keep each `variant-a` / `variant-b` pair anchored to one persona or refinement angle so the alternatives are directly comparable
- when you want broader hardening, add another fan-out pass with a different persona or angle and its own `variant-a` / `variant-b` pair instead of blending multiple personas into one pair
- do not fork the parent session just to share planning context; summarize it instead
- save raw subagent outputs under `tmp/phases/phase-x/subagents/raw/` only when keeping the raw capture is actually useful
- then write the human-oriented `Variant A` (`tmp/phases/phase-x/variant-a.md`) / `Variant B` (`tmp/phases/phase-x/variant-b.md`) / `Variant C` (`tmp/phases/phase-x/variant-c.md`) files from those raw outputs when applicable

Update `manifest.json` with the planned artifact list and current status.

### 4. Fan in to a merged phase plan

Write:
- `Merged Plan` (`tmp/phases/phase-x/merged-plan.md`)
- update [Phase Plan](../../docs/phases/phase-x.md) with the selected durable phase plan

Use the templates in [Merged Phase Plan Template](../dev-loop/templates/merged-phase-plan.md) and [Phase Doc Template](../dev-loop/templates/phase-doc.md).

The merged plan must include:
- exact scope for this phase
- explicit non-goals
- tests to write first
- implementation order
- validation steps
- acceptance criteria
- definition of done
- when a bounded audit artifact exists: prioritized findings, highest-value follow-up candidates, and an explicit statement of what this phase will not rewrite or broaden
- RFC escalation notes for any RFC-worthy technical decisions that must go to the parent session / human operator instead of being silently resolved during refinement
- for any new CLI surface: explicit success-output and malformed-argument/error-contract expectations
- for any watcher/predicate-driven behavior: explicit timeout semantics plus negative-case detection rules for non-target identities or events
- for package-first phases in a source-loaded workspace: explicit expectations about whether callers consume shared logic through workspace/source adapters or published package import paths during local development

The durable phase doc should capture the subset that a fresh human or agent should read first: objective, why now, scope, non-goals, acceptance criteria, definition of done, validation approach, durable decisions, and open questions.

### 5. Review the merged phase plan adversarially

Write:
- `Phase Review` (`tmp/phases/phase-x/review.md`)

Use the template in [Review Template](../dev-loop/templates/review.md).
Ensure the durable phase doc still matches the reviewed plan; update [Phase Plan](../../docs/phases/phase-x.md) if the review changes accepted scope or criteria.

The review must check for:
- overreach beyond phase scope
- KISS/SRP/YAGNI violations
- missing tests
- weak validation
- unclear module boundaries
- hidden coupling to Pi runtime internals
- ambiguous acceptance criteria
- unclear or incomplete definition-of-done output
- missing review-surface completeness
- weak RFC-escalation sanity when the plan surfaces an unresolved technical decision
- for bounded audits/scans: missing prioritization or quiet expansion into a broad rewrite
- for new CLI surfaces: weak malformed-argument or error-contract coverage
- for watcher/predicate-heavy behavior: weak timeout semantics or missing negative-case tests for non-target activity
- for package-first phases: ambiguous source-loaded workspace integration boundaries that leave local scripts/tests guessing how shared helpers are consumed

If the review finds real issues, revise the merged plan and briefly update the review.

### 6. Only then start implementation

<!-- rule: LOCAL-PLAN-REVIEW-GATE -->
You MUST NOT begin coding before the merged phase plan has passed review.
Update `manifest.json` to show that phase implementation has started.

## Task breakdown & delegation

After the merged phase plan passes review and before implementation starts, break the phase
into parallel executable tasks and dispatch them to the right specialist subagents.

### Task decomposition

1. Read the merged phase plan and identify independent work slices.
2. Break each slice into a discrete task with explicit acceptance criteria, required files,
   and expected verification.
3. Prefer parallel dispatch of non-overlapping tasks.
4. Treat task ordering as: parallel-independent work first, then dependent work that requires
   a prior task's output.

### Delegation contract

<!-- rule: LOCAL-DELEGATION-TABLE -->
Implementation tasks MUST be dispatched to dedicated specialist agents per this table:

| Task type | Delegate to |
|---|---|
| Code changes, refactors, tests, bug fixes, feature work | `developer` |
| Build systems, CI, test runners, type-checking, linting | `quality` |
| README, plan docs, agent docs, migration notes | `docs` |
| Review-comment follow-up, PR fix commits | `fixer` |

For each delegated task:
- give the subagent one focused task with exact success criteria
- include only the minimum relevant files, plans, and repo context
- tell the subagent whether it should implement, verify, or review
- require the subagent to report blockers, verification results, and changed files
- avoid circular delegation and overlapping scopes

### Status monitoring

Track each dispatched task:
- at minimum record agent name, task summary, status (`queued`, `running`, `done`, `failed`),
  and output artifacts
- when tasks are dispatched asynchronously, check status periodically
- if a subagent exits while the task is still non-terminal, resume or re-dispatch

### Consolidation

After all dispatched tasks complete:
1. Collect results and verification output from each task.
2. Review that each task's acceptance criteria are genuinely satisfied.
3. Resolve any coordination gaps or overlapping changes.
4. Proceed to the implementation loop for the phase once all tasks are green.

## Subagent summary logging

If subagents are used for planning, review, research, or implementation support:

Create one summary file per subagent run under:
- `tmp/phases/phase-x/subagents/`

Recommended naming:
- `001-planner.md`
- `002-reviewer-correctness.md`
- `003-reviewer-maintainability.md`
- `004-worker-followup.md`

Each summary must include a machine-readable header block using bullet-key format so
`conductor-monitor.mjs` can detect and parse local phase subagent state:

```
- agent name: <developer|quality|docs|review|refiner|fixer>
- status: <queued|running|completed|failed|paused>
- run id: <subagent-run-id>
- task: <one-line task summary>
- cwd: <working directory>
```

Only `agent name` and `status` are required for conductor-monitor detection; the
other fields improve resume-plan quality. The header block must start at the
beginning of a line (no leading whitespace before the bullet).

Below the header, include human-readable context:
- whether it was sync or async
- why it was used
- main findings or output
- files or artifacts it influenced
- whether its advice was accepted, partially accepted, or rejected
- raw output path if output was saved separately

If the subagent ran asynchronously, update its summary when results arrive so fresh sessions can understand what happened without replaying the whole conversation.

## Workflow-run subagent hand-off contract

When handing off a full workflow run to a subagent (draft PR → gates → Copilot → merge),
use the canonical hand-off contract. Do not rely on abbreviated task summaries or operator
memory.

The canonical contract is [Workflow Handoff Contract](../docs/workflow-handoff-contract.md) (source-tree path: `skills/docs/workflow-handoff-contract.md`). It includes:
- direct contract-doc references the subagent must read before executing
- a mandatory 8-step checklist (draft PR → draft_gate → ready → Copilot → resolve → pre_approval_gate → merge)
- non-negotiable invariants (Copilot review loop between gates, `unresolvedThreadCount === 0`, visible gate comments)

For all GitHub-first routed follow-up (`copilot_pr_followup`, `issue_intake`), the
 `local-implementation` skill uses this template when delegating the full run to a subagent.
Reference it by path, not by memory.

## Implementation loop for the phase

After the phase plan passes review:

1. Write or update tests first.
2. Implement only enough code for the current phase.
3. Run local validation:
   - `npm run verify`
   - when a narrower local check is more honest for the touched slice, say so explicitly and run the narrowest justified subset instead of pretending the full verify path was unnecessary
   - for a *rendered* HTML artifact (a deck `docs/presentations/*.html`, an article `docs/articles/*.html`, or the inspect-run viewer source) UI e2e coverage is **required and auto-scoped** — not opt-in. Touching one obliges you to register it in the shared harness and have a passing UI e2e suite, or the gate fails closed (see [UI e2e scoping step](../docs/ui-e2e-scoping-step.md)); run the matching shared suite locally, e.g. `npm run test:playwright:intro-deck` / `:intro-article` / `:viewer`. For a bespoke local UI surface that is not a registered rendered artifact, the WebKit smoke seam (fixture-backed Playwright WebKit plus screenshot capture) remains available without being mandatory
   - **Commit immediately after validation passes.** Once `npm run verify` (or the narrowest justified validation subset) is green, stage and commit the current slice of work with an atomic commit message. For tracker-backed sessions, also push the commit. In non-interactive subagent sessions, commit authorization is implicit — the subagent was dispatched to implement and must commit before exiting. In interactive sessions, wait for coordination agent authorization. Do not defer commits — uncommitted changes when the session terminates are a workflow defect.
4. Review the implementation against the merged phase plan.
5. Run the default pre-approval gate as a full review / fix loop on the branch before calling it review-complete, approval-ready, merge-ready, or ready for final handoff:
   - resolve review angles from config: `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config` (shipped defaults enable all 11 pre-approval gate angle families; consumer repos may opt out individual angles via `excludeAngles`); run via the chain prescription below
   - run the resolved angle-focused passes in parallel with fresh context when practical
   - the sequential-fallback rule is owned by `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK` in [Gate Review Sub-Loop Contract](../../docs/gate-review-sub-loop-contract.md); when it applies, record the fallback in `Phase Review` (`tmp/phases/phase-x/review.md`) (or the equivalent merged review artifact)
   - for each angle, resolve its persona and prompt via `resolveReviewerRole(config, angle)` — start each reviewer in fresh context with a concise briefing including the angle-specific prompt, the branch/phase, intended behavior, acceptance criteria, relevant files or artifacts, and current validation status
   - run the mandatory chain defined in [Gate Review Sub-Loop Contract](../../docs/gate-review-sub-loop-contract.md). Retry rule: in subsequent cycles, only re-run reviewers that produced findings in the previous pass. Do not fork the parent session for parallel reviewers; write a compact handoff artifact under `tmp/` and point the reviewer at it.
   - when reviewer subagents stumble on raw source-tree reads (for example unresolved build artifacts or import assumptions), generate a deterministic diff/review artifact under `tmp/` and have reviewers inspect that artifact instead of the raw file set
   - synthesize actionable findings
   - apply accepted fixes on the same branch
   - rerun validation after fixes
   - log review artifacts and subagent summaries under `tmp/`
6. Update [Phase Plan](../../docs/phases/phase-x.md) so it reflects the phase as actually implemented, including any accepted scope or validation changes.
7. Update [Project Plan](../../PLAN.md) when the phase changed durable product truth, resolved an open question, or made the shipped command/behavior surface more concrete.
8. Write `Phase Summary` (`tmp/phases/phase-x/summary.md`) using [Phase Summary Template](../dev-loop/templates/phase-summary.md).
9. Write `Retrospective` (`tmp/phases/phase-x/retrospective.md`) using [Retrospective Template](../dev-loop/templates/retrospective.md).
10. Update `tmp/phases/phase-x/manifest.json` and `tmp/phases/index.json`.
11. Update [Implementation State](../../docs/IMPLEMENTATION_STATE.md).
12. <!-- rule: LOCAL-COMMIT-BEFORE-EXIT --> **Exit validation gate — no uncommitted changes.** Before the subagent session terminates, run `git status --porcelain` and verify the output is empty. If uncommitted changes exist, first determine whether they are intended implementation changes or unintended/post-validation deltas. Revert any unintended or speculative changes. For intended changes, rerun the narrowest justified validation (`npm run verify` or equivalent) before staging and committing with an appropriate message; for tracker-backed sessions, also push the branch. A subagent session that exits with uncommitted changes in the worktree is a workflow defect and MUST NOT be treated as a clean completion. After committing, verify `git status --porcelain` is empty before declaring phase completion.
13. For tracker-backed sessions, create the PR from the working branch: `dev-loops pr create --assignee @me --repo <owner/name> --base main --head <branch> --title "..." --body-file <body-file>` (fallback when the CLI helper is unavailable: `node <resolved-skill-scripts>/github/create-pr.mjs --repo <owner/name> --assignee @me --base main --head <branch> --title "..." --body-file <body-file>`); never raw `gh pr create`. Draft/assignment/`Closes #N` policy: [LOCAL-PR-CREATE-CANONICAL](#tracker-backed-local-implementation) above.
14. If authorized, merge the fully reviewed, locally validated phase branch back into local `main` (phase-doc-backed sessions) or proceed through the PR gate pipeline (tracker-backed sessions).
15. If authorization for PR creation or merge is still pending (commit authorization is already enforced by the exit validation gate in step 12), mark the phase as `awaiting-finalization` rather than `completed`, and record exactly which finalization step is pending.

## Retrospective requirements

The retrospective must capture:
- what worked well in the local dev loop
- what caused friction or waste
- whether the fan-out/fan-in/review loop improved the phase
- what should change in the skill or workflow next time
- what a fresh session should know before the next phase

<!-- rule: LOCAL-RETROSPECTIVE-REQUIRED -->
This is the infrastructure for self-improvement; you MUST NOT skip it.

## Dev mode

Dev mode improves the local implementation loop itself while using it. A repo may declare a default via `.devloops` field `workflow.devModeDefault`; explicit user opt-in/opt-out for the current run still wins over that default. Trigger it when the user explicitly asks for dev mode, self-improvement mode, or says they want the skill to refine itself as it goes.

After the normal phase summary and retrospective, run one extra bounded self-improvement pass:

1. Collect a deterministic context bundle: `../dev-loop/scripts/dev-mode-context.mjs` → `tmp/phases/phase-x/dev-mode-context.json`.
2. Review the phase artifacts/logs for planning quality, review quality, validation friction, bash exit-code-1 patterns, and places where prompts or deterministic tooling should improve.
3. Write `Dev Mode Retrospective` (`tmp/phases/phase-x/dev-mode-retrospective.md`) — required; name the highest-value prompt/workflow follow-ups revealed by the phase.
4. Optionally write `Dev Mode Review` (`tmp/phases/phase-x/dev-mode-review.md`) when separate analytical notes help.
5. Apply at least one bounded follow-up update to a relevant skill and/or agent prompt (supporting tooling/docs/template changes may accompany it but do not replace the prompt update), kept phase-bounded and tied directly to the retrospective findings.
6. Write `Dev Mode Skill Changes` (`tmp/phases/phase-x/dev-mode-skill-changes.md`) recording which prompts and supporting changes landed; if no prompt update can be justified safely, stop and report that dev-mode exit criteria were not met.
7. If skill scripts or deterministic tooling changed, rerun the skill-local tests.
8. Stop after this bounded pass — do not recurse into endless self-editing loops.

Dev mode is still phase-bounded: it improves the loop around the completed phase and does not authorize work on the next product phase.

## tmp/ logging requirements

<!-- rule: LOCAL-TMP-EPHEMERAL-STATE -->
The required durable-doc + `tmp/` artifact set for a phase is defined once in [Deterministic logging structure](#deterministic-logging-structure); this section MUST NOT duplicate that list. Those artifacts are normally temporary and do not need to be checked into git; do not force-add them unless the user explicitly wants checked-in examples or fixtures. Also log validation output summaries and notable decisions if they help evaluate the local dev loop later.

Additionally, append every bash call that exits with code `1` to `tmp/phases/phase-x/bash-exit-1.jsonl` using the deterministic helper `../dev-loop/scripts/log-bash-exit-1.mjs`. Each line is one JSON object with at least `timestamp`, `phase`, `cwd`, `command`, `exitCode`, `purpose`, `summary` (optionally truncated `stdout`/`stderr` or a path to a larger saved artifact). This log improves the local dev loop itself, so do not skip it just because the command was exploratory.

## Stop conditions

See [Stop Conditions](../docs/stop-conditions.md). Local-specific stops: phase completed & finalized, next-phase refinement needed, user/main-agent approval required, validation failure needing direction change.

## Branch / review / merge policy

- Implement on a dedicated local working branch, never directly on `main`, switching to it before the first mutating step; if the repo is unborn (no commits yet), still create the working branch first and make the initial atomic commits there.
- Use atomic local commits to log progress, but only for coherent reviewable slices — [Commit policy](#commit-policy) below governs commit timing/authorization.
- Before merging, run a full parallel review / fix loop and resolve accepted findings on the same branch; rerun validation after review-driven fixes.
- A phase is not operationally closed until its branch state is captured in commit history and the reviewed branch has been finalized according to session type (merged into local `main` for phase-doc-backed sessions; merged via GitHub PR for tracker-backed sessions); when authorization for that finalization is still pending, record the phase as `awaiting-finalization` and describe the exact missing step.
- For tracker-backed sessions, the handoff path is always: push the working branch → open a PR → merge via GitHub; never merge the working branch into local `main`. PR creation follows [LOCAL-PR-CREATE-CANONICAL](#tracker-backed-local-implementation) above; a new PR must exist in draft before `gh pr ready` is eligible.
- For phase-doc-backed sessions, merge the fully reviewed, locally validated branch back into local `main` when authorized.
- Behind-branch integration before merge (for example a sibling PR merged first and both touch shared files): prefer a merge commit (`git merge origin/main`) over rebase + force-push. Since dev-loop PRs are squash-merged, intermediate branch history is discarded at merge time, so a merge commit lands an identical result on `main` while avoiding a non-fast-forward push to the remote. Force-push (`--force-with-lease` only, never bare `--force`) remains acceptable only for a branch the loop solely owns and where no integration alternative exists (rare); document that carve-out rather than leaving it implicit. After any integration that changes the head SHA, re-verify gate evidence at the new head (existing behavior — see [Merge Preconditions](../docs/merge-preconditions.md#required-before-merge)).

## Commit policy

- Do not commit speculative work or before the relevant validation for that slice passes.
- Immediately before every `git add && git commit` sequence, assert branch identity with `git branch --show-current` and stop if it does not match the intended local working branch.
- Commit only when the coordination/main agent has decided the slice or phase is ready. **Exception:** in non-interactive subagent sessions, commit authorization is implicit — the subagent was dispatched to implement and must commit before exiting, enforced by [LOCAL-COMMIT-BEFORE-EXIT](#implementation-loop-for-the-phase) (implementation loop step 12; `git status --porcelain` must be empty before the session terminates).
- If commit/merge authorization has not yet been given, do not call the phase `completed`; call it `awaiting-finalization` instead.

## Anti-patterns

See [Anti-patterns](../docs/anti-patterns.md). Local-specific: don't assume optional plan docs exist, don't guess through missing plan details, don't skip fan-out/fan-in, don't skip `tmp/` artifacts, don't use subagents without readable summaries.
