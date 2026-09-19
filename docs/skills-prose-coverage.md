# Skills prose cleanup coverage

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236). Baseline: `894a5a59080222cef5a47fc3f4e962824e05bfda`.

Inventory: 77 tracked files under `skills/`, including 67 Markdown files and ten code/registry files. A pending row is not reviewed coverage. This record tracks execution; the issue remains the canonical specification.

Dispositions: `pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`. Generated `.claude/skills/` projections are outside this source inventory and must be regenerated, never edited by hand. Script/registry rows remain pending until their prose-bearing parts have been inspected; no code/schema rewrite is authorized.

Phases: 1 = Copilot follow-up and directly coupled references/tests; 2 = other routed entrypoints and their workflow contracts; 3 = remaining shared documentation, references, templates and script comments/help. Only phase 1 is active. All phases use the same cleanup PR unless the human changes the scope.

## Current run — 2026-09-19

The user selected A for all three phases on `issue-2236`/PR2237; B is now a pinned read-only reference, not an equivalent-scope competition. Issue2236 records this direction and the narrow runtime exception tracked separately by issue2273. Phase 1 is complete for prose inspection, condensation, relevant test audit and local validation; phases 2/3 remain pending. The inventory has 71 pending and six changed rows. This is not whole-issue completion or lifecycle-gate clearance.

| Input / evidence | Current value |
| --- | --- |
| Coordinator / worktree | Native Codex `/root/dev_loop`; `tmp/worktrees/dev-loops/issue-2236` |
| A start / original merge base | `eccf273da654d494bcc67cc118dc2ff4caf6cb91` / `894a5a59080222cef5a47fc3f4e962824e05bfda` |
| Integrated main / merge commit | `25e04c37a0065a8c32ff1bf6ac266b1aeff64a99` / `3e219529acf3278a96155746004b7950ffd7413a` (pushed and remote verified) |
| B reference | `608550f80dbc702b026e4ace8b01d6908e16dfae`; untouched |
| Toolchain / baseline | Bun1.4.1, Node26.7.0; pristine main verify9368pass/391files, assets92pass |
| Integration validation / review | Exact committed tree verify9373pass/391files, docs/workflows and assets92pass; fresh native Terra `/root/dev_loop/integration_review_native` found no integration regression. Residual production/dependency/schema/CI/unrelated assets equal main. |
| Preservation / local evidence | Original two-file dirty CI draft and integration backup are preserved privately; exact paths and validation logs are recorded in `/private/tmp/dev-loop-2237-resume.md`. These are local resume artifacts, not durable lifecycle clearance. |

Main integration retained accepted grouped dispatch, verdict minimization, classifier and viewer behavior. Canonical source was reconciled before regeneration. Original writer `/root/dev_loop/integration_fixer` could not resume because the native thread limit was reached at both child and root; the coordinator preserved its independently reviewed staged work and completed the merge/push. No history rewrite or B mutation occurred. Restricted test failures were reproduced on pristine main before rerunning with localhost/Git-fixture permissions.

The initial issue amendment changed narrative outside the spec extractor's table. The subsequent runtime exception is explicitly included in that table; refresh canonical identity before spec-bound clearance. Earlier phase/gate claims are not current-head/current-scope clearance.

### Active phase 1: keyed all-carried plan (issue2273)

**Committed-tree validation correction.** CI for `25c843d5e9024ddef6dc43e6a5e03a1fa4574be1` failed generated-asset parity: the partitioned commit omitted two `--repo`/`--pr` additions in the Claude follow-up commands, whose launcher spelling differs from canonical source. The clean committed tree reproduced the failure. Regeneration uses the canonical generator; generated projections must never be reconstructed by text substitution when partitioning a commit. Pending phase-1 prose/tests are parked privately, outside this fixup. Earlier working-tree full-suite/92-asset results are historical and are not current-head clearance. The authoritative post-commit result is `/private/tmp/dev-loop-2237-ci-fix-final-validation.json`, which binds commands/results to the final full commit SHA and tree identity, with clean status and unchanged HEAD/tree before and after validation. Only that artifact's completed successful result establishes this fixup's local validation; CI remains separately reported. After validation, update the private resume checkpoint with the parked-byte location and matching final SHA. Further cleanup awaits exact committed-tree validation and current-head CI.

This user-authorized runtime exception was committed separately as `574e27fb`. A later complete-owner audit by fresh Terra `/root/dev_loop/phase1_complete_audit` found that the initial zero-unit plan did not bind its complete carried set or identities. The corrective slice persists the resolver proof, requires fan-in's repository/PR identity, and checks complete proof/provenance and retained finding content. Shared validation moved to its existing helper; finding recommendations and location arrays survive normalization. Completed-only and unsupported empty plans still refuse; normal/partial emission, keyed persistence and failure cleanup remain unchanged. No no-plan exception, synthetic reviewer or CI evidence was introduced.

Real-module coverage drives resolver → context writer → emitter CLI → fan-in → findings-log conversion/writer. Corrective red cases reproduced foreign angle, stale prior head, changed reviewer and lost locations; the two-angle positive preserves findings, locations and recommendations. Negatives cover omitted/duplicate proof, foreign/missing round identities, changed findings, fresh provenance and malformed input. The initial independent review by `/root/dev_loop/runtime_review_retry_2` and its 383-test result are historical, superseded for affected behavior. The complete-owner reviewer cleared the corrective runtime and caller diff after remediation. Current validation: 348 targeted tests; full working-tree verify 9377 passed, zero skipped/failed, including the separately pending phase-1 prose; docs/workflows and 92 assets passed. Logs and frozen identities are recorded in the private resume checkpoint. This is not phase completion or lifecycle clearance.

The full-owner completion below covers the remaining large-owner sections and Phase-1 assertion audit; fresh independent review cleared semantics, with its test correction recorded below. The pinned main emitter still nulls final provenance `group` on one-angle split tails despite ADR0072's original-group requirement; this pre-existing runtime discrepancy is outside issue2273 and is not silently fixed or claimed preserved. B-reference reviewer `/root/dev_loop/b_reference` identified a useful `mustRerun` inversion counterexample; not yet adopted. Its proposed no-plan interpretation was withdrawn for lack of governing authority.

### Phase 1: follow-up handoff and owner audit

This bounded slice starts at `4cfbb7a7723b98fbb6e8d0e7a2f3188c889180b4`. Both canonical owners were read in full; the changed obligations were traced through their callers and existing deterministic tests. The follow-up now names the owner's judge-before-durable-write and spec-bound `judge-pass` bridge explicitly, with only the resulting act list reaching the fixer. This point-of-use instruction prevents the shortened checklist from jumping directly from consolidation to an unfiltered fixer pass; Phase 3.5 remains the authority. Fixer reproduction judgment, post-before-fix, thread disposition, re-entry flags and current spec/head/content identity remain required.

| Old obligation / scenario | Retained decision and evidence |
| --- | --- |
| Judge marks a low/nit finding `act`, or rejects a high finding on relevance | The Phase 3 bridge consumes the current-head, spec-bound judge verdict and emits its severity-blind act list; the fixer retains reproduction-based rejection. `judge-pass` tests cover stale/malformed/partial verdicts and spec conflicts. Severity, locatability, medium-window and gate-close rules remain in Phase 4 / `GATE-EXEC-THREAD-DISPOSITION`. |
| A tackled thread has a fingerprint but no thread id, or its fixing SHA is absent from the PR head | `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` retains required thread id, containment, evidenced reply, resolve and live re-read, in order. The pure evaluator and CLI tests reject missing/uncontained evidence, retain the request/gate block even at zero unresolved count, and avoid duplicate replies after partial failure. |
| A fan-out verdict has no structured findings, including a budget-withheld round | Phase 3 retains complete ledger/provenance proof, mandatory-angle refusal, the foreign-angle warning opt-out, valid supplied-provenance pool checks without mandatory angles, true severity totals and the separate merge-evidence backstop. Writer/poster tests cover these branches. |
| A prompt layout is invalid but files can be regenerated | Recovery requires actual compliant redispatch, not certification of prior delivery by new files. Unchanged prefix uses the hash-bound retry; changed prefix retires before rebuild, retaining history. Existing layout, sentinel and retirement tests cover the mechanical checks; actual agent relay remains unobserved. |
| Untouched findings-present angle versus touched/ambiguous/mandatory angle | ADR0064 and resolver/fan-in tests preserve prior verdict, findings, reviewer and head, including blocking findings. Retry and fan-in descriptions no longer imply clean-only carry. Dispatch remains current resolved angles minus proven carries; `mustRerun` is not a replacement set. ADR0070 current-head rebuilding/advisory memory and ADR0072 grouped dispatch remain unchanged. |

The brittle-test audit replaces gate-heading pins with field-scoped Markdown selection; renamed headings pass and missing/sibling fields cannot supply the selected gate's obligations. Phase selection tolerates renamed labels and wrapping while command-bound flags, ownership links, generated parity and the declared verbatim dispatch payload remain checked. Known-findings routing still requires the full-body capture helper and disposition owner. Carry-default and known-findings-placement sentence pins were removed in favor of those routing checks, existing carry/prompt behavior tests and this semantic review: the conductor must run the carry seam by default, preserve refusal/full-fallback behavior, and append all-author open/resolved known findings after angle text outside the invariant prefix. Keyword matching cannot establish those agent decisions. Polling bans, round-cap stops, conflict authorization and human merge approval were compared against the unchanged owner text; request/watch tests cover only their executable portions.

Measurements (`wc -w -c`, words / UTF-8 bytes), starting commit → this slice: source pair **36,246 / 279,151 → 35,637 / 275,856**; corresponding Claude pair **36,053 / 278,145 → 35,445 / 274,868**; all 77 tracked skills files **145,206 / 1,132,018 → 144,597 / 1,128,723**. The same 24-file source/Pi normal-draft conductor set defined under Render-budget slice is **82,429 / 634,013 → 81,820 / 630,718**. No reference was added to that read set; these are static text measurements, not observed prompt/token savings.

Validation used Bun 1.4.1 and `timeout 90 bun scripts/run-bun-test.mjs`: 907 tests across 16 owner/caller/projection suites passed before the final test-only cleanup; then 439 tests across the two changed contracts plus request/watch/outer-loop/verdict suites passed, with no skips or failures. The final test edits removed one redundant prose-posture test; earlier totals are not a claim about the final test count. `bun run test:docs`, `bun run assets:check` (92 assets) and `git diff --check` passed after the ledger update. Logs are `/private/tmp/2237-phase1-owner-{focused,routing,docs,assets}.log`.

Implementation-side semantic audit is complete for this slice; independent review, remaining owner condensation, phase-wide verification and lifecycle clearance are pending. Both inventory rows remain in progress. The known split-tail `group` discrepancy is unchanged, and no runtime or dependency file changed.

### Phase 1: operations and obsolete descriptions

Full operations-owner review retained helper/layout authority, issue/PR identity and intake authorization, request/watch branching and stop behavior, draft/closing-reference gates, checkpoint reattachment and interpreter/polling bans. Duplicated explanations were condensed; owner 2713 → 2296 words, 20677 → 18280 bytes. The prior CI slice reduced its owner 1014 → 698 words, 8105 → 6014 bytes (`wc -w -c`, source only).

Obligation trace: ADR0064 plus `buildCarryForwardPlan` retain latest-prior-head/no backscan, all refusal/attribution/mandatory-angle guards, current-set subtraction, prior finding/reviewer/head identity and blocking findings. The follow-up's clean-only statements were obsolete. ADR0070 and `writeGateContext` require fresh current-head runtime rebuilding and advisory prior dispositions; Section E now explicitly limits append-only composition to its offline builder, as authorized. ADR0072 and `expandDispatchUnits` supersede proportionality's per-angle dispatch wording; emitted units replace it without changing any size/risk/tier/mandatory floor or provenance guard.

Fresh Terra `/root/dev_loop/phase1_authority_review` reviewed the operations owner and changed follow-up/gate sections against their accepted decisions/enforcement. Its test-only findings (incidental carry prose pins and missing command-bound spec identity) were fixed and independently rechecked. Reviewed diff: `ce39e853ecf06767a3ea7a29b28ef2db9c5cacb3b42194fd15ecdba3d53e9b09` on `b28547fd4ce15d77de4ca9c5495577e7cbcd8b15`; subsequent ledger edits only record evidence. Expanded contracts/carry/context/lineage validation had 752 pass, one packaging-network skip and one incidental draft-wording failure; after replacing that pin, all 47 affected contracts passed. Docs/assets passed. Phase-wide and cumulative clearance remain pending.

The one skipped check was `claude-plugin-npm-ci-smoke.test.mjs`; rerunning that check alone with registry access passed (one test, no skip). Logs are under `/private/tmp/` with prefix `dev-loop-2237-phase1-`. No unavailable live-harness check is counted as executed.

Process limitation: the two preceding commits used the correct worktree/branch and remote checks but omitted the immediate pre-commit branch-guard invocation and explicit `git -C` spelling. No other branch changed. Subsequent commits use both; no retrospective guard execution is claimed.

Comparable canonical-tree measurement (`wc -w -c`, all 77 tracked skills files): pinned main 152940 words / 1185234 bytes; A start 145725 words / 1134425 bytes; integrated A 145978 words / 1136288 bytes. The 6962-word / 48946-byte reduction against main is inherited A work; integration itself adds 253 words / 1863 bytes from main. No tokens or final loaded-context savings claimed.

### Phase 1: full-owner completion

This slice starts at `6db154ca6a109092c7f338c90eee5e66581f072a`. Both remaining owners were read end to end, together with their routed callers, existing companion owners, ADR0064/0070/0072, relevant helpers and tests. The source edits were followed by canonical Claude regeneration. No runtime, dependency, gate policy or Phase-2/3 source changed; no new reference file or mandatory read was introduced. Fresh Sol pre-commit review cleared the semantic condensation and found one dispatch-key test gap, corrected below without changing the owner or runtime.

| Owner sections inspected | Disposition and obligation trace |
| --- | --- |
| Follow-up introduction, reattachment and delegation | Condensed. Canonical post-PR ownership, every-resume read-only checkpoint, each `outerAction` branch, Pi redispatch versus Claude inline continuation, and mandatory public dispatch guards remain explicit. |
| Follow-up runner coordination, retrospective and board sync | Condensed. Ownership/death/staleness predicates, actual executing-child proof, takeover scope, fresh independent full-record retrospective and identity/provenance, main-checkout ordering, configuration, fallback and both nonfatal exit contracts remain. |
| Follow-up anti-patterns and output | Removed duplicate bans already required at their request/wait/reply/gate/merge decision sites; retained conflict-operation prohibition and concise identity/state/action/authorization reporting. |
| Other follow-up sections, including commands and gate checklists | Inspected and retained. Earlier slices already condensed shared explanations; remaining routing, validation-before-context, judge-before-write, act-list fix scope, severity/thread handling, approval and current-head evidence are load-bearing. The declared verbatim async clause remains exact. |
| Gate execution model, standalone review, angle resolution and spec resolution | Condensed. Fresh neutral full-diff/adjacent-code seed, non-evidence review header, config merge/selection floors, CLI versus programmatic spec resolution, all closing references, failed reads and mid-flight rebuild refusal remain. `gate:full` grouped dispatch follows accepted ADR0072. |
| Gate collectable dispatch, dispatch keys, composer and harness delivery | Condensed. Await/join/artifact requirements, killed-reviewer redispatch, bounded waves, no silent inline fallback, per-item unique keys, atomic ordered composition and verbatim angle content remain. Pi concrete relay and Claude/Codex agent-relay limits are distinct; no delivered-prompt or provider-cache proof is claimed. |
| Gate sentinel lifecycle and retirement | Condensed. Head/scope isolation, legacy fallback, no manual clears, exact-hash same-head retry with unchanged prefix/live PR-body fetch, retire-before-rebuild, full-SHA/gate/artifact scope, audit preservation and no retired-evidence reuse remain. |
| Gate primer evidence and carry-forward introduction | Condensed. Primer proof stays opt-in and layout unconditional. Carry uses the current set minus proven clean/findings-present carries; any-severity attribution, exact retained open findings, mandatory/touched/ambiguous reruns and whole-plan refusal remain. Detailed guards remain at the same point of use. |
| Gate context/request-plan/primer details; consolidation, judge and fixer phases; logging/threads; proportionality, coverage and lineage | Inspected and retained except the changed summaries above. Distinct actor/order/evidence/refusal branches and literal artifacts carry obligations beyond their headings; earlier slices already removed duplicate implementation explanations. Recorded authority conflicts remain visible rather than being resolved by deleting a branch. |

The Phase-1 brittle-test audit inspected every contract file referencing either remaining owner or the four completed Phase-1 companions, plus runtime/CLI/packaging callers found by path search. Assertions are dispositioned by the source they inspect; incidental pins for Phase-2/3 source in mixed files remain for those phases.

| Test surface | Disposition |
| --- | --- |
| `copilot-review-doc-contracts`, `issue-intake-doc-contracts`, `public-facade-doc-contracts` | Replaced Phase-1 sentence/title pins with existing Markdown link/section parsers, unique owner IDs, frontmatter, literal API routes and rule ordering. Retained exact declared async payload and command/flag checks. Draft readiness is exercised by real create/ready helpers; structural assertions do not prove MUST/MUST NOT meaning. |
| `gate-fanout-dispatch-key-contract`, `gate-sub-loop-no-fork-claim-contract`, `gate-fanout-code-defect-surfacing-contract` | Removed incidental wording/keyword heuristics. Assert owned rules, reviewer links and actual fresh-context frontmatter; exercise the existing inline-qualification function for light/full/threshold/reason cases. Following Sol's finding, the key test also reads its canonical rule: `runs.all` MUST require a unique, non-empty `key` on each item. Reflow passes; missing/blank/wrong keys, weakened constraints and sibling-only requirements fail. Actual key discipline, context independence and adversarial effort still require semantic review. |
| `gate-angle-carry-forward-routing-contract` | Retained step-bound resolver/head/spec/provenance/bridge flags and rewrite/negative fixtures. Removed the natural-language findings-only heuristic: real resolver/emitter/fan-in tests cover eligibility, refusal and all-carried proof; prose meaning remains review work. No `mustRerun` inversion policy was added. |
| `gate-severity-vocabulary-contract`, `spec-authority-default-on-contract`, `review-doc-contracts` | Select relevant owner sections by stable IDs, accept wrapping, compare actual severity/disposition vocabulary and retain exact API flags; follow-up reaches its owner by a real link. Phase-2/3 prose checks are unchanged. |
| `claude-assets-reproducible`, `claude-plugin-manifest`, `rule-id-doc-contracts`, `bun-toolchain-contract`, `orphan-entrypoint-ratchet` | Inspected; retained generated-byte equality, Pi-only transformations, literal IDs, tool commands, packaging and public-entrypoint metadata. Unrelated source assertions are outside this phase. |
| Startup/CLI/extension, context, dispatch, carry, sentinel, composer, retirement, fan-in and readiness tests | Inspected applicable fixtures and enforcement; retained behavior and literal route/path assertions. No production implementation was changed to satisfy a prose rewrite. |

Known limits remain explicit. ADR0064 resolves the historical clean-only prose in favor of evidenced findings-present carry; the active owners no longer assert a competing clean-only rule. Issue2273's accepted all-carried path requires a keyed emitted plan and complete resolver proof: empty completed-only resumes still refuse, with no no-plan exemption. Runtime current-head context rebuilding remains distinct from offline lineage composition under ADR0070. The one-angle split-tail `group` discrepancy remains unresolved. Other pre-existing register items (fixer identity and disputed coverage wording) are unchanged. Prompt recovery still requires actual redispatch, not just rewriting emission records.

Counts use `wc -w -c`, including code examples/frontmatter, not tokens. From this candidate's starting HEAD to the current source pair: 35,637 / 275,856 → 32,082 / 251,837 words/bytes (3,555 / 24,019 removed). The corresponding regenerated Claude pair is 31,888 / 250,848. All 77 tracked skills files are 141,042 / 1,104,704. The same conservative 24-file source/Pi normal-draft set defined below is 78,265 / 606,699; no removed text was transferred to an additional read. These are static surfaces, not measured live loading or cache savings.

Final validation after Sol's test correction: the focused key suite passed three tests, the complete contract/doc-guard run passed 357 without skips or failures, and full `bun run verify` passed 9,376 tests across 391 files without skips or failures, plus docs and workflows. The earlier ten focused runtime suites passed 754 tests without skips or failures. Canonical generation, the 92-asset parity check and `git diff --check` passed. Logs use the private prefix `/private/tmp/2237-phase1-complete-`; the final full run is `verify.log`. Phase 1 is complete under the selected one-review cadence; phases 2/3 remain pending. These are local working-tree results, not current-head lifecycle evidence or CI clearance.

## Historical parked checkpoint — 2026-09-16

Paused at the user's request; resume only when requested, not automatically on Saturday. PR2237 remains draft and unmerged. Latest implementation/test commit pushed before this note: `cef3de0b` on `issue-2236`. Its full verification passed 9,293 tests across 390 files, plus docs/workflows; doc guard passed 354 with one skip.

Preserved uncommitted work in `tmp/worktrees/dev-loops/issue-2236`: `skills/docs/copilot-ci-status-contract.md` and its canonically regenerated `.claude/skills/docs/copilot-ci-status-contract.md` mirror. This draft condenses repeated check-exclusion explanations; zero-suite exception, inputs, outputs and precedence are unchanged. Its 82 focused CI/prober/workflow tests passed. Independent post-edit semantic review, docs/assets checks, measurement update and full verification are pending; the preceding full-suite result does not cover this draft. This checkpoint note is committed separately, without staging those two files.

On explicit resume: fetch origin, refresh canonical startup/envelope and issue2236 spec, preserve the two-file diff, review it against `cef3de0b`, finish its semantic scenarios and checks, then commit/push the coherent slice. Continue phase1 afterward; remaining 77-file inventory is not complete. Next candidates include the issue-intake persistence prose pins and the safe proportionality-floor explanation block. The ambiguity register remains unresolved, including carry eligibility, zero-unit dispatch, grouping, fixer identity and lineage/context requirements; no new policy choice is authorized by parking. No review workers or validation jobs remain intentionally running.

## File inventory

| File | Phase | Disposition | Evidence / remaining work |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 1 | changed | Full owner and applicable tests inspected; remaining lifecycle/reattachment/coordination prose condensed. Fresh Sol semantic review and final local verification passed; see current-run trace. |
| `skills/dev-loop/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/init-phase.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/phase-files.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/render-template.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/render-template.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-agents.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/merged-phase-plan.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-doc.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-summary.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-variant.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/retrospective.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/slides-story-review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/ui-vision-review.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ab-contrast-deslop-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/acceptance-criteria-verification.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/agent-stall-detection.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/anti-patterns.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/artifact-authority-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/conductor-routing-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/confirmation-rules.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/contract-style-guide.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/copilot-ci-status-contract.md` | 1 | changed | Full owner and normalization/detector/prober consumers inspected. Parked exclusion condensation retained; inputs/output, precedence, failure/timeout, unsupported-completed override and zero-suite identity prerequisites unchanged. Both exclusion names stay explicit; missing current-head evidence remains fail-closed failure. 82 focused CI/prober/workflow tests; docs/assets pass. Fresh Terra `/root/dev_loop/ci_owner_review` required restoring the explicit missing-evidence predicate, then verified the fix with no remaining defect. |
| `skills/docs/copilot-loop-operations.md` | 1 | changed | Full owner/callers inspected and condensed; authority/watch/stop/approval/draft/closing-reference/checkpoint contracts retained. Fresh `/root/dev_loop/phase1_authority_review` semantic review and corrected structural tests; see current-run evidence. |
| `skills/docs/copilot-loop-state-graph.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/cross-harness-regression-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/decision-record-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/docs-grill-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/entrypoint-strategies.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/epic-tree-refinement-procedure.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/gate-review-comment-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/gate-review-sub-loop-contract.md` | 1 | changed | Full owner and applicable tests inspected; remaining execution/spec/dispatch/delivery/sentinel/carry summaries condensed, distinct guards retained. Fresh Sol semantic review passed; its dispatch-key test correction and final local verification passed. |
| `skills/docs/issue-intake-procedure.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/local-planning.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/main-agent-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/merge-preconditions.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/pr-lifecycle-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/projects-queue-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/public-dev-loop-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/release-runbook.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/required-rules.json` | 3 | pending | Not yet reviewed. |
| `skills/docs/retrospective-checkpoint-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/reviewer-loop-state-graph.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/slides-story-review-loop.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/spec-authority-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/spike-mode-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/stop-conditions.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/structural-quality.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/sub-issue-tree-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/tracker-first-loop-state.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/tracker-seam-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-artifact-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-designer-review-loop.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-e2e-scoping-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-review-recipe-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-smoke-harness.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-validation-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/validation-policy.md` | 1 | changed | Full source inspected; CI exception now requires its current owner. Default validation, coverage admission and meaningful exception rules intentionally retained. |
| `skills/docs/wait-watch-procedure.md` | 1 | changed | Full-file old/new review complete; duplicate capture commands and obsolete CI history removed. Remaining route-local decisions intentionally retained to avoid loading the full follow-up bundle. |
| `skills/docs/workflow-handoff-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/worktree-guidance.md` | 3 | pending | Not yet reviewed. |
| `skills/final-approval/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/local-implementation/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/loop-grill/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/review/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/ui-review/SKILL.md` | 2 | pending | Not yet reviewed. |

## Phase 1 validation plan

Reviewed first slice: simplify the follow-up skill's startup/path-resolution prose and the shared wait procedure; replace generated-projection prose pins using existing transformation tests. Subsequent slices condense fan-out/fan-in with its owner while preserving unresolved conflicting instructions. This PR is variant A; the issue now defines an independent variant-B comparison. Neither variant is selected for merge.

Compare old/new instructions for actors, permissions, triggers, conditions, order, exceptions, stop rules, evidence and revision identity. Preserve frontmatter, rule IDs, command examples and the declared verbatim dispatch payload. Independently evaluate high-risk scenarios with no live writes. Replace incidental prose pins with existing structural/behavior seams; keep exact API/projection checks. Run docs, contract, generated-asset and default verification before draft handoff.

## Ambiguity register

- Fan-in count: corrected to actual emitted/spawned units following the existing owner's explicit authority and emitter tests; unsplit `pendingGroups.length` was obsolete advice.
- CI evidence flag: removed executable use of unsupported `--local-validation-head-sha`; the existing CI owner retains prerequisites and now states that ordinary CLI refresh cannot activate the exception. See the code-backed correction below.
- Carry eligibility: the skill still says clean-only; the owner and current tools support carrying `findings_present` with unchanged findings. The contradictory passages remain unresolved.
- Zero-unit rounds: the skill says an all-carried round dispatches no emitter, but sanctioned consumers require an emit plan and the emitter/writer reject an empty plan. No exception or new stop rule was invented.
- Proportionality grouping: `GATE-EXEC-PROPORTIONALITY` describes `full_fanout` as distinct-reviewer-per-angle, while `resolveReviewProportionality` always obtains groups from `resolveFanoutGroups`. The disputed prose is retained pending authority reconciliation.
- Fixer handoff identity: the owner permits thread ID "or finding fingerprint", while `normalizeFixerDispositionHandoff` requires `threadId` and only optionally accepts a fingerprint. Neither policy nor validator was changed.
- Review lineage: its introduction says a new head does not rebuild a full head-specific briefing, while Phase 5 mandates a fresh Phase 1 context-builder pass. Whether these refer to distinct artifact layers needs clarification; neither instruction was weakened.

The detector's current `--help` lists no `--local-validation-head-sha` option. The dispatch emitter returns its expanded unit count, and its tests cover splits beyond the configured group count. These evidence-backed description corrections do not resolve the remaining policy conflicts or establish whole-phase clearance.

## First-slice evidence

- Independent old/new review read both complete edited sources and found no material semantic regression.
- Read-only scenarios covered stale installed source, older installed tooling, dirty PR/new-review transitions, exhausted review budget, Pi versus Claude continuation, and invalid startup/envelope. All preserved the required decisions. This is scoped scenario evidence, not lifecycle-gate clearance or proof of universal semantics.
- `test/contracts/claude-assets-reproducible.test.mjs` now checks paired Pi-only markers, source-derived omission, complete projection equality and the actual wait-route target. Existing transform fixtures assert exact outputs while varying prose wording and wrapping. API literals and generated byte parity remain checked.
- Tests do not prove that arbitrary text inside a valid scope marker has the right meaning. Source semantic review and the scenarios above cover that limitation for this slice.
- The source edits retain frontmatter, rule IDs, command blocks, anchors and the declared verbatim dispatch payload. Generated Claude copies come from the canonical generator.
- Remaining brittle tests include the Copilot review persistence/section pins, issue-intake persistence pins, carry-forward single-line extraction and defect-surfacing prose assertions. These remain in the same cleanup scope, not silently declared fixed.

The first slice changes two source documents; neither is fully reviewed for simplification yet. All other inventory rows remain pending or under inspection. Do not merge this partial cleanup as completion of issue 2236.

Validation for this slice used Bun 1.4.1: 69 focused contract/projection tests passed; generated-asset check passed for 92 assets; docs/link/rule/changelog checks passed. The first default `bun run verify` attempt exposed another incidental packaging-sentence assertion and local listener/Git worktree fixture failures. The assertion was replaced with installed-link, bundle, packaging and ownership checks; all 12 tests in that file passed, including wording variants and missing-link/bundle failures. The two environmental test files passed all 48 tests with the required local permissions. A full rerun on `49125139` then passed: 9,289 tests across 390 files, zero skipped or failed, plus docs and workflow checks. This is local validation, not lifecycle-gate clearance or completion of the remaining inventory.

## Substantive condensation slice

The human clarified that total loaded contract surface, rather than shorter entrypoints alone, is the objective. Variant A remains PR2237; the independent-B handoff in issue2236 is not a dispatch or merge authorization. This slice follows that clarified spec and does not reuse previous clearance.

The fan-out and fan-in checklist items shrink from 918 words each to 164 and 201 words. Their owner also shrinks: grouping algorithms, primer rationale and count derivations no longer repeat. The skill explicitly requires the complete owner before execution. Existing rule IDs, anchors, flags, evidence duties and harness distinctions remain. The actual emitted/spawned dispatch count replaces the stale unsplit-count derivation, following the owner's existing explicit authority and emitter tests; the other ambiguities above remain untouched.

Measurements use `wc -w -c`: whitespace words and UTF-8 bytes, including code examples/frontmatter, not tokenizer estimates or isolated prose estimates. Columns compare the original unmodified base, the prior A checkpoint, and this slice respectively.

| Named surface | Original base `894a5a59` words / bytes | A checkpoint `cc032f92` words / bytes | This slice words / bytes |
| --- | --- | --- | --- |
| All 77 tracked `skills/` files (including code/registry files) | 152,637 / 1,182,913 | 152,462 / 1,181,751 | 149,162 / 1,157,388 |
| Follow-up skill + gate-review owner | 43,100 / 326,906 | 42,939 / 325,850 | 39,639 / 301,487 |
| Corresponding Claude projections, used instead of source pair | 42,907 / 325,900 | 42,746 / 324,844 | 39,446 / 300,481 |
| Named conductor contract-read set below | 79,828 / 606,829 | 79,667 / 605,773 | 76,367 / 581,410 |

The conductor set assumes a source/Pi follow-up gate and counts each of these full files once: the source pair above; AGENTS.md; dev-loop/SKILL.md; and docs/public-dev-loop-contract, retrospective-checkpoint-contract, copilot-loop-operations, entrypoint-strategies, confirmation-rules, stop-conditions, validation-policy, main-agent-contract, anti-patterns, worktree-guidance, structural-quality, gate-review-comment-contract, spec-authority-contract, acceptance-criteria-verification and merge-preconditions (all docs names under `skills/`, with `.md`). This includes the same mandatory owner in both versions, not a short checklist compared with missing references. It is a named contract-text measurement, not a complete live prompt or token bill: PR/spec/diff artifacts, system instructions and step-specific additional reads vary. Reviewers consume their emitted briefing and role instructions in separate contexts; do not multiply the conductor set by reviewer count. Other routes and a complete transitive live-read audit remain pending.

The compact old-obligation trace is in the local phase review artifact `tmp/phases/issue-2236/condensation-obligations.md`. Independent comparison found no introduced semantic defect; seven read-only scenarios covered emitted groups/leftovers, partial carry, zero-unit ambiguity, missing evidence, opaque caching, grouped provenance and stale head. This is scoped evidence, not lifecycle clearance or proof of better determinism. Contract tests now accept wrapped steps while rejecting flags borrowed from sibling steps. Full verification for this slice passed under Bun1.4.1: 9,290 tests across390 files, no skips/failures, plus docs/workflows. Assets check passed92 projections; docs were rerun after this ledger update.

## Reviewer-budget slice

The next slice condenses the owner's preflight instructions into inputs, result branches and resume duties. It removes another 210 words / 1,467 bytes from both source and corresponding projection, without adding a reference. The source pair is now 39,429 words / 300,020 bytes; the same named conductor set is 76,157 / 579,943. These retain the measurement assumptions above.

Independent old/new review found no changed obligation. Its trace locates budget pass-through and preflight consumption in the opening paragraph, zero dispatch and resumable evidence in the branch table, same-head scanning versus proven prior-head carry in the resume paragraph, ALL-angle exclusion immediately after it, and no verdict/inline exemption in the final paragraph. Six read-only scenarios covered unexposed budget, proven shortfall, clean same-head resume, mixed completed/carried groups, prior-head provenance and zero required reviewers. The unresolved clean-head wording remains unchanged. Generated Claude output was rebuilt; 21 focused tests and 92-asset parity passed. Full `bun run verify` passed under Bun 1.4.1: 9,290 tests across 390 files, zero skips/failures, plus docs/workflows. Whole-phase and lifecycle clearance remain pending.

Inspection for the next slice found an additional existing mismatch in the unchanged render-budget section: unconditional foreign-angle refusal versus the implemented `gates.rejectForeignAngles: false` warning mode. The section also calls no-mandatory-angle gates unaffected, although supplied provenance still receives pool checks. These statements require reconciliation; this slice does not change them or expand acceptance.

## Render-budget slice

Only the unambiguous render/output instructions are condensed; the disputed coverage paragraphs remain unchanged. This removes 258 words / 1,661 bytes from source and its regenerated projection. The source pair is now 39,171 words / 298,359 bytes; the named conductor set is 75,899 / 578,282 under the same read assumptions.

Independent review traced renderer-based fit, the 16-character floor, real finding/angle/verdict retention and complete ledger to the opening paragraph/table; withholding versus refusal and stale-output removal to the table; output existence, summary fallback and severity-count duties to the caller paragraph and unchanged downstream count contract. Four scenarios covered truncation that fits, withholding with a ledger, refusal without a ledger and posting a withheld clean verdict. Removing the assertion that renderer acceptance prevents every later posting failure removes an overstated implementation guarantee, not a permission or duty; posting validation still applies. All 172 fan-in tests and 92-asset parity passed. Full `bun run verify` passed: 9,290 tests across 390 files, no skips/failures, plus docs/workflows. This is not phase completion or lifecycle clearance.

Independent read-set audit adds five applicable owners to the earlier named 19-file set: `workflow-handoff-contract.md`, `artifact-authority-contract.md`, `contract-style-guide.md`, `copilot-loop-state-graph.md` and `pr-lifecycle-contract.md`, all under `skills/docs/`. The resulting 24-file conservative contract surface is 89,563 words / 683,005 bytes at the original base versus 85,634 / 654,458 now (3,929 words / 28,547 bytes removed). Assumption: source/Pi conductor, existing tracker-backed draft PR, first full fan-out round, clean result through ready-for-review; no intake, fix, watch reroute, recovery, UI review, final approval or merge. Retained background files in the original set remain counted in both versions. Adding the separate, unchanged `agents/dev-loop.agent.md` role instruction yields 91,146 / 694,598 versus 87,217 / 666,051.

This is a route-scoped conservative surface including applicable referenced owners, not an observed prompt or complete mandatory-read claim. Startup/envelope emits four route reads; it does not traverse Markdown links. A fix push adds the CI-status contract; watch/intake/recovery/harness-specific routes add their respective owners. Other agent roles remain separate contexts. Static text measurements do not prove actual loading or token savings.

## Watch-contract test slice

The test cleanup separates structural availability, exact dispatch payloads and helper behavior from agent-only persistence duties. Step extraction may tolerate a renamed title but must not borrow a sibling's payload. The contract-declared dispatch clause remains case-sensitive and exact. Persistence wording is reviewed with scenarios rather than treated as an executable contract merely because a sentence matches.

| Read-only scenario | Required decision | Coverage limit |
| --- | --- | --- |
| Pi: pending, non-terminal, budget remains | Child exits on external wait; parent refreshes and redispatches the same target when feasible, carrying checkpoint/outcome; otherwise reports the blocker. | Helper tests cover pending/continue-wait and checkpoint identity, not actual agent redispatch. |
| Claude: same result | Continue inline with fresh envelopes until the requested boundary or budget. | Projection tests protect Pi-only stripping, not agent continuation. |
| Explicit handoff-only request | State the narrower scope and stop at handoff without claiming workflow completion; otherwise continue. | User-intent interpretation remains agent judgment. |
| Requested one-shot status/reattach | Use a supported zero-timeout probe; ordinary waiting uses emitted bounded nonzero arguments. | Probe/watch tests cover outputs and arguments, not authorization to choose one-shot mode. |
| Review boundary exhausts 30 minutes | Refresh once; if still waiting, report timeout and stop. No new cycle without authorized extension. | Tests bound individual calls, not cumulative agent elapsed time or every redispatch. |

Independent read-through of the current owners produced all five outcomes; it did not execute an agent or establish end-to-end persistence. Existing `run-watch-cycle`, `outer-loop-routing`, handoff and probe tests cover their mechanical portions. Additional sentence pins in issue-intake tests remain pending. Inspection also found stale `--probe-only` guidance in `scripts/README.md` despite parser rejection; that external reference remains unchanged. General public-contract redispatch wording is not harness-qualified, while the specific Claude rule requires inline continuation; this ambiguity remains visible rather than rewritten here.

The implemented tests check the skill-to-operations/wait and operations-to-state-owner references with the existing Markdown-link extractor and verify unique rule ownership. Fixtures accept changed labels and reflow, but reject missing references, missing step sections and sibling payload leakage. Exact payload fixtures reject weakened obligation, changed head identity and casing. Independent review confirmed these are structural checks, not substitutes for the agent scenarios above. Other assertion families in the file remain pending; this is not completion of the brittle-test audit.

## Prompt-layout slice

The owner retains atomic compose-and-record, capped leading bytes plus a full-content hash, canonical emitted-file rediscovery, inline prefix layout, fail-closed invalid records, the zero-record exception and separate records-floor, delivery uncertainty and recovery preserving history. The compact obligation mapping is: capture paragraph/command, binding checks/failure list, delivery boundary, then exception/recovery paragraph. Six independent scenarios covered altered suffix, pointer/angle-first layout, missing evidence, zero records with a pending plan, dishonest final-hop delivery and recovery. No introduced semantic finding was reported.

This removes another 297 words / 1,985 bytes from source and its projection. The source pair is 38,874 / 296,374; the 24-file conservative set is 85,337 / 652,473 under the same assumptions. Existing recovery wording still says rerun emitter and reconsolidate; tooling additionally calls for redispatch. That discrepancy is recorded, not resolved by the prose edit. Validation passed: 21 focused contract tests, 189 helper tests, 92-asset parity and full `bun run verify` (9,292 tests across 390 files, no skips/failures, plus docs/workflows).

## Generated-briefing slice

Repeated generator internals now point to their existing implementation; agent invocation, byte identity, complete-input access, fallback and verification duties remain in the owner. The old predicate trace is:

| Removed enumeration | Existing authority / retained instruction |
| --- | --- |
| Section order, body fencing, multi-issue labels, validation suffix | `renderBriefingPrefix` / `pickFence` in `scripts/github/write-gate-context.mjs`; consume emitted bytes unchanged. |
| Default/additional exclusion globs and whole-file filtering | `filterDiffForInline` / `DEFAULT_DIFF_EXCLUDE_GLOBS`; preserve changed-file visibility and full-diff access. |
| Cap/mode selection and exact supplied-prefix bytes | Builder modes; all modes retain byte identity and missing-pointer disclosure. |
| Collapse purity, two-hunk floor, metadata exceptions and bounded summary paths | `collapsePureSubstitutionRuns`, `analyzeHunkPurity`, `hasNonTrivialFileHeader`; nonqualifying hunks/metadata and persisted diff remain intact. |
| Scope-specific slices and fallback | `renderScopedBriefingVariant` and `writeGateContext`; full body/AC/validation and unconditional widening pointers remain required. |
| Missing hash, wrong gate, same-head separation and legacy fallback | `verify-briefing-prefixes.mjs`; reviewers record invariant hashes and fan-in must invoke verification and stop on failure. |

Independent old/new review found no material loss across malicious fenced bodies, excluded files, one/two-hunk runs, impure/metadata-bearing hunks, scoped inputs, fallback, hash failures and absent-record scenarios. The 439 focused renderer/filter/verifier tests passed. No runtime feature or new tolerance was introduced.

This slice removes 1,050 words / 6,893 bytes from source and its generated mirror. The source pair is now 37,824 / 289,481; the 24-file conservative set is 84,287 / 645,580. Whole-tree coverage remains partial. Full `bun run verify` passed: 9,292 tests across 390 files, no skips/failures, plus docs/workflows. The 92-asset parity check also passed.

## Request-plan and obsolete CI-invocation slice

Request-plan implementation detail now delegates to existing `buildReviewDispatchPlan`, `buildAngleRequestGroups`, model resolution and writer enforcement. Retained interpretation duties include Claude/Pi limitations, unobserved fingerprint inputs, hash formats, TTL defaults, scoped-prefix ordering, volatile/stable separation, validation before destructive writes, completion-marker ordering and the distinction between a plan and actual primer evidence. Independent scenarios found no changed decision for pending-name trimming, Pi models, omitted fingerprint inputs, scoped companions, malformed inputs or changed acceptance criteria. The original complete-set failure invariant remains explicit; same-prefix marker retention does not itself prove it. That existing implementation gap is not fixed or excused here.

The CI correction preserves the old zero-suite, previous-green and same-head-local-verification prerequisites in the existing CI owner, with mandatory point-of-use reads from both callers. The detector parser rejects the removed flag, and `runCli` supplies only repo/PR to `autoDetectSnapshot`; ordinary CLI refresh cannot provide the local-validation SHA required by internal promotion. No runtime promotion was enabled. Independent scenarios confirmed that raw `none` cannot be self-certified, failure still routes to stop/fix, wrong-head or incomplete internal evidence cannot promote, and gate-evidence exclusion remains separate. This corrects an impossible invocation, not a permission boundary.

The combined slice reduces the whole source tree by 622 words / 4,201 bytes. The source pair is 37,134 / 284,662; the 24-file conservative normal-draft set is 83,570 / 640,611. The CI owner is a conditional additional read for this exception: it is now 1,014 words / 8,105 bytes, versus 919 / 7,337 at the original base. Counting the same 24 files plus that whole owner in both versions gives 90,482 / 690,342 versus 84,584 / 648,716; the shorter callers alone would hide that owner's growth. Validation passed: 453 focused detector/builder/plan tests, 92-asset parity and full `bun run verify` (9,292 tests across 390 files, no skips/failures, plus docs/workflows).

## Context, verdict and fixer checklist slice

The skill's context/verdict/retry steps retain their commands and agent responsibilities while dropping repeated owner explanations. Validation-before-context and live spec resolution remain in step 1 and owner Phase 1; same-round findings, withheld-summary-plus-ledger and post-before-fix remain in step 6 and the mandatory command contract; every-round triage, question handling, nit judge-act exception, severity windows and file/stamp distinctions remain in step 7 and the owner's disposition rules. Governing-issue resolution stays at point of use because the owner delegates it back here: all closing issues as CSV, omit only for no issue, never a hardcoded or unrelated allowlist.

Independent scenarios covered clean rounds with open low/questions, ordinary versus judge-acted nits, in-window medium, withheld output and umbrella references. The known clean-only carry sentence is retained verbatim. The checklist still lacks an explicit judge bridge despite the owner's mandatory Phase 3.5; its every-finding formulation and the owner's act-only fixer input need reconciliation. This slice does not choose between them.

The old test failed because it pinned the governing-issue sentence. Replacement checks preserve exact invocation arguments across source/mirrors, accept surrounding prose changes, and reject missing flags, numeric/wrong placeholders and duplicate overrides. They do not prove that an agent selected the real governing issues; independent scenario review covers that duty, while existing closing-sweep tests cover unrelated-reference refusal.

A second obsolete CLI instruction, `--review-request-status`, is corrected visibly: existing parser tests reject it. Separate requests still follow the request-result branches before a normal detector refresh. Combined handoff preserves its own request result through `applyConfirmedReviewRequest`; it does not accept an external override. No snapshot fabrication or new request permission is introduced.

Net source reduction for this slice is 445 words / 2,825 bytes; the source pair is 36,664 / 281,552 and the 24-file normal-draft comparison set is 83,125 / 637,786. Validation passed: 21 focused contract tests, 161 closing-sweep/handoff/parser tests, 92-asset parity and full `bun run verify` (9,292 tests across 390 files, no skips/failures, plus docs/workflows).

## Wait-file completion and primer accuracy

Whole-file independent review found the remaining wait instructions necessary at the narrow route boundary: read-only ownership, fresh transitions, ordered envelope loading, lightweight flags, confirmed watch entry, timeouts and harness differences must remain available without preloading the full follow-up owner. Duplicate capture commands were removed because the destination procedure is already mandatory at re-entry. The zero-suite paragraph now states the actual missing-input limitation directly. The exact pre-approval dispatch clause is unchanged. Broader cumulative-budget and generic-redispatch limitations remain recorded above; this is file-level review, not whole-phase or lifecycle clearance.

The primer checklist retains mandatory priming, first-token/completion barrier, both primer forms and the owner's request-envelope/evidence duties. Unsupported promises of zero extra cost and guaranteed cache reads were removed; ordering evidence is not provider cache telemetry. The validation-policy table's third obsolete flag reference now requires the same bounded CI owner rather than suggesting an unavailable override. Independent review found no changed permission or execution branch.

The complete wait file is 959 words / 7,340 bytes versus 1,035 / 7,920 at the original base. A narrow source-route set—AGENTS, main-agent contract, dev-loop entrypoint, public contract and wait procedure, each once—is 13,840 / 106,456 versus 13,764 / 105,876. Startup mechanically names only the last two route files; the first three are baseline reads. Variable issue/PR state and agent-role text are excluded in both versions. This is a named static instruction set, not observed token usage.

Net whole-tree reduction for the current slice is 67 words / 406 bytes. The normal-draft 24-file set is 83,120 / 637,854: five fewer words but 68 more bytes than the preceding slice, because the truthful CI-owner link is longer. The file-level accounting does not hide that tradeoff. Focused checks passed 31 tests; doc guard passed 353 with one skip. Full `bun run verify` passed: 9,292 tests across 390 files, no skips/failures, plus docs/workflows. All 92 generated assets matched.

## Gate-comment command slice

The skill retains canonical-helper-only posting, same-call current-head artifacts and true counts, durable identity-bearing findings logs on every round, withheld-summary-plus-ledger, explicit inline mode/reason, and precomputed size evidence. All three command blocks and the narrow human-authorized CI override are unchanged. Removed renderer/default explanations already belong to `GATE-COMMENT-SINGLE-SURFACE`, `GATE-COMMENT-SIZE-BUDGET-FIELDS` and the existing helper; no additional mandatory read or reference file was introduced.

| Removed explanation | Retained authority or enforcement |
| --- | --- |
| Finding placement, markers and digest calculation | Gate-comment owner; helper rendering and `buildStructuredFindingsDigest`; existing single-surface/count tests. |
| Structured input normalization and ledger identity rationale | `normalizeStructuredFindings` and preloaded-ledger validation; existing malformed/mixed-shape and wrong-gate/head tests. Agent input-selection duties remain explicit. |
| Withheld coverage internals | Mandatory Phase 3 owner and provenance validation; summary alone remains forbidden. |
| Inline default and size auto-derivation detail | Existing argument checks and `evaluatePrSizeBudget` path; explicit mode/reason and size precomputation remain required. |

Independent old/new review found no material drift for withheld output, wrong ledger identity, missing inline reason, zero placeholders or size-budget exits 0/1/2. This review does not claim that prose tests prove agent compliance. The source reduction is 488 words / 3,525 bytes, without moving text elsewhere. The source pair is now 36,159 / 277,962; the 24-file normal-draft set is 82,632 / 634,329. Focused checks passed 31 tests, doc guard passed 353 with one skip, and all 92 generated assets matched. Full `bun run verify` passed: 9,292 tests across 390 files, no skips/failures, plus docs/workflows.

## Stable validation-policy test slice

Replaced incidental sentence pins with unique rule ownership, generated mirror parity and a real `Validation`-section reference to `OPS-PR-VALIDATION-STABLE-EVIDENCE`. Existing Markdown-section and rule-reference parsers supply the structure; no new framework or runtime behavior was added. Fixtures accept rewritten/wrapped guidance and reject absent, wrong, sibling-section and fenced references. Independent review caught an initial fenced-heading false positive; using the existing fence-aware section parser and adding that negative fixture corrected it.

The reporting policy is unchanged. Independent scenarios confirmed that a named command plus stable pass/fail is suitable; incidental aggregate counts, skips, durations and timestamps belong outside the PR description; an explicit quantity-sensitive AC is the exception; detailed totals stay in artifacts bound to the producing head. There is no executable reporting-policy validator: structural tests cannot detect inverted instructions or prove agent compliance. The removed regexes did not establish those semantics either. This limitation remains a review obligation, not a claimed deterministic gate. Focused tests passed 22; doc guard passed 354 with one skip. Full `bun run verify` passed: 9,293 tests across 390 files, no skips/failures, plus docs/workflows.
