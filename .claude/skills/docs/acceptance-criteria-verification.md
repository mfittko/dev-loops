# Acceptance Criteria Verification

Extracted procedure for verifying issue acceptance criteria during the `pre_approval_gate`. Referenced from [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md#pre-approval-gate-contract).

## Procedure

Before posting the `pre_approval_gate` comment, verify every acceptance criteria checklist item in the issue linked to this PR:

1. **Resolve the linked issue number deterministically:** use `gh pr view <pr-number> --repo <owner/name> --json closingIssuesReferences,body` and apply this decision tree: if there is exactly one closing issue reference, use it; else if there is exactly one PR-body `Closes #N` / `Fixes #N` pattern, use it; otherwise (zero or multiple candidates), post the gate comment with verdict `blocked` (gate cannot complete deterministically) rather than guessing.

2. **Read the issue body:** `gh issue view <issue-number> --repo <owner/name> --json body`

3. **Extract checklist items** from the **Acceptance criteria** section of the issue body (both `- [ ]` unchecked and `- [x]` already-checked items). Ignore checklist items from other sections (DoD, tasks, non-goals) that are not acceptance criteria.

4. **Verify each AC item** against the proposed changes on the current PR head.

5. **Update the issue body once:** compute the fully-updated issue body by replacing each verified item's `- [ ]` with `- [x]`, write it to a temporary file, and perform a single `gh issue edit <issue-number> --body-file <tmp-file> --repo <owner/name>`. Do not issue one edit per item; prefer `--body-file` over inline `--body` to avoid shell quoting/escaping hazards.

6. **Post the gate comment:** always post a `pre_approval_gate` comment (the checkpoint verdict comment contract requires a visible comment even for non-`clean` verdicts). Use verdict `clean` only when all AC items are verified; use verdict `findings_present` when any AC item is not satisfied and requires follow-up fixes; use verdict `blocked` when the gate cannot complete deterministically (for example no linked issue, ambiguous issue linkage, or the issue body is unavailable). In all cases include a note on AC verification status.

When the issue body has no AC checklist items, post the gate comment with verdict `findings_present` and note that fact explicitly rather than assuming satisfaction.
