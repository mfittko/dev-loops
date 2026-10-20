# 0175. Own the model tier policy's shape, not the operator's model id

## Status

Proposed

## Context

[ADR 0167](./0167-pi-pre-push-reviewer-enabled-model.md) pinned this repo's Pi pre-push reviewer to one concrete model id, and the repo-level contract test pinned the same literal in four places. The pin had a good origin: a wrong or paid model id used to pass the test by self-consistency, because the assertion read the expected value back out of the config under test. But it pinned the operator's current model choice, and the repo does not own that choice. The consequence was a shape mismatch: switching the Pi review model required TWO tracked edits — the `.devloops` tier value AND the test file — so a one-line operator preference change could not ship as a config-only change.

The repo does own the tier STRUCTURE: which role resolves to which tier, which harness key carries a concrete model, and that the review tier is a distinct model from the cheap tier the reviewers check. That structure is the invariant worth guarding. The concrete id is a per-operator, per-week preference that changes independently of the repo's policy.

## Decision

Keep the concrete Pi model id tracked in `.devloops` and stop pinning it in the repo-level contract test. The contract test asserts the tier policy's STRUCTURE against literals — the role-to-tier mapping, the presence of a concrete model on each harness key, and the resolution of every review role and gate angle to the tier's configured value — and it derives the expected model ids from the tiers the config under test declares, so a model switch never needs a test edit.

The test keeps a non-vacuity floor: the review tier must carry a concrete provider-qualified model id, it must differ from the cheap tier's id, and the Claude side must still resolve to the repository's own `sonnet` and `opus` tokens. A config with no Pi opt-in, a wrong role-to-tier mapping, or a missing harness key therefore still fails the test, while a different model id alone does not.

Rejected alternatives:

- Pinning the concrete model id as a literal. It guards the operator's weekly preference, not the repository's policy, and forces a second tracked file into every model switch.
- Moving the model out of the tracked `.devloops` into an untracked layer. Rejected: the operator keeps the model tracked so it ships as a lightweight PR, and a second config layer replaces the tracked tier map wholesale rather than merging into it.
- Dropping the repo-level contract test and relying on the resolver's unit coverage. The resolver's precedence is already covered exhaustively with synthetic configs; the repo-level test is where the repository's own structure is guarded.

## Consequences

Changing the Pi review model is now a `.devloops` edit alone and ships as a config-only change. The contract test still fails on a wrong tier mapping, a wrong role-to-tier mapping, a missing harness key or a config without a Pi opt-in, so the structure stays guarded; the concrete id is no longer guarded, which is the intended trade.

The superseded record [0167](./0167-pi-pre-push-reviewer-enabled-model.md) keeps its history: it recorded a correct one-time correction of an unavailable model id, and that correction is now expressed as a policy shape rather than an id.
