# 0150. Bind Delta to pulled raw coverage before completion emission

## Status

Accepted — 2026-10-15 ([issue 2784](https://github.com/mfittko/dev-loops/issues/2784))

## Context

The completion consumer in ADR 0149 needs the exact coverage a Delta reviewer saw.
Normalized coverage loses optional kind and empty-reason fields; a caller-supplied
file cannot prove that a real commit-only worker delivered it. Historical Delta
records contain no such attestation. The merged decision audit ends at 0149;
open PRs reserve 0140 and 0145. Accepted 0147–0149 remain unchanged.

## Decision

Amend the ACT Delta boundary of ADRs 0094 and 0131. Coordinator input and result
recording require the canonical current commit-only plan and its output. Authenticate
semantic identity, actual renderer/materialization bytes, original pull subject,
after-pull output, ACT bytes and semantic authority, branch, baseline and contained
candidate. Derive paths from the main checkout and emitted execution, never a copied
snapshot. Validate normalized coverage separately and retain raw coverage unchanged.

Input, result template, result and decision share `coverageProtocol:
"pulled_commit_only_v1"`, raw semantic `siteCoverageDigest`, exact
`handbackBytesDigest` and the `origin` identity triple. Result recording recomputes
this identity and refuses damage before invocation-three fallback. Matching stale
review evidence retains the existing bounded-out rule. Membership-only consumers
check structure; optional completion additionally checks real origin/report bytes.
Digest-only historical records remain legacy. The write-free fixer handback check
and narrow THREAD route retain their behavior; THREAD cannot claim this ACT binding.

## Consequences

Old records stay readable and unchanged; a new review of a genuine old unit confers
only new authority and refuses if its renderer invariant no longer reproduces.
This slice enables no optional full emission. Later children of issue 2765 own
bounded legacy qualification, populated full emission, immutable completion-only
reentry and real worker smoke before operational recovery in issue 2766. Recovery
must preserve old evidence and cannot grant a new source edit, commit or push.
