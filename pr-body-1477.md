## Summary

Implements **#1468 slice 5** for issue **#1477**: additive review-lineage base + per-fix-round delta composition. A new head after a fix no longer rebuilds a full head-specific briefing; round 2+ appends only what changed.

Adds a pure, offline, deterministic module `packages/core/src/loop/review-lineage.mjs` covering Section E of the #1468 spec:

- **`review-lineage-base`** artifact: lineage identity + gate + stable contracts/instructions + original review target + original full diff (`baseHash` fingerprint).
- **`round-N-delta`** artifact: exact `baseHead`/`reviewedHead` SHAs + the actual fix diff + validation evidence + an independent findings verification checklist (`deltaHash` fingerprint).
- **`composeRoundRequest`** — append-only composition: `[lineage base][delta 1]...[delta N][angle suffix]`. Round N+1 appends exactly one new delta segment; every prior segment is byte-identical (same ref + hash). It never parses/reserializes the full PR context as a replacement block.
- Carry-forward provenance preserved unchanged: a carried clean angle still records its original reviewer and prior head (decision logic stays in `gate-carry-forward.mjs`).

## Acceptance criteria

- [x] A review-lineage base artifact exists per PR review lineage, plus per-fix-round delta artifacts recording exact SHAs, the fix diff, validation evidence, and an independent findings checklist.
- [x] Round 2+ request composition reuses the lineage base and prior deltas and appends only the new delta; a test proves it does not rebuild the full PR context as a replacement block.
- [x] Delta artifacts are deterministic: identical inputs produce byte-identical output (base/delta/composed hashes).
- [x] Carry-forward semantics unchanged — a carried clean angle still records its original reviewer and prior head.

## Definition of done

- [x] Every AC covered by an executable test (`packages/core/test/review-lineage.test.mjs`, 13 tests).
- [x] `npm run verify` green; `npm run assets:check` and `npm run schema:check` green.
- [x] `skills/docs/gate-review-sub-loop-contract.md` updated (new Section E subsection) with its generated `.claude` mirror regenerated in the same change.
- [x] Existing fresh-context, one-reviewer-per-angle, briefing-prefix hash, carry-forward and fan-in guarantees remain green (none of those paths were modified).

## Non-goals (kept out of scope / later slices)

- No continuity-reviewer convergence loop (#1468 slice 6).
- No calibration audit (#1468 slice 7) or compaction/rebase policy (#1468 slice 8).
- No provider cache-reuse claim from artifact hashes.
- No change to gate verdict semantics, carry-forward decision logic, or round-1 fresh-angle provenance.

## Validation

- `npm run verify` → exit 0 (all suites: assets 274, extension 123, scripts 3902, core 2560, docs, pack 1, dev-loop 35, workflows).
- `npm run assets:check` → `{"ok":true,"checked":94}`
- `npm run schema:check` → up to date.

Closes #1477
