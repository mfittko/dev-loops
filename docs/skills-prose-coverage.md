# Skills prose cleanup coverage (variation B)

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236), independent A/B handoff. This record is variation B. Variation A is [PR 2237](https://github.com/mfittko/dev-loops/pull/2237) on branch `issue-2236`; B never edits A. The issue remains the canonical specification; this file tracks execution only.

## Baseline record

Frozen before any B edit.

| Input | Value |
| --- | --- |
| B base (origin/main at B start) | `66c96ee8361a9dad205de42c3008907596113347` |
| A original baseline (merge-base of `issue-2236` with `main`) | `894a5a59080222cef5a47fc3f4e962824e05bfda` |
| A comparison checkpoint named in the issue | `cc032f923b6942f567761584fd05e1a28f4af8b0` (partial implementation, not a baseline) |
| A head at B start | `eccf273da654d494bcc67cc118dc2ff4caf6cb91` |
| Issue 2236 spec revision | `updatedAt 2026-09-16T08:37:44Z`, `specDigest sha256:7d579da560ad722721fbd795426f87d1a9e80527dfd4ea2d88a9c665671f4e2a` (`scripts/loop/spec-context.mjs`) |
| Toolchain | Bun 1.4.1 (pinned by `bun run verify`) |

## Baseline divergence

`origin/main` advanced from A's baseline to B's base by PR 2233, the v1.0.3 release commits and PR 2234. Within that range the following in-scope files changed (PR 2233, emitter reconciled to ADR 0048):

- `skills/copilot-pr-followup/SKILL.md`
- `skills/docs/gate-review-sub-loop-contract.md`
- their generated `.claude/skills/` projections

A and B therefore start from different revisions of the phase 1 files. Before the A/B comparison, both variants must be reconciled onto an equivalent baseline (A rebased onto B's base, or the comparison run against a common ancestor). This record does not perform that reconciliation.

## File inventory

Revision-pinned at B base `66c96ee8361a9dad205de42c3008907596113347`. Every tracked file under `skills/` is listed. Dispositions: `pending` (inventoried but not yet processed — visible coverage, never claimed coverage), `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`.

Generated `.claude/skills/` projections carry no inventory row of their own. They are a byte-reproducible projection of these sources (`bun run assets:check`), so each source row's disposition governs its projection, and hand-editing a projection is forbidden.

| File | Disposition | Phase | Rationale |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | changed | 1 | Phase 1 primary target: condensed onto its owner contracts, obsolete descriptions corrected, historic references removed. |
| `skills/dev-loop/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/scripts/init-phase.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/phase-files.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/scripts/render-template.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/render-template.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/templates/bootstrap-agents.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/merged-phase-plan.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-doc.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-summary.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-variant.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/retrospective.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/slides-story-review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/ui-vision-review.md` | pending | 3 | Prose-bearing template. |
| `skills/docs/ab-contrast-deslop-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/acceptance-criteria-verification.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/agent-stall-detection.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/anti-patterns.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/artifact-authority-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/conductor-routing-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/confirmation-rules.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/contract-style-guide.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/copilot-ci-status-contract.md` | changed | 3 | Phase 1 ambiguity fix only: named a removed CLI flag as a live surface. Condensation still pending. |
| `skills/docs/copilot-loop-operations.md` | changed | 1 | Coupled required read: obsolete removed-flag instruction corrected; historic reference removed. |
| `skills/docs/copilot-loop-state-graph.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/cross-harness-regression-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/decision-record-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/docs-grill-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/entrypoint-strategies.md` | unchanged | 1 | Reviewed: already reference-shaped, with no duplicated normative restatement to remove. |
| `skills/docs/epic-tree-refinement-procedure.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/gate-review-comment-contract.md` | changed | 1 | Coupled owner: anchor citation updated only; no obligation relocated here. Condensation deferred to phase 2. |
| `skills/docs/gate-review-sub-loop-contract.md` | changed | 1 | Canonical owner of the fan-out/fan-in chain: non-decisional narration trimmed, every obligation kept in place. |
| `skills/docs/issue-intake-procedure.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/local-planning.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/main-agent-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/merge-preconditions.md` | changed | 3 | Phase 1 ambiguity fix only: named a removed CLI flag. Condensation still pending. |
| `skills/docs/pr-lifecycle-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/projects-queue-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/public-dev-loop-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/release-runbook.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/required-rules.json` | non-prose | 1 | Machine-consumed rule manifest; no prose to condense. |
| `skills/docs/retrospective-checkpoint-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/reviewer-loop-state-graph.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/slides-story-review-loop.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/spec-authority-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/spike-mode-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/stop-conditions.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/structural-quality.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/sub-issue-tree-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/tracker-first-loop-state.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/tracker-seam-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-artifact-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-designer-review-loop.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-e2e-scoping-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-review-recipe-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-smoke-harness.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-validation-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/validation-policy.md` | changed | 3 | Phase 1 ambiguity fix only: gate table named a removed CLI flag. Condensation still pending. |
| `skills/docs/wait-watch-procedure.md` | pending | 3 | Consulted in phase 1 as the correct owner of the removed-flag note; its own text needed no edit, so it carries no diff at this head. Condensation still pending. |
| `skills/docs/workflow-handoff-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/worktree-guidance.md` | pending | 3 | Shared contract/reference doc. |
| `skills/final-approval/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/local-implementation/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/loop-grill/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/review/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/ui-review/SKILL.md` | pending | 2 | Routed entrypoint skill. |

## Phase 1 result

Coverage after phase 1, over all 77 tracked files under `skills/`: 7 `changed`, 1 `unchanged`,
10 `non-prose`, 59 `pending`. Nothing is `blocked`. Each count is derived from
`git diff --name-only <B base>...HEAD -- skills/`, so a row can only claim `changed` when the
file carries a diff at this head. Pending rows are visible coverage, never claimed coverage:
phase 2 takes the other routed entrypoints and their workflow contracts, phase 3 the remaining
shared docs, references and templates.

### Measurement

Bytes and words only. No token counts: none were measured with a named tokenizer, so none are
claimed. Baseline is B base; result is the phase 1 head. Both sides are measured with the same
script over the same file sets (`wc -c` / `wc -w`).

| Bundle | Baseline bytes | Result bytes | Baseline words | Result words |
| --- | --- | --- | --- | --- |
| Edited source (the two phase 1 targets) | 328,335 | 302,465 | 43,276 | 39,690 |
| Whole `skills/` tree (77 tracked files) | 1,184,342 | 1,158,551 | 152,813 | 149,249 |
| Realistic required-read bundle for the `copilot_pr_followup` route | 513,400 | 487,599 | 67,209 | 63,639 |

Per file: `skills/copilot-pr-followup/SKILL.md` 98,167 → 79,992 bytes (12,596 → 10,091 words);
`skills/docs/gate-review-sub-loop-contract.md` 230,168 → 222,473 bytes. Inside the skill, the
agent-orchestrated fan-out/fan-in procedure went 28,630 → 16,518 bytes.

**Route and read assumptions for the bundle.** The envelope's `requiredReads` for this route
(`skills/docs/public-dev-loop-contract.md`, `skills/docs/retrospective-checkpoint-contract.md`,
`skills/copilot-pr-followup/SKILL.md`, `skills/docs/copilot-loop-operations.md`) PLUS every read
the skill makes mandatory at a point of use on the gate path it drives:
`skills/docs/gate-review-sub-loop-contract.md`, `skills/docs/gate-review-comment-contract.md`,
`skills/docs/merge-preconditions.md`, `skills/docs/issue-intake-procedure.md`,
`skills/docs/entrypoint-strategies.md`, and `AGENTS.md`. Generated `.claude/skills/` projections
are byte-identical to their sources, so a harness that loads the projection instead measures the
same figure. Relocating prose into a bundle member would not have moved this number, which is why
no obligation was relocated.

### Old obligation to retained home

Every obligation removed from the skill's prose is listed with where it now lives. No obligation
lost a home, changed strength, or moved behind an optional link.

| Obligation removed from the skill's prose | Retained home / enforcement |
| --- | --- |
| Grouped-dispatch semantics: configured groups matched first, leftovers auto-chunked to ≤ `maxAnglesPerGroup`, `mode: per-angle` bypass, `gate:full` dispatches grouped | `GATE-EXEC-FANOUT-DISPATCH-EMIT` and "Grouped dispatch (default)" in the checkpoint review chain contract; `resolveFanoutGroups` in `@dev-loops/core/config` |
| Emitter cap-splitting, shared-reviewer-per-unit rule, provenance `group` recording, fail-closed emitter inputs | `GATE-EXEC-FANOUT-DISPATCH-EMIT`; enforced by `fanoutReviewerPairingError` re-deriving the grouping at both `detect-checkpoint-evidence.mjs` sites |
| Per-angle findings-artifact write rule for a grouped reviewer (one artifact per angle, never one merged) | `GATE-EXEC-ARTIFACT-HEAD-STAMP` and Phase 2 of the contract; the reviewer is seeded with the emitter's prompt bytes, so the conductor never restates it |
| Carry-forward refusal conditions, per-angle must-re-run reasons, carried-entry provenance shape | `GATE-EXEC-ANGLE-CARRY-FORWARD`; enforced by `resolve-angle-carry-forward.mjs` and `resolveAngleCarryForward` |
| `--expected-dispatch-units` derivation from a rebuilt vs never-rebuilt context artifact | Phase 3 of the contract, which already owned the full derivation; the skill keeps the operative instruction and the omit-on-zero branch |
| Primer barrier mechanics and the cold-cache rationale | `GATE-EXEC-PRIME`; the skill keeps the default form, the release signal and the no-verification-pass fact |
| Briefing-prefix layout, scoped-variant hashing rule, known-findings block contract | `GATE-EXEC-BRIEFING-PREFIX` and `GATE-EXEC-FINDING-THREADS`; the skill keeps the conductor's own seeding actions |
| Stale-installed-CLI narrative (why a stale CLI blocks on `WAITING_FOR_CI`) | Dropped as explanation; the decision (`resolve-verdict-ledger-source.mjs` then run from `worktree` or `installed`) is unchanged and still stated |
| Runner-coordination release/supersede narrative | Condensed to the operative facts; the anti-trap rule (a fresh heartbeat is not proof of a live driver; confirm via `subagent status`) is kept verbatim in force |
| Comment-field content, validation reporting, draft/pre-approval boundary requirements, fail-closed posting behavior | `GATE-COMMENT-VALIDATION-REPORTING`, `GATE-COMMENT-DRAFT-REQUIREMENTS`, `GATE-COMMENT-PREAPPROVAL-REQUIREMENTS`, `GATE-COMMENT-FAIL-CLOSED` — referenced by ID at each point of use, as before |

Rule IDs the skill owns are unchanged and still owned by it: `COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY`,
`COPILOT-FOLLOWUP-REQUEST-BRANCHING`, `COPILOT-FOLLOWUP-WAIT-TOOLS`,
`COPILOT-FOLLOWUP-REREQUEST-AFTER-PUSH`, `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER`,
`COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE`, `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY`,
`COPILOT-FOLLOWUP-ROUND-CAP`, `COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE`,
`COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL`, `COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`,
`GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE`, `ASSET-PATH-INSTALLED-NO-ASSUME`,
`ASSET-PATH-SOURCE-NO-REPO-LOCAL`. Rule ownership is machine-checked by
`bun scripts/docs/validate-rule-ownership.mjs`.

### Ambiguity register

Each entry is traced to owners, code and tests, then reported as an evidence-backed correction of
an obsolete description or as a genuine policy conflict. No stop rule, bypass or exemption was
invented to make the prose consistent.

| Ambiguity | Finding | Evidence | Disposition |
| --- | --- | --- | --- |
| `pendingGroups.length` versus the dispatch units actually emitted or spawned | Obsolete description. The authoritative value is the unit count Phase 2 actually spawned, which the sanctioned emitter returns as its own `count` after cap-splitting. `pendingGroups.length` is an upper bound: it counts unsplit units and keeps a partially-carried unit whole. | `scripts/github/emit-fanout-dispatch.mjs` emits `count` alongside `units`; `scripts/loop/consolidate-fanin.mjs` compares the sentinel `reviewerCount` against the passed value and rejects `0`; the contract's own Phase 3 text already called `pendingGroups.length` an upper bound, never the authoritative figure. | Corrected in both the skill and the contract. Strictly stricter or equal, never looser: the emitter's count is never below the pre-split figure. |
| Follow-up instructions referencing `--local-validation-head-sha` while it is reported removed elsewhere | Obsolete description. The flag exists on no watch-route CLI. The detector derives the bounded zero-suite `crediblyGreen` case from GitHub facts plus the previous-head rollup. | `detect-copilot-loop-state.mjs --help` lists `--repo`, `--pr`, `--input`, `--lightweight`, `--jq`, `--silent` and nothing else; `localValidationHeadSha` survives only as a snapshot field reachable through `--input`; the CHANGELOG records the flag as a removed CLI surface; `wait-watch-procedure.md` already stated the removal. | Corrected in the skill, the operations doc, the validation policy, the CI-status contract and the merge preconditions. No new exception introduced: the derivation was already the real behavior. |
| Skill clean-only carry-forward wording versus owner support for `findings_present` carry-forward | Obsolete description. A prior findings-log is carry-forward-eligible when its verdict is `clean` OR `findings_present`; a carried `findings_present` angle brings its open findings forward, still blocking. | `CARRY_FORWARD_ELIGIBLE_VERDICTS = new Set(["clean", "findings_present"])` in `@dev-loops/core/loop/gate-carry-forward`; `resolve-angle-carry-forward.mjs` refuses only a verdict outside that set, and refuses a `findings_present` log with no findings array; `GATE-EXEC-ANGLE-CARRY-FORWARD` states the same. | Corrected by removing the clean-only claims from the skill rather than restating the rule: the skill now defers refusal conditions to the owner. Nothing is weakened — a carried findings-present angle still blocks the round. |
| All-carried flow dispatching no emitter versus a mandatory emit-plan and an emitter that rejects zero units | Obsolete description, not a conflict. The emit-plan is mandatory on every round that RAN the emitter. An all-carried round dispatches no reviewer, so no emitter runs and no plan exists to pass. | `emit-fanout-dispatch.mjs` refuses a plan resolving zero units; `--emit-plan` is optional input on both consumers (`consolidate-fanin.mjs`, `write-gate-findings-log.mjs`) and only activates the round-key guard when supplied; `GATE-EXEC-EMIT-PLAN-KEY` governs the guard, not the round. | Corrected to "every round that ran the emitter". The guard stays fail-closed whenever a plan exists, so no round loses enforcement. |

No entry required a human policy decision. Nothing is left unresolved.

### Test changes

Word-for-word prose pins coupled to the edited files were replaced with structural or behavioral
checks at existing enforcement seams. Exact pins were kept for API literals, CLI flags, rule IDs,
generated parity and verbatim payload contracts.

- The fan-out phase-step extractor bounded a step to a single physical LINE, so it froze the
  wall-of-text format the cleanup exists to remove. It now bounds a step from its heading to the
  next numbered step or section, which accepts sub-bullets and reflow.
- Carry-forward routing, dispatch subtraction, `mustRerun` non-authority, refusal-widens-fan-out,
  wave-bound-not-wavePlan and provenance-on-the-ledger-write are asserted by executable literal
  plus a same-sentence co-occurrence check, never by sentence text.
- Watch-persistence, conflict-resolution and round-cap obligations moved to the same primitives
  plus a step-order assertion, so the flow's safety ordering (refresh, authorize, reconcile,
  re-detect, re-gate, re-wait for CI) is what is protected.
- The `maxCopilotRounds` default is now a parity check against the value
  `resolveRefinementConfig` and `resolveEffectiveCopilotRoundCap` actually resolve, so a config
  change that leaves the doc behind fails.
- The two remaining hard line-break pins (`A full\nre-dispatch ... EXCEPTION` and the
  known-findings block ordering) are now whitespace-insensitive.

Discrimination is demonstrated, not asserted: fixture tests feed each checker a meaning-preserving
rewrite of the same step (passes), a step that drops the subtract-not-substitute rule (fails), a
step that turns a CLI refusal into "nothing to re-run" (fails), a `--provenance` flag reattached to
the comment post (fails), a two-step document proving step extraction does not leak a sibling's
text, and — for the shared primitives themselves — a reworded statement (passes), a statement with
the obligation removed but every token kept (fails), two unrelated sentences carrying the tokens
between them (fails), and a reordered procedure (fails).

Limitation: these checks protect structure and executable surface. They do not prove the prose
means what it says to a reader; that judgment stays with gate review.

### Validation

Run in the worktree on Bun 1.4.1.

| Command | Result |
| --- | --- |
| `bun run test:docs` | pass — 687 links, 242 rules, 73 decision records, changelog completeness |
| `bun run test:doc-guard` | pass — 359 tests across 63 files |
| `bun run assets:check` | pass — 92 generated assets byte-reproducible from source |
| `bun run verify` | pass — 9,305 tests across 390 files, plus test:docs and test:workflows |

Generated `.claude/skills/` assets were regenerated through
`bun scripts/claude/generate-claude-assets.mjs` only. No generated file was hand-edited.

### Remaining work

- Phase 2: the other routed entrypoint skills (`dev-loop`, `local-implementation`,
  `final-approval`, `review`, `ui-review`, `loop-grill`) and their workflow contracts, including
  the condensation of `gate-review-comment-contract.md` deferred out of phase 1.
- Phase 3: the remaining shared docs, references and templates (59 files still `pending`), plus
  the final cross-harness validation pass.
- Not attempted here: any change to runtime enforcement. Where an obligation has no enforcement
  seam it was kept in prose rather than dropped.
