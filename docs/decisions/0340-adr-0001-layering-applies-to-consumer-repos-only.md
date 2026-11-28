# 0340. The ADR 0001 truth layering applies to consumer repos only

## Status

Accepted — 2026-11-28 ([issue 3476](https://github.com/mfittko/dev-loops/issues/3476)).

Amends [ADR 0001](./0001-layered-source-of-truth-workflow.md): this repository no longer keeps `PLAN.md`, `docs/IMPLEMENTATION_STATE.md`, `docs/IMPLEMENTATION_WORKFLOW.md` or `docs/phases/`. The layering stays the model that dev-loops teaches and bootstraps in consumer repos. The record that introduced the layering stays unedited.

## Context

ADR 0001 split repository truth into GitHub issues and PRs, a durable plan, an execution snapshot, a phase doc and `tmp/` artifacts. This repository followed that split with its own `PLAN.md`, `docs/IMPLEMENTATION_STATE.md`, `docs/IMPLEMENTATION_WORKFLOW.md` and two phase docs (phase 7 and phase 8). Work here now starts from GitHub issues and PR bodies (the tracker-first and lightweight modes of the [Artifact Authority Contract](../../skills/docs/artifact-authority-contract.md)). The state file named phase 8 as active long after the work moved to releases and milestones, and the three docs restated each other. Each phase change made the other docs stale again. Issue 3077 proposed to retire the flow.

The templates under `skills/dev-loop/templates/` bootstrap the same layering in a consumer repo, and `skills/local-implementation/SKILL.md` runs it there. Those paths stay.

## Decision

- ADR 0001 applies to a consumer repo that adopts the local phase flow. It does not bind this repository.
- This repository deletes `PLAN.md`, `docs/IMPLEMENTATION_STATE.md`, `docs/IMPLEMENTATION_WORKFLOW.md`, `docs/phases/phase-7.md`, `docs/phases/phase-8.md` and the two other files under `docs/phases/`. GitHub issues, PR bodies, ADRs and the contracts under `skills/docs/` own this repository's truth.
- `WORKFLOW-DOCS-NO-REDEFINE-HELPER` keeps its text and ID. Its owner moves to `skills/docs/contract-style-guide.md`.
- The consumer bootstrap templates and the generic `docs/phases/phase-<n>.md` paths in `skills/docs/` stay.

## Consequences

A fresh agent in this repository reads `AGENTS.md` and the startup `requiredReads`, and no longer meets a stale phase snapshot. The `AGENTS.md` rule "Implement one phase at a time" stays for work that uses phase docs. A reader of ADR 0001 must treat its `PLAN.md` and state-file text as guidance for consumer repos.
