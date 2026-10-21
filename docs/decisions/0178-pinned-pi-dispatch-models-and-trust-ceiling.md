# 0178. Pin Pi dispatch models per role tier and record the project-trust ceiling

## Status

Accepted — 2026-10-21 ([PR 2907](https://github.com/mfittko/dev-loops/pull/2907))

Relates to [0173](./0173-pi-agents-provision-time-render.md) and [0176](./0176-tier-distinctness-is-an-operator-model-choice.md). It amends neither and edits neither.

## Context

[Issue #2854](https://github.com/mfittko/dev-loops/issues/2854) slice 3. Rendered Pi project agents carried no `model:` line, so a dispatched child inherited the conductor's model. The preflight also cannot read Pi's project-trust state.

## Decision

- The provision-time render writes a quoted `model:` line into every Pi project agent that has a non-null Pi resolution for its role tier.
- `.devloops` `roleTiers` maps `dev-loop` and `gate-coordinator` to `low`, so their rendered Pi agents pin the low-tier model when Pi trusts the project. The Claude side keeps the built-in tier policy, where `dev-loop` inherits (`skills/docs/main-agent-contract.md`).
- Project-trust ceiling: the preflight cannot read Pi's project-trust state. A pinned `model:` line applies only when Pi trusts the project. The repo does not claim more than that.
- Full-mode pre-push briefs name the artifact paths, state the read-only evidence rule, and forbid `sed`, pipe-to-`head` and test execution.
- No file outside `.devloops` names a concrete model id (see 0176).

## Consequences

- Dispatched Pi children use the tier model chosen in `.devloops`.
- An untrusted project still falls back to Pi's default model. The trust gap stays visible.
