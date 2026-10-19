# 0161. A branch marker covers only a push to its own branch

## Status

Accepted — 2026-10-19 ([issue 2787](https://github.com/mfittko/dev-loops/issues/2787))

## Context

Amends [0143](./0143-gate-fix-push-authority.md): it decided that a fix-sequence marker is active for a tested commit that is the baseline or descends from it, whatever ref the push targets. A stacked branch B descends from the baseline of branch A. A push of B was refused under the marker of A. Record 0143 stays unedited. <!-- secret-scan:allow ADR file link, not a credential -->

## Decision

- A fix-sequence marker that names a branch covers a push only when the push target is that branch (`remoteRef === refs/heads/<branch>`) or the push target is unknown. The ancestry test then applies as before.
- A branchless or malformed marker stays fail-closed. A branch value that fails the git ref-name check (for example empty, whitespace-padded or `HEAD`) reads as branchless.
- `PRE-PUSH-DELTA-PUSH-AUTHORITY` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md) records the rule.

## Consequences

A stacked branch pushes without being refused under the marker of its base branch.

A tag push, and a push of the fix commit to another ref name, is no longer covered by a branch marker. This is deliberate.

The inline shell fallback of the hook is unchanged. It still refuses on any open marker.
