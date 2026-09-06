# 0061. Use Bun for development while preserving Node consumers and npm publication

Status: Accepted

## Decision

Pin Bun 1.4.1 for source-checkout installs, scripts, and unit tests. `bun.lock` is authoritative; installs are frozen and `bun run verify` preserves complete coverage and failure status. Keep Node `>=24` for published packages and runtime-boundary proofs. Keep npm for pack, registry, publication, and provenance operations.

## Consequences

Contributor tooling is faster without changing Node consumers or npm releases. Evidence is under `docs/benchmarks/bun-1.4.1/`.
