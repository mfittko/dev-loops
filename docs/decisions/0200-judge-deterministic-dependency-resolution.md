# fix(judge): resolve evidence and dependency paths through deterministic tooling

Fixes https://github.com/mfittko/dev-loops/issues/2874

## Problem

The v1.0.8 Codex lane repeatedly stopped at the judge stage because judges
invented dependency filenames that do not exist:

- `agents/review-angles/pr-checklist.md` → does not exist; angle definitions
  are inline in `extension-defaults.yaml` and `.devloops`
- `skills/docs/review-angles.md` → does not exist; same reason
- `agents/reviewer.agent.md` → wrong name; actual file is `agents/review.agent.md`
- `skills/docs/pr-review-contract.md` → wrong name; actual file is
  `skills/docs/pre-pr-review-contract.md`

`emit-judge-work-order.mjs` had no supported input for additional dependency
locations, so judges guessed and stopped on missing-file errors.

## Changes

### `scripts/loop/emit-judge-work-order.mjs`

Added three new functions and integrated them into `emitJudgeWorkOrder`:

**`DiscoveryResult`** — typed outcome constants: `found` (verified read),
`missing` (absent candidate), `denied` (permission refusal, always fatal).
An optional discovery miss cannot accidentally become a missing-required-input
failure; the types are explicitly distinct.

**`discoverOptionalDep(kind, absPath)`** — bounded deterministic single-file
discovery. Permission/classifier denials (`EACCES`, `EPERM`, `EISDIR`) are
always fatal with no alternate-command retry. `ENOENT`/`ENOTDIR` yields a
typed `missing` result.

**`resolveJudgeDependencies({ config, gate, packageRoot })`** — resolves all
additional judge dependencies from owning configuration and contract sources,
never from a second filename catalog:

- **Role definitions**: `agents/review.agent.md` and `agents/developer.agent.md`
  resolved by filesystem existence at the toolchain root. Judges can no longer
  invent wrong names.
- **Contract files**: `skills/docs/pre-pr-review-contract.md` and
  `skills/docs/gate-review-sub-loop-contract.md` resolved by filesystem
  existence. Judges can no longer guess `pr-review-contract.md`.
- **Inline angle definitions**: the resolved angle pool for the gate is
  extracted from `resolveGateAngles(config, gateKey)` (the canonical owning
  surface — `extension-defaults.yaml` merged with `.devloops`), serialised,
  and carried as an `inline-angle-defs` entry. Judges never need to read
  separate angle-definition files because none exist.

The work order now carries:
- `optionalReads`: verified-existing optional dependency reads
- `discoveryMisses`: typed records for absent candidates (outcome: `"missing"`)

Required reads and existing integrity/hash checks are unchanged.

### `test/loop/emit-judge-work-order.test.mjs`

Added five regression tests covering issue #2874:

1. Work order carries tooling-resolved optional dependency reads (not guessed filenames)
2. Inline angle definitions are config-derived, not invented filesystem paths
3. An absent optional dependency produces a typed discovery miss, not a
   required-input failure
4. Regression for the four absent-path classes that stopped Codex judges in v1.0.8
5. Optional discovery miss cannot accidentally become a missing-required-input failure

## Preserves

- All existing required-input hash checks and work-order integrity
- Judge independence, mutation boundary, and verdict authority
- Claude Code and Pi read/write boundaries and role hooks
- All existing tests pass unchanged
