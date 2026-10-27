# 0198. Spec-authority verdicts expand cluster-keyed decisions

## Status

Accepted — 2026-10-27 ([issue 2903](https://github.com/mfittko/dev-loops/issues/2903))

## Context

The judge keys its decisions by `clusterId`. `validateSpecAuthorityVerdict` required one decision per finding position. On PR 2940, two review angles reported one defect. The judge returned one cluster decision, and the validator refused the verdict.

## Decision

- `validateSpecAuthorityVerdict` expands a cluster-keyed decision to each member of the cluster before it checks coverage (`SPEC-AUTHORITY-CLUSTER-EXPANSION`).
- A finding that no decision covers refuses with `spec_authority_uncovered_finding`.
- A cluster whose members receive conflicting decisions refuses with `spec_authority_cluster_conflict`.
- The judge brief keeps cluster keying.

## Consequences

The validator is the single owner of the keying rule. Dispositions and caps are unchanged.
