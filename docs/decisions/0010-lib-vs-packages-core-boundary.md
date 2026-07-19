# 0010. Keep pure deterministic logic in packages/core, runtime command support in lib, and the scripts shim as a re-export only

## Status

Accepted — 2026-05-31 ([commit da3179d8](https://github.com/mfittko/dev-loops/commit/da3179d8b7975378101ff9c87fcbde255aa30aed))

## Context

Shared logic was accumulating across `lib/`, `packages/core/`, and `scripts/_core-helpers.mjs` with no placement rule. Deterministic Copilot/GitHub parsing helpers (`isCopilotLogin`, `normalizeTimestamp`, gate-review comment parsing) were duplicated between the scripts shim and `packages/core/src/loop/copilot-loop-iterations.mjs`, and the shim was drifting toward a dumping ground for new helpers. Logic trapped behind runtime dependencies cannot be fixture-tested and cannot be reused by external packages. The boundary was codified in `docs/lib-vs-packages-core-boundary.md`, which carries the ownership table and a decision tree for new shared logic.

## Decision

Place all reusable deterministic logic — pure functions with no filesystem, network, or process imports, testable from raw data fixtures, consumed by more than one caller — in `packages/core/` (under `src/github/` for GitHub data and `src/loop/` for loop-state machines). Keep `lib/dev-loops-core.mjs` as the runtime command surface shared by the extension and CLI: command parsing, readiness-check collection via runtime probes, and result rendering. Reduce `scripts/_core-helpers.mjs` to a thin re-export shim; at decision time it retained one local definition, the `isDirectCliRun` entry-point guard, and ban adding any new deterministic parsing or aggregation logic to it. We rejected keeping helpers in the shim (it duplicates logic and hides it from external consumers) and rejected placing pure helpers in `lib/` (the boundary doc states explicitly that `lib/` is not the place for helpers with no runtime dependency). New shared logic follows the decision tree in the boundary doc: pure → `packages/core/`, command/readiness → `lib/`, entry-point guard → the shim, otherwise stay local to `scripts/<area>/`.

## Consequences

Every new shared helper has a defined home, and the shim cannot re-become a dumping ground — contributors consult the decision tree instead of defaulting to the nearest file. Core logic stays unit-testable from fixtures without runtime setup and remains exportable to external consumers through `packages/core/package.json` export entries. Contributors pay a small placement decision per helper, and moving a helper into `packages/core/` requires wiring a package export plus a shim re-export when scripts need it. The shim has since thinned further: `isDirectCliRun` later moved into `packages/core/src/cli/helpers.mjs`, leaving the shim as pure re-exports, consistent with the boundary's direction.
