# Audit Scope 8: Release Readiness

**Date:** 2026-07-06
**Context:** v0.8 release gate contract audit (#1192), Epic #1104

## 1. Test Suite Results

### `npm run verify`

| Suite | Tests | Pass | Fail | Skipped | Status |
|-------|-------|------|------|---------|--------|
| test:assets | 189 | 189 | 0 | 0 | ✅ PASS |
| test:extension | 81 | 81 | 0 | 0 | ✅ PASS |
| test:scripts | - | - | - | - | ❌ HANG |
| test:core | 1865 | 1864 | 1 | 0 | ❌ 1 FAIL |
| test:docs | - | - | - | - | ✅ PASS |
| test:dev-loop | 32 | 32 | 0 | 0 | ✅ PASS |

**test:scripts details** — hangs on `test/github/upsert-checkpoint-verdict.test.mjs` (exceeds 120s per file). The loop test suite also hangs (likely same root). Running individual files reveals additional pre-existing failures:

| Failing file | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| detect-checkpoint-evidence-stale-runner | 3 | 1 | 2 | 0 |
| detect-checkpoint-evidence | 49 | 48 | 1 | 0 |
| reconcile-draft-gate | 17 | 12 | 3 | 2 |

**test:core failure** — `resolveRunId trims and treats blank/absent as null`: expects `null`, got `'363fd6c8'`. Likely environment pollution from the `.pi-subagents/artifacts/outputs/363fd6c8/` directory path used for this audit run. Pre-existing conditional: path structure may cause the test to find a run ID where it expects none.

**Summary:** `npm run verify` does not pass. 1 hang + 1 test failure + 3 pre-existing failure files. This is a blocker for release.

### `npm run test:docs`

```
Markdown links OK (97 files, 512 links checked).
Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.
```
✅ PASS

### `npm run test:assets`

189 tests, 0 failures. ✅ PASS

### `npm test`

Aggregate of test:assets + test:extension + test:scripts + test:core + test:docs. Same failures as above.

## 2. Release Pipeline Integrity

### `.github/workflows/release.yml`

✅ Exists and is well-structured.
✅ Dispatches `npm-publish.yml` explicitly via `gh workflow run npm-publish.yml --ref "${{ steps.version.outputs.tag }}"` (line 90).
✅ Grants `actions: write` permission.
✅ Includes `--verify-tag` on `gh release create`.
✅ Validates release commit is ancestor of `origin/main`.
✅ Validates `@dev-loops/core` dependency version lockstep.

### `.github/workflows/npm-publish.yml`

✅ Exists.
✅ Has `workflow_dispatch:` in `on:` trigger (line 7) — the documented GITHUB_TOKEN exception.
✅ Retains legacy `release: published` trigger for manual UI releases.
✅ Validates release commit is on main before publishing.

### Fix #1187 — npm-publish never fires

**Issue:** GITHUB_TOKEN-created releases don't fire `release: published` — npm publishing silently skipped since v0.6.0.

**PR #1188:** merged 2026-07-05, merge commit `8cda46da`. ✅
**Verification:**
- `release.yml` line 90: dispatches `npm-publish.yml` via `workflow_dispatch`
- `npm-publish.yml` line 7: accepts `workflow_dispatch`
- `release.yml` comment references #1187 explicitly
- Dispatch step is NOT gated on release existence (idempotent retries)

✅ Fix is merged and effective.

## 3. Main Branch Readiness

### `git status`

```
On branch main
Your branch is up to date with 'origin/main'.

Untracked files: .pi-subagents/
nothing added to commit but untracked files present
```

✅ Clean working tree. Only `.pi-subagents/` untracked (audit artifact dir).

### Open PRs

| PR | Branch | Title | Issue |
|----|--------|-------|-------|
| #1226 | issue-1218 | feat(queue): auto-enqueue issue-less lightweight PRs | #1218 |
| #1225 | issue-1196 | fix(gates): fail closed on missing mandatory angles | #1196 |
| #1222 | issue-1213 | fix(copilot): sanitize summon literals, code-span-aware guard | #1213 |

⚠️ 3 open PRs. All are linked to open v0.8 milestone issues.

### v0.8 Milestone

| State | Count |
|-------|-------|
| Open | 8 |
| Closed | ~22 |

Open v0.8 issues:

| # | Title |
|---|-------|
| #1224 | contract: ban inline interpreters in coordinator flows |
| #1220 | gates: inline reviewed content into briefing-prefix.txt |
| #1218 | lightweight: auto-enqueue issue-less PRs as board PR items |
| #1213 | comment writers vs copilot-summon guard: self-deadlock |
| #1196 | gate evidence: enforce configured mandatoryAngles + angle-pool membership |
| #1192 | Release gate: independent contract audit before rolling v0.8 |
| #1104 | Epic: Contract corpus audit — condense + firm to law language |
| #1082 | fix(pi-runtime): keep launching subagent attached through Copilot review waits |

⚠️ 8 open issues in v0.8 milestone. Release cannot proceed with open milestone issues.

## 4. Package Version

| Package | Version | Target |
|---------|---------|--------|
| root (`dev-loops`) | `0.7.1` | `0.8.0` |
| `@dev-loops/core` | `0.7.1` | `0.8.0` |

Latest tag: `v0.7.1`

⚠️ Package version is `0.7.1`. Needs bump to `0.8.0` before tagging.

## Summary

| Check | Status |
|-------|--------|
| npm run verify passes | ❌ Hang + failures |
| test:docs passes | ✅ |
| test:assets passes | ✅ |
| release.yml dispatches npm-publish.yml | ✅ |
| Fix #1187 merged + effective | ✅ |
| git status clean | ✅ |
| No open PRs blocking release | ❌ 3 open |
| All v0.8 milestone issues closed | ❌ 8 open |
| package.json version ready | ❌ 0.7.1, needs 0.8.0 |

## Blockers

1. **Hanging test:** `test/github/upsert-checkpoint-verdict.test.mjs` hangs `test:scripts` → blocks `npm run verify`
2. **Core test failure:** `resolveRunId` expects null but environment leaks a run ID
3. **3 pre-existing test failures** in `test:scripts` (detect-checkpoint-evidence-stale-runner, detect-checkpoint-evidence, reconcile-draft-gate)
4. **8 open issues** in v0.8 milestone
5. **3 open PRs** linked to v0.8 milestone issues
6. **Version not bumped:** package.json at 0.7.1, needs 0.8.0

## Required Follow-ups (Repository Settings)

- After v0.8 tag is pushed, verify npm-publish workflow fires via `workflow_dispatch`
- Ensure branch protection on `main` is configured (cannot verify from here)