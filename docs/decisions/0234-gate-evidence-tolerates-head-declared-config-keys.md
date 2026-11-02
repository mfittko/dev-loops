# 0234. Gate evidence tolerates a head-only config key that the head schema declares

## Status

Accepted — 2026-11-02

## Context

Issue [2662](https://github.com/mfittko/dev-loops/issues/2662) (AC7) describes a PR that adds a new `.devloops` key. The gate-evidence workflow runs default-branch code (ADR 0034, ADR 0076). That code reads the PR head's `.devloops` and loads it with the default-branch schema. The schema is strict, so the new key fails with `config_load_failed ... Unrecognized key`, and the required `gate-evidence` status cannot pass for that PR.

Running the PR head's schema in the credential-bearing jobs would break the trust boundary.

## Decision

- Option A (chosen). A new job `head-declared-keys` runs the PR head's own config loader in a job with `permissions: {}`, no secrets and no API call. It runs on `pull_request*` events only. It prints the dotted key paths of the head's `.devloops` when the head loads cleanly under its own schema, and an empty set on any failure. It also uploads the result as the artifact `head-declared-keys-<head sha>` (7 days).
- On `issue_comment` events the workflow runs in the default-branch context, even for fork PRs. Head `bun install` and head `config.mjs` would hold the Actions runtime and cache token there and could poison the default-branch cache. So head code never runs on `issue_comment`. Instead the trusted script `fetch-head-declared-keys.mjs` (default-branch code, `actions: read`) downloads the artifact, accepts it only when its producing run's head SHA and the PR's current head SHA both equal the evaluated head SHA, and validates it against a strict schema (at most 512 keys, each 1..200 chars of `[A-Za-z0-9_-]` segments joined by dots, at most 256 KB). The detector applies the same schema to `--head-declared-keys`.
- The detector receives the keys as data through an `env:` variable and the option `--head-declared-keys=<value>`. The write-credential jobs run only default-branch code.
- When every head-attributable load error is an unknown-keys-only error and every unknown key is in the declared set, the detector reloads the head `.devloops` once with exactly those keys removed. The default-branch schema ignores keys it does not know, so a removed key cannot change default-branch behavior.
- Any other error still fails with `config_load_failed`. This includes a key declared by neither schema, a mixed error and an error that is not unknown-keys-only. Invalid or oversized declared-key input counts as an empty set.

## Rejected alternatives

- Option B: accept the cache-poisoning risk of head code on `issue_comment`. Rejected because it breaks the trusted-evaluation constraint (ADR 0034).
- Option C: run head code on `issue_comment` with caching disabled. Rejected because it is unverified that disabling caches closes the runtime-token path to the cache service.

## Threat model

The declared set is fully attacker-controlled, whether it comes from the head schema, a direct `$GITHUB_OUTPUT` write or an uploaded artifact. This is safe only because stripping a key the default branch does not know cannot change default-branch behavior. The trusted fetch step additionally binds the artifact to the PR's current head SHA and a strict schema. `stripConfigKeyPaths` follows own properties only, so a `__proto__` path cannot reach `Object.prototype`.

## Job failure and limits

A job-level failure or timeout of `head-declared-keys` is possible (`timeout-minutes: 10`). The runner uses `!cancelled()` in its `if`, so a skipped or failed keys job does not skip the runner; this prevents a stale success after an approve-merge retraction. An empty output parses to the empty set and fails closed. A head with no artifact (no `pull_request` run yet, expired, or a private repository where the head cannot be fetched without credentials) gets the empty set.

## Consequences

A PR that introduces a new config key passes gate evidence without an operator workaround. The declared set only widens what the detector tolerates and never what it trusts. The gate-evidence workflow gains one job and the reporter and runner depend on it.
