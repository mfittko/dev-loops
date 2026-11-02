# 0234. Gate evidence tolerates a head-only config key that the head schema declares

## Status

Accepted — 2026-11-02

## Context

Issue [2662](https://github.com/mfittko/dev-loops/issues/2662) (AC7) describes a PR that adds a new `.devloops` key. The gate-evidence workflow runs default-branch code (ADR 0034, ADR 0076). That code reads the PR head's `.devloops` and loads it with the default-branch schema. The schema is strict, so the new key fails with `config_load_failed ... Unrecognized key`, and the required `gate-evidence` status cannot pass for that PR.

Running the PR head's schema in the credential-bearing jobs would break the trust boundary.

## Decision

- A new job `head-declared-keys` runs the PR head's own config loader in a job with `permissions: {}`, no secrets and no API call. It prints the dotted key paths of the head's `.devloops` when the head loads cleanly under its own schema, and an empty set on any failure.
- The detector receives that output as data through an `env:` variable and the option `--head-declared-keys`. The write-credential jobs run only default-branch code.
- When every head-attributable load error is an unknown-keys-only error and every unknown key is in the declared set, the detector reloads the head `.devloops` once with exactly those keys removed. The default-branch schema ignores keys it does not know, so a removed key cannot change default-branch behavior.
- Any other error still fails with `config_load_failed`. This includes a key declared by neither schema, a mixed error and an error that is not unknown-keys-only. Invalid or oversized declared-key input counts as an empty set.

## Consequences

A PR that introduces a new config key passes gate evidence without an operator workaround. The declared set only widens what the detector tolerates and never what it trusts. The gate-evidence workflow gains one job and the reporter and runner depend on it.
