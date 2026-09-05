---
name: "review"
description: "Standalone, on-demand review entrypoint over the shared draft+pre-approval fan-out/fan-in gate procedure. Runs ONE `review`-gate round on any PR — draft or ready, with no dev-loop lifecycle obligation — and posts the single-surface verdict. Never fixes, never flips ready-for-review, never moves a board item, and never satisfies draft_gate/pre_approval_gate evidence."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/review/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Review

`review` is a THIRD gate, alongside `draft_gate` and `pre_approval_gate`
(`scripts/github/_gate-names.mjs` `GATE_NAMES`), reachable on **any** PR with
**no gate obligations of its own**: it never blocks a draft→ready transition,
never blocks merge, never auto-resolves, and never waits on CI. It exists for
an on-demand "review this PR right now" pass — a code review someone asked for
outside the normal draft/pre-approval lifecycle — without disturbing that
lifecycle's own state.

**Ownership-exempt (issue #1850).** `review` is read-only — it makes no
branch push, no fix commit, no merge, no board move, and no assignee claim —
so it never needs the single-contributor ownership gate
(`resolve-dev-loop-startup.mjs`, see [Single-contributor ownership gate](../docs/public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup)).
None of `write-gate-context.mjs`, `consolidate-fanin.mjs`, or
`upsert-checkpoint-verdict.mjs` — the three scripts this skill's procedure
runs — import or invoke `resolve-dev-loop-startup.mjs`; the exemption holds
structurally, not by convention. The public [dev-loop](../dev-loop/SKILL.md)
router recognizes a plain review request and dispatches straight here,
before its own startup resolver (and the ownership gate it enforces) ever
runs — a reviewer runs `review` against a PR owned by anyone, or by no one,
with no ownership block and no fallback prompt. Every write-capable route
(`copilot_pr_followup`, `reviewer_fixer`, `final_approval`, the full loop)
stays gated exactly as before; this exemption reaches only this read-only
route.

## Interface

```
/loop-review <pr>          # interactive: ends with a submit choice
/loop-review <pr> --auto   # headless: posts a COMMENT review, no prompt
```

`<pr>` is a pull request number or URL, required. `<owner/repo>` resolves from
the git remote at invocation, same as the other loop commands. `--auto`
mirrors `/loop-grill`'s (`/dev-loops:loop-grill` in a consumer install)
headless flag (`skills/loop-grill/SKILL.md`).

In a consumer (plugin) install this runs as `/dev-loops:loop-review <pr>`; the
bare `/loop-review` form is dev-loops-repo-local (repo-local
`.claude/commands`).

## What it runs

`review` reuses the SAME shared sub-loop
([Gate-review sub-loop contract](../docs/gate-review-sub-loop-contract.md)) the
draft/pre-approval gates run, with `--gate review` threaded through every stage,
but stops after fan-in/verdict-post — it never reaches the judge, fix, or
repeat phases those gates run:

1. **Phase 1 — context-builder.** `node scripts/github/write-gate-context.mjs
   --repo <owner/repo> --pr <n> --gate review --head-sha <sha> --base <ref>
   [...]` — the SAME build-once neutral bundle (diff + adjacent code) draft/
   pre-approval get. Angle resolution for `review` is NOT dynamic/tiered: it is
   the deterministic UNION of `draft`'s and `preApproval`'s configured angle
   sets (`resolveReviewGateAngles` in `write-gate-context.mjs`). The
   `acceptance-criteria` angle is DROPPED (with a recorded rationale entry,
   reason `"no spec-of-record"`) only when the PR closes no issue AND its own
   body carries no AC checklist; it is KEPT when either is true.
2. **Phase 1.5 — cache primer.** Same `GATE-EXEC-PRIME` contract as any other
   gate fan-out — prime the shared prefix before releasing the rest of the
   fan-out.
3. **Phase 2 — fan-out.** One independent, fresh-context `review` agent per
   resolved dispatch unit (`resolveFanoutGroups`), each seeded with the
   identical neutral bundle plus its angle(s) — unchanged from draft/
   pre-approval fan-out; no new reviewer angles, no bespoke review agent.
4. **Phase 3 — fan-in + post.** `node scripts/loop/consolidate-fanin.mjs
   --gate review [...] --ledger-out <path>` synthesizes the per-angle findings
   into one disposition ledger and computed verdict, then `node
   scripts/github/upsert-checkpoint-verdict.mjs --repo <owner/repo> --pr <n>
   --gate review --head-sha <sha> --findings-ledger <path> --next-action "none
   — informational review, no re-gate required" --submit <mode> [--auto]
   [...]` posts the SINGLE visible PR review surface
   (`GATE-COMMENT-SINGLE-SURFACE`) straight from that ledger — no CI wait, no
   coordination-context read, no auto-resolve, no forbidden-action check
   (those are draft/pre-approval-only machinery `review` never touches). See
   [Checkpoint Verdict Comment Contract](../docs/gate-review-comment-contract.md#review-gate-submit-modes-1840)
   for the `--submit` vocabulary. `approve`/`request-changes`/`discard`
   additionally REQUIRE `--interactive-confirm` (#1888/#1912) — fail closed
   unless provably interactive, so omitting `--auto` is not a license for a
   headless caller. When an own same-head pending review already exists,
   `comment`/`request-changes`/`approve` SUBMIT it via `/reviews/<id>/events`
   (preserving inline comments) rather than creating a second review (which
   422s); `discard` DELETES it (#1912).

   <!-- rule: REVIEW-GATE-VERDICT-CANONICAL -->
   `REVIEW-GATE-VERDICT-CANONICAL`: the `review` verdict MUST be posted through
   `upsert-checkpoint-verdict.mjs --gate review --findings-ledger <path>`
   (above) and MUST NOT be posted with a raw `gh pr review` or `gh api
   .../reviews` call. A raw post skips the `dev-loops:gate-findings-review
   review <sha> round=<n>` marker (`buildReviewHeaderMarker`,
   `_gate-finding-surface.mjs`) and every inline finding comment, so a reader
   cannot tell a contract-compliant round from a hand-authored comment that
   merely looks like one. The dev-loop skill's gh-only fallback poster
   ([Fallback gate-comment poster](../dev-loop/SKILL.md#fallback-gate-comment-poster))
   exists ONLY for the missing-`@dev-loops/core` case — it is not a
   convenience substitute for `review` when the full helper is reachable, and
   it does not even accept `--gate review` today.
   `audit-review-marker-presence.mjs` (`scripts/github/`) is a standalone, advisory-only check that
   flags a posted round missing the marker (or, when a `--findings-ledger`
   carries locatable findings, missing inline comments) with a WARNING; it
   never blocks and never becomes gate evidence — running it is optional, not
   part of this skill's own procedure.
5. **Phase 4 — submit choice.**
   - **Interactive run:** the review was posted `--submit pending` — an
     author-only draft, invisible to other reviewers until submitted. Present
     an `AskUserQuestion` multiple choice (mirroring `/loop-grill`'s
     interactive pattern, `skills/loop-grill/SKILL.md`). No-dangling
     guarantee (#1848): every **Submit as** choice CONSUMES the pending draft
     in place — it submits the existing pending review via `/events` (same
     review id), never creating a second review — so the run leaves exactly
     ONE review and no orphaned pending draft; **Leave pending** keeps exactly
     the one draft and **Discard** leaves none:
     - **Leave pending (default)** — print the PR review URL and how to
       finish it (open the URL, or re-invoke with `--submit comment`, or
       `--submit approve --interactive-confirm`/`--submit
       request-changes --interactive-confirm` for a human-confirmed submit
       — see the option below); warn it stays invisible to other reviewers
       until submitted.
     - **Submit as Comment** — re-run `upsert-checkpoint-verdict.mjs --gate
       review --submit comment` for the SAME round (do not re-fan-out). The
       re-run detects the caller's own same-head pending review and SUBMITS
       it via `POST /repos/<owner>/<repo>/pulls/<n>/reviews/<id>/events`
       (event `COMMENT`), preserving its inline comments — it does NOT create
       a second review (a second create 422s: GitHub allows only one pending
       review per user per PR, #1912).
     - **Submit as Request-changes** — same re-run with `--submit
       request-changes --interactive-confirm` (#1888: the token records that
       a human made this choice in this prompt). Submits the existing pending
       review via `/events` (event `REQUEST_CHANGES`). State inline: this is a
       GitHub-native review event that can BLOCK merge (branch protection)
       until dismissed, independent of any dev-loops gate.
     - **Submit as Approve** — same re-run with `--submit approve
       --interactive-confirm` (#1888: the token records that a human made
       this choice in this prompt). Submits the existing pending review via
       `/events` (event `APPROVE`). State
       inline: this is a GitHub-native review event that SATISFIES a
       required-approvals branch-protection rule, independent of any
       dev-loops gate — it never satisfies `draft_gate`/`pre_approval_gate`
       evidence (see [Non-evidence, by construction](#non-evidence-by-construction)
       below).
     - **Discard** — re-run `upsert-checkpoint-verdict.mjs --gate review
       --submit discard --interactive-confirm`, which DELETES the caller's
       own pending draft review (`DELETE /pulls/<pr>/reviews/<id>`) so no dangling
       artifact is left (#1912). `discard` is destructive, so like
       approve/request-changes it is refused headless and fails closed
       without `--interactive-confirm`. This is distinct from **Leave
       pending**, which keeps the draft in place.
   - **`--auto`/headless run:** skip the prompt entirely; the round already
     posted `--submit comment` (the default, and the only escalation-capable
     mode headless is allowed — `approve`/`request-changes` are refused
     headless, reachable only through the interactive choice above).

**Stop here.** Never proceed to the judge pass, the fix cycle, a re-gate
round, `pr ready-for-review`, or a board move — a `review` round is a single,
complete, terminal pass. There is no `review` fixer loop and no re-gate path;
if the operator wants findings fixed, that is a SEPARATE, explicit
instruction, not something this skill initiates itself.

## Non-evidence, by construction

`review` is absent from `GATE_CONFIG_KEY` (`@dev-loops/core/loop/gate-fanin`:
it has no `draft`/`preApproval`-style config threshold), but that absence is
NOT what keeps a posted `review` verdict comment from being misread as
draft/pre-approval evidence. The real guard lives in
`parseGateReviewCommentFields` (`@dev-loops/core/github/copilot-helpers`):
`review` IS a recognized gate name there — recognized, not absent — and
recognizing it as `review` is exactly what makes the parser return `null`
immediately, before its lenient whole-body `draft_gate`/`pre_approval_gate`
token-scan fallback ever runs. That short circuit holds independent of
whether the comment carries the `--findings-ledger` gate-findings-review
marker: a bare `review` post (no ledger, no marker) is caught the same way as
a marker-bearing one. Without it, a `review` verdict whose findings text
merely mentions "draft_gate" or "pre_approval_gate" (a plausible thing to say
when reporting on this very mechanism) could otherwise be misread as real
evidence by that fallback. Because of this guard,
`detect-checkpoint-evidence.mjs`/`detect-pr-gate-coordination-state.mjs` never
attribute a `review` comment to either gate's evidence — draft-gate
satisfaction stays unaffected and pre-approval readiness is unaffected, no
matter how many `review` rounds a PR has carried. Posting `review` is purely
informational.

This guard reads only the comment BODY (the header line) — it is entirely
independent of the GitHub review's own `event`/`state`. A `review` verdict
therefore stays non-evidence for dev-loops gates in EVERY `--submit` mode
(#1840), including `approve`: a GitHub-native `APPROVE` review still counts
toward GitHub branch protection (satisfying a required-approvals rule) — that
is expected and separate, and is exactly why headless `--auto` review runs
are refused `--submit approve`/`--submit request-changes` (see
[`--submit`](#interface) above); only a deliberate interactive choice reaches
those two events. Since #1888 that guarantee is structural, not caller-
self-identified: `approve`/`request-changes` fail closed without
`--interactive-confirm` (and still refuse `--auto` even with it), so a
headless caller cannot reach them by merely omitting `--auto`.

## Non-goals

No fixer loop, no re-gate, no merge path, no new reviewer angles, and no
headless CLI that spawns reviewers itself — fan-out stays agent-orchestrated
exactly like draft/pre-approval fan-out. It does not change draft_gate or
pre_approval_gate semantics in any way. No auto-submit of a pending review on
a later run — the human submits it (or discards it) via the interactive
submit choice.
