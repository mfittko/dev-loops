# Acceptance Criteria Verification

Extracted procedure for verifying issue acceptance criteria during the `pre_approval_gate`. Referenced from [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md#pre-approval-gate-contract).

## Procedure

Before posting the `pre_approval_gate` comment, verify every acceptance criteria checklist item in the issue linked to this PR, and reflect the verified items back into both the linked issue body and the PR body (exception: under the lightweight path — `specSource: pr_body` — the step 5 issue-body mirroring is skipped, since the PR body, not the issue body, is the canonical spec surface; see the lightweight fork below):

> **Lightweight (PR-body-as-spec) fork:** when the session is lightweight — the resolver output / handoff envelope carries `specSource: pr_body` (`canonicalSpecSource: pr_body`) — a linked issue still exists (`--lightweight` runs on the `--issue` path, so keep the `Closes #N` linkage and all issue-level tracking), but the **PR body**, not the issue body, is the canonical spec-of-record read for AC/DoD. In that case, still resolve the linked issue for tracking, but read the AC/DoD/invariants from the PR body rather than the issue body (skip step 2's issue-body read for spec purposes). Run `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <pr-number>` (reuses `@dev-loops/core/loop/issue-refinement-artifact`) to confirm the body carries the required invariants — it fails closed with a per-section `missing_*` reason if any is absent, in which case post the gate comment with verdict `blocked`. Then continue at step 3, extracting the **Acceptance criteria** checklist items from the PR body itself; step 5's issue-body AC-tick update is unnecessary for lightweight since the issue body is not the spec surface (the PR body is ticked in step 6 as usual). The default issue-backed procedure below is unchanged.

1. **Resolve the linked issue number deterministically:** use `gh pr view <pr-number> --repo <owner/name> --json closingIssuesReferences,body` and apply this decision tree: if there is exactly one closing issue reference, use it; else if there is exactly one PR-body `Closes #N` / `Fixes #N` pattern, use it; otherwise (zero or multiple candidates), post the gate comment with verdict `blocked` (gate cannot complete deterministically) rather than guessing.

2. **Read the issue body:** `gh issue view <issue-number> --repo <owner/name> --json body`

3. **Extract checklist items** from the **Acceptance criteria** section of the issue body (both `- [ ]` unchecked and `- [x]` already-checked items). Ignore checklist items from other sections (DoD, tasks, non-goals) that are not acceptance criteria.

4. **Verify each AC item** against the proposed changes on the current PR head.

5. **Update the issue body once:** compute the fully-updated issue body by replacing each verified item's `- [ ]` with `- [x]`, write it to a temporary file, and perform a single `gh issue edit <issue-number> --body-file <tmp-file> --repo <owner/name>`. Do not issue one edit per item; prefer `--body-file` over inline `--body` to avoid shell quoting/escaping hazards.

6. **Tick the PR body once:** after the verification is clean, flip each verified item's `- [ ]` to `- [x]` in the PR body via a single `gh pr edit --body-file` update, so the merged PR shows checked AC/DoD. Run `node scripts/github/tick-verified-checkboxes.mjs --repo <owner/name> --pr <pr-number> --verified <exact label>...` (one edit; exact-label match; only items actually verified are ticked; unverified or deferred items stay `- [ ]`; fail closed). This runs automatically as part of the `pre_approval_gate`, not by memory.

7. **Post the gate comment:** always post a `pre_approval_gate` comment (the checkpoint verdict comment contract requires a visible comment even for non-`clean` verdicts). Use verdict `clean` only when all AC items are verified; use verdict `findings_present` when any AC item is not satisfied and requires follow-up fixes; use verdict `blocked` when the gate cannot complete deterministically (for example no linked issue, ambiguous issue linkage, or the issue body is unavailable). In all cases include a note on AC verification status.

When the issue body has no AC checklist items, post the gate comment with verdict `findings_present` and note that fact explicitly rather than assuming satisfaction.
