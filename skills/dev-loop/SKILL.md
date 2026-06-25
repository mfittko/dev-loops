---
name: dev-loop
description: >-
  Single public dev-loop entrypoint. Resolve canonical current state first,
  then load only route-specific internal skills.
user-invocable: true
compatibility: Pi skill for git+GitHub repositories. Requires gh auth; async follow-up works best in Pi/TelePi sessions.
allowed-tools: read bash edit write subagent review_loop
---

**No-implicit-start rule:** Never start implementation without explicit instruction.

**Work-origin rule:** All work must originate from a tracked artifact: a GitHub issue (tracker-first) or a persisted markdown plan file (local-planning). See [Artifact Authority Contract](../docs/artifact-authority-contract.md) for canonical mode definitions and settings. No work may originate from a PR or direct local change unless explicitly requested.

# Unified Dev Loop

This is the public `dev-loop` façade — a summary of the authoritative routing contract. The authoritative contract is [Public Dev Loop Contract](../docs/public-dev-loop-contract.md). Runtime evaluator: `@dev-loops/core/loop/public-dev-loop-routing`. For status/progress/readiness/merge-state/next-step queries, resolve authoritative artifact identity first; for issue targets, identity resolution is handled by the startup resolver. Fail closed to reconcile/unknown when unresolved. When an open linked PR exists, treat it as the single canonical artifact for the issue and reuse it instead of opening another PR.

## Installed skill layout

Required installed runtime contract docs are shared bundled copies under `../docs/` from this skill directory. Read those bundled `../docs/` files from the installed skill layout — do not assume a source checkout. If a required bundled contract doc is missing, treat it as a packaging/installer bug.

## Startup procedure

<!-- pi-only -->
### Main agent (read-only)

The main agent must **always** dispatch the `dev-loop` async subagent for any dev-loop work.
Do not run `dev-loops loop startup` or any startup resolver in the main agent.
For async-required routes (config `workflow.asyncStartMode`, default `required`) the resolver needs an async run-id marker (`DEVLOOPS_RUN_ID`, or the `PI_SUBAGENT_RUN_ID` alias) that the Pi harness injects when it dispatches the async subagent; under the Claude Code harness the requirement is relaxed automatically (no marker needed). The startup resolver also runs without a marker for non-async routes. Regardless, only the `dev-loop` subagent runs it — never the main agent.
<!-- /pi-only -->

### Resolve authoritative state

> Under the Claude Code harness the dev-loop runs as a single agent: run these steps directly — no read-only boundary and no separate async-subagent dispatch. See [Main Agent Contract](../docs/main-agent-contract.md).

<!-- pi-only -->
**CLI invocation (`<dev-loops-package-root>`):** dev-loop CLI commands below are invoked as `node <dev-loops-package-root>/cli/index.mjs <verb...>` using the package-local CLI rather than `npx`, so they resolve unambiguously from the installed package without a global install. Resolve `<dev-loops-package-root>` from this skill's own installed path: this skill is installed at `<package-root>/.pi/skills/dev-loop/SKILL.md`, so the package root is `../../..` from this skill's directory. (The `dev-loop` agent resolves it analogously from its own installed path.)
<!-- /pi-only -->

Resolve authoritative state via the startup resolver (`node <dev-loops-package-root>/cli/index.mjs loop startup --issue <n>` for issues, `node <dev-loops-package-root>/cli/index.mjs loop startup --pr <n>` for PRs), then immediately build the handoff envelope via `node <dev-loops-package-root>/cli/index.mjs loop build-envelope --input <resolver-output.json>`. The envelope determines `requiredReads`, `nextAction`, `stopRules`, and `acceptance` — load only those files, execute only that bounded task. It is the first handoff artifact consumed before loading any route pack. See [Workflow Handoff Contract](../docs/workflow-handoff-contract.md) for the derivation contract.

**Retrospective checkpoint gate:** the resolver reads `.pi/dev-loop-retrospective-checkpoint.json` and injects the state. When the checkpoint is `missing` and the repo config `workflow.requireRetrospective` (set via `.devloops` at repo root) is `true`, the resolver returns `needs_reconcile`. Complete or explicitly skip the retrospective before starting.

**Pre-flight PR gate (mandatory):** Before working an existing PR, the dev-loop must run `node scripts/loop/copilot-pr-handoff.mjs --repo <owner/name> --pr <number>` and abort if `action: "stop"`. When `terminal: true`, proceed inline. When `terminal: false`, resolve the blocking condition first.

**Worktree cwd (mandatory):** Always use a worktree checkout for git operations, file reads/writes, and validation commands — never use the `main` checkout.

**Worktree fetch (mandatory):** Always run `git fetch origin` before creating or reusing any worktree.

### Resume from existing loop state

When the startup resolver returns a fresh-start routing but an existing outer-loop checkpoint
(`tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json`) is present on disk, the
dev-loop must check the checkpoint before treating the start as a fresh intake or follow-up:

1. Read the outer-loop checkpoint (authored by `outer-loop.mjs`).
2. If `outerAction` is `continue_wait`, `reenter_copilot_loop`, or `reenter_reviewer_loop`:
   - Skip issue-intake normalization or fresh-intake routing.
   - Route directly to the existing PR's follow-up path (the PR number is in the
     checkpoint's `pr` field). For `reenter_copilot_loop`, enter the copilot-pr-followup
     path. For `reenter_reviewer_loop`, enter the reviewer-loop path.
   - Use the checkpoint's `copilotState` and `reviewerState` as last-known context for
     re-attachment, then re-baseline with fresh detectors (`copilot-pr-handoff.mjs`
     or `detect-copilot-loop-state.mjs`) before acting on the state.
3. If `outerAction` is `stop`:
   - Report the `reason` field and the authoritative state from the checkpoint.
   - `stop` means the loop is blocked or needs a human decision; ask for direction
     rather than guessing or starting fresh.
4. If no checkpoint exists, or `outerAction` is `done`:
   - Treat as normal fresh startup (the existing startup resolver path).

This eliminates the manual "report-and-resume" or "exit and resume later" pattern when the
deterministic state already knows the next action.

The outer-loop checkpoint is the canonical re-attachment artifact. Do not rely on chat
context, local notes, or prose recollection of "where we left off."

## Route table

Load only the route-specific internal skill required by `selectedStrategy`:

| Strategy | Route pack to load |
| --- | --- |
| `local_implementation` | [Local Implementation Skill](../local-implementation/SKILL.md) |
| `issue_intake` | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](../docs/copilot-loop-operations.md) + [Issue Intake Procedure](../docs/issue-intake-procedure.md) |
| `copilot_pr_followup` | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](../docs/copilot-loop-operations.md) |
| `external_pr_followup` | same as `copilot_pr_followup` |
| `reviewer_fixer` | same as `copilot_pr_followup` |
| `wait_watch` | same as `copilot_pr_followup` |
| `final_approval` | same as `copilot_pr_followup` + [Final Approval Skill](../final-approval/SKILL.md) |

Do not preload route packs before the resolver selects the strategy.

## Async dispatch

**Async dispatch rule (enforced):** the resolver fails closed for GitHub-first strategies when `canonicalStateSummary.requiresAsyncDispatch` is `true` (default `required` mode) — inline invocation without an async run-id marker (`DEVLOOPS_RUN_ID`, or the `PI_SUBAGENT_RUN_ID` alias) is rejected for those routes. Under the Claude Code harness this requirement is relaxed automatically. See [Startup procedure](#startup-procedure).


## Fallback gate-comment poster

When the `@dev-loops/core` package is not installed in the consumer repo, the full `scripts/github/upsert-checkpoint-verdict.mjs` helper (referenced from the copilot-pr-followup skill procedure) is unavailable. To keep the PR audit trail intact in that mode, the dev-loop skill ships a small gh-only fallback poster at `scripts/post-gate-verdict-fallback.mjs` (relative to the dev-loop skill root) that renders the same visible comment format and fails closed if posting cannot succeed.

Use the fallback poster only when the full helper cannot be reached:

1. Detect the missing helper: try `node scripts/github/upsert-checkpoint-verdict.mjs --help` from the consumer repo. If the script is absent or imports fail, switch to the fallback path.
2. Invoke the fallback from the installed dev-loop skill directory: `node <resolved-skill-scripts>/post-gate-verdict-fallback.mjs --repo <owner/name> --pr <number> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings-summary <text> | --findings-file <path>) --next-action <text> [--gate <draft_gate|pre_approval_gate>]`.
3. Treat every successful fallback-posted gate comment as a one-shot create with no idempotent same-head update: if the agent reruns the gate on the same head, a duplicate comment will be created. Detect duplicates manually and update manually if needed.
4. Treat every fallback-posted gate comment as a degraded audit-trail artifact: the visible body uses the same parser-stable shape as the full helper (gate name, head SHA, verdict, blocking severities when applicable, findings summary, next action), but the helper skips stale-head detection, gate-coordination validation, blocking-severity count enforcement, and the internal-only PR short-circuit.
5. If the fallback helper exits non-zero, stop the gate and report the posting failure: do not mark the PR ready for review and do not proceed to merge readiness until the comment is posted.

When `@dev-loops/core` is available again, switch back to the full helper. The fallback poster is a degraded path, not a permanent replacement.

## Read-only info shortcut

Info/handoff requests can be served directly via `node <dev-loops-package-root>/cli/index.mjs loop info` (read-only; no full dev-loop run required):
- `node <dev-loops-package-root>/cli/index.mjs loop info --issue <n>` — human-readable issue state summary (strategy, route, linked PR, next action)
- `node <dev-loops-package-root>/cli/index.mjs loop info --pr <n>` — human-readable PR state summary (branch, CI, threads, rounds, action)
- `node <dev-loops-package-root>/cli/index.mjs loop info --issue <n> --json` — machine-readable JSON output

## Guard rules

**Handoff envelope precedence:** The dev-loop builds the envelope immediately after authoritative-state resolution and treats it as the first handoff artifact. Read it first, load only `requiredReads`, execute `nextAction`. See [Resolve authoritative state](#resolve-authoritative-state). Derivation contract: [Workflow Handoff Contract](../docs/workflow-handoff-contract.md).

**Handoff contract rule:** When no envelope is present, use the `workflow-handoff-contract.md` contract. Never delegate with abbreviated task summaries. Include deterministic routing inputs, explicit `cwd`, bounded task scope, exit conditions.

**Inline-first rule:** Prefer inline commands over nested async delegation when managing a single PR. Use nested delegation only for parallel fan-out or when the parent needs to continue other work.

**Bounded async task contract:** Break work into discrete tasks with clear inputs, explicit outputs, bounded scope. No shell polling — use `run-watch-cycle.mjs` or `gh run watch`.

**Round-cap budget check (enforced):** After every watch cycle, fix pass, or reply-resolve, check whether completed Copilot review rounds have reached the maximum (default: 5). Stop re-requesting Copilot review when the limit is reached — never re-request after the cap.

## Shorthand issue-based auto trigger contract

- `auto dev loop on issue <n>` → public `dev-loop` intent `auto_continue_current` after authoritative current-state resolution
- Continue through GitHub/Copilot loop until stop condition or human approval checkpoint
- Stop at the human approval checkpoint by default unless merge explicitly authorized

## No gate exemptions

All PRs must pass the full gate pipeline before merge. No scope is exempt: docs-only, tooling, meta, configuration, internal-process — all require `draft_gate`, current-head `pre_approval_gate` evidence, and Copilot review (except internal-only PRs detected by path pattern, which skip the Copilot convergence requirement).

## Authority boundary

- Source code, tests, config, CI, and shared contract docs are authoritative.
- Main-agent delegation contract: [Main Agent Contract](../docs/main-agent-contract.md) — how dev-loop work is structured per harness (Pi: read-only main agent + async-subagent dispatch; Claude: a single agent runs the steps directly).
- Before any state-changing action, get explicit confirmation unless already authorized.
- A question requires an answer, not an action.
- Stop and ask rather than guessing when facts don't agree.
