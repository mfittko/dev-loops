# 0079. Pre-PR review phase: developer-briefed fresh-context review before the first push

## Status

Accepted — 2026-09-21 ([PR 2319](https://github.com/mfittko/dev-loops/pull/2319))

## Context

Almost all dev-loop churn comes from findings that surface INSIDE the gate. Every in-gate fix costs a head bump, a re-gate, and often a forced Copilot round plus thread reconciliation. The cheapest place to fix a defect is BEFORE the first push: no head bump, no PR thread, no Copilot round, nothing to reconcile. Until now there was no structured pass that shifted even one review to that point. The practice was applied ad hoc via coordinator prompts during the v1.0.4 drain (issue #2305); this record makes it a durable phase.

## Decision

Add an additive pre-PR review phase to the local-implementation loop, between the exit-validation commit and PR creation (step 11b, before the branch's first push). The developer hands a mandatory review brief to ONE fresh-context, general-purpose reviewer paired with an adversarial-enumeration checklist for any new filesystem/parse/diff seam. Findings are applied in-tree; the pass is ephemeral (no PR, comment, thread, or Copilot round), bounded to one general-purpose reviewer per round and at most two rounds, then the branch is pushed once. The full fresh-context fan-out `draft_gate`/`pre_approval_gate` still runs afterward as the authority: the pre-PR pass is a cheap pre-filter, not a replacement, and produces no lifecycle-gate evidence. Canonical contract: `skills/docs/pre-pr-review-contract.md`.

The reviewer's model is harness-agnostic and config-resolved via `resolveRoleModel` (a new `pre-PR-reviewer` built-in role, high tier default). No model literal is hardcoded in the phase prose, tooling, or dispatch; the resolved model is passed to the dispatch only when non-null. Operators opt into a concrete strong model per harness in `.devloops`. This repo opts the Claude-Code harness into Fable.

Harness-token decision: the issue AC names the Claude opt-in model as `claude-fable-5-1`. The Claude Code Agent-tool `model` parameter is an enum that accepts only `sonnet|opus|haiku|fable`, so the full id is rejected at dispatch. `.devloops` therefore sets `claude: fable` (the accepted Fable token), with the full identity `claude-fable-5-1` retained in the config comment and contract as documentation. This preserves the AC intent (opt into Fable) and is the only value the harness accepts. The contract records that each harness value must be a token that harness's dispatch accepts.

The first push is deferred to step 11b for tracker-backed sessions: the per-slice commit push (implementation-loop step 3), the sub-delegate self-commit push (`LOCAL-DELEGATE-SELF-COMMIT`), and the exit-validation push (`LOCAL-COMMIT-BEFORE-EXIT`) all commit locally and defer the first push to 11b, so the branch reaches origin once, already cleaned. Phase-doc-backed sessions have no first push (they merge locally) and no pre-PR step.

We rejected reusing the fan-out gate's fixed-angle taxonomy for this pass (it is general-purpose and brief-driven, which catches more than a single fixed lens), hardcoding any model (config-resolved per harness), and mandating same-reviewer continuation for round two (SendMessage is unavailable on some harnesses, so round two is the same reviewer continued when the harness supports agent continuation, otherwise one fresh dispatch — either way fresh relative to the implementer). We rejected mechanical enforcement that the pass ran: it is agent-executed procedure, guarded by contract prose plus conformance tests (`test/contracts/pre-pr-review-contract.test.mjs`, `test/contracts/devloops-tier-config.test.mjs`).

## Consequences

One review moves to the cheapest fix point. A defect caught pre-push never triggers a downstream full draft-gate fan-out (7+ reviewers) plus a Copilot round per missed finding, so one premium call replaces many re-gate cycles. The phase was dogfooded on its own PR: two bounded pre-PR rounds (fresh-context reviewer, model Fable) caught a real push-ordering contradiction and the harness-token defect above before the first push. The trade-off is one extra premium review call per tracker-backed run before the branch is pushed, accepted because it is far cheaper than the in-gate churn it removes. The fan-out gate remains authoritative, so the pre-filter cannot lower the merge bar.
