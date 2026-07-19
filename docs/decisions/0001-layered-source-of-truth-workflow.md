# 0001. Layer repository truth across GitHub, durable docs, and tmp/ artifacts

## Status

Accepted

## Context

The repo supports two workflows side by side: a local phased workflow driven by phase docs and a GitHub-first remote workflow driven by issues and PRs (`docs/IMPLEMENTATION_WORKFLOW.md`). With both active, four kinds of truth — durable roadmap decisions, backlog, current execution snapshot, and ephemeral run artifacts — were at risk of blurring into one another. Parallel backlog files started appearing alongside GitHub issues, and workflow/phase docs began restating (and drifting from) the behavior of already-shipped helpers whose semantics are owned by code and tests. `PLAN.md`, `docs/IMPLEMENTATION_STATE.md`, and `docs/index.md` each carried partial answers to "where does this fact live," but nothing made the split binding, dating from the 2026-05-12 workflow bootstrap.

## Decision

We split repository truth into fixed layers, each owning one kind of fact. GitHub issues own the backlog and PRs own the execution and review trail; we reject parallel backlog files for active GitHub-first work. `PLAN.md` owns durable repo/product/architecture/roadmap truth and we reject turning it into an issue-level implementation checklist. `docs/IMPLEMENTATION_STATE.md` is the current execution snapshot: active phase, fresh-session read order, and expected next workflow mode. A local session uses exactly one durable spec surface — a phase doc (`docs/phases/phase-<n>.md`) or a tracker-backed issue spec, never both — and `tmp/` holds uncommitted execution artifacts such as planning variants, review notes, and deterministic logs. Rule `WORKFLOW-DOCS-NO-REDEFINE-HELPER` completes the split: workflow and phase docs explain procedure and planning intent but must not silently redefine shipped helper behavior, which stays owned by code, tests, and the helper contract docs.

## Consequences

Every new fact has exactly one legal home, so a parallel backlog file or a phase doc that respecifies runtime behavior is a contract violation, not a judgment call. Fresh humans and agents get a legible taxonomy: read the state snapshot, then the one active spec surface, without replaying `tmp/`. Merged slices that change durable truth must sync the affected durable docs before the slice counts as closed, which adds ceremony in deciding where a fact belongs. The rule side is enforceable — `WORKFLOW-DOCS-NO-REDEFINE-HELPER` is registered in `skills/docs/required-rules.json` — while the layering itself relies on review discipline.
