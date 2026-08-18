# 0050. Run this repo with humanMergeOnly off: the agent merges on a full gate pass

## Status

Accepted — 2026-08-18 ([PR 1747](https://github.com/mfittko/dev-loops/pull/1747))

## Context

[ADR 0007](./0007-human-only-merge-authority.md) hardened `autonomy.humanMergeOnly` as a repo-level invariant: when set, the agent never runs `gh pr merge`, and every merge is a human click. The shipped extension default enables it. Its Consequences section describes that posture as "the final merge is always a human action". By August 2026 the gate pipeline had grown a stronger standing check than the click it guarded: draft and pre-approval verdicts posted per head by fan-out review with judge disposition, fail-closed evidence audits over both verdict surfaces, thread-resolution enforcement, and CI gating. During the rc.7 drive the operator concluded the per-merge click added latency without adding safety and directed the change in-session (operator instruction, 2026-08-18, recorded in the PR that carries this record).

## Decision

We run this repository with `autonomy.humanMergeOnly: false`: the agent executes `gh pr merge` itself once the full gate pipeline passes — clean `draft_gate` and `pre_approval_gate` verdicts at the current head, zero unresolved review threads, a green two-surface gate-evidence audit, and green CI. The standing authorization is the gate contract, not a per-PR message. ADR 0007's mechanism is unchanged and not superseded: the knob, the single authoritative resolver, and its fail-closed behavior (a broken config denies merge) remain the enforcement path; this record changes only the value this repo sets. We rejected removing the knob (other repos legitimately want the invariant) and rejected a per-PR chat authorization (it reintroduces the latency without strengthening the check).

## Consequences

Merge latency drops to the gate pipeline's own wall time; unattended queue drives can complete a cycle end to end. The gate pipeline is now the last line before main: weakening any gate precondition weakens merge safety directly, so gate-contract changes deserve the scrutiny previously reserved for merge authorization. The mandatory post-merge duties become load-bearing rather than advisory: main push workflows verified green at every merge commit, and the substantive post-merge retrospective. A repo that wants the old posture back flips the one config value; the fail-closed machinery of ADR 0007 is still there to enforce it.
