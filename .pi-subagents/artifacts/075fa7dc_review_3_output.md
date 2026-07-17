# Lane D v0.8 release audit: dedup / condensation

Issue: #1192 `Release gate: independent contract audit before rolling v0.8`

Baseline: parent of `02bd0de0` = `8cda46daea2f838962f1fc653ddd123fbb167278`

Audited HEAD: `bd71a006328b66fc60900586da13611e96515f4f`

Corpus: requested paths `skills/docs`, `docs/`, top-level `skills/*/SKILL.md`, `agents/`, `commands/`. Counts below use `wc` semantics and dereference `docs/outer-loop-state-graph.md -> conductor-routing-contract.md`; that symlink duplicates the conductor doc in totals at both revisions.

## Verdict

Epic AC5 is **not met** against the pre-epic baseline for the requested corpus: total corpus size is up **+696 words / +256 lines** (`114,227w/14,460l` -> `114,923w/14,716l`).

The prose cleanup mostly succeeded, but rule registry annotation overran it. Diff-line attribution shows roughly **+6.0k words / +420 lines** of marker/ID/manifest annotation, offset by about **-2.6k words** of normative prose contraction and **-2.7k words** of other prose contraction. Net still grows.

## Hard wc totals

| Slice | Files | Base words | Head words | Δ words | Base lines | Head lines | Δ lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| `skills/docs` | 29 | 29,065 | 30,286 | +1,221 | 3,704 | 3,930 | +226 |
| `docs/` | 43 | 60,895 | 61,515 | +620 | 8,728 | 8,846 | +118 |
| `skills/*/SKILL.md` | 5 | 16,965 | 15,820 | -1,145 | 1,491 | 1,403 | -88 |
| `agents/` | 7 | 5,669 | 5,669 | 0 | 434 | 434 | 0 |
| `commands/` | 9 | 1,633 | 1,633 | 0 | 103 | 103 | 0 |
| **Total** | **93** | **114,227** | **114,923** | **+696** | **14,460** | **14,716** | **+256** |

Largest word deltas:

| Path | Δ words | Δ lines | Note |
|---|---:|---:|---|
| `skills/local-implementation/SKILL.md` | -827 | -94 | real condensation |
| `skills/docs/contract-style-guide.md` | +502 | +37 | new rule/style owner doc |
| `docs/gate-review-sub-loop-contract.md` | +400 | +36 | new gate fanout details + marker tax |
| `docs/reviewer-loop-state-graph.md` | +341 | +51 | new reviewer state/rule vocabulary |
| `skills/docs/stop-conditions.md` | +291 | +15 | new compact stop-condition owner/table |
| `docs/copilot-loop-state-graph.md` | +146 | +2 | marker/ID growth, prose reduced |
| `skills/docs/required-rules.json` | +146 | +145 | pure manifest tax |
| `skills/docs/artifact-authority-contract.md` | +133 | +1 | lightweight PR-body invariant expansion |
| `docs/projects-queue-contract.md` | +99 | +12 | queue pickup rule IDs/details |
| `skills/copilot-pr-followup/SKILL.md` | -318 | +6 | prose reduced, many markers added |

## Growth attribution

Method: unified diff from baseline to HEAD over the requested corpus, classifying changed lines as:

- marker/ID: `<!-- rule:... -->`, `<!-- term:... -->`, all-caps rule IDs, canonical-owner / manifest JSON lines;
- normative prose: changed lines containing RFC-2119 / fail-closed / do-not modality;
- residual prose: remaining changed prose/examples.

Because modified lines are whole-line diffs and the symlink is dereferenced for `wc`, this attribution is approximate; it reconciles within tokenization noise of the hard `wc` delta.

| Bucket | Net words | Net lines | Interpretation |
|---|---:|---:|---|
| Marker / ID / manifest annotation | about +6,026 | about +432 | Dominant growth driver; includes `required-rules.json`, term/rule IDs, canonical owner lines. |
| Genuinely new or revised normative prose | about -2,601 | about -34 | Net contraction despite new rules; much old procedural prose was replaced or shortened. |
| Residual prose / examples / explanatory scaffolding | about -2,715 | about -142 | Net contraction, but high-value duplicates remain below. |
| **Total explained** | **about +710** | **about +256** | Close to hard `wc` +696/+256; variance from tokenization and symlink handling. |

Conclusion: v0.8 did reduce non-marker prose, but **total corpus word count did not drop**. If AC5 is interpreted literally, release is blocked until either marker tax is waived as accepted non-prose overhead or the candidates below are condensed enough to offset it.

## Semantic dedup findings

These are same-behavior rules repeated across families, not lexical near-dups.

1. **Scoped gate reviewer contract repeated in three surfaces.**
   - Evidence: `docs/gate-review-sub-loop-contract.md:64`, `docs/gate-review-sub-loop-contract.md:135`, `agents/review.agent.md:31-84`, `skills/copilot-pr-followup/SKILL.md:311-315` all restate fresh-context, no isolated worktree, full-diff, adjacent-code, adversarial review, and output artifact rules.
   - Owner should be `docs/gate-review-sub-loop-contract.md` + minimal runtime prompt in `agents/review.agent.md`.

2. **Queue `Next Up` pickup / no Backlog fallback repeats across contract, usage, setup, and command docs.**
   - Evidence: owner rule in `docs/projects-queue-contract.md:305-326`; repeated as operator prose in `docs/projects-queue-usage.md:18-24`, `docs/projects-queue-usage.md:143-173`, `docs/queue-board-setup.md:11-13`, `docs/queue-board-setup.md:76-77`, and command behavior in `commands/loop-continue.command.md:8-12`.
   - Keep exact fail-closed outcomes in owner; shorten guides/commands to invocation + link.

3. **Lightweight PR-body-as-spec invariants repeat across artifact authority, AC verification, and local implementation.**
   - Evidence: canonical rule in `skills/docs/artifact-authority-contract.md:48-58`; restated as fork procedure in `skills/docs/acceptance-criteria-verification.md:8-10`; summarized again in `skills/local-implementation/SKILL.md:55` and `skills/copilot-pr-followup/SKILL.md:244-245`.
   - Keep invariant list and closing-reference conditions in artifact authority; AC doc should only say which body to read and which validator to run.

4. **Current-head gate evidence / merge readiness repeats in many lifecycle docs.**
   - Evidence: `skills/docs/merge-preconditions.md:44-47`, `skills/copilot-pr-followup/SKILL.md:365-388`, `skills/docs/pr-lifecycle-contract.md:74-83`, `skills/docs/public-dev-loop-contract.md:307-330`, `skills/docs/validation-policy.md:15`, `skills/docs/entrypoint-strategies.md:37-41`.
   - Keep full rule in merge preconditions / gate comment contract; downstream docs should link and state boundary only.

5. **PR creation requirements repeat across local implementation and Copilot operations.**
   - Evidence: `skills/local-implementation/SKILL.md:68`, `skills/local-implementation/SKILL.md:514`, `skills/docs/copilot-loop-operations.md:165-174`, `skills/docs/anti-patterns.md:9`, `skills/docs/merge-preconditions.md:47`.
   - Keep canonical wrapper/draft/assignee/`Closes #N` rule in `copilot-loop-operations.md` or artifact authority; local skill can reference it.

6. **Anti-pattern entries became mini-contracts.**
   - Evidence: `skills/docs/anti-patterns.md:14-15` restates queue-board contract and gate fan-in wait contract in long paragraphs.
   - Anti-pattern doc should name the smell and link owner; owner docs hold details.

## Ranked condensation candidates (>~50 words)

| Rank | Candidate | Expected savings | Pre-v0.8 issue? | Rationale / safe cut |
|---:|---|---:|---|---|
| 1 | `agents/review.agent.md:31-84` scoped angle-review mode | 450-550 words | **Yes** | Replace duplicated contract bullets with compact trigger + must-read link + output schema. If self-contained agent prompts are mandatory, generate this block from the owner doc instead of hand-maintaining duplicate prose. |
| 2 | `docs/gate-review-sub-loop-contract.md:64-166` Phase 1/2 repeated fresh-context/no-isolation/build-once prose | 220-300 words | **Yes** | Phase 2 can say “same guard/invocation as Phase 1” and keep only Phase-2-specific sentinel hash/fan-in details. |
| 3 | `skills/docs/anti-patterns.md:14-15` long anti-pattern details | 180-240 words | **Yes** | Convert each to a one-line smell plus owner links (`projects-queue-contract`, `gate-review-sub-loop-contract`). |
| 4 | Queue docs/command repetition: `docs/projects-queue-usage.md:18-24,143-173`, `docs/queue-board-setup.md:11-13,76-77`, `commands/loop-continue.command.md:8-12` | 180-260 words | **Yes** | Keep operator examples; remove repeated fail-closed outcome prose that already lives at `QUEUE-NEXTUP-*`. |
| 5 | `skills/copilot-pr-followup/SKILL.md:308-315` gate fan-out/fan-in procedure | 150-220 words | **Yes** | This skill owns dispatch only. Replace phase restatements with “run owner contract” plus script/helper call list. |
| 6 | Lightweight PR-body-as-spec repeats: `skills/docs/acceptance-criteria-verification.md:8-10`, `skills/local-implementation/SKILL.md:55`, `skills/copilot-pr-followup/SKILL.md:244-245` | 120-180 words | **Yes** | Keep invariant/closing-reference matrix in artifact authority; other docs only state “when `specSource: pr_body`, read PR body and run validator.” |
| 7 | Merge/pre-approval evidence repetition across lifecycle/followup/public/validation docs | 100-180 words | **Yes** | Make merge preconditions + gate comment contract the owner; reduce downstream copies to boundary-specific reminders. |
| 8 | PR creation wrapper/assignee/closing-link repetition: local skill + copilot operations + anti-pattern + merge preconditions | 80-140 words | **Yes** | One owner rule for draft/self-assigned/wrapper/closing-link; other docs link. |
| 9 | `docs/projects-queue-contract.md:305-344` elaboration after rule table | 80-120 words | **Maybe** | Dense examples are useful; can trim the final example/limitation wording without semantic loss, but lower priority than cross-doc repeats. |
| 10 | `skills/docs/artifact-authority-contract.md:55` single long lightweight invariant bullet | 60-90 words | **Maybe** | Split into compact matrix for issue-backed vs issue-less; saves words and improves scanability, but changes a canonical owner so risk is higher. |

Combined safe savings from clear **Yes** items: roughly **1.5k-2.1k words**, enough to offset the +696 total growth if applied cleanly.

## Per-doc wc table

See generated full table below.

| Path | Base w | Head w | Δw | Base l | Head l | Δl |
|---|---:|---:|---:|---:|---:|---:|
| `agents/dev-loop.agent.md` | 1329 | 1329 | +0 | 98 | 98 | +0 |
| `agents/developer.agent.md` | 317 | 317 | +0 | 38 | 38 | +0 |
| `agents/docs.agent.md` | 283 | 283 | +0 | 33 | 33 | +0 |
| `agents/fixer.agent.md` | 734 | 734 | +0 | 54 | 54 | +0 |
| `agents/quality.agent.md` | 180 | 180 | +0 | 28 | 28 | +0 |
| `agents/refiner.agent.md` | 958 | 958 | +0 | 88 | 88 | +0 |
| `agents/review.agent.md` | 1868 | 1868 | +0 | 95 | 95 | +0 |
| `commands/loop-auto.command.md` | 61 | 61 | +0 | 5 | 5 | +0 |
| `commands/loop-continue.command.md` | 290 | 290 | +0 | 13 | 13 | +0 |
| `commands/loop-enqueue.command.md` | 416 | 416 | +0 | 20 | 20 | +0 |
| `commands/loop-grill.command.md` | 245 | 245 | +0 | 15 | 15 | +0 |
| `commands/loop-info.command.md` | 75 | 75 | +0 | 5 | 5 | +0 |
| `commands/loop-queue-status.command.md` | 185 | 185 | +0 | 22 | 22 | +0 |
| `commands/loop-start-spike.command.md` | 249 | 249 | +0 | 14 | 14 | +0 |
| `commands/loop-start.command.md` | 46 | 46 | +0 | 5 | 5 | +0 |
| `commands/loop-status.command.md` | 66 | 66 | +0 | 4 | 4 | +0 |
| `docs/IMPLEMENTATION_STATE.md` | 528 | 528 | +0 | 62 | 62 | +0 |
| `docs/IMPLEMENTATION_WORKFLOW.md` | 943 | 948 | +5 | 139 | 139 | +0 |
| `docs/ab-contrast-deslop-step.md` | 535 | 535 | +0 | 43 | 43 | +0 |
| `docs/articles/dev-loops-deep-dive.html` | 4608 | 4608 | +0 | 560 | 560 | +0 |
| `docs/articles/dev-loops-deep-dive.md` | 3352 | 3352 | +0 | 242 | 242 | +0 |
| `docs/articles/introducing-dev-loops.html` | 2237 | 2237 | +0 | 259 | 259 | +0 |
| `docs/articles/introducing-dev-loops.md` | 1571 | 1571 | +0 | 99 | 99 | +0 |
| `docs/conductor-routing-contract.md` | 2229 | 2260 | +31 | 322 | 335 | +13 |
| `docs/copilot-loop-state-graph.md` | 2167 | 2313 | +146 | 213 | 215 | +2 |
| `docs/docs-grill-step.md` | 620 | 620 | +0 | 45 | 45 | +0 |
| `docs/gate-review-comment-contract.md` | 1587 | 1604 | +17 | 180 | 195 | +15 |
| `docs/gate-review-sub-loop-contract.md` | 4015 | 4415 | +400 | 419 | 455 | +36 |
| `docs/index.md` | 426 | 426 | +0 | 67 | 67 | +0 |
| `docs/lib-vs-packages-core-boundary.md` | 468 | 468 | +0 | 66 | 66 | +0 |
| `docs/migrating-to-dev-loops.md` | 551 | 551 | +0 | 96 | 96 | +0 |
| `docs/outer-loop-state-graph.md` | 2229 | 2260 | +31 | 322 | 335 | +13 |
| `docs/phases/intro-dev-loops-article.md` | 866 | 866 | +0 | 57 | 57 | +0 |
| `docs/phases/phase-7.md` | 1431 | 1431 | +0 | 144 | 144 | +0 |
| `docs/phases/phase-8.md` | 1262 | 1262 | +0 | 169 | 169 | +0 |
| `docs/presentations/README.md` | 437 | 437 | +0 | 62 | 62 | +0 |
| `docs/presentations/applied-dev-loops-presentation.md` | 872 | 872 | +0 | 188 | 188 | +0 |
| `docs/presentations/applied-dev-loops-review-notes.md` | 1001 | 1001 | +0 | 135 | 135 | +0 |
| `docs/presentations/dev-loops-deep-dive.html` | 2909 | 2909 | +0 | 672 | 672 | +0 |
| `docs/presentations/introducing-dev-loops.html` | 2146 | 2146 | +0 | 506 | 506 | +0 |
| `docs/presentations/process-observability-presentation.md` | 978 | 978 | +0 | 227 | 227 | +0 |
| `docs/presentations/process-observability-review-notes.md` | 773 | 773 | +0 | 104 | 104 | +0 |
| `docs/presentations/style.css` | 365 | 365 | +0 | 172 | 172 | +0 |
| `docs/projects-queue-contract.md` | 3008 | 3107 | +99 | 427 | 439 | +12 |
| `docs/projects-queue-usage.md` | 1693 | 1375 | -318 | 214 | 195 | -19 |
| `docs/queue-board-setup.md` | 1959 | 1863 | -96 | 318 | 309 | -9 |
| `docs/repo-wiki-manual-first.md` | 1128 | 1128 | +0 | 222 | 222 | +0 |
| `docs/reviewer-loop-state-graph.md` | 1023 | 1364 | +341 | 137 | 188 | +51 |
| `docs/slides-story-review-loop.md` | 872 | 872 | +0 | 107 | 107 | +0 |
| `docs/specs/queue-mode/SPEC.md` | 1325 | 1325 | +0 | 211 | 211 | +0 |
| `docs/steerable-subagents-design.md` | 1305 | 1305 | +0 | 255 | 255 | +0 |
| `docs/steering-contract.md` | 2447 | 2468 | +21 | 476 | 479 | +3 |
| `docs/sub-issue-tree-contract.md` | 851 | 858 | +7 | 140 | 139 | -1 |
| `docs/tracker-story-pr-contract.md` | 22 | 22 | +0 | 5 | 5 | +0 |
| `docs/ui-artifact-contract.md` | 831 | 831 | +0 | 140 | 140 | +0 |
| `docs/ui-designer-review-loop.md` | 936 | 936 | +0 | 136 | 136 | +0 |
| `docs/ui-smoke-harness.md` | 592 | 592 | +0 | 100 | 100 | +0 |
| `docs/ui-validation-contract.md` | 631 | 631 | +0 | 89 | 89 | +0 |
| `docs/worktree-guidance.md` | 1166 | 1102 | -64 | 181 | 183 | +2 |
| `skills/copilot-pr-followup/SKILL.md` | 6640 | 6322 | -318 | 461 | 467 | +6 |
| `skills/dev-loop/SKILL.md` | 2559 | 2559 | +0 | 175 | 175 | +0 |
| `skills/docs/acceptance-criteria-verification.md` | 672 | 682 | +10 | 25 | 26 | +1 |
| `skills/docs/anti-patterns.md` | 462 | 451 | -11 | 24 | 24 | +0 |
| `skills/docs/artifact-authority-contract.md` | 2453 | 2586 | +133 | 192 | 193 | +1 |
| `skills/docs/confirmation-rules.md` | 123 | 123 | +0 | 28 | 28 | +0 |
| `skills/docs/contract-style-guide.md` | 0 | 502 | +502 | 0 | 37 | +37 |
| `skills/docs/copilot-ci-status-contract.md` | 366 | 366 | +0 | 52 | 52 | +0 |
| `skills/docs/copilot-loop-operations.md` | 2233 | 2170 | -63 | 233 | 230 | -3 |
| `skills/docs/cross-harness-regression-contract.md` | 596 | 596 | +0 | 60 | 60 | +0 |
| `skills/docs/debt-remediation-contract.md` | 542 | 542 | +0 | 107 | 107 | +0 |
| `skills/docs/entrypoint-strategies.md` | 564 | 564 | +0 | 115 | 115 | +0 |
| `skills/docs/epic-tree-refinement-procedure.md` | 1656 | 1661 | +5 | 234 | 237 | +3 |
| `skills/docs/issue-intake-procedure.md` | 2032 | 2123 | +91 | 240 | 246 | +6 |
| `skills/docs/local-planning-flow.md` | 613 | 613 | +0 | 63 | 63 | +0 |
| `skills/docs/local-planning-worked-example.md` | 733 | 733 | +0 | 139 | 139 | +0 |
| `skills/docs/main-agent-contract.md` | 809 | 809 | +0 | 98 | 98 | +0 |
| `skills/docs/merge-preconditions.md` | 1139 | 1141 | +2 | 159 | 160 | +1 |
| `skills/docs/plan-file-contract.md` | 465 | 465 | +0 | 37 | 37 | +0 |
| `skills/docs/pr-lifecycle-contract.md` | 1641 | 1680 | +39 | 210 | 219 | +9 |
| `skills/docs/public-dev-loop-contract.md` | 3972 | 3932 | -40 | 497 | 491 | -6 |
| `skills/docs/release-runbook.md` | 264 | 264 | +0 | 45 | 45 | +0 |
| `skills/docs/required-rules.json` | 0 | 146 | +146 | 0 | 145 | +145 |
| `skills/docs/retrospective-checkpoint-contract.md` | 1506 | 1525 | +19 | 221 | 227 | +6 |
| `skills/docs/spike-mode-contract.md` | 1773 | 1815 | +42 | 237 | 244 | +7 |
| `skills/docs/stop-conditions.md` | 204 | 495 | +291 | 30 | 45 | +15 |
| `skills/docs/structural-quality.md` | 278 | 278 | +0 | 42 | 42 | +0 |
| `skills/docs/tracker-first-loop-state.md` | 1969 | 2013 | +44 | 281 | 286 | +5 |
| `skills/docs/ui-e2e-scoping-step.md` | 1012 | 1012 | +0 | 134 | 134 | +0 |
| `skills/docs/validation-policy.md` | 118 | 129 | +11 | 27 | 26 | -1 |
| `skills/docs/workflow-handoff-contract.md` | 870 | 870 | +0 | 174 | 174 | +0 |
| `skills/final-approval/SKILL.md` | 109 | 109 | +0 | 19 | 19 | +0 |
| `skills/local-implementation/SKILL.md` | 6459 | 5632 | -827 | 671 | 577 | -94 |
| `skills/loop-grill/SKILL.md` | 1198 | 1198 | +0 | 165 | 165 | +0 |

## Commands run

- `git status --short && git rev-parse HEAD && git rev-parse 02bd0de0^`
- `gh issue view 1192 --json number,title,body,state,labels --jq ...`
- `find skills/docs docs agents commands ...` and `find skills -mindepth 2 -maxdepth 2 -name SKILL.md ...`
- Python wc scripts using `git ls-tree`/`git show` for baseline vs HEAD, with symlink dereference for `wc` semantics.
- Python unified-diff classifier for marker/ID vs normative prose vs residual prose attribution.
- `rg` semantic scans for gate-review, queue, lightweight, merge/preapproval, and PR-create rule repeats.
- Targeted reads of candidate docs (`docs/gate-review-sub-loop-contract.md`, `agents/review.agent.md`, `skills/copilot-pr-followup/SKILL.md`, `commands/loop-continue.command.md`, `commands/loop-enqueue.command.md`, `skills/docs/acceptance-criteria-verification.md`, `skills/local-implementation/SKILL.md`, `skills/docs/artifact-authority-contract.md`, `skills/docs/stop-conditions.md`, `skills/docs/anti-patterns.md`).

## Residual risks

- Semantic savings estimates are manual word-range estimates, not applied patches.
- Symlink handling matters: literal git-object counts are `112,664w/14,382l` at HEAD and +665w/+243l delta; actual `wc`-style dereferenced counts used for this audit are `114,923w/14,716l` at HEAD and +696w/+256l delta.
- No GitHub `pre-v0.8` issues were filed by this audit because the task asked to note candidates, not mutate GitHub state.