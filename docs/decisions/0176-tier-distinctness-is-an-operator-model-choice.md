# 0176. Tier distinctness is an operator model choice, not a repo invariant

## Status

Accepted — 2026-10-21 ([PR 2902](https://github.com/mfittko/dev-loops/pull/2902))

Amends [0175](./0175-tier-policy-shape-owned-by-the-repo-not-the-model-id.md): the requirement that the review tier's model id differs from the cheap tier's leaves the repo-owned structural invariant and becomes a recommendation.

## Context

0175 assigns concrete model choice to the operator and keeps the policy shape in the repo. It still listed tier distinctness (review tier model id differs from the cheap tier's) as part of the shape. Whether two tiers use the same model is a model-choice preference, so the guard blocks an operator choice that 0175 reserves for the operator.

## Decision

The repo guards only the structure: the role-to-tier mapping, a harness key on every tier, a concrete provider-qualified model id on the Pi side, and the sonnet and opus tokens on Claude. Tier distinctness is no longer asserted. Prose may recommend distinct review and cheap models.

## Consequences

- An operator can point every Pi tier at one model with a `.devloops` edit only.
- A wrong role mapping, a missing harness key or a malformed Pi model id still fails the contract test.
- The review tier is no longer guaranteed to differ from the cheap tier.
