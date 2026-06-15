# Phase A — Repo rename prep survey

Issue: [#788](https://github.com/mfittko/pi-dev-loops/issues/788)  
Goal: prepare the repository rename `mfittko/pi-dev-loops` → `mfittko/dev-loops` without performing the actual file edits.  
This document inventories tracked files that still reference the **old repo slug** and categorizes each reference so Phase B can apply the edits safely.

Excluded from this survey:
- `@pi-dev-loops/core` package imports / references — those are tracked in #766.
- `package-lock.json` — regenerates automatically.
- `.wiki/` content — regenerates on the next wiki-publish workflow run.

## Summary

- **Total tracked files with old slug:** 34
- **Total old-slug occurrences:** 230
- **Renamed in Phase B:** 226 occurrences across 31 files
- **Deferred:** 4 occurrences across 3 files
- **Kept (out of scope):** 0 old-slug occurrences
  - `@pi-dev-loops/core` references are excluded from this table; see #766.

| Category            | Occurrences | Files | Action |
|---|---|---|---|
| docs                | 47 | 12 | Rename in Phase B |
| code                | 179 | 18 | Rename in Phase B |
| tooling config      | 1 | 1 | Rename in Phase B |
| skill content       | 3 | 1 | Defer to #768 |
| archive             | 1 | 1 | Defer (historical phase doc) |
| **total**           | **231** | **33** | |

(The totals line is one more than 230 because `docs/archive/phases/phase-6.md` is counted under both “docs” and “archive”; its action is deferred.)

## Detailed survey table

| File | Line(s) | Category | Action |
|---|---|---|---|
| PLAN.md | 27 | docs | Rename in Phase B |
| README.md | 55, 146–147 | docs | Rename in Phase B |
| cli/index.mjs | 212–213, 235 | code | Rename in Phase B |
| docs/archive/phases/phase-6.md | 13 | docs | Defer (historical phase doc) |
| docs/conductor-routing-contract.md | 26–31 | docs | Rename in Phase B |
| docs/phases/phase-7.md | 123 | docs | Rename in Phase B |
| docs/phases/phase-8.md | 168 | docs | Rename in Phase B |
| docs/projects-queue-contract.md | 403–404 | docs | Rename in Phase B |
| docs/projects-queue-usage.md | 46, 49, 52, 59, 62, 69, 72, 79, 82, 85, 150–157 | docs | Rename in Phase B |
| docs/queue-board-setup.md | 20, 43, 93, 101, 133–135 | docs | Rename in Phase B |
| docs/specs/queue-mode/SPEC.md | 3, 104 | docs | Rename in Phase B |
| extension/README.md | 8, 10, 92–94 | docs | Rename in Phase B |
| extension/post-merge-update.ts | 11–12 | code | Rename in Phase B |
| extension/presentation.ts | 34, 52, 76 | code | Rename in Phase B |
| packages/core/test/ac-dod-matrix.test.mjs | 38, 275, 306, 328, 384 | code | Rename in Phase B |
| packages/core/test/copilot-helpers.test.mjs | 291 | code | Rename in Phase B |
| packages/core/test/debt-e2e-synthetic.test.mjs | 21 | code | Rename in Phase B |
| packages/core/test/debt-signal.test.mjs | 20 | code | Rename in Phase B |
| packages/core/test/deep-persona-signals.test.mjs | 22, 214 | code | Rename in Phase B |
| schemas/dev-loop-config.schema.json | 3 | tooling config | Rename in Phase B |
| skills/docs/tracker-first-loop-state.md | 237–239 | skill content | Defer to #768 |
| test/dev-loops-cli.test.mjs | 314, 333 | code | Rename in Phase B |
| test/dev-loops-core.test.mjs | 154, 157, 206, 211, 216, 221, 227, 232 | code | Rename in Phase B |
| test/extension-command-contract.test.mjs | 226, 239 | code | Rename in Phase B |
| test/extension-post-merge-update.test.mjs | 53–54, 56–58, 303, 320–321 | code | Rename in Phase B |
| test/github/upsert-checkpoint-verdict.test.mjs | 246 | code | Rename in Phase B |
| test/loop/detect-initial-copilot-pr-state.test.mjs | 237, 274, 376, 480, 522 | code | Rename in Phase B |
| test/loop/inspect-run-viewer-managed-instance.test.mjs | 125, 136, 140, 177, 188–189, 202, 218, 245–246, 261, 268, 348, 486, 531–532, 535–536, 547 | code | Rename in Phase B |
| test/loop/resolve-dev-loop-startup.test.mjs | 721, 740, 753, 768, 782, 801, 821, 852, 857, 890, 894 | code | Rename in Phase B |
| test/projects/add-queue-item.test.mjs | 141, 157, 164, 171, 178, 194, 213, 235, 256, 275, 295, 314, 336, 352, 369, 386, 407, 429, 444, 457, 496 | code | Rename in Phase B |
| test/projects/ensure-queue-board.test.mjs | 153, 204, 221, 235, 265, 269, 282, 286, 292, 315, 346, 370, 375, 443, 463, 501, 529, 539, 550, 573, 694, 715, 739, 766, 797, 825, 852 | code | Rename in Phase B |
| test/projects/list-queue-items.test.mjs | 117, 124, 131, 138, 165, 180, 201, 227, 252, 271, 297, 320, 335, 394, 409, 426, 443, 461, 494, 510, 533, 553, 567 | code | Rename in Phase B |
| test/projects/move-queue-item.test.mjs | 98, 116, 123, 130, 137, 144, 162, 173, 183, 206, 231, 256, 269, 279, 310, 329, 346, 363, 382, 400, 415, 428, 470 | code | Rename in Phase B |
| test/projects/reorder-queue-item.test.mjs | 100, 122, 166, 206, 240, 265, 283, 302, 318, 345, 375 | code | Rename in Phase B |

## Phase B action list

This is the explicit checklist the Phase B PR (#786) will execute.

- [ ] `README.md`: update Docker smoke-test `--repo` example and install URLs from `github.com/mfittko/pi-dev-loops` to `github.com/mfittko/dev-loops`.
- [ ] `PLAN.md`: update line 27 install URL.
- [ ] `cli/index.mjs`: update help text install/update URLs (lines 212–213, 235).
- [ ] `extension/README.md`: update install/update URLs (lines 8, 10, 92–94).
- [ ] `extension/post-merge-update.ts`: update queued `pi update` URL (lines 11–12).
- [ ] `extension/presentation.ts`: update install/update messages (lines 34, 52, 76).
- [ ] `docs/conductor-routing-contract.md`: update GitHub issue links (lines 26–31).
- [ ] `docs/phases/phase-7.md`: update `pi install` example URL (line 123).
- [ ] `docs/phases/phase-8.md`: update GitHub issue link (line 168).
- [ ] `docs/projects-queue-contract.md`: update GitHub issue links (lines 403–404).
- [ ] `docs/projects-queue-usage.md`: update all `--repo mfittko/pi-dev-loops` examples and issue links (lines 46, 49, 52, 59, 62, 69, 72, 79, 82, 85, 150–157).
- [ ] `docs/queue-board-setup.md`: update `--repo` examples and issue links (lines 20, 43, 93, 101, 133–135).
- [ ] `docs/specs/queue-mode/SPEC.md`: update repo references (lines 3, 104).
- [ ] `schemas/dev-loop-config.schema.json`: update `$id` URL from `https://github.com/mfittko/pi-dev-loops/...` to `https://github.com/mfittko/dev-loops/...` (line 3).
- [ ] Update all test mock repo values from `mfittko/pi-dev-loops` to `mfittko/dev-loops` across:
  - `packages/core/test/*.mjs`
  - `test/dev-loops-cli.test.mjs`
  - `test/dev-loops-core.test.mjs`
  - `test/extension-command-contract.test.mjs`
  - `test/extension-post-merge-update.test.mjs`
  - `test/github/upsert-checkpoint-verdict.test.mjs`
  - `test/loop/*.test.mjs`
  - `test/projects/*.test.mjs`
- [ ] After edits run `npm run verify` and confirm green.
- [ ] Do **NOT** edit `@pi-dev-loops/core` package references — #766.
- [ ] Do **NOT** edit `skills/docs/tracker-first-loop-state.md` — #768.
- [ ] Do **NOT** edit `docs/archive/phases/phase-6.md` unless explicitly requested.

## Operator setup — GitHub Settings rename

> This section is for the human operator. The agent cannot click the Settings UI.

1. Open the repository on GitHub:
   `https://github.com/mfittko/pi-dev-loops/settings`
2. In the left sidebar, click **General**.
3. Under the **Repository name** heading, replace `pi-dev-loops` with `dev-loops`.
4. Click **Rename**.
5. Wait for GitHub to confirm the new URL:
   `https://github.com/mfittko/dev-loops`
6. Verify the auto-redirect by visiting `https://github.com/mfittko/pi-dev-loops`; it should redirect to the new slug.
7. Update the local clone remotes:

   ```bash
   git remote set-url origin https://github.com/mfittko/dev-loops.git
   git fetch origin
   ```

8. Confirm the new remote:

   ```bash
   git remote -v
   # should show https://github.com/mfittko/dev-loops.git
   ```

After the Settings rename is complete, Phase B can be executed without risk of stale GitHub URLs.

## Methodology

- Base: `origin/main` at `42598ec` (after #783).
- Search: `git grep -nE 'mfittko/pi-dev-loops' origin/main`.
- Exclusions applied: `node_modules/`, `.git/`, `package-lock.json`, `.wiki/`, and `@pi-dev-loops/core` package references.
- Only the old **repo slug** was surveyed; the `@pi-dev-loops/core` package rename is out of scope for Phase A.
