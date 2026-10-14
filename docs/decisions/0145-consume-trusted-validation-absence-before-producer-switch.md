# 0145. Consume trusted validation absence before the producer switch

## Status

Accepted — 2026-10-14 ([accepted refinement](https://github.com/mfittko/dev-loops/issues/2470#issuecomment-6162416233))

## Context

The [operator assessment](https://github.com/mfittko/dev-loops/pull/2754#issuecomment-6162269381) and accepted refinement require consumer expansion before enabling a new validation outcome. [A1, issue 2757](https://github.com/mfittko/dev-loops/issues/2757), prepares that seam while retaining the producer/default policy in [0137](./0137-validation-modes-and-consumer-configured-commands.md). The [archived unmerged 0145 proposal at e6341fb](https://github.com/mfittko/dev-loops/blob/e6341fb12422e2456e582ffa509e55f35f412e8f/docs/decisions/0145-validation-role-boundaries-and-shared-gate-evidence.md) is extraction provenance, not a registered main-branch decision. <!-- secret-scan:allow public immutable GitHub commit URL identifies archived decision provenance, not a credential -->

## Decision

Consumers accept a distinct `not_configured` resolution with `allPassed: null`, empty suites and an actionable `validation_not_configured` warning. Acceptance binds the requested head, context reference/path identity, SHA-256 and byte count, and verifies absence against the trusted remote-default-branch configuration revision, family path and raw-byte hash, with matching checkout configuration. Missing, unreadable, malformed, stale or mismatched evidence remains its specific error; it cannot establish absence.

Verified absence permits reviewer/judge participation and coordinator reporting with a visible warning that validation was not performed. It fabricates no pass, mandatory absence finding, fixer, incomplete retry or fallback test run. Independent CI, approval and merge requirements still apply. Existing complete, failed, incomplete and CI-authoritative evidence retains its meaning; legacy records and native work orders remain accepted without newly mandatory fields or reads.

A1 leaves producer output and configuration defaults unchanged. [A2, issue 2758](https://github.com/mfittko/dev-loops/issues/2758), separately amends 0137 and enables the producer only after compatible A1 consumers are merged and loaded. A producer-only warning was rejected because old consumers would still block it; importing the archived proposal or its runtime restrictions is outside this seam.

## Consequences

Synthetic future records can exercise the complete consumer path without changing the current producer. A1 alone does not deliver the full unconfigured-consumer feature, and PR-head native assets do not prove that a session has loaded compatible consumers. A2 must establish that compatibility before switching output.
