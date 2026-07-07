# Acceptance Criteria Verification

Canonical owner for the acceptance-criteria verification procedure run during the `pre_approval_gate`. Referenced from [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md#pre-approval-gate-contract).

## Procedure

<!-- rule: ACCEPT-CRITERIA-VERIFY-AND-REFLECT -->
`ACCEPT-CRITERIA-VERIFY-AND-REFLECT`: Before posting the `pre_approval_gate` comment, the agent MUST verify every acceptance criteria checklist item in the issue linked to this PR, and MUST reflect the verified items back into both the linked issue body and the PR body (exception: when the linked issue body is not the spec-of-record — under a lightweight session (tracker-backed or issue-less; the PR body is the spec) or a plan-file promotion session (the committed plan doc the PR body points to is the spec) — the step 5 issue-body mirroring is skipped; see the fork below):

> **Non-tracker spec-source fork:** when the linked issue body is not the spec-of-record, the fork covers three arms — lightweight (the PR body itself is the spec; splits on whether a backing issue exists) and plan-file promotion (a distinct local-planning origin whose committed plan doc, pointed to from the PR body, is the spec). Handle each arm as below.
>
> **Tracker-backed lightweight** (`--issue --lightweight`): a linked issue exists, so keep the `Closes #N` linkage and all issue-level tracking, but the **PR body**, not the issue body, is the canonical spec-of-record read for AC/DoD. Still resolve the linked issue for tracking, but read the AC/DoD/invariants from the PR body rather than the issue body (skip step 2's issue-body read for spec purposes). Run `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <pr-number> --expected-issue <issue-number>` (reuses `@dev-loops/core/loop/issue-refinement-artifact`) to confirm the body carries the required invariants — it fails closed with a per-section `missing_*` reason if any is absent, in which case post the gate comment with verdict `blocked`. The PR body MUST carry the `Closes #N` linkage (or GitHub's other closing-keyword forms): `validate-pr-body-spec` fails closed with `missing_closing_issue_reference` without it, and with `closes_wrong_issue` when `--expected-issue` doesn't match. Then continue at step 3, extracting the **Acceptance criteria** checklist items from the PR body itself; step 5's issue-body AC-tick update is unnecessary since the issue body is not the spec surface (the PR body is ticked in step 6 as usual).
>
> **Issue-less lightweight** (`--lightweight` alone): no linked issue exists — by design, not a gap. There is nothing to resolve at step 1 and nothing to read or mirror at steps 2 and 5; skip all three. Read AC/DoD/invariants directly from the PR body and run `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <pr-number> --no-issue`, which fails closed with a per-section `missing_*` reason for any absent invariant and with `unexpected_closing_issue_reference` if the body carries a closing reference to an issue that doesn't back it (a closing reference MUST NOT be present). On any validation failure, post the gate comment with verdict `blocked`. Step 1's "zero candidates → blocked" rule is scoped to tracker-backed sessions; for a deliberately issue-less session, zero closing references is the expected state, not a blocked condition. Continue at step 3 against the PR body, then step 4 and 6 as usual.
>
> **Plan-file promotion (P4) — a distinct local-planning origin, not a lightweight sub-arm:** no linked issue exists — similar to the issue-less lightweight arm, there is nothing to resolve at step 1 and nothing to read or mirror at steps 2 and 5; skip all three. AC/DoD live in the PR body, copied from the committed plan doc that is the spec-of-record; read them from the PR body as usual.
>
> The default issue-backed procedure below is unchanged.

1. **Resolve the linked issue number deterministically:** use `gh pr view <pr-number> --repo <owner/name> --json closingIssuesReferences,body` and apply this decision tree: if there is exactly one closing issue reference, use it; else if there is exactly one PR-body `Closes #N` / `Fixes #N` pattern, use it; otherwise (zero or multiple candidates), post the gate comment with verdict `blocked` (gate cannot complete deterministically) rather than guessing.

2. **Read the issue body:** `gh issue view <issue-number> --repo <owner/name> --json body`

3. **Extract checklist items** from the **Acceptance criteria** section of the issue body (both `- [ ]` unchecked and `- [x]` already-checked items). Ignore checklist items from other sections (DoD, tasks, non-goals) that are not acceptance criteria.

4. **Verify each AC item** against the proposed changes on the current PR head.

5. **Update the issue body once:** compute the fully-updated issue body by replacing each verified item's `- [ ]` with `- [x]`, write it to a temporary file, and perform a single `node scripts/github/edit-issue.mjs --repo <owner/name> --issue <issue-number> --body-file <tmp-file>`. Do not issue one edit per item; prefer `--body-file` over inline `--body` to avoid shell quoting/escaping hazards.

6. **Tick the PR body once:** after the verification is clean, flip each verified item's `- [ ]` to `- [x]` in the PR body via a single `gh pr edit --body-file` update, so the merged PR shows checked AC/DoD. Run `node scripts/github/tick-verified-checkboxes.mjs --repo <owner/name> --pr <pr-number> --verified <exact label>...` (one edit; exact-label match; only items actually verified are ticked; unverified or deferred items stay `- [ ]`; fail closed). This runs automatically as part of the `pre_approval_gate`, not by memory.

7. **Post the gate comment:** always post a `pre_approval_gate` comment (the checkpoint verdict comment contract requires a visible comment even for non-`clean` verdicts). Use verdict `clean` only when all AC items are verified; use verdict `findings_present` when any AC item is not satisfied and requires follow-up fixes; use verdict `blocked` when the gate cannot complete deterministically (for example no linked issue, ambiguous issue linkage, or the issue body is unavailable). In all cases include a note on AC verification status.

When the issue body has no AC checklist items, post the gate comment with verdict `findings_present` and note that fact explicitly rather than assuming satisfaction.
