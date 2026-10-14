# 0148. Deliver Codex judge read setup in the pulled work order

## Status

Accepted — 2026-10-14 ([issue 2776](https://github.com/mfittko/dev-loops/issues/2776))

## Context

The judge contract assumes native read tools and restricts shell commands to pull and decision checking. Codex has no native text reader in this environment. A separately sent setup message reached a fresh judge after its first attempted read/hash command was denied, blocking PR #2775 despite a valid reviewer fan-in. Retrying that message race is unreliable.

The numbering check inspected current `origin/main` and the relevant in-flight worktrees: accepted 0146 remains unchanged, A1 reserves 0145, and PR #2775 reserves 0147. None uses 0148.

## Decision

Render the narrow Codex after-pull read/hash setup before the judge's first required read. Keep the compact dispatch pointer unchanged. Reuse `executionRules.contract` as an absolute locator into the actual emitting toolchain; resolve relative contract paths there. Existing relative contract paths and content digests retain semantic identity, while canonical rendered-byte integrity binds the local locator. Do not change the shared serializer.

Codex may use bounded direct `cat`/`sed`/`rg` for pinned reads and already-authorized concrete dependency widening, plus availability-qualified `shasum -a 256` for pinned hashes. A denial, missing tool, unreadable material or digest mismatch stops the actor without a verdict or alternate command. Read truncated inputs completely in bounded ranges. No inline interpreters, generated scripts, tests/builds, source writes, external posting or permission changes are authorized. Only the two existing verdict artifacts may be written; checker, latest-pull receipt, spec authority and bridge requirements remain intact. Native Pi and Claude retain their existing read tools and shell/write boundaries.

## Consequences

The canonical pull supplies setup before a Codex judge needs it, without coordinator relay timing or a new role, provider or dispatch API. Pulls still delegate to the checkout owning the execution index: updating main does not prove an older emitting checkout serves this renderer. Verify the actual delivery and receipt before recovering an interrupted judge; failed actors remain historical evidence, never successful gate evidence.
