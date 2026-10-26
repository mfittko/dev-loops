# 0165. Union targeted validation across mapped surfaces

## Status

Accepted — 2026-10-20 ([PR 2849](https://github.com/mfittko/dev-loops/pull/2849))

## Context

Amends [0105](./0105-targeted-validation-and-full-run-authority.md).

Amends [0137](./0137-validation-modes-and-consumer-configured-commands.md).

[Issue #2508](https://github.com/mfittko/dev-loops/issues/2508) identifies unnecessary full validation for mixed mapped surfaces and changeset fragments, and missing command-line access to the resolver. Records 0105 and 0137 stay unedited. This record stages the decided changes across three implementation slices.

## Decision

Slice 1 selects `targeted` when every changed path matches a first-match rule with non-empty commands. The result is the sorted, deduplicated union of expanded `commands` and explicit plus inferred `gateSuites` across all matched surfaces. Distinct surface names no longer require full validation. Empty input, invalid or unmapped paths, empty-command matches and unsafe templated paths retain the `full-repository` fallback.

Slice 2 will map `changes/*.md` to surface `changeset` with only `bun run test:docs` and gate suite `test:docs`. It will add worker-only literal referencing tests for skills contracts; referencing tests contribute no gate suite. These mappings and runner behavior do not ship in slice 1.

Slice 3 will expose the worker resolver through a new `targeted-validation` subcommand under `dev-loops loop` and add `dev-loops gate resolve-validation --profile auto`. In local mode, auto will resolve the head's changed paths against the default branch's trusted `validation.paths`, run the resolved gate suites, and fall back to full validation when resolution is unavailable, includes a deleted path, requires full validation or yields no suites. Auto and explicit `--suite` will be mutually exclusive. These command surfaces do not ship in slice 1.

Keep ADR 0137's command-trust boundary: gate commands come only from the default branch's validation block, and a differing checkout block yields typed `incomplete` without running commands. Keep full-run ownership with `gate resolve-validation`, CI's full coverage, and [ADR 0163](./0163-same-head-validation-artifact-reuse.md)'s same-head reuse unchanged.

Reject full validation solely because surface names differ: all matched rules already declare their checks. Retain conservative fallback when any path lacks a safe, non-empty check selection.

## Consequences

Workers can combine declared checks for mixed change sets without weakening path safety or command trust. Changeset fragments still require full validation until slice 2; automatic gate selection remains unavailable until slice 3. Later slices build on the union rule without changing CI coverage or merge validation authority.
