# 0137. Validation modes and consumer-configured commands

## Status

Accepted — 2026-10-10 ([issue 2517](https://github.com/mfittko/dev-loops/issues/2517))

## Context

Amends [0105](./0105-targeted-validation-and-full-run-authority.md): the resolver hard-coded the dev-loops path layout and a `package.json` Bun toolchain. A consumer without `package.json` (for example a Rails or Rust repo) recorded `incomplete` validation on every gate round, and its reviewers raised a gate-evidence finding that the judge rejected each time. A consumer with a large Node suite ran the whole suite locally on every round. Record 0105 stays unedited.

## Decision

- A `.devloops` `validation` key sets `mode`: `ci-only` or `local`. Consumers default to `ci-only`. This repo sets `local`.
- In `ci-only` mode the full-repository profile runs no local suite. `dev-loops gate resolve-validation` reads the PR's head and status rollup. Green current-head CI writes an artifact with `status: "complete"` and `authority: "ci-authoritative"`. Red CI writes `failed`. Pending, missing or wrong-head CI writes typed `incomplete`. The artifact keeps `status: "complete"` so reviewer and verdict surfaces need no new status value.
- In `local` mode an optional `validation.fullCommand` (for example `cargo test`) is the full-validation command. It runs through `sh -c` at the repo root. Without it, `local` mode keeps the `package.json` `verify` behavior.
- An optional `validation.paths` map selects targeted worker commands. Rules are ordered and first match wins. A change set that spans surfaces, or touches an unmapped path, needs full validation. This repo's former built-in map now lives in its own `.devloops`.
- Command-trust boundary: commands come only from the base branch's `.devloops` `validation` block (read from `origin/<base>` like `standingAuthorizations`, base resolved by `resolveBaseBranch`), validated by the config schema, never from PR content, the PR-head checkout, PR title, PR body or CLI arguments. If the checkout's `validation` block (mode, `fullCommand` or `paths`) differs from the base block, the gate writes a typed `incomplete` artifact that names a config-source change needing review and runs nothing. An unreadable base block is also `incomplete`. The `sh -c` command runs with an environment that drops tokens and other secrets (names matching token, secret, password, credential, API key, `GH_*`, `GITHUB_*`, `NPM_*`).
- Known limits: `ci-only` with no CI at all (empty rollup) stays `incomplete`. `ci-only` covers only the full-repository profile; the targeted profile still needs `package.json`.

## Consequences

A non-Node consumer gets passing validation evidence without local tooling. The gate-evidence finding no longer recurs for green `ci-only` rounds. The core carries no dev-loops layout. A consumer that wants local suites opts into `local` mode.
