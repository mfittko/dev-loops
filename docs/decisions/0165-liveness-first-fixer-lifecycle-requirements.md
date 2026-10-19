# 0165. Liveness-first fixer lifecycle requirements

## Status

Accepted — 2026-10-19 ([issue 2787](https://github.com/mfittko/dev-loops/issues/2787))

## Context

Amends [0155](./0155-advisory-fixer-disposition-boundary.md), [0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md), [0131](./0131-pre-push-delta-thread-route-and-decision-record.md), [0143](./0143-gate-fix-push-authority.md) and [0149](./0149-authenticated-fixer-completion-construction.md). Their bodies stay unedited. <!-- secret-scan:allow ADR file link, not a credential -->

The gate fix loop assumes that only the fixer commits, and only from an emitted work order. Every evidence record binds to the fixer's latest commit. Any other event makes the next check refuse, and no sanctioned exit exists. In the v1.0.7 drain this deadlocked or nearly deadlocked nine PRs. About ten fixer re-dispatches came from the push and `--construct` order alone. ADR 0155 made the boundary advisory as a stopgap and named this redesign.

The numbering check found 0165 free on origin/main.

## Decision

Six requirements govern every slice of issue 2787.

1. The whole fix loop is one state machine. Every fail-closed state has a sanctioned exit, and a test proves that the exit exists.
2. Evidence follows the head, not the role that made the commit. A developer commit, a CI fix, a commit with nothing to fix and a base merge are events with a defined transition.
3. Findings outside the act list (delta residue, new findings on the thread route, CI failures) can enter a fixer order.
4. Tooling produces the fixer report and the disposition. Agents never construct or hand-write either one.
5. A full gate round on the live head is always the fallback authority. It replaces any skipped intermediate evidence. A carried or recovered disposition never satisfies a gate verdict.
6. Every full-phase work order states numbered steps: push the candidate, confirm the remote head, wait for green CI, then `--construct`, then verify.

Slice 1 implements requirements 4 and 6 and the red-CI exit. Every full-phase order (ACT, THREAD, completion) renders the numbered steps and the Edit/Write-only rule. `verify-fixer-disposition.mjs --construct` builds the THREAD report, and normal and `--check` modes accept only a report that its own `--construct` wrote. They refuse unless the head's checks are observed and settled green. The sidecar mark on a constructed report is a deterrent, not authentication. No shell-parsing hook is added (ADR 0107 and issue 2534 rationale).

## Consequences

The fixer follows one ordered procedure on every full-phase order, and a hand-written report is refused with the sanctioned command named. Later slices add the state machine and the head-follow transitions, then re-arm the fail-closed boundary of ADR 0155 once no transition lacks a verified exit.
