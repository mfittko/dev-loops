# 0170. A head-pinned validation record replaces gate-run validation

## Status

Accepted — 2026-10-20 ([issue 2866](https://github.com/mfittko/dev-loops/issues/2866))

Amends [0105](./0105-targeted-validation-and-full-run-authority.md): the producer of the validation record is a sanctioned local run launcher. Amends [0137](./0137-validation-modes-and-consumer-configured-commands.md): the validation mode selects the producer, and the gate runs no suite. Amends [0163](./0163-same-head-validation-artifact-reuse.md): head records replace cross-gate artifact reuse. The records that introduced those rules stay unedited.

## Context

Gate rounds in `local` mode run the full suite inside the round preamble. PR 2856 spent 21.8 of 44.7 gate minutes on five full runs. Record 0163 reuses a passing artifact across lifecycle gates, but a re-round of the same gate and the first push before the PR exists still miss it.

## Decision

- A `head_validation_record` lifecycle node holds one validation record per pushed head. A record is a JSON file at `tmp/validation-records/<owner>/<repo>/<headSha>.json` with repo, head SHA, producer, profile, toolchain, requested suites, suites with exit codes, the PR title the suites consumed and `generatedAt`. A record has no PR number, because the first push happens before the PR exists. The core module `@dev-loops/core/loop/validation-record` defines the path, the fields and the validation.
- Two producers write the record. The `local` producer is `dev-loops loop validation-record`. It runs in the foreground with a bounded timeout, reads the validation block only from the base branch, selects the profile through `resolveTargetedValidation` on the head's changed paths and runs the suites through the existing runner. A failed suite writes a failed record. Any `incomplete` outcome, including a timeout, writes no record and exits non-zero, so the head stays in `head_validation_record`. The `ci` producer reads current-head CI for the head and writes the same record.
- The validation mode selects the producer: `local` selects the `local` producer and `ci-only` selects the `ci` producer. [ADR 0172](./0172-repo-validation-ci-only.md) already set this repository to `ci-only`. The `local` producer stays built for later and consumer use.
- The gate is a reader. It reads the record for the PR head and never runs a suite.
- A cross-head surface map decides when a record for an earlier head still covers a later head. Slice 4 of issue 2866 defines it.
- Lifecycle nodes, push sites, the gate reader, cross-head reuse and the `ci` producer land in later slices of issue 2866. This record's slice adds the record module and the `local` producer only.

## Consequences

Validation runs once per head outside the gate. A same-gate re-round no longer misses a record. The producer is the only new launcher of a local run, and it is bounded below the 600 s tool-call ceiling. Until the gate-reader slice lands, nothing reads the record, and `gate resolve-validation` behaves as before.
