PR #1102 merged, issue #1096 auto-closed. Dev-loop complete through all gates.

## Summary

**Issue #1096** → **PR #1102** (merged) → squash commit `5694689`

**What changed:** Docs-only contract change — dev-loop PRs that fall behind `main` now integrate via merge commit (`git merge origin/main`) instead of rebase+force-push. Since PRs are squash-merged, intermediate history is discarded at merge time, so a merge commit lands an identical result on `main` without a non-fast-forward push.

**Files changed (5):**
- `skills/local-implementation/SKILL.md` — new behind-branch integration policy bullet (source of truth)
- `skills/copilot-pr-followup/SKILL.md` — conflict-resolution gate defaults to merge commit, cross-references local-implementation policy
- `.claude/` mirrors — regenerated (2 files)
- `test/contracts/copilot-review-doc-contracts.test.mjs` — assertions updated for new wording

**Gate verdicts:**
- Draft gate: clean (13 angles, fanout_fanin)
- Copilot review: converged (3 rounds, 2 findings addressed, 0 unresolved on final head)
- Pre-approval gate: clean (14 angles, fanout_fanin)
- CI: green on head `79d32b98`
- Mergeable: CLEAN
- Pre-merge gate evidence check: passed