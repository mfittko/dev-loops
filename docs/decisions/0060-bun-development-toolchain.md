# 0060. Use Bun for development while preserving Node consumers and npm publication

## Status

Accepted

## Context

npm orchestration and `node:test` made setup and verification slower while tool assumptions spread across automation.

## Decision

Pin Bun 1.4.1 for source-checkout installs, scripts, and unit tests. `bun.lock`
is authoritative; installs are frozen and `bun run verify` preserves complete
coverage, attributable failures, and nonzero failure status.

Keep Node `>=24` for both published packages and their CLI, packed-consumer,
inspect-run, and Playwright proofs. Keep npm for pack, registry, dist-tag,
publication, and provenance operations; consumer npm/npx examples remain valid.

## Consequences

Contributors and CI use one toolchain and lockfile; Node consumer and npm
release proofs remain explicit. Two-session evidence under
`docs/benchmarks/bun-1.4.1/` passed the migration gates.
