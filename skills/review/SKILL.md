---
name: review
description: >-
  Standalone, on-demand review entrypoint over the shared draft+pre-approval
  fan-out/fan-in gate procedure. Runs ONE `review`-gate round on any PR — draft
  or ready, with no dev-loop lifecycle obligation — and posts the single-surface
  verdict. Never fixes, never flips ready-for-review, never moves a board item,
  and never satisfies draft_gate/pre_approval_gate evidence.
allowed-tools: read bash
user-invocable: false
---

# Review

`review` is an informational gate on any PR (draft or ready). It never blocks a
lifecycle transition, waits on CI, auto-resolves, or satisfies lifecycle evidence.

**Ownership-exempt (issue #1850).** It makes no branch push, fix commit, merge,
board move, or assignee claim. Enter directly from the public review-intent
shortcut; never run startup or its single-contributor ownership gate. Read the
[ownership boundary](../docs/public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup)
when distinguishing this route from write-capable follow-up, which stays gated.

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

Read [Gate-review sub-loop contract](../docs/gate-review-sub-loop-contract.md) before execution. Reuse its context, primer, fan-out and fan-in procedure with `--gate review` through every stage; stop after verdict-post and the submit choice, before judge, fix or repeat phases.

1. **Phase 1 — context-builder.** `node scripts/github/write-gate-context.mjs
   --repo <owner/repo> --pr <n> --gate review --head-sha <sha> --base <ref>
   [...]` — the SAME build-once neutral bundle (diff + adjacent code) draft/
   pre-approval get. Angle resolution for `review` is NOT dynamic/tiered: it is
   the deterministic UNION of `draft`'s and `preApproval`'s configured angle
   sets (`resolveReviewGateAngles` in `write-gate-context.mjs`). The
   spec-of-record-dependent angles — `acceptance-criteria`, `pr-checklist`,
   `pr-description`, and `gate-evidence` — are each DROPPED (with a recorded
   rationale entry, reason `"no spec-of-record"`) only when the PR closes no
   issue AND its own body carries no AC checklist; all are KEPT when either
   is true.
2. **Phase 1.5 — cache primer.** Same `GATE-EXEC-PRIME` contract as any other
   gate fan-out — prime the shared prefix before releasing the rest of the
   fan-out.
3. **Phase 2 — fan-out.** One independent, fresh-context `review` agent — the
   `dev-loops:review` persona in scoped angle-review mode
   (`agents/review.agent.md`, generated to `.claude/agents/review.md`),
   spawned via the plain Agent tool, NOT a general-purpose agent — per
   resolved dispatch unit (`resolveFanoutGroups`), each seeded with the
   identical neutral bundle plus its angle(s) — unchanged from draft/
   pre-approval fan-out; no new reviewer angles, no bespoke review agent.
4. **Phase 3 — fan-in + post.** `node scripts/loop/consolidate-fanin.mjs
   --gate review [...] --emit-plan <emit-plan-path> --ledger-out <path>`
   synthesizes the per-angle findings into one disposition ledger and computed
   verdict (`<emit-plan-path>` is the keyed `review-<headSha>.emit-plan.json`
   sibling `emit-fanout-dispatch.mjs` persisted in Phase 2, consumed by the
   fan-in's `GATE-EXEC-EMIT-PLAN-KEY` fail-closed round-key guard — a stale or
   foreign emit plan fails closed instead of being consumed). Before posting,
   write the durable ledger through `write-gate-findings-log.mjs` with
   `--findings-file <ledger-out-path> --emit-plan <emit-plan-path>`,
   `--execution-mode fanout_fanin` (this IS a fan-out/fan-in write, so the ledger
   records the real execution mode — omitting it defaults to `inline_single_agent`
   and mis-records the round), and
   `--provenance <json>` so the
   same keyed plan also guards that caller-supplied reviewer provenance
   corresponds to the emitted units; the plan remains a guard, never a findings
   or provenance source. Then `node
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
   - **Interactive:** post `--submit pending` first, then present `AskUserQuestion`.
     Every submit choice re-runs `upsert-checkpoint-verdict.mjs --gate review`
     for the SAME round, without another fan-out. It consumes the caller's own
     same-head pending review through `/reviews/<id>/events`, preserving inline
     comments and the review id; never create a second review.
     - **Leave pending (default):** print the review URL and how to finish it
       (open the URL or re-run the helper with the submit flags below). Warn
       that the draft remains invisible to other reviewers.
     - **Submit as Comment:** `--submit comment`, event `COMMENT`.
     - **Submit as Request-changes:** `--submit request-changes --interactive-confirm`,
       event `REQUEST_CHANGES`. Explain that this can BLOCK merge under GitHub
       branch protection until dismissed, independently of dev-loops gates.
     - **Submit as Approve:** `--submit approve --interactive-confirm`, event
       `APPROVE`. Explain that this SATISFIES required-approvals branch protection,
       independently of dev-loops gates; it never supplies lifecycle-gate evidence.
     - **Discard:** `--submit discard --interactive-confirm` deletes the caller's
       own pending draft (`DELETE /pulls/<pr>/reviews/<id>`), leaving no review.
     `--interactive-confirm` records the human's choice in this prompt;
     approve/request-changes/discard fail closed without it and refuse headless
     execution, including `--auto` with the token. Submit leaves one review,
     leave-pending keeps one draft, discard leaves none.
   - **`--auto`/headless:** post `--submit comment` and skip the prompt.

**Stop here.** Never proceed to the judge pass, the fix cycle, a re-gate
round, `pr ready-for-review`, or a board move — a `review` round is a single,
complete, terminal pass. There is no `review` fixer loop and no re-gate path;
if the operator wants findings fixed, that is a SEPARATE, explicit
instruction, not something this skill initiates itself.

## Non-evidence, by construction

A `review` verdict is never `draft_gate`/`pre_approval_gate` evidence, in any
`--submit` mode. `parseGateReviewCommentFields` recognizes the `review` header
and returns `null` before the whole-body lifecycle-token fallback, with or
without a findings marker. Preserve that header: findings mentioning lifecycle
gate names must not become evidence.

GitHub-native `APPROVE` can satisfy required approvals and `REQUEST_CHANGES` can
block merge independently. The interactive choice above owns their confirmation
boundary; omitting `--auto` does not establish human confirmation.

## Non-goals

No fixer loop, no re-gate, no merge path, no new reviewer angles, and no
headless CLI that spawns reviewers itself — fan-out stays agent-orchestrated
exactly like draft/pre-approval fan-out. It does not change draft_gate or
pre_approval_gate semantics in any way. No auto-submit of a pending review on
a later run — the human submits it (or discards it) via the interactive
submit choice.
