# Lane B audit: L2/L3 conformance + release readiness for #1192

Working tree: `/Users/mfittko/github/dev-loops`
Branch/commit: `main` @ `bd71a006`
Issue input: `gh issue view 1192` read. `commentCount: 0`; `gh api repos/:owner/:repo/issues/1192/comments --jq 'length'` also returned `0`.
Tracked-file mutation: none. Only `.pi-subagents/` audit/progress artifacts are untracked.

## Verdict

**Blocking findings present. Do not tag v0.8 from this checkout.**

Conformance lane itself is clean: all four registered machines pass L2/L3, no `known_gap` entries are active, and conformance tests pass.

Release readiness is not clean: `npm run verify` fails, and a v0.8.0 release tag would currently fail release guards because manifests/changelog are still at 0.7.1 / no 0.8.0 changelog section.

## Blocking findings

1. **`npm run verify` fails on `main`.**
   - Command: `npm run verify`
   - Exit: `1`
   - Summary: `tests 2312`, `pass 2224`, `fail 52`, `skipped 36`, duration `311548.13025ms`.
   - Failing areas reported by the failure-summary reporter include:
     - `test/github/detect-checkpoint-evidence.test.mjs`
     - `test/github/reconcile-draft-gate.test.mjs`
     - `test/github/upsert-checkpoint-verdict.test.mjs`
     - `test/loop/copilot-pr-handoff.test.mjs`
     - `test/loop/resolve-dev-loop-startup-cli-contract.test.mjs`
     - `test/loop/run-watch-cycle.test.mjs`
   - Exact sample failures:
     - `reconcile-draft-gate fails closed when visible draft_gate evidence already exists`: expected `/already has a visible draft_gate comment/i`, actual `PR owner/repo#17 is now owned by run 2e39bdc9; run 075fa7dc must stop.`
     - `copilot-pr-handoff requests review and emits watch action for pr_ready_no_feedback`: actual `'stop'`, expected `'watch'`.
     - `resolve-dev-loop-startup rejects async-required strategy via stderr contract`: expected exit `1`, got `0`.
   - Impact: #1192 requires `npm run verify` green before release readiness. This is a release blocker even though L2/L3 conformance passes.

2. **v0.8 release tag is not currently publishable from these manifests/changelog.**
   - `package.json:84` has root version `0.7.1`.
   - `package.json:74` has `@dev-loops/core` dependency `^0.7.1`.
   - `packages/core/package.json:3` has core version `0.7.1`.
   - `node scripts/release/assert-core-dependency-version.mjs --release-version 0.8.0` exits `1` with:
     - `::error::@dev-loops/core dependency "^0.7.1" (major.minor 0.7) does not match the release version 0.8.0 (major.minor 0.8). Bump the @dev-loops/core range to ^0.8.0 before releasing (root cause of #1033).`
   - `node scripts/release/extract-changelog-section.mjs --version 0.8.0` exits `1` with:
     - `error: no section found for version 0.8.0 in CHANGELOG.md. Refusing to create a release for an undocumented version.`
   - Impact: the release workflow correctly fails closed, but this checkout is not v0.8 release-ready.

## Non-blocking findings / clean checks

- **L2/L3 state-machine conformance passes for all registered machines.**
  - CLI output:
    - `Machine pr-gate-coordination: PASS`
    - `Machine conductor-routing: PASS`
    - `Machine copilot-loop-state: PASS`
    - `Machine reviewer-loop-state: PASS`
  - Exit: `0`.
- **Registered-machine coverage is complete for the expected #1156/#1157 machines.**
  - Registered names printed: `pr-gate-coordination`, `conductor-routing`, `copilot-loop-state`, `reviewer-loop-state`.
- **L3 completeness/safety/liveness are clean.**
  - Programmatic report:
```json
[
  {
    "name": "pr-gate-coordination",
    "ok": true,
    "states": 13,
    "transitions": 18,
    "docTransitions": 18,
    "conformanceCounts": { "verified": 13, "owned_elsewhere": 4, "external": 1 },
    "completenessOk": true,
    "completenessDeadEnds": [],
    "livenessOk": true,
    "livenessStuck": [],
    "safetyOk": true,
    "safetyViolations": 0
  },
  {
    "name": "conductor-routing",
    "ok": true,
    "states": 7,
    "transitions": 28,
    "docTransitions": 28,
    "conformanceCounts": { "verified": 28 },
    "completenessOk": true,
    "completenessDeadEnds": [],
    "livenessOk": true,
    "livenessStuck": [],
    "safetyOk": true,
    "safetyViolations": 0
  },
  {
    "name": "copilot-loop-state",
    "ok": true,
    "states": 15,
    "transitions": 15,
    "docTransitions": 15,
    "conformanceCounts": { "verified": 15 },
    "completenessOk": true,
    "completenessDeadEnds": [],
    "livenessOk": true,
    "livenessStuck": [],
    "safetyOk": true,
    "safetyViolations": 0
  },
  {
    "name": "reviewer-loop-state",
    "ok": true,
    "states": 13,
    "transitions": 35,
    "docTransitions": 35,
    "conformanceCounts": { "verified": 30, "owned_elsewhere": 5 },
    "completenessOk": true,
    "completenessDeadEnds": [],
    "livenessOk": true,
    "livenessStuck": [],
    "safetyOk": true,
    "safetyViolations": 0
  }
]
```
- **No stale `known_gap` entries found.**
  - Programmatic result: `{ "knownGapCount": 0, "knownGaps": [] }`.
  - Text grep finds only documentation/comments/printing for `known_gap`, plus retired allowlist comments; no active `status: "known_gap"` entries.
- **Conformance unit tests pass.**
  - `node --test --test-reporter ./test/failure-summary-reporter.mjs test/docs/validate-state-machine-conformance.test.mjs`
  - Exit: `0`; `tests 27`, `pass 27`, `fail 0`.
- **`npm run test:docs` passes.**
  - Exit: `0`.
  - Output: `Markdown links OK (97 files, 512 links checked).` and `Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.`
- **`npm run test:assets` passes.**
  - Exit: `0`; `tests 189`, `pass 189`, `fail 0`, duration `2164.576375ms`.
- **Release workflow chain is present and intact structurally.**
  - `.github/workflows/release.yml:86-90` dispatches `npm-publish.yml` with `gh workflow run npm-publish.yml --ref "${{ steps.version.outputs.tag }}"`.
  - `.github/workflows/release.yml:16-18` grants `actions: write`, needed for workflow dispatch.
  - `.github/workflows/npm-publish.yml:6-10` supports both `workflow_dispatch` and `release: published`.
  - `.github/workflows/npm-publish.yml:41-42` runs `npm run verify` before pack/publish.
  - `.github/workflows/npm-publish.yml:44-69` dry-runs both packages and publishes core before root with provenance and idempotency checks.

## Commands run

| Command | Exit | Evidence |
| --- | ---: | --- |
| `gh issue view 1192 --json number,title,body,comments --jq ...` | 0 | Read #1192 mandate/scope/AC; comment count `0`. |
| `gh api repos/:owner/:repo/issues/1192/comments --jq 'length'` | 0 | Returned `0`. |
| `node scripts/docs/validate-state-machine-conformance.mjs` | 0 | Four machines `PASS`. |
| `node - <<'NODE' ... getRegisteredMachines/runMachineConformance ...` | 0 | JSON report above; all L2/L3 booleans true. |
| `node - <<'NODE' ... known gaps ...` | 0 | `knownGapCount: 0`. |
| `rg -n "status:\\s*['\"]known_gap..." ...` | 0 | Only documentation/comment/printing references, no active gap entry. |
| `node --test --test-reporter ./test/failure-summary-reporter.mjs test/docs/validate-state-machine-conformance.test.mjs` | 0 | `tests 27`, `pass 27`, `fail 0`. |
| `npm run test:docs` | 0 | Links/rule ownership OK. |
| `npm run test:assets` | 0 | `tests 189`, `pass 189`, `fail 0`. |
| `npm run verify` | 1 | `tests 2312`, `pass 2224`, `fail 52`, `skipped 36`. |
| `node scripts/release/assert-core-dependency-version.mjs` | 0 | Current 0.7.1 lockstep passes. |
| `node scripts/release/assert-core-dependency-version.mjs --release-version 0.8.0` | 1 | Fails: `@dev-loops/core` range `^0.7.1` mismatches release `0.8.0`. |
| `node scripts/release/extract-changelog-section.mjs --version 0.8.0` | 1 | Fails: no 0.8.0 changelog section. |
| `git diff --cached --name-only` | 0 | No staged files. |
| `git status --short --untracked-files=no` | 0 | No tracked working-tree changes. |

## Residual risks

- I did not mutate tracked files or attempt release/publish operations.
- Because `npm run verify` fails, I could not validate npm-publish end-to-end past its verification gate in the current checkout.
- Full issue #1192 has wider lanes outside this lane B audit: rule ownership, contradiction scan, phrase-pin zero-state, semantic drift, epic closeout, and condensation lens are not assessed here except where commands overlapped (`test:docs`).