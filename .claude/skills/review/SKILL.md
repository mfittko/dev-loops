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

## Interface

```
/loop-review <pr>
```

`<pr>` is a pull request number or URL, required. `<owner/repo>` resolves from
the git remote at invocation, same as the other loop commands.

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
   — informational review, no re-gate required" [...]` posts the SINGLE
   visible PR review surface (`GATE-COMMENT-SINGLE-SURFACE`) straight from
   that ledger — no CI wait, no coordination-context read, no auto-resolve, no
   forbidden-action check (those are draft/pre-approval-only machinery `review`
   never touches).

**Stop here.** Never proceed to the judge pass, the fix cycle, a re-gate
round, `pr ready-for-review`, or a board move — a `review` round is a single,
complete, terminal pass. There is no `review` fixer loop and no re-gate path;
if the operator wants findings fixed, that is a SEPARATE, explicit
instruction, not something this skill initiates itself.

## Non-evidence, by construction

`review` is deliberately absent from `GATE_CONFIG_KEY`
(`@dev-loops/core/loop/gate-fanin`) and from the core gate-comment header
vocabulary (`GATE_REVIEW_NAMES`/`GATE_REVIEW_COMMENT_HEADER_RE`,
`@dev-loops/core/github/copilot-helpers`): a posted `review` verdict comment
never parses as a `draft_gate` or `pre_approval_gate` comment, so
`detect-checkpoint-evidence.mjs`/`detect-pr-gate-coordination-state.mjs` never
attribute it to either gate's evidence — `draftGateAlreadySatisfied` stays
`false` and pre-approval readiness is unaffected, no matter how many `review`
rounds a PR has carried. Posting `review` is purely informational.

## Non-goals

No fixer loop, no re-gate, no merge path, no new reviewer angles, and no
headless CLI that spawns reviewers itself — fan-out stays agent-orchestrated
exactly like draft/pre-approval fan-out. It does not change draft_gate or
pre_approval_gate semantics in any way.
