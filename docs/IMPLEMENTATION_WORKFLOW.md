# Implementation workflow

Canonical owner for the local-vs-GitHub-first implementation workflow layering in this repository.

This repository supports both a local phased workflow and a GitHub-first remote workflow.

## Repo-level workflow preference

Use these defaults unless the user explicitly asks for something else:
- use **`dev-loop`** as the single public workflow entrypoint
- prefer the GitHub-first routed path for active implementation and release work
- use the local implementation strategy for phase-bounded local planning/implementation only when explicitly requested

Authority split:
- [Public Dev Loop Contract](../skills/docs/public-dev-loop-contract.md) owns the public routing/shorthand contract
- this file owns workflow layering, source-of-truth boundaries, and the local phase process
- internal compatibility/routed strategy details stay behind that public contract rather than acting as peer public entrypoints

## Layers of truth

### 1. GitHub issues and PRs

Use GitHub as the backlog and execution trail for GitHub-first work:
- issues are the backlog
- PRs are the execution and review trail
- issue/PR comments are the durable discussion trail for remote-loop work

Do not invent a parallel backlog file for active GitHub-first execution.

### 2. [Project Plan](../PLAN.md)

Use for durable repo/product/architecture/roadmap truth.

Do not turn [Project Plan](../PLAN.md) into an issue-level implementation checklist.

### 3. [Implementation State](./IMPLEMENTATION_STATE.md)

Use for the current repo execution snapshot:
- which phase is active
- what a fresh session should read first
- which workflow mode is expected next

### 4. `Phase Plan` (`docs/phases/phase-<n>.md`)

Use for the durable plan for one phase-doc-backed local phase:
- why the phase exists now
- in-scope work
- explicit non-goals
- acceptance criteria
- definition of done
- validation approach
- durable decisions and open questions

A fresh human or agent should be able to read the active phase doc first and understand the current local-phase intent without replaying `tmp/` artifacts.

### 4a. Tracker-backed local issue spec

For tracker-backed local sessions, the tracker issue is the durable canonical spec for the active local slice.

- resolve the tracker reference deterministically from a full GitHub issue URL or explicit `<owner/name>` + issue number
- use the bounded GitHub-backed helper path (`scripts/github/resolve-tracker-local-spec.mjs`) or the equivalent `node scripts/github/view-issue.mjs --repo <owner/name> --issue <number> --json number,title,body,url,state` call
- treat the tracker issue title/body/acceptance content as the local spec surface
- sync durable scope / acceptance / status changes back to the tracker issue
- do **not** also maintain `Phase Plan` (`docs/phases/phase-<n>.md`) for that same tracker-backed session

### 5. `tmp/`

Use for temporary execution artifacts and audit trails:
- planning variants
- merged plan drafts
- review notes
- retrospective notes
- subagent summaries
- deterministic logs
- proposal/intake artifacts

These files are normally local-only and do not need to be committed.

## Authority boundary for shipped behavior

For already-shipped helpers, CLIs, and extension commands:
- shipped helper/runtime semantics stay owned by code, tests, and the relevant contract docs
- [Scripts Documentation](../scripts/README.md) summarizes those semantics for operators and maintainers; it must be kept aligned with the implementation
- the narrower state-graph/contract docs under `docs/` remain part of the authoritative shipped contract surface for their helper families
- <!-- rule: WORKFLOW-DOCS-NO-REDEFINE-HELPER --> `WORKFLOW-DOCS-NO-REDEFINE-HELPER`: Skills and phase docs explain workflow procedure and durable planning intent; they MUST NOT silently redefine shipped helper behavior

Use workflow/phase docs to explain how to operate within the repository contract. Use code, tests, and helper contract docs to define what shipped runtime surfaces actually do.

## Documentation sync rule

When a merged slice changes durable repo truth, update the affected durable docs before treating the slice as closed.

Typical touched docs:
- [README](../README.md) when the shipped surface or usage contract changed
- [Project Plan](../PLAN.md) when durable roadmap/product truth changed
- [Implementation State](IMPLEMENTATION_STATE.md) when the current status, active phase, or fresh-session guidance changed
- [Implementation Workflow](./IMPLEMENTATION_WORKFLOW.md) when workflow preference or source-of-truth rules changed
- relevant contract/state-graph docs under `docs/` when a helper or workflow contract changed
- [Scripts Documentation](../scripts/README.md) when script surfaces, outputs, or supported entrypoints changed

Keep issue-specific execution plans in GitHub issues/PRs or `tmp/`, not in repo-level durable docs.

## Default operating rules for local phase work

When the user explicitly chooses the local phased path:
- work one phase at a time
- refine the active phase before coding it
- use the dedicated refiner role for phase-refinement work when available, while escalating RFC-worthy decisions to the parent session / human operator
- when the active local spec is tracker-backed, treat the tracker issue as canonical and do not bootstrap a duplicate phase doc
- keep durable decisions in docs and execution traces in `tmp/`
- use fan-out / fan-in / review before implementation
- write tests first for non-trivial changes
- validate locally before closing a phase
- prefer dedicated local branches over direct work on `main`
- treat phase closure as including review/fix, commit history capture, and merge back to local `main` when authorized

## Phase completion semantics

Use these terms consistently:
- `planning` / `in-progress` = the phase is still being refined or executed
- `awaiting-finalization` = scoped work, required support files, artifacts, and validation are done, but commit and/or merge steps are still pending authorization or execution
- `completed` = the phase is fully finalized, including commit history capture and merge back to local `main`

Do not mark a phase `completed` if the only thing left is “commit later” or “merge later.” In that case, mark it `awaiting-finalization` and record the missing step explicitly.

## Bootstrap/support expectation for the local phase path

The local phase workflow expects the repo to maintain:
- [Agent Instructions](../AGENTS.md)
- [Implementation State](IMPLEMENTATION_STATE.md)
- [Implementation Workflow](IMPLEMENTATION_WORKFLOW.md)
- `Phase Plan` (`docs/phases/phase-<n>.md`) for phase-doc-backed local sessions
- `tmp/phases/index.json`
- `tmp/phases/phase-<n>/...`

## Convention goal

The split is intentional:
- GitHub issues/PRs carry backlog and remote execution trail
- durable docs carry long-lived human-and-agent truth
- `tmp/` carries resumable execution detail and machine-friendly artifacts
