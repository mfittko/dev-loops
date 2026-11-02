# 0227. Judge work order carries the verdict schema and the pull owns the digest check

## Status

Accepted — 2026-11-02 ([issue 2678](https://github.com/mfittko/dev-loops/issues/2678)).

Extends [0106](0106-workers-pull-deterministic-work-orders.md) for the judge work-order content. Accepted records remain unchanged.

## Context

A judge searched the source tree to learn the spec-authority verdict shape, tried a digest tool the read-only boundary denies, and was told to use `Read/Grep/Glob` although Grep and Glob are not always available. The pull already verifies the sha256 of every required read.

## Decision

1. `SPEC_AUTHORITY_VERDICT_SCHEMA` in `packages/core/src/loop/spec-authority.mjs` lists the required and conditional verdict fields. Its value sets derive from the validator constants (`DIGEST_RE`, `HEAD_SHA_RE`, `SPEC_AUTHORITY_OUTCOME_VALUES`, `SPEC_AUTHORITY_CONFLICT_OUTCOMES`, `DEFECT_KINDS`). The field list and shape rules are maintained beside the validators.
2. The judge work order carries `outputSchemas`, keyed by the file name of each `outputRefs` path.
3. The pull owns the digest check. A changed read arrives as a pull refusal. The judge computes no digest and stops only when a read is missing or unreadable.
4. The judge denial names `Read` as the always-available file tool, and Grep and Glob only when available.
5. The read-only boundary is unchanged: the judge still cannot run a digest tool.

## Consequences

A judge builds a valid verdict from the work order alone. The schema is pinned into the work order at emission. A validator change reaches a judge through a re-emitted work order.
