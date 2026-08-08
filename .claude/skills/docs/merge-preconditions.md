# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Conflict-free (mergeable) is a precondition at every gate

A PR that conflicts with its base gets **no `pull_request` CI run** — GitHub can't
compute the merge ref — so the gate silently stalls (green-less with no obvious
cause). Conflict-free is therefore a required gate precondition, checked at **two
seams**: before requesting CI/Copilot, and again before merge.

- `gh pr view --json mergeable,mergeStateStatus` drives it. A `CONFLICTING` /
  `DIRTY` / `BEHIND` PR does **not** pass any gate (`gateBoundary:
  conflict_resolution`, `nextAction: resolve_merge_conflicts`).
- `mergeable` is computed asynchronously, so a freshly-pushed head briefly reads
  `UNKNOWN`. The detect layer **re-polls a bounded number of times**; if it never
  settles, the gate **fails closed to a recheck** (`nextAction: wait_for_ci`) —
  an unsettled merge state is never treated as clean.
- `loop info` surfaces a **Mergeable:** line (mergeStateStatus included) so a
  conflict is diagnosed immediately, never mistaken for missing CI.

### Deterministic auto-resolve (additive CHANGELOG only)

When a PR is behind/`CONFLICTING`, run the conservative resolver before resuming
the gate path:

```sh
node scripts/loop/resolve-pr-conflicts.mjs [--base <branch>] [--push]
```

It merges `origin/<base>` into the PR branch and resolves **only the safe additive
case** — a `CHANGELOG.md` conflict where both sides only ADD list/section entries
(keep BOTH sides, in order) — then runs `npm run test:docs` and (with `--push`)
pushes. **Any other conflicted path, or a non-additive CHANGELOG edit, FAILS
CLOSED** naming the conflicted paths (no silent stall, no guessing — resolve those
by hand). This encodes the exact additive-CHANGELOG resolution the loop has been
doing manually; it is not a general conflict-resolution engine.

## Required before merge

<!-- rule: MERGE-PRECOND-REQUIRED -->
Before merge, ALL of the following MUST hold:

1. ✅ Conflict-free with base (`mergeable: MERGEABLE`; not `CONFLICTING`/`DIRTY`/`BEHIND`/`UNKNOWN`)
2. ✅ CI green (`success`) on current head. `crediblyGreen` (the bounded zero-suite
   `--local-validation-head-sha` exception) never substitutes for this —
   `evaluatePrGateCoordination` fails it closed identically to a real CI failure at
   the pre-approval and final-approval boundaries (#552). It only extends the
   draft-gate wait until CI actually settles green.
3. ✅ Draft gate satisfied — clean `draft_gate` verdict per `GATE-COMMENT-VERDICT-VALUES` ([Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md))
4. ✅ Pre-approval gate satisfied — clean `pre_approval_gate` verdict on the current head, same rule
5. ✅ All review threads resolved
6. ✅ Explicit merge authorization from operator
7. ✅ Closing-reference state matches artifact backing, each arm owned by a different contract: tracker-backed work — PR body contains `Closes #N` or `Fixes #N` (owned by the PR description contract in [copilot-loop-operations.md](copilot-loop-operations.md)); issue-less lightweight (PR-body-as-spec, no backing issue) — the closing reference is absent by design and `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <number> --no-issue` passes clean (owned by `ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS` in [Artifact Authority Contract](artifact-authority-contract.md)); plan-file promotion (P4) — the PR body carries the committed plan-doc path as the spec-of-record and, being issue-less by design (`buildPromotionPrBody` neutralizes closing keywords), the closing reference MUST NOT be present
8. ✅ PR **title** free of merge-blocking markers — see [Title markers](#title-markers) for the exact constructions that count

> Runner-coordination lock: the pre-merge evidence check fails closed on a stale/foreign runner claim for the PR. A completing run releases its claim best-effort at every terminal stop (including the human approval checkpoint), so a merge re-dispatch normally proceeds. If a lock held by a completed/dead run still blocks the merge, take it over explicitly with `node <resolved-skill-scripts>/loop/pr-runner-coordination.mjs takeover --repo <owner/name> --pr <number>`. Never take over a genuinely active (non-stale) run — that fail-closed block is intentional.

> Stranded Copilot review request (human-only): a review requested on a head that already carries Copilot's own clean submitted review is never delivered — Copilot does not re-engage a change it effectively approved — so below the round cap the loop waits indefinitely and `pre_approval_gate` cannot post. (At the cap the loop already routes to `round_cap_clean_fallback`, so the gate is not blocked and there is nothing to unstick.) Withdraw it explicitly with `node <resolved-skill-scripts>/github/withdraw-copilot-review-request.mjs --repo <owner/name> --pr <number> --reason <why>`. It withdraws only when a request is pending (no request is an exit-0 no-op) and refuses outright unless Copilot has already submitted a review and no unresolved threads remain, and it verifies the withdrawal took effect — so prefer it over a raw `gh pr edit --remove-reviewer`, which has none of those guards. This is an operator judgement about a model's behavior: it is deliberately NOT in the sanctioned-command set and an agent must not invoke it.
>
> Head-advanced sibling case (issue 1441): the loop converged, the round's threads were reply-resolved on a NEW head, so `copilotReviewOnCurrentHead` is false. Withdrawing alone would just make the loop re-request Copilot on that head and strand again. The tool covers this too, but only when the delta since Copilot's last SUBMITTED review is provably a pure doc/prose bump (the same fail-closed classifier `request-copilot-review.mjs` already trusts at the round cap) — any code/test/config/CI or unclassifiable delta, a non-linear advance, or an unavailable compare still refuses, exactly as before. On success it records an operator-authorized suppression marker scoped to that exact head (`scripts/loop/_post-convergence-review-suppression.mjs`); `request-copilot-review.mjs` and the gate coordinator (`evaluatePrGateCoordination`'s `postConvergenceReviewSuppressed` input) both honor that marker so the round is not forced open again and `pre_approval_gate` can post. Any further push changes the head and invalidates the marker.

### Items 3 and 4 apply to every path, not just the dev-loop tooling

Items 3 and 4 (clean `draft_gate` / current-head `pre_approval_gate` verdicts) are
enforced two ways, and both must be closed for the precondition to hold in
practice:

- **Client-side:** the PreToolUse Bash hook blocks an ungated `gh pr ready` /
  `gh pr merge` invocation, and `detect-checkpoint-evidence.mjs` is what the
  dev-loop tooling calls before merging.
- **Server-side:** the `gate-evidence` status check
  (`.github/workflows/gate-evidence.yml`) re-runs the same verdict check on
  GitHub's own token for every non-draft PR, re-firing on push, ready-for-review,
  a submitted or edited review, a standalone review comment, and a
  created/edited PR issue comment that starts with the gate-comment marker
  (`### Gate review:`) from a trusted author (`OWNER`/`MEMBER`/`COLLABORATOR`)
  — so a newly-opened unresolved thread re-evaluates the check instead of
  leaving a SHA-pinned green stale on the thread axis, and posting a gate
  verdict itself re-evaluates the check instead of leaving a stale
  pre-verdict `pending`/`failure` blocking a satisfied PR. The verdict is a PR
  REVIEW (`GATE-COMMENT-SINGLE-SURFACE`): a new round's review fires
  `pull_request_review [submitted]`, and a same-head verdict correction (the
  upsert's in-place `PUT`) fires `pull_request_review [edited]`; the
  issue-comment arm covers only legacy verdicts and the zero-dep fallback
  poster. Evaluation always runs the DEFAULT BRANCH's
  detector (trusted code; the resolved PR head SHA is only the status target).
  Recovery for a lost/failed run when the verdict already exists and is
  correct: re-run the round's verdict post with a corrected field (the upsert
  PUTs the review in place and `edited` re-fires the check), post the next
  round's verdict review, or — where the full toolchain is unavailable — the
  zero-dep fallback poster's issue comment re-fires via the issue_comment
  arm. An identical same-head rerun is a deliberate no-op and does not
  re-fire. `gh run rerun` is NOT a recovery
  path (it replays the stale original event payload). (There is no `pull_request_review_thread` Actions
  trigger, so thread resolve/unresolve is not itself a re-fire event; a
  newly-appearing unresolved thread arrives via a submitted review or a review
  comment, both of which do re-fire. One narrow residual remains: a bare
  "Unresolve conversation" UI action on an already-resolved thread, with no
  accompanying review or comment, fires only that non-triggerable event and so
  does not re-fire the check — bounded by the maintainer-gated merge, and
  re-caught on the next push, review, or comment.) The `gate-evidence`
  context itself is always an explicit commit status posted to the resolved PR
  head SHA (not the triggering job's own check-run, which for
  review and comment event types would land on the wrong commit — the base
  branch's latest for review events, the default branch's for issue_comment). This is what closes the ready/merge bypass —
  a direct GitHub API call (MCP/REST, web UI, a raw `gh` invocation outside the
  hook) skips the client-side path entirely but still cannot merge without a
  green `gate-evidence` check **once branch protection on `main` requires it**.
  Until an operator adds it to branch protection, the check runs and reports on
  every non-draft PR but does **not** yet block merge — it is reporting-only in
  that window.

The server-side check verifies the same visible, comment-derived verdict fields
the client-side tooling does (including the light-mode inline exception,
[Gate Review Sub-Loop Contract](./gate-review-sub-loop-contract.md#light-mode-inline-acceptance-under-threshold-micro-prs)),
via `--skip-fanout-ledger-check`. It does **not** re-verify the deeper fan-out
findings-log ledger/provenance layer (`gates.requireFanoutEvidence` /
`requireFanoutProvenance`): that evidence lives in a gitignored, worktree-local
`tmp/` file only the machine that ran the review has on disk, so a stateless CI
runner can never see it. That layer remains client-side/self-reported-only — the
same "not un-forgeable" caveat the sub-loop contract already documents.

### Evidence writes and `gh pr merge` MUST be separate tool calls (#1172)

The PreToolUse Bash gate evaluates `gh pr merge` **before** the Bash tool call executes. A compound
command that both writes gate evidence (the findings-log ledger, `upsert-checkpoint-verdict`) and
merges in the same call is blocked at hook-evaluation time — the write never runs. This can look
like the ledger "vanished" between writing and merging; it was never written. The block message
names this when it detects an evidence-writing invocation in the same command string.

Documented pattern — **write, verify, then merge alone**:

1. Write the gate evidence (findings-log ledger / checkpoint verdict) in its own Bash call.
2. Verify it landed (e.g. `ls tmp/gate-findings/<slug>/pr-<n>/`) in a separate call.
3. Run `gh pr merge` alone, with no other command chained via `&&`/`;`/newline.

## Title markers

The PR title is a contract surface, so a merge-blocking marker in the title is enforced
deterministically (`findBlockingTitleMarkers` in `@dev-loops/core/loop/pr-title-markers`), not
just reviewed. `WIP` and `DRAFT` only count as blocking when the title uses one of four
sanctioned constructions — a genuine status claim, not a plain word match:

- bracketed: `[WIP]`, `[draft]`
- parenthesized: `(wip)`, `(DRAFT)`
- colon-suffixed: `WIP: add feature`, `draft: new module`
- standalone (the entire title, nothing else): `WIP`, `draft`

A hyphen, underscore, or space joining the marker word into a compound noun phrase names a
component instead of asserting status, and is exempt from every construction —
`draft-gate`, `draft_gate`, `draft gate`, `wip-branch` never flag; nor does a conventional-commit
scope that happens to share the marker word, e.g. `fix(draft): support x`. `DO NOT MERGE`
(flexible whitespace between the words) and `🚧` (anywhere in the title) are matched directly,
with no compound-noun exemption — case-insensitive throughout.

A dash-set-off trailing tag (`Fix login flow — WIP`) is deliberately not a construction: no
dash-based rule closes the tag without also reopening the compound-noun false positive for a
different dash character, so it stays unflagged; `WIP:`/`DRAFT:` remains one keystroke away.

The bracket/paren/colon constructions require their opening delimiter to sit at the start of the
title or right after whitespace — never directly after a letter, `/`, or `-`. This anchoring is
what exempts a conventional-commit scope, a path segment, and a scoped label from matching, and it
is also why a marker preceded by other punctuation with no space (`Fix bug,(draft)`,
`Fix login(wip)`) stays unflagged: the anchor is whitespace-only, not punctuation-only. The colon
construction additionally requires the colon to close the tag — followed by whitespace or
end-of-title, never another character — so `draft:latest` and `wip:branch` read as an identifier,
not a status claim.

- At the **draft → ready-for-review** transition: `ready-for-review` refuses `gh pr ready` while the
  title carries a marker.
- At the **pre-approval gate boundary and final approval** (for non-draft PRs): the gate coordinator
  returns `title_marker_blocked` so a PR un-drafted externally still cannot enter pre-approval or
  reach merge-ready with a marked title.

A marker is allowed only while the PR is still in draft; it must be removed before the PR leaves draft.

## Merge authorization

- Merge authorization MUST be explicit for the active issue/PR scope
- `"Merge authorized if gates green"` is valid explicit authorization
- Implied approval from prior turns MUST NOT be treated as sufficient

### `autonomy.humanMergeOnly` — fixed human-only merge (non-overridable)

When a repo sets `autonomy.humanMergeOnly: true` in `.devloops`, merge is a fixed
human action and this authorization step is **non-overridable**:

- `resolveAutonomyStopAt` always includes `merge`, even if `stopAt` is set to `[]`.
- The effective merge authorization fails closed: `resolveEffectiveMergeAuthorized`
  returns `false` regardless of the `mergeAuthorized` envelope flag or an explicit
  "merge" instruction. The lifecycle resolver therefore never advances to the merge
  state and parks at the `pre_approval_gate` human-merge handoff.
- The agent still runs the full mechanical pre-merge evidence check and reports
  merge-ready + gate evidence, then hands off to a human to perform `gh pr merge`.
  The agent **never** runs `gh pr merge` itself.

This makes human-gated merge an enforced repo invariant, not a per-run default an
explicit instruction can unlock.

### `approval` — offer to assign a human at the handoff (opt-in)

When a repo sets `approval.enabled: true` in `.devloops`, the loop
does not just park silently at the human-merge stop — at the
`pre_approval_gate` / `waiting_for_merge_authorization` boundary it **offers**
to route the PR to a contributor (pairs with `autonomy.humanMergeOnly`: when
human-merge is enforced, the handoff names who should take it). Disabled by
default; no candidate sourcing when disabled.

```yaml
approval:
  enabled: true
  candidatesFrom: [codeowners, recent-committers]
  assignees: [alice, bob]
```

At the handoff boundary, resolve and surface candidates:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number>
```

This prints the deduped, ordered candidate list (priority:
`assignees` > `codeowners` for the touched paths (last-match-wins) >
`recent-committers` to those paths, PR author/bots excluded). It assigns no one.

**OFFER-only — the operator confirms the assignee** (auto-assigning without
confirmation is a non-goal). On confirmation, perform the action:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number> \
  --assign <login> --request-review <login>
```

which runs `gh pr edit --add-assignee` / `--add-reviewer` for the confirmed
human(s).

## Post-merge

- Fast-forward the main checkout's local `main` to `origin/main` (#1596): resolve the main (primary) checkout via `git worktree list` (first entry) from the current cwd, then run `git -C <main-checkout> fetch origin main && [ "$(git -C <main-checkout> rev-parse --abbrev-ref HEAD)" = main ] && git -C <main-checkout> merge --ff-only origin/main` (best-effort, `|| true`). The post-merge hooks (Pi `post-merge-update`, Claude `post-tool-use-merge`) also run this automatically; the explicit step makes it deterministic for the dev-loop's own merges. The merge only advances `main` when the main checkout is on `main` (the normal state); a main checkout not on `main` should be reconciled manually first. `--ff-only` refuses a diverged main without rewriting history — a diverged main checkout warns and continues, never blocking. Read-only gate scripts (`probe-ci-status.mjs`, `detect-copilot-loop-state.mjs`, …) run from the main checkout, so a stale local `main` made them execute pre-merge code (re-introducing the CI-wait stall every PR).
- Sync the merged item's board Status to Done (issue #1458), run BEFORE worktree removal below:
  `dev-loops queue sync-status --repo <owner/name> --pr <number> --item <linked-issue> --logical-column done || true`
  (omit `--item` when the merged PR is itself the queue item — an unfilled/empty `--item` falls back to `--pr`; the
  `|| true` masks the residual usage-error exits the same way the archive step's does). `--logical-column done`
  resolves the Done column through `queue.statusColumns`, so a board that renamed Done still converges. Resolves the
  board from `.devloops` (`tracker.board`/`queue.board`) relative to `cwd` — there is no `--repo-root` flag — using
  local `gh` auth, so it must run from the main checkout: the next step removes the worktree, leaving it with no cwd.
  Best-effort and NON-FATAL on a parsed invocation: a board that is not configured, an item not on the board, or any
  API failure exits 0 with a JSON result describing the skip instead of failing the merge; a usage/argument error
  still exits 1 and an invalid `--jq` filter exits 2.
- Remove merged worktree (canonical, `WORKTREE-CLEANUP`): `node scripts/loop/cleanup-worktree.mjs --repo-root <main> (--issue <n> | --pr <n>)`.
  See [Worktree usage guidance](./worktree-guidance.md#post-merge-cleanup).
- Archive long-done queue items (operator-induced, NOT a cron): `node scripts/projects/archive-done-items.mjs --repo <owner/name> || true`.
  Runs as part of this post-merge hook. It applies the configured `queue.archiveOlderThanDays` (default `7d`) and archives
  board items whose issue/PR has been closed at least that long. Best-effort: run it as a standard post-merge step but ignore
  any non-zero exit (a successful run that finds nothing to archive exits 0; a board/config-resolution/API error exits
  non-zero, which the `|| true` masks) — a failure here must never block merge completion. See
  [projects queue usage](./projects-queue-usage.md).
- Clean up stale branches

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
- [PR Lifecycle Contract](pr-lifecycle-contract.md)
- [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) — `GATE-COMMENT-VERDICT-VALUES`
- [Contract style guide](contract-style-guide.md)
