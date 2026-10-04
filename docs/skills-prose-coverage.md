# Skills prose cleanup coverage

Current run: tracking issue [2454](https://github.com/mfittko/dev-loops/issues/2454). Start revision: `6202c2ed70b5cd438051a90bee9aae89e56326f3`. The current run has its own inventory, phases and baseline measurements in the section below.

Previous run: tracking issue [2236](https://github.com/mfittko/dev-loops/issues/2236). Baseline: `894a5a59080222cef5a47fc3f4e962824e05bfda`. The previous run inventoried 77 tracked files under `skills/`, including 67 Markdown files and ten code/registry files. Its records start at the previous-run section and continue through the end of this file.

A pending row is not reviewed coverage. This record tracks execution; the tracking issue remains the canonical specification.

Dispositions: `pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`. Generated `.claude/skills/` projections are outside this source inventory and must be regenerated, never edited by hand. In the previous run, runtime changes were limited to the explicitly authorized C17/C21 corrections; schema and dependencies were excluded.

Previous-run phases: 1 = Copilot follow-up and directly coupled references/tests; 2 = other routed entrypoints and their workflow contracts; 3 = remaining shared documentation, references, templates and script comments/help. The previous run's cross-phase contradiction pass has a final disposition for every decision row in its section.

## v1.0.6 slice 1 — gate-round contract surface (issue 2603)

Slice 1 of the v1.0.6 prose cleanup condenses the three files the gate coordinator and the gate reviewer load: `skills/docs/gate-review-sub-loop-contract.md`, `agents/gate-coordinator.agent.md` and `agents/review.agent.md`. Start revision: `410eccba0` (contract bytes equal to `d8252e39`). No rule ID, rule marker, heading slug, flag, script name or modality is removed or weakened. `skills/docs/required-rules.json` and `FORWARD_RULE_REFERENCES` are unchanged. The contract keeps the same 42 `<!-- rule: ... -->` markers (sorted `git grep -o` list identical before and after) and every linked heading, so the 11 inbound anchors resolve.

### v1.0.6 slice 1 measurements

| File or bundle | Before bytes / words | After bytes / words | Change |
| --- | --- | --- | --- |
| `skills/docs/gate-review-sub-loop-contract.md` | 225,283 / 29,755 | 191,434 / 24,943 | -33,849 bytes (-15.0%) |
| `agents/gate-coordinator.agent.md` | 2,520 / 365 | 2,153 / 306 | -367 bytes |
| Coordinator bundle (both files) | 227,803 / 30,120 | 193,587 / 25,249 | -34,216 bytes (-15.0%) |
| `agents/review.agent.md` (reviewer bundle) | 21,413 / 2,952 | 19,225 / 2,625 | -2,188 bytes (-10.2%) |

Targets: contract at most 191,500, coordinator bundle at most 193,600, reviewer bundle at most 19,270. All three hold. The Claude projections regenerate byte-identically for the contract (191,434) and shrink for the two agents (`.claude/agents/gate-coordinator.md` 2,460 to 2,093, `.claude/agents/review.md` 21,379 to 19,191).

### v1.0.6 slice 1 duplicate-table trace

- Reviewer reads every required read in full (`GATE-EXEC-BUILD-ONCE-SEED`): authoritative home is the rule's step 2 (MUST read in full, MUST NOT clip, a summary never replaces the read). The "Each reviewer" bullet now cites the rule ID. `agents/review.agent.md` keeps one shortened point-of-use bullet (required reads in full, blocked result on a missing, unreadable or hash-mismatched read, never judge from a summary). The work order prefix from `write-gate-context.mjs` carries the same instruction.
- `contextWidened` lists only reads that moved judgment (absence means "not consulted"): authoritative home is the Phase 2 "Each reviewer" bullet. The `GATE-EXEC-FANOUT-DISPATCH-EMIT` copy now cites it. `agents/review.agent.md` keeps the field definition once (the Required-reads copy became a pointer). The work order execution rules in `emit-fanout-dispatch.mjs` and `write-gate-context.mjs` deliver it too.
- Severity calibration (reachable correctness or fail-open gaps are at least `medium`): authoritative home is the Phase 3 classification bullet. `agents/review.agent.md` keeps one short point-of-use clause, because the work order does not deliver it. The question and nit semantics left that bullet for `GATE-EXEC-THREAD-DISPOSITION`.
- Worktree isolation is prohibited for gate reviewers: authoritative home is the Phase 1 bullet. The Phase 2 reviewer bullet keeps a one-line cross-reference. The `worktreeIsolationProhibited` field row now reads "See Phase 1". `agents/review.agent.md` keeps a short clause (not delivered by the work order).
- Typed round result field list (`GATE-EXEC-GATE-COORDINATOR`): authoritative home is the rule. The review-route omission sentence stays in the contract (a distinct obligation). `agents/gate-coordinator.agent.md` dropped its eight-item list and cites the rule ("leaving out the fields it omits on a `review` round").
- Coordinator never posts the verdict, flips ready, pushes or merges: authoritative home is the rule. The agent keeps its Boundary section (the agent's only statement of its write limits), which also names the fixer dispatch.
- Blocking join of children (`GATE-EXEC-HARNESS-JOIN`, `END-TURN-AND-AWAIT-WAKE`): contract text unchanged. The agent line shrank to the two citations and dropped the restated "blocking dispatch or one `bg_wait` subscription" clause. Owner: `END-TURN-AND-AWAIT-WAKE` in `anti-patterns.md`, and the `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK` paragraph that names the `bg_wait` alternative.

### v1.0.6 slice 1 obligation trace

`skills/docs/gate-review-sub-loop-contract.md`:

- Build-once rule: dropped the "Build-once avoids repeated discovery" sentence and the "Widen only when ... never inherit the conductor's conversation" sentence (duplicates of the MUST NOT fork clause and the Phase 2 widening rule). The three-step list, the MUSTs and the ADR 0086 citation stay.
- Standalone `review` gate paragraph: shortened only; the `GATE_CONFIG_KEY` clause (an absent key means only that the gate has no draft/preApproval threshold; a separate rule covers why it cannot satisfy lifecycle evidence) stays. Owner: `@dev-loops/core/github/copilot-helpers` and `_gate-names.mjs`.
- Phase 1 sentinel bullet: dropped the per-flag purpose explanation. The full command, the gate-prefixed `--scope`, `--context-path` and the prefix hash stay.
- Phase 1 threat-model bullet: shortened the checklist enumeration to one clause. The `SECURITY_SENSITIVE_SEAM` trigger and "never dropped for such a diff" stay.
- Phase 1 neutral-bundle bullet: dropped the "build-once, work-deduped seed" restatement. Owner: the build-once rule.
- Phase 1 `scope.diffSource`, partial `"base"` and spec-resolution bullets: shortened wording; dropped the umbrella-issue label and `closingIssuesReferences` repository detail. Owner: `write-gate-context.mjs`. The `--base` fail-closed rule, the thin-briefing fallback, the `scope.diffPath` keying MUST and the Source-value table stay.
- Phase 1 rebuild paragraph: merged two overlapping refusal sentences. The MUST NOT rebuild while reviewers run, the live-sentinel refusal and "retire THEN rebuild" stay. The pi-subagents technique bullet keeps its imperative ("reference ... when applicable") and drops only the example output paths.
- Request-plan section: shortened the schema, writer-ownership and shipped-limits prose; dropped the trailing "proves request-shape identity only" duplicate, the `sharedPrefixHash` hex-format note and the `toolDefinitions`/`instructions`/`settings` note. Owners: `@dev-loops/core/loop/review-dispatch-plan` and `write-gate-context.mjs`. The write-ordering MUSTs (invalidate marker first, marker last, failed required write removes the marker, report both errors) stay. Restored in the contract: "Pi and Claude model settings never supply a Codex model", "the prefix binds the evidence file and the full diff by sha256", "a rerun with unchanged stable bytes retains the marker in place" and "the persisted filtered and unfiltered diff files stay uncollapsed". Dropped with a code owner: the reserved `"inherit"` grouping meaning (owner: `INHERIT_MODEL_KEY` and its doc comment in `review-dispatch-plan.mjs`), the TTL defaults (`"5m"` for `5m_1h`, else `"harness_managed"`; owner: the capability-to-TTL default in `write-gate-context.mjs`, with `TTL_INTENT_VALUES` in `review-dispatch-plan.mjs`) and the intersection of the angle universe with `fanoutDispatch.pendingGroups` excluding completed/carried angles (owner: `resolveFanoutDispatch` in `write-gate-context.mjs`; the preflight rule in the contract states the unit exclusion).
- First-wave release: merged the priming and raw-API paragraphs; shortened the telemetry helper list to the module path. The immediate-release MUST, "MUST NOT depend on a provider cache hit" and `cacheReuseVerified: false` stay.
- `GATE-EXEC-FANOUT-CAPACITY`: dropped the JSON-serialization rationale, the fixed-width-digest `NAME_MAX` note and the "so wave 1 and every same-head resume derive identical units" rationale (owner: `resolveFanoutDispatch`); dropped the "packed list is recorded" and "packing never splits a base unit" sentences (owner: `resolveFanoutDispatch`; the pack, name, refuse and opt-out rules stay). Wave paragraph: shortened repo-config guidance.
- Phase 2 "Each reviewer" bullets: shortened the "fresh" definition, the composer bullet (now cites `GATE-EXEC-FANOUT-DISPATCH-EMIT`) and the `--scope` rationale; the 429 paragraph now cites `GATE-EXEC-DISPATCH-RETRY-BACKOFF` for the retry schedule and keeps the halving, the wave recompute and the foreground one-at-a-time fallback. Grouped-dispatch paragraph: dropped the "emitter shares every multi-angle unit" repeat (owner: the emit rule bullet).
- `GATE-EXEC-SOURCE-READ-WORKTREE`, `GATE-EXEC-NO-CWD-DEPENDENCE`, `GATE-EXEC-ARTIFACT-HEAD-STAMP`: dropped one rationale sentence each (stale installed copies, wrong-tree reads, "distinguishable from a fresh verdict"). Every MUST, the `git show HEAD:<path>` check and both exemptions stay.
- `GATE-EXEC-BRIEFING-PREFIX`: shortened the findings-write-path rationale, the cache-alignment paragraph and the composer paragraph. Byte identity, the angle-only-in-suffix MUST, the ledger `--tmp-root` MUST NOT and "reference seeding ... is compliant" stay.
- `GATE-EXEC-FANOUT-DISPATCH-EMIT`: dropped the "merged-config sha256 (informational)" aside and the internal repeat of the wave bound; shortened the persona and shared-reviewer bullets and dropped the "angle list is normalized once" sentence. Owners: `emit-fanout-dispatch.mjs`, `resolveReviewerRole`, `fanoutReviewerPairingError`. Pull-refusal codes, the 30 KB ceiling and the keyed emit plan stay.
- Content inlining, filtered-diff and scoped-variant paragraphs: merged and shortened; dropped the hunk-collapse paragraph and the per-mode bullets (kept as one sentence about the recorded mode), and the excluded-path listing detail. Owners: `collapsePureSubstitutionRuns`, `filterDiffForInline`, `renderScopedBriefingVariant`. The required `diff` read, `raw-diff` widening read, config-source exclusion guard and variant retention MUSTs stay. The `dispatch_identity_mismatch` meaning ("execution or role disagrees") and the `.yaml`/`.yml`/`.json` extension clause for `packages/core/src/config/extension-defaults` stay.
- Records-floor: shortened. The plan-is-authority and fail-closed rules stay. `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`: dropped the repo-config parenthetical. Re-run rule: replaced by a pointer to `GATE-EXEC-ANGLE-CARRY-FORWARD` (duplicate of Phase 5).
- `GATE-EXEC-DISPATCH-RETRY-BACKOFF`: dropped the "encoded, testable policy" sentence and three rationale clauses ("rather than keep retrying at full concurrency", "instead of retrying into the same wall", and "a transient failure's" before "cap window"). `planDispatchRetry`, the schedule, the ~3-attempt halving and the immediate hard 4xx escalation stay; `STICKY-PROVIDER-PIN` still defines the cap window.
- `GATE-EXEC-CACHE-TELEMETRY`, `GATE-EXEC-EXECUTION-RECORD`: dropped the "Section D honesty invariant" restatements, the pre-slice-4 example and the live-producer pointer. The fail-closed conditions and the optional-telemetry carve-out stay.
- Sentinel lifecycle: shortened. The same-head retry and `GATE-EXEC-ROUND-RETIREMENT` rules are unchanged in substance.
- Phase 3 fan-in: shortened the CLI, `--carried-angles`, coverage-table, withheld-round and ledger paragraphs. Dropped "no improvised `--jq` extraction" asides. The pair-required fail-closed rule, exit codes and render-budget table stay.
- Classification bullet: moved the question, reject-close and nit detail to `GATE-EXEC-THREAD-DISPOSITION` (the owner). The calibration rule and the `Examined on merits:` MUST stay here.
- Post-before-fix: shortened the opt-in comment paragraph and the slot explanation. `GATE-EXEC-POST-BEFORE-FIX` MUSTs stay.
- Phase 3.5: shortened disposition memory (dropped "checked in both prefix directions", "each ledger is checked on its own" and the carried-reviewer aside), the AC1 paragraph (the four writer-plus-flag pairs stay verbatim), the judge-not-fresh rationale and the merge-seam purpose sentence.
- Phase 4 `GATE-EXEC-BLOCKING-ONLY-FIX`: dropped the restated low, question and nit semantics and the duplicated gate-close detail (owner: `GATE-EXEC-THREAD-DISPOSITION`). The window rule, the two-layer rule and ADR 0089 composition stay.
- `GATE-EXEC-THREAD-DISPOSITION`: restructured into per-severity bullets and removed the repeated low-triage, judge-`act` and nit sentences (each rule now appears once). The round-1 low-defer allowance now appears once, with the judge-acted-low exception in the same sentence.
- `GATE-EXEC-DEFERRAL-RECORD`: dropped the restated stamp rules for nits, questions and unstamped lows (owner: `GATE-EXEC-THREAD-DISPOSITION`). The three record places, comment-target rule, never-creates-an-issue rule, marker format and idempotency stay.
- `GATE-EXEC-FINDING-THREADS`: dropped the aggregate-line and per-angle-breakdown detail (owner: `GATE-COMMENT-SINGLE-SURFACE` and `GATE-COMMENT-INLINE-LAYOUT` in `gate-review-comment-contract.md`, cited by ID). The two-track split, one-carrier rule and marker stay. Close paragraph: shortened the known-findings snapshot restatement (owners: Phase 1, Sentinel lifecycle and the Copilot follow-up fan-out procedure).
- `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`: shortened the helper-behavior prose. The ordered boundary, containment rule and forbidden-action rule stay.
- Carry-forward: shortened the Phase 5 retry bullet, the eligibility paragraph, `GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED`, the delta basis, the same-rebuild disposition-memory paragraph, the config-source and rename explanations and the provenance paragraph. Dropped the `GIT_DIR`/`GIT_WORK_TREE` scrub note (owner: `scripts/lib/git-delta.mjs`) and the parenthetical "honest attribution" aside. The fail-closed defaults, the CLI refusal list and the review-surface mapping stay.
- Copilot round-cap interplay: shortened the strict-mode seam. The `suppressed_post_convergence` results, `converged_once` grant and the fail-closed decision stay. Owners: `COPILOT-FOLLOWUP-ROUND-CAP`, `COPILOT-STATE-CARRIED-CONVERGENCE`.
- Execution-mode paragraph: dropped the epic #867 sentence. Light-mode, proportionality and diff-class tier sections: shortened wording (dropped one-clause rationales, the "a tier is needed because `dynamic.subtractive` keeps per-category width" rationale and the repeated degenerate-pool fallback; the light-mode "exclusion applies only to the cap" scope statement stays); every floor, the precedence order and the merge-time re-verify stay. ADR paths shortened to ADR numbers.
- Fan-out provenance and angle coverage: shortened the one-reviewer-per-unit, `distinctReviewers` floor, caveat and CI paragraphs; dropped the `#1601` repeat and the "may additionally be pool-configured" aside. The pairing check, grouped exception, `gates.requireFanoutProvenance` floor and fan-in-synthetic-angle rule stay.
- Fail-closed fan-out-unavailable section: dropped the Pi-bridge driving-command sentence. The quoted `FANOUT_UNAVAILABLE_MESSAGE` string and the routing to the conductor stay.
- Additive review-lineage section: reduced to a summary that points at `review-lineage.mjs` and its tests (artifact shapes, append-only composition, compaction policy). The `maxLineageBytes` compaction trigger and `rebaseLineage` detail left with the summary (owners: `checkLineageCompaction` and `rebaseLineage` in `review-lineage.mjs`, and `packages/core/test/review-lineage.test.mjs`; the contract still names both functions and the default `maxRounds` 20). The runtime-chain boundary, carry-forward non-ownership and the three non-goals stay. The sub-headings other than "Non-goals preserved" were folded into the summary (no inbound link targeted them).

`agents/gate-coordinator.agent.md`: dropped the typed-result field list (owner: `GATE-EXEC-GATE-COORDINATOR`, cited). The join line keeps both rule citations. Dispatch relay, boundary and file-ops citation stay.

`agents/review.agent.md`: shortened the work-order description, the required-reads bullet, the build-once citation bullet, the bounded-unit bullet, the grouped-dispatch paragraph, the severity and `contextWidened` clauses of the findings-shape text, the `defectKey` paragraph (the location condition "on one file and line, or one file with no line" and "findings without a key merge only on identical summaries" stay), the full-PR blocked-angle clause and the Tool strategy section (dropped the `Grep`/`Glob` allowlist sentence, the `tools:` rationale and the "reads the diff, the plan, and the source" clause; the `tools:` frontmatter stays) and the "(ADR 0115)" aside. The adversarial defect-class parenthetical (edge cases, input validation, numeric coercion, null/undefined, boundary conditions, caller/callee contracts, dedup/identity bugs) stays, because `COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING` owns the behavior but the work order does not carry the class list. Shortened the `question` clause to "An unanswered `question` blocks gate-close like a defect" and dropped the downstream nit treatment (owner: `GATE-EXEC-THREAD-DISPOSITION`). Shortened the "`42` is a placeholder value, not literal example syntax" clause to "`42` is a placeholder, not syntax to copy"; the obligation stays. Every other reviewer rule the work order does not deliver stays.

### v1.0.6 slice 1 test changes

Each replaced pin becomes a structural claim: a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities) that must co-occur in one sentence of a block located by rule marker or literal. `assertClaims` also proves, on the real block, that a reworded copy passes (positive case: a filler clause inserted after each non-final token of the sentence that carries a claim, and the sentence order reversed) and that removing a claim's last token fails exactly that claim (negative case). Exact assertions for rule IDs, markers, flags, script names, frontmatter, slugs, verbatim payloads and the `doesNotMatch` guards stay.

- `drain-learned-runner-rules.test.mjs` (28): `GATE-EXEC-BASE-REFRESH` claims (ancestor check, `git merge --no-edit`, MUST push, regate rule ID); clean-definition check now locates chunks by their literals (it replaces four named opening-phrase anchors); `GATE-EXEC-VALIDATION-RESOLUTION` claims (eleven, replacing whole-sentence matches); dispatch guidance located by the verbatim spec pointer and its bullet list, with role bullets found by rule ID.
- `gate-reviewer-work-order-contract.test.mjs` (17): reference-seeding, read-in-full and no-clip claims, first-wave release claims, delivery-row claims, review-agent required-read claims, `.adjacentCode` optional claim.
- `gate-deferral-comment-target-contract.test.mjs` (16): `GATE-EXEC-DEFERRAL-RECORD` and `GATE-EXEC-THREAD-DISPOSITION` claims; the judge-pass paragraph is located by its `judge-pass` and `commentDeferredFindings` literals; the judge `defer` bullet claims.
- `gate-coordinator-contract.test.mjs` (14): scope, light-mode, typed-result field, reserved-writes, typed-observation and fail-closed claims; gate-coordinator agent claims (relay, rule citation, boundary).
- `gate-judge-merit-disposition-contract.test.mjs` (10): Phase 3.5 merit claims, calibration claims in the contract and the review agent, and a per-sentence check that every round-1 low-defer allowance carries the judge-acted-low exception (replaces the "three restatements" count).
- `gate-fanout-dispatch-key-contract.test.mjs` (5): the dispatch-key requirement is extracted by marker; variants are built from its protected tokens (no exact contract text, no line-break dependence).
- `self-hosting-gate-rules.test.mjs` (4): `GATE-SELF-HOST-EXPAND-CONTRACT` claims.
- `review-doc-contracts.test.mjs` (3): review-agent gate phrasing, `defaultContext: fresh` frontmatter and the limitation claim.
- `acceptance-criteria-verification-doc.test.mjs` (2): the exit table is parsed into cells and the routing is asserted on the result cell.
- `gate-reviewer-style-contract.test.mjs` (1): the `defectKey` optionality claim.

No script, hook, schema or config changed. Because no producer and consumer pair crosses checkouts, the slice needs no expand-contract split (`GATE-SELF-HOST-EXPAND-CONTRACT`).

## Current run — 2026-09-27 (issue 2454)

Start revision: `6202c2ed70b5cd438051a90bee9aae89e56326f3` (origin/main). Inventory: 80 tracked files under `skills/` (`git ls-files skills`), including 70 Markdown files and ten code/registry files.

Disposition vocabulary: `pending` (not yet worked; the row names its phase), `in progress` (partly worked in an earlier phase), `changed`, `unchanged`, `generated`, `non-prose`, `blocked` (the whole file is reserved by another unit; the row names the owner). A partly reserved file stays in scope. Its row names each reserved passage and the owning issue. This run does not condense, move or reword a reserved passage.

Phases:

1. Inventory, baseline measurements and the folded items. Folded item A updates `OPS-DRAFT-FIRST-PR` in `skills/docs/copilot-loop-operations.md`. Folded item B removes the stale `--local-validation-head-sha` flag from `scripts/README.md`.
2. Routed entrypoints (`skills/*/SKILL.md`) and their directly coupled references and templates: `skills/dev-loop/templates/*` and the comments and help of `skills/dev-loop/scripts/*`. Work starts with the files that changed most since baseline `894a5a59`.
3. Remaining shared docs under `skills/docs/`, completion of inventory coverage, the cumulative cross-file contradiction review and cross-harness validation.

The churn figures in the table count added and removed lines from `894a5a59` to the start revision (`git diff --numstat`).

### Phase 1 status

Folded item A is applied. `OPS-DRAFT-FIRST-PR` now names two sanctioned draft exits: `ready-for-review.mjs` for a normal ready flip, and `restore-ready.mjs` only for a transient draft that `convert-to-draft.mjs` made while CI is blocking. `restoreReady()` in `scripts/github/restore-ready.mjs` calls `readyForReview()` with the internal `skipCiPrecondition` seam, so both exits keep the clean current-head `draft_gate` evidence guard. `assertDraftBoundary` in `test/contracts/public-facade-doc-contracts.test.mjs` requires `restore-ready.mjs`, and a negative test strips it and expects the check to throw. `OPS-NO-INLINE-INTERPRETER` in the same file is unchanged.

Folded item B is applied. `scripts/README.md` no longer lists the `--local-validation-head-sha` flag bullet. The "Prefer the normal paths first" sentence names only green current-head CI and the `gates.draft.requireCi` draft-gate policy knob.

No other `skills/` source changed in phase 1.

### Required-read bundles

Each bundle is a fixed file list for a realistic route. Measurements count complete files, including frontmatter and code examples. Files outside `skills/` (for example `AGENTS.md`) and live issue, PR and source reads are excluded, because this issue does not condense them.

| Bundle | Route assumption | Files |
| --- | --- | --- |
| A. Startup | `loop startup --issue <n>` resolves strategy `local_implementation`. Its `requiredReads` come from `STRATEGY_REQUIRED_READS.local_implementation` in `scripts/loop/resolve-dev-loop-startup.mjs`. | `skills/docs/public-dev-loop-contract.md`, `skills/local-implementation/SKILL.md` |
| B. Copilot follow-up | Startup resolves strategy `copilot_pr_followup` (`requiredReads`: public contract, retrospective contract, follow-up skill, operations). The follow-up skill's "Required startup reads" section adds the entrypoint briefing `skills/docs/entrypoint-strategies.md`. The retrospective contract is counted because async state and resume apply on this route. | `skills/copilot-pr-followup/SKILL.md`, `skills/docs/entrypoint-strategies.md`, `skills/docs/public-dev-loop-contract.md`, `skills/docs/retrospective-checkpoint-contract.md`, `skills/docs/copilot-loop-operations.md` |
| C. Gate coordinator | One `draft_gate` `fanout_fanin` round in a fresh-context gate coordinator (`GATE-EXEC-GATE-COORDINATOR`). The coordinator reads the gate owner in full, the comment contract that owns the required verdict evidence, and `anti-patterns.md` for the rule IDs cited at point of use (`END-TURN-AND-AWAIT-WAKE`, `SILENT-STDERR-PROBE`). The dispatching follow-up skill is loaded by the parent and is not counted. `acceptance-criteria-verification.md` applies only to `pre_approval_gate` and is not counted. | `skills/docs/gate-review-sub-loop-contract.md`, `skills/docs/gate-review-comment-contract.md`, `skills/docs/anti-patterns.md` |

### Baseline measurements

Method: `wc -c` (bytes) and `wc -w` (words) at the start revision, before any phase 1 edit. The raw command output is kept outside the repository with the run's scratch artifacts.

| Surface | Files | Bytes | Words |
| --- | --- | --- | --- |
| Total canonical `skills/` Markdown prose (`git ls-files 'skills/**/*.md'`) | 70 | 1,105,439 | 144,970 |
| Bundle A. Startup | 2 | 94,393 | 12,156 |
| Bundle B. Copilot follow-up | 5 | 178,374 | 22,288 |
| Bundle C. Gate coordinator | 3 | 251,582 | 33,069 |
| Reference: all tracked `skills/` files, including code and registry | 80 | 1,203,872 | 154,175 |

Per-file baseline: `public-dev-loop-contract.md` 43,380 / 5,607; `local-implementation/SKILL.md` 51,013 / 6,549; `copilot-pr-followup/SKILL.md` 82,373 / 10,200; `entrypoint-strategies.md` 5,130 / 515; `retrospective-checkpoint-contract.md` 27,388 / 3,432; `copilot-loop-operations.md` 20,103 / 2,534; `gate-review-sub-loop-contract.md` 208,581 / 27,458; `gate-review-comment-contract.md` 33,421 / 4,415; `anti-patterns.md` 9,580 / 1,196 (bytes / words).

### Inventory

Totals: 0 `pending`, 0 `in progress`, 50 `changed`, 18 `unchanged`, eight `non-prose`, four `blocked`; 80 files.

| File | Phase | Disposition | Rationale |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 2 | changed | Removed restatements owned by `COPILOT-FOLLOWUP-REQUEST-BRANCHING`, the gate comment contract and merge preconditions, plus helper internals that change no agent decision. Reserved passages of issues 2438 and 2442 are byte-identical. |
| `skills/dev-loop/SKILL.md` | 2 | blocked | Owner: parallel unit PR 2480 (issue 2456) edits this file. It also holds the bounded Copilot/CI watch rule (issue 2438) and the "Blocking join for a nested single-child step" paragraph (issue 2442). |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | 1 | non-prose | Context extraction code with no comments; behavior, payload keys and diagnostics only. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | 1 | non-prose | Test fixtures and assertions with no comments. |
| `skills/dev-loop/scripts/init-phase.mjs` | 2 | changed | Comments only. The two inline blocks that restated `ARTIFACT-TRACKER-FIRST-NO-DUP` now cite the header comment. No code change. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | 1 | non-prose | Re-export shim with no comments. |
| `skills/dev-loop/scripts/phase-files.mjs` | 1 | non-prose | Re-export shim with no comments. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | 2 | unchanged | The comments document the security invariants of hand-copied zero-dep guards (head SHA, id guard, marker encoding, continuation blockquoting) for maintainers. No route loads the file as instructions. The usage string is a single line. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | 1 | non-prose | Test suite. Its comments explain security and compatibility cases and carry no agent instruction. |
| `skills/dev-loop/scripts/render-template.mjs` | 1 | non-prose | Template renderer code with no comments. |
| `skills/dev-loop/scripts/render-template.test.mjs` | 1 | non-prose | Test fixtures and assertions with no comments. |
| `skills/dev-loop/templates/bootstrap-agents.md` | 2 | unchanged | Consumer bootstrap scaffold. Its text is the rendered product and restates no skill rule. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | 2 | unchanged | Consumer bootstrap scaffold. Its text is the rendered product and restates no skill rule. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | 2 | unchanged | Consumer bootstrap scaffold. Its text is the rendered product and restates no skill rule. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/dev-mode-review.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/merged-phase-plan.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/phase-doc.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/phase-summary.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/phase-variant.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/pr-body.md` | 2 | changed | Removed two explanatory clauses. The required sections, `validate-pr-body-spec` boundary and `OPS-PR-VALIDATION-STABLE-EVIDENCE` stay. |
| `skills/dev-loop/templates/retrospective.md` | 2 | unchanged | Heading skeleton for a rendered artifact. No condensable prose. |
| `skills/dev-loop/templates/review.md` | 2 | blocked | Owner: issue 2442 reserves the whole file. |
| `skills/dev-loop/templates/slides-story-review.md` | 2 | unchanged | Model-facing prompt payload with a strict output schema. It holds no duplicated rule. |
| `skills/dev-loop/templates/ui-vision-review.md` | 2 | changed | Merged the per-lens artifact list that item 2 repeated and the repeated coverage paragraph. The JSON example, lens set, severity map and `checkedCriteria` rules stay. |
| `skills/docs/ab-contrast-deslop-step.md` | 3 | changed | Phase 3b. Dropped the #936 history sentence. The antipattern list, flow, rewrite rule and gate-angle scope stay. |
| `skills/docs/acceptance-criteria-verification.md` | 3 | changed | Phase 3b. Condensed the fork intro, the #1951 restatements and the completeness-block rationale; step 1 now reads through `view-pr.mjs` (see the contradiction register). Every step, command, verdict row and refusal stays. |
| `skills/docs/agent-stall-detection.md` | 3 | unchanged | Phase 3b. Already tight: the stall definition, config, detector API, probe flags and recovery procedure carry no restated owner. |
| `skills/docs/anti-patterns.md` | 3 | changed | Phase 3a. Dropped incident narration and the ready-path self-correction internals; `RAW-GH-PR-READY-BYPASS` now cites `OPS-DRAFT-FIRST-PR` for the restore-ready exit. Reserved passage `END-TURN-AND-AWAIT-WAKE` (issue 2442) is byte-identical. |
| `skills/docs/artifact-authority-contract.md` | 3 | changed | Phase 3a. Condensed the intro, the refinement-floor explanation, settings-layer prose and own-mode rationale. Every `ARTIFACT-*` rule, flag, finding code and anchor stays. |
| `skills/docs/conductor-routing-contract.md` | 3 | changed | Phase 3a. Merged the relationship, boundary and non-goal lists into one boundary list and the six scenario tables into one table. Inputs, priority table, transitions and fail-closed rules stay. |
| `skills/docs/confirmation-rules.md` | 3 | unchanged | Phase 3b. A 1 KB owner of `CONFIRM-CORE-EXPLICIT` with its confirmation list; nothing to cut. |
| `skills/docs/contract-style-guide.md` | 3 | unchanged | Phase 3b. A rule table of `STYLE-*` owners; every row is normative and owned here. |
| `skills/docs/copilot-ci-status-contract.md` | 3 | changed | Phase 3b. Dropped the exclusion rationale sentence and merged the two merged-current-head exception bullets. Every exclusion, precedence and `crediblyGreen` statement and the linked anchor stay. |
| `skills/docs/copilot-loop-operations.md` | 3 | changed | Phase 1 changed `OPS-DRAFT-FIRST-PR` (folded item A). Phase 3a replaced the carried-convergence and status-reporting restatements with owner citations and dropped the workflow sketch. Reserved passage `OPS-NO-INLINE-INTERPRETER` (issue 2442) and the Phase 1 `OPS-DRAFT-FIRST-PR` text are byte-identical. |
| `skills/docs/copilot-loop-state-graph.md` | 3 | changed | Phase 3a. Condensed the overview, request-status derivation, clean-convergence and `unavailable` explanations, and replaced the green re-request list with an owner citation plus the snapshot predicates. Carried-convergence and body-disposition rules keep their full text. |
| `skills/docs/cross-harness-regression-contract.md` | 3 | changed | Phase 3b. Shortened the two CI non-goal bullets. The seam list, coverage MUST, additive/no-op bar and suite inventory stay. |
| `skills/docs/decision-record-contract.md` | 3 | changed | Phase 3b. Split the tripwire paragraph into a trigger list and dropped its history and the duplicate tracker cross-reference. Every `ADR-*` rule row is byte-identical. |
| `skills/docs/docs-grill-step.md` | 3 | changed | Phase 3b. Dropped two rationale sentences about the core import boundary and testability. |
| `skills/docs/entrypoint-strategies.md` | 3 | changed | Phase 3b. Shortened the standalone tracker-tooling paragraph. Every strategy block and linked anchor stays. |
| `skills/docs/epic-tree-refinement-procedure.md` | 3 | changed | Phase 3b. Stated the AC/DoD matrix rule once in Definitions, removed the parallelism-model restatement and the relationship table, and fixed the Phase A step numbering. Every `EPIC-REFINEMENT-*` rule, command and phase step stays. |
| `skills/docs/gate-review-comment-contract.md` | 3 | changed | Phase 3a. Condensed the severity-floor, `review` parser, submit-mode, size-budget and verdict-enforcement prose. The "Review-angle ownership" section, including the reserved angle-resolution sentence (issue 2442), is byte-identical. |
| `skills/docs/gate-review-sub-loop-contract.md` | 3 | blocked | Owner: parallel unit issue 2416 edits this file. It also holds reserved passages of issue 2438 (`GATE-EXEC-GATE-COORDINATOR`, `GATE-EXEC-VALIDATION-ARTIFACT`, `GATE-EXEC-BLOCKING-ONLY-FIX`, `GATE-EXEC-NO-CWD-DEPENDENCE`, the Phase 3 verdict list, the Phase 5 clean-pass bullet, the escalation table) and issue 2442 (the reviewer wave paragraph, `GATE-EXEC-COLLECTABLE-DISPATCH`, the per-harness delivery table, `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`). |
| `skills/docs/issue-intake-procedure.md` | 3 | changed | Phase 3a. Removed the duplicate closed-issue bullet and mutation-pass sentence, pointed epic decomposition at the sub-issue tree flow, and routed the PR edit through `edit-pr.mjs`. Reserved passage: the follow-up-capture bullet (issue 2438) is byte-identical. |
| `skills/docs/local-planning.md` | 3 | changed | Phase 3b. The validator payload, size-estimate rules and plan↔PR link are stated once and cited from the flow and example. Every linked anchor, command and stage stays. |
| `skills/docs/main-agent-contract.md` | 3 | changed | Phase 3a. Merged the restated coordinator write boundary into the shared intro and dropped exemption history and dispatch rationale. Reserved passages (issue 2438) are byte-identical: the coordinator verify-delegation passage in the intro plus `COORDINATOR-VERIFY-BOUNDARY` (the table's `COORDINATOR-VERIFY-DELEGATION`; see the Phase 3 contradiction register), and `MAIN-AGENT-FILING-BLOCKER-ONLY`. |
| `skills/docs/merge-preconditions.md` | 3 | changed | Phase 3a. Condensed the gate-evidence server-side narrative, title-marker rationale, size-budget and wrapper restatements, and dropped the removed `--local-validation-head-sha` flag. Reserved passage: the post-merge duties (issue 2438), byte-identical. |
| `skills/docs/pr-lifecycle-contract.md` | 3 | changed | Phase 3a. Cited the merge-preconditions owner for title-marker constructions, condensed the changelog rule mechanics and removed history rows. Transition bullets and state vocabulary stay. |
| `skills/docs/pre-pr-review-contract.md` | 3 | changed | Phase 3b. Removed "Why this phase exists" and rationale sentences inside the rules. Every `PRE-PR-*` and `PRE-PUSH-DELTA-*` rule keeps its MUST text. Reserved passages (issue 2447) are byte-identical: delta sequence Step 3 and `PRE-PUSH-DELTA-EXIT-BOUND`. |
| `skills/docs/projects-queue-contract.md` | 3 | changed | Phase 3a. Merged duplicated Setup, Usage and configuration restatements into their owning sections and dropped GraphQL query bodies the helper scripts own. Every `QUEUE-*` rule, command, flag, reason literal and linked anchor stays. |
| `skills/docs/public-dev-loop-contract.md` | 3 | changed | Phase 3a. Loaded on every startup route. Dropped the mermaid diagram, slice non-goals, example mappings and ownership-race narration, and merged the convergence posture restatement. Every `FACADE-*` rule, gate row, routing step and transition bullet stays. |
| `skills/docs/release-runbook.md` | 3 | changed | Phase 3b. Dropped the v1.0.0 incident narration, the npm-vs-Bun rationale and repeated changelog mechanics. Every command, staging rule, approval refusal and failure-mode recovery stays. |
| `skills/docs/required-rules.json` | 1 | non-prose | Rule registry: IDs, enforcement values and enforcement notes that validators read. Schema and literals are exact data, not condensable prose. |
| `skills/docs/retrospective-checkpoint-contract.md` | 3 | changed | Phase 3a. Removed self-review rationale, verifier matching internals, the lifecycle-reconciliation history and repo-root rationale; routed the merge-commit read through `view-pr.mjs`. Every `RETRO-*` rule, state row and CLI flag stays. |
| `skills/docs/reviewer-loop-state-graph.md` | 3 | changed | Phase 3b. Condensed the overview, reviewer-scope and guarantees prose, and corrected the stale default-angle list in `REVIEWER-STATE-GATE-ANGLE-MAPPING` (see the contradiction register). States, transitions and both rules keep their MUST text. |
| `skills/docs/slides-story-review-loop.md` | 3 | changed | Phase 3b. Merged the entrypoint bullets and dropped the repeated sibling-loop bullet. Inputs, lens, outputs and fail-closed list stay. |
| `skills/docs/spec-authority-contract.md` | 3 | changed | Phase 3b. Condensed the #2016 digest-boundary, enforcement, invalidation and parity prose; the composition paragraph cites its owners by rule ID. Every `SPEC-AUTHORITY-*` rule and CLI flag stays. |
| `skills/docs/spike-mode-contract.md` | 3 | changed | Phase 3b. Dropped the shipping history, the "Why" column, a docs-only non-goal and repeated exit narration. Every `SPIKE-*` rule, command and worked-example payload stays. |
| `skills/docs/stop-conditions.md` | 3 | changed | Phase 3b review fix. Term and `STOP-*` rule tables only; every row is owned here. `STOP-WAIT-001` now cites the per-harness wait rule in `wait-watch-procedure.md`; see the Phase 3 contradiction register. |
| `skills/docs/structural-quality.md` | 3 | changed | Phase 3b. Merged the duplicated "apply during implementation" lead-ins and shortened the rule-ID comment rationale. |
| `skills/docs/sub-issue-tree-contract.md` | 3 | changed | Phase 3b. Step 7 cites the lean-body section and the verify and compatibility prose is merged. Reserved passage: the follow-up row (issue 2438) and the adjacent conservatism clause are byte-identical. |
| `skills/docs/tracker-first-loop-state.md` | 3 | changed | Phase 3b. Removed the event-trigger table, the text lifecycle diagram and the scope-boundary table that restated §1, §3.2, §4.1 and §5.2. Every `TRACKER-*` rule, state and the linked §3.1 anchor stay. |
| `skills/docs/tracker-seam-contract.md` | 3 | changed | Phase 3b. Dropped rationale from the config bullets, scope and non-goals. Every interface method, config key and registration step stays. |
| `skills/docs/ui-artifact-contract.md` | 3 | changed | Phase 3b. Merged the path list and the three best-effort artifact paragraphs, and corrected the report dedup claim (see the contradiction register). The state.json field list, severity map, failure policy and linked anchor stay. |
| `skills/docs/ui-designer-review-loop.md` | 3 | changed | Phase 3b. The axe mapping cites the artifact contract, the route plumbing and lens-seam list are merged, and the dedup claim is corrected. Outcomes, coverage gate, fail-closed list and the linked lens anchor stay. |
| `skills/docs/ui-e2e-scoping-step.md` | 3 | changed | Phase 3b. Dropped rationale sentences from the trigger, CI jobs and verification sections. Every glob, registry, gate outcome and job name stays. |
| `skills/docs/ui-review-recipe-contract.md` | 3 | changed | Phase 3b. Condensed the intro, prerequisites, teardown, viewport and hosting prose. The config-key block and every key, default and fail-closed stop stay. |
| `skills/docs/ui-smoke-harness.md` | 3 | changed | Phase 3b. Removed restatements of the scoping owner and the artifact slug owner and merged the config paragraphs. |
| `skills/docs/ui-validation-contract.md` | 3 | changed | Phase 3b. The glob list is replaced by a citation of the scoping owner; history is shortened. The shared assertions and worked example stay. |
| `skills/docs/validation-policy.md` | 3 | unchanged | Phase 3b. Three `VALIDATE-*` rules and the gate table; each sentence carries an obligation. |
| `skills/docs/wait-watch-procedure.md` | 3 | changed | Phase 3b. Dropped two rationale sentences. The route deliberately restates watch and timeout policy so it need not load the follow-up skill; the dispatch clause pinned by `ASYNC_DISPATCH_CLAUSE` stays verbatim. |
| `skills/docs/workflow-handoff-contract.md` | 3 | changed | Phase 3b. Merged the duplicate `sanctionedCommands` shape into the envelope schema, stated the terminal stop-rule exception once and shortened the #1462 history. |
| `skills/docs/worktree-guidance.md` | 3 | changed | Phase 3a. Condensed the create/provision, branch-resolution, guard and wrong-checkout prose and the duplicate cleanup block. Reserved passage: the `WORKTREE-COMMIT-MSG-GUARD` section (issue 2438), byte-identical. |
| `skills/final-approval/SKILL.md` | 2 | unchanged | Already a thin redirect to the follow-up skill's "Human approval checkpoint" section, which still exists under Step 7. |
| `skills/local-implementation/SKILL.md` | 2 | changed | Merged the duplicated lightweight, handoff-path, commit-authorization and fan-out restatements into their in-file owners. Dropped rationale that changes no agent decision. |
| `skills/loop-grill/SKILL.md` | 2 | changed | Dropped detector-internals rationale and the Output-format restatement of Step 4 posting rules. |
| `skills/pi-session-audit/SKILL.md` | 2 | changed | Removed the motivation section and parser internals that change no reading of the output. |
| `skills/review/SKILL.md` | 2 | blocked | Owner: parallel unit issue 2416 edits this file. |
| `skills/ui-review/SKILL.md` | 2 | changed | Removed stage implementation detail that the stage scripts own. Commands, flags, config keys, fail-closed stops, trust boundary and authorization rules stay. |

### Phase 2 status

Phase 2 worked every phase 2 row that was `pending`: eight changed, 14 unchanged. The four `blocked` rows stay blocked. Phase 3 rows under `skills/docs/` stay `pending`; phase 2 claims no whole-tree completion. Every `<!-- rule: ... -->` marker, MUST/MUST NOT/SHOULD/MAY count, CLI flag and link anchor in the changed files is retained. A backticked-token comparison against the start revision found only internal names and explanatory literals removed; each is listed in the trace below. The phase 2 gain is modest, about 1% of total canonical prose. Deeper condensation of the `copilot-pr-followup` restatements, such as the Required-PR-comment bullets and the `COPILOT-FOLLOWUP-ROUND-CAP` sub-bullets, is carried to phase 3.

### Phase 2 obligation trace

`skills/copilot-pr-followup/SKILL.md`:

- Claude inline-loop note: reworded into short sentences. The fixer-delegation exception stays (Step 6).
- Stale-CLI source selection: dropped the version-comparison internals and the `#1661` non-goal note. The fail-soft to the installed layout and the "tooling source, not gate behavior" statement stay.
- Step 6 re-request paragraph: dropped the consequence sentence about an unrequested watch. The MUST and `COPILOT-FOLLOWUP-REQUEST-BRANCHING` citation stay.
- Step 6 practical rules: dropped the `watch-ci` flags, the provider list and the `gh run watch <run-id>` fallback. Owner: `COPILOT-FOLLOWUP-WAIT-TOOLS` in the same file, which keeps every literal.
- Key rules: merged the two shell-polling bullets into one bullet. Both prohibitions stay.
- Step 7 item 3 question severity: dropped the "unresolved feedback" restatement. The never-deferred rule, the three outcomes and the gate-close block stay.
- Step 7 item 11: replaced the restatement of `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` with a point-of-use citation plus the operative stop (no request, re-request or gate dispatch until `verify-fixer-disposition.mjs` reports the tackled set complete). Owner: `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` in `skills/docs/gate-review-sub-loop-contract.md`.
- Step 7 item 12 converged-once bullet: dropped the carry description. Owners: `COPILOT-FOLLOWUP-REQUEST-BRANCHING` (`suppressed_post_convergence`) and `COPILOT-STATE-CARRIED-CONVERGENCE`.
- Step 7 item 12 request-result bullets: merged four bullets into one citation of `COPILOT-FOLLOWUP-REQUEST-BRANCHING`. The `unavailable` passive-waiting exception, the reference to the immediate `detect-copilot-loop-state.mjs` re-baseline and the `watch-cycle`/`watch-ci` routing stay in the merged bullet. The unexpected-failure stop is owned by the branching rule.
- Gate comment command: dropped the sentence that the helper handles inline versus body-filed findings. Owner: `upsert-checkpoint-verdict.mjs` and [Gate Review Comment Contract](../skills/docs/gate-review-comment-contract.md).
- Size-budget shell comment: shortened. Exit 0/1 write JSON, exit 2 aborts, and the `set -e` capture rule stay.
- Draft and pre-approval gate contracts: dropped "summarizes the procedural integration only" and "This skill does not restate" sentences. The owner links and rule IDs stay. Board sync: dropped the exit-code and auth detail. Owner: `ready-for-review.mjs`; the best-effort, NON-FATAL and never-blocks statements stay.
- Human approval checkpoint: merged two paragraphs. The authoritative verify, the thread cross-check, both stops, the sanctioned `merge-pr.mjs` command and the raw `gh pr merge` prohibition stay.
- Mechanical pre-merge check: dropped the duplicate `merge-pr.mjs` code block (same command in the checkpoint above). `RAW-GH-PR-MERGE-BYPASS` and the violation stop stay.
- Stale lock takeover: dropped the lead-in sentence. The takeover trigger and command stay.
- Post-merge board sync: dropped the exit-code table. Owners: `scripts/projects/sync-item-status.mjs` and `scripts/projects/archive-done-items.mjs`. Both `|| true` guards and the never-blocks rule stay. `queue reconcile` sentence: dropped the consequence clause.
- Reserved passages (`COPILOT-FOLLOWUP-REQUEST-BRANCHING`, Phase 5 retry and fixer triage step, `run-gate-validation.mjs` step, both "Review angles" bullets) are byte-identical.

`skills/local-implementation/SKILL.md`:

- Lightweight session bullet: removed the "NOT a durable committed artifact" restatement. The bullet sits under the non-durable list, which carries the classification. The `pr_body` literals and no-phase-doc rule stay. Enforcement: `assertLightweightIsNonDurable` in `test/contracts/planning-doc-contracts.test.mjs`.
- Lightweight exception in the bootstrap section: cites the tracker-backed section for the `pr_body` literals. The skip, no-commit and `tmp/phases/` rules stay.
- Bootstrap authority paragraph: replaced the restated authority layers with a citation of [Deterministic logging structure](../skills/local-implementation/SKILL.md#deterministic-logging-structure). The no-duplicate-phase-doc rule stays.
- Refinement: dropped the contamination rationale and the briefing sentence. The `refiner` role and parallel fresh-context rule stay.
- Workflow handoff: merged three paragraphs into one. Owner: [Workflow Handoff Contract](../skills/docs/workflow-handoff-contract.md). The by-path rule, envelope read-first and PR Lifecycle ownership stay.
- Implementation loop doc-guard bullet: dropped the `test:assets` rationale. The command and scope stay.
- Commit-immediately bullet and step 11: replaced the restated subagent commit authorization with a citation of [Commit policy](../skills/local-implementation/SKILL.md#commit-policy).
- Review guidance: replaced the fan-out restatement with `LOCAL-DEV-SELF-CHECK-NO-FANOUT`. Tracker handoff path: cites `LOCAL-TRACKER-NO-DIRECT-MERGE`.
- Merge-commit integration: dropped the squash-merge explanation. The preference and force-push limit stay.
- Commit policy: merged the `awaiting-finalization` bullet with step 14. The authorization set is commit, PR-creation or merge.

`skills/loop-grill/SKILL.md`:

- Step 1 items 1 and 2: dropped the `--jq` mechanics and envelope literals. The raw-body and bare-array input requirements and the fail-closed statement stay. The `detect_gaps`/`provenance_missing` consequence stays in Step 4.
- Step 4 no-embed paragraph: dropped the "no embed, not sections only" aside.
- Output format item 2: dropped the restated first-line consequence and `source:`/`bypass:` ordering. Owner: Step 4 `GRILL-SUBLOOP-RATIONALE-COMMENT`, which keeps both.
- `--auto` capture bullet: dropped the harness-internals clause. The command, fallback, runtime origin confinement and the final-screen-only persistence rule stay. Intermediate captures that can hold credential state after a `fill` are pruned as the walk advances.

`skills/ui-review/SKILL.md`:

- Provision stage: dropped the reused helper names (`ensure-worktree`, `provision-worktree`). Owner: `packages/core/src/loop/ui-review-provision.mjs`. The primary-checkout refusal and every fail-closed stop stay.
- Drive stage: dropped the listener names (`response`, `requestfailed`, `pageerror`) and the buffer slicing mechanics. Owner: `packages/core/src/loop/ui-review-drive.mjs`. The recorded failure classes, the 3xx exclusion and the fail-closed step error stay. Dropped the "final report dedups per-state attribution" clause. No stage script implements that dedup; `ui-review-report` posts only diagnosed findings. The statement stays in [UI Artifact Contract](../skills/docs/ui-artifact-contract.md) and is a phase 3 review item.
- Diagnose stage: dropped the stack-frame language list. Owner: `packages/core/src/loop/ui-review-diagnose.mjs`. The skip list, deterministic finding sort order (`rankFindings`), ADDED-lines rule and never-drop rule stay.
- Remaining stages: removed implementation detail that the stage scripts own. Every command, flag, config key, trust-boundary statement and authorization rule stays.

`skills/pi-session-audit/SKILL.md`:

- Removed "Motivation & Context". The thresholds stay in the anti-pattern section (>100 turns, growth > 15x-30x).
- Dedup and role-default paragraphs: dropped parser internals, including the `.output` collection predicate (collect a background-task `.output` file only when its first non-empty line is a JSON object with a string `type` or an object `message`). Owner: `scripts/lib/audit-pi-session.mjs`. The single-turn counting, replay rule, prompt-size definitions and role defaults stay. Owner of the mechanics: the audit script and its tests.
- Per-agent Turns column: cites the Total Turns definition. Dropped the "Uncached Input vs Cached Read" explanation.

Templates and scripts:

- `skills/dev-loop/templates/pr-body.md`: dropped two rationale clauses. Owner of conformance: `validate-pr-body-spec`.
- `skills/dev-loop/templates/ui-vision-review.md`: item 2 cites the per-lens artifact list above it. Merged the coverage paragraphs. The `checkedCriteria` shape, fail-closed marks, all-clean payload and `continue_ui_fix_loop` stay. Dropped the "report dedups" aside. Owner: `convergeUiReviewRouteFindings`.
- `skills/dev-loop/scripts/init-phase.mjs`: two inline comments cite the header comment for `ARTIFACT-TRACKER-FIRST-NO-DUP`. No code change.

### Phase 2 measurements

Method: `wc -c` and `wc -w` after the phase 2 commits and the phase 2 review fixes, compared with the start revision.

| Surface | Baseline bytes / words | Phase 2 bytes / words |
| --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 82,373 / 10,200 | 79,413 / 9,744 |
| `skills/local-implementation/SKILL.md` | 51,013 / 6,549 | 48,729 / 6,198 |
| `skills/loop-grill/SKILL.md` | 25,228 / 3,595 | 23,992 / 3,414 |
| `skills/ui-review/SKILL.md` | 13,946 / 1,980 | 10,469 / 1,442 |
| `skills/pi-session-audit/SKILL.md` | 10,236 / 1,371 | 8,435 / 1,114 |
| `skills/dev-loop/templates/pr-body.md` | 2,071 / 311 | 1,955 / 294 |
| `skills/dev-loop/templates/ui-vision-review.md` | 7,195 / 917 | 6,709 / 850 |
| `skills/dev-loop/scripts/init-phase.mjs` | 3,697 / 340 | 3,390 / 301 |
| Total canonical `skills/` Markdown prose (70 files) | 1,105,439 / 144,970 | 1,093,282 / 143,131 |
| Bundle A. Startup | 94,393 / 12,156 | 92,109 / 11,805 |
| Bundle B. Copilot follow-up | 178,374 / 22,288 | 175,617 / 21,860 |
| Bundle C. Gate coordinator | 251,582 / 33,069 | 251,582 / 33,069 |

Bundle B includes the phase 1 folded item A (`copilot-loop-operations.md`, 20,103 / 2,534 to 20,306 / 2,562). Bundle C holds only `skills/docs/` files and changes in phase 3.

### Phase 2 contradiction list

| Files | Conflict | Owner | Resolution |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` (`COPILOT-FOLLOWUP-REQUEST-BRANCHING` versus Step 7 item 12) | The branching rule says `unavailable`: report and stop. Item 12 keeps the exception "unless the user explicitly wants passive waiting anyway". | Issue 2438 (reserved passage) | Left for issue 2438. Phase 2 kept the item 12 exception verbatim and did not edit the reserved rule. |
| `skills/copilot-pr-followup/SKILL.md` (`COPILOT-FOLLOWUP-REQUEST-BRANCHING` versus `COPILOT-FOLLOWUP-WAIT-TOOLS`) | The `requested` branch names only `dev-loops loop watch-cycle` or `gh run watch` for a wait. `COPILOT-FOLLOWUP-WAIT-TOOLS` and item 12 also route `waiting_for_ci` to `dev-loops loop watch-ci`. | Issue 2438 (reserved passage) | Left for issue 2438. |

### Phase 3 status

Phase 3 runs in two parts. Phase 3a worked the 14 highest-load shared docs under `skills/docs/`: `public-dev-loop-contract.md`, `merge-preconditions.md`, `projects-queue-contract.md`, `gate-review-comment-contract.md`, `retrospective-checkpoint-contract.md`, `copilot-loop-state-graph.md`, `artifact-authority-contract.md`, `worktree-guidance.md`, `copilot-loop-operations.md`, `issue-intake-procedure.md`, `main-agent-contract.md`, `conductor-routing-contract.md`, `pr-lifecycle-contract.md` and `anti-patterns.md`. All 14 rows are `changed`. Phase 3b works the remaining 32 `pending` rows; phase 3a claims no whole-tree completion.

Every `<!-- rule: ... -->` marker in the 14 files is retained, and no MUST, MUST NOT, SHALL, SHOULD, SHOULD NOT or MAY count dropped in any of them. `extractRuleModalities` (`scripts/loop/check-adr-tripwire.mjs`) reports the same family for every rule, except `GATE-COMMENT-IDENTITY-DISJOINT`, which moved from no detected keyword to `must`, because its MUST NOT now falls inside the scan window. Every heading that another file links to by anchor is unchanged. Reserved passages are byte-identical; the per-row rationale names them.

Phase 3b worked the remaining 32 `pending` rows: 27 `changed` and five `unchanged` (`agent-stall-detection.md`, `confirmation-rules.md`, `contract-style-guide.md`, `stop-conditions.md`, `validation-policy.md`). The `post-gate-verdict-fallback.mjs` row was already `unchanged` from phase 2 and needed no work. No inventory row is `pending` or `in progress`, so the whole-tree inventory is complete. In the 32 files, every rule marker is retained and no MUST, MUST NOT, SHALL, SHOULD, SHOULD NOT, MAY or NEVER count dropped (per-file grep against the start revision). `check-adr-tripwire.mjs --base origin/main` reports only the expected contract-doc triggers, with no modality reversal and no removed rule. Every inbound `#anchor` into these files (`local-planning.md`, `entrypoint-strategies.md`, `tracker-first-loop-state.md#31-required-pr-metadata`, `copilot-ci-status-contract.md#zero-suite-local-validation-exception`, `pre-pr-review-contract.md#delta-mode`, `ui-designer-review-loop.md#four-lenses-over-one-bundle-converged-deterministically`) still resolves. Phase 3b changed no test. The phase 3b semantic review then changed `stop-conditions.md` to resolve the `STOP-WAIT-001` contradiction, so the final split is 28 `changed` and four `unchanged`.

### Phase 3 obligation trace

`skills/docs/public-dev-loop-contract.md`:

- Installed-layout rationale sentence and the "Accordingly" restatement of the single entrypoint: removed. The entrypoint, the read-only `review` selector and the MUST-callable surfaces stay in "Public surface".
- Shorthand mapping table: folded into one sentence with the same literals (`auto dev loop on issue 112`, `dev-loop --intent auto_continue_current`).
- Deprecation bar follow-up bullet "dev-loop remains the only intended visible write-capable entrypoint": removed. Owner: the taxonomy table row "Public write-capable workflow entrypoint" and "Public surface".
- "Its tests are" list: replaced by the real test glob. The listed `packages/core/test/public-dev-loop-routing.test.mjs` does not exist (see the contradiction register).
- Tracker-backed "Non-duplication rule" list: merged into one paragraph at the end of the section. The "do not create, read, or update `docs/phases/phase-<n>.md`" rule and the "reconcile an existing duplicate before continuing" duty both stay there. `ARTIFACT-TRACKER-FIRST-NO-DUP` in `artifact-authority-contract.md` owns only the "create" part, so the "read or update" part stays local (Phase 3a review fix).
- Ownership gate: dropped the `issueAssignmentState` non-parameter aside (owner: "Bounded variation parameter contract" in the same file) and the interleaving and convergence narration. Every claim, re-read, tiebreak, loser self-unassign, winner removal, `claim_not_visible_post_read` skip, fail-closed and residual-window statement stays.
- Required transitions preamble and trailer: shortened. Every transition bullet and terminal gate stays; `validate-state-machine-conformance.mjs` checks them.
- `FACADE-PICKUP-INTEGRATE-BASE-FIRST` and `FACADE-NEVER-CI-WAIT-WHILE-DIRTY`: dropped the "same way without re-deriving" and PR #2028 deadlock narration. The MUST NEVER, integrate-first ordering, fail-closed stop and `runBasePickupPreflight` owner stay.
- "Internal / external model" mermaid diagram: removed. Owner: the "Authoritative gate contract" table (`final_approval` routes to the human approval checkpoint; `waiting_for_merge_authorization` is a stop). Enforcement: `assertApprovalStopGates` in `test/contracts/issue-intake-doc-contracts.test.mjs`.
- "Single-entrypoint convergence posture": dropped the two bullets that restate "Public surface" and the taxonomy. The three SHOULD bullets stay.
- "Non-goals for this slice" and "Example mappings": removed. Owners: "Deterministic routing order" and "Representative translations" in the same file.

`skills/docs/gate-review-comment-contract.md`:

- Severity floor: dropped the non-goal quotation and restated rationale. Valid values, rank order, fold block, invisible marker, thread exclusion, schema rejection, fail-open, `question` never folds and `blockCleanOnFindingSeverities` independence stay.
- `review` gate paragraph: dropped the `GATE_CONFIG_KEY` aside and the parser-fallthrough explanation. Header recognition, immediate non-evidence return and symmetric `GATE-COMMENT-NON-SUBSTITUTION` stay.
- Submit modes: dropped the #1888 self-identification rationale and PR-scoped-limit narration. Every mode, the headless refusal, the `--interactive-confirm` requirement in the CLI and runtime, same-head submit, stale delete and discard stay.
- `GATE-COMMENT-SIZE-BUDGET-FIELDS`: merged the two overlapping paragraphs. The MUST render, auto-derive, fail-closed escape hatch, draft/review opt-in rendering and "absent size evidence requires human approval" statement stay.
- Verdict enforcement: merged two paragraphs into one list. The write-time and post-time refusals, the judge's non-revision, act-list composition, no override and the `blocked` exception stay.
- "See also" list: folded into the relationship table.

`skills/docs/anti-patterns.md`:

- Item 6: dropped the #1973 narration. `WORKTREE-WRONG-CHECKOUT-GUARD` and its link stay.
- Item 8: dropped the reconcile mechanics. Owner: `QUEUE-NEXTUP-SOURCE` in `projects-queue-contract.md`.
- `ANTIPATTERN-FANIN-WAIT`: shortened the breach sentence. The three NEVERs, the #982 link, the advisory `rawCallViolations` entry and the sanctioned wait stay.
- `RAW-GH-PR-READY-BYPASS`: the restore-ready clause now cites `OPS-DRAFT-FIRST-PR` in `copilot-loop-operations.md`; the self-correction mechanics are shortened. The mandatory wrapper, both prohibitions, the "carrying unresolved gate-authored threads" routing predicate and the #1915 backstop stay.
- `RAW-GH-PR-MERGE-BYPASS`: shortened the enforcement sentence; `check-retro-tooling.mjs` and `decideBashGate` stay.

`skills/docs/copilot-loop-operations.md`:

- Companion list: one sentence with the same three links.
- Item 7 carried convergence: replaced the restatement with a point-of-use citation. The earlier partial restatement omitted the preconditions (zero unresolved threads, no outstanding request, the latest submitted review decides), so the Phase 3a review cut it to the citation. Owner: `COPILOT-STATE-CARRIED-CONVERGENCE` in `copilot-loop-state-graph.md` (ADR 0090).
- "Workflow overview" sketch: removed; "Deterministic orchestration authority" owns routing.
- Step 1 status bullets: replaced by a citation of `FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED` and the status reporting contract in `public-dev-loop-contract.md`. The startup-resolver linkage rule and "include the resolved artifact identity" stay.
- PR description contract: dropped the "one validator, never drifting" rationale; both validator seams, the own-body requirement and the skeleton link stay.
- Timeout policy and checkpoint lead-ins: shortened. Every default, the removed-flag warning and `buildCorrectedArgs` stay.
- Shell-polling rule: merged the "watcher sleeping is not a blocker" line.

`skills/docs/issue-intake-procedure.md`:

- Companion list: the `FACADE-*` IDs are cited at point of use in Phases 2 and the unattended section. The merge wrapper duty moved to Phase 4.
- Quick-capture exemption and mutation pass: shortened; every deferred step, the safeties and the verification artifact stay. Enforcement: `assertMutationPassContract`.
- Duplicate closed-issue bullet in the plan-doc path: removed. Enforcement: `assertPlanDocClosedStop`.
- Phase 3b: the seven-step flow is replaced by the owner citation plus every `manage-sub-issues.mjs` command. Owner: "Default decomposition flow", `SUBISSUE-NO-ADHOC-BYPASS` and `SUBISSUE-LEAN-BODY-NO-DUPLICATE` in `sub-issue-tree-contract.md`.
- Phase 4 merge paragraph: dropped the precondition list and `resolveEffectiveMergeAuthorized` detail. Owner: `MERGE-PRECOND-REQUIRED` and "`autonomy.humanMergeOnly`" in `merge-preconditions.md`. The never-merge handoff and the authorized command stay.
- Phase 4 PR edit example: `gh pr edit` is replaced by `edit-pr.mjs` (see the contradiction register). Enforcement: `assertIntakePrEditUsesWrapper`.

`skills/docs/retrospective-checkpoint-contract.md`:

- Self-review rationale and write-mechanism explanation: shortened; the disallowed inline retro and the self-attestation limit stay.
- `RETROSPECTIVE_QUALIFYING_GATES` note, advisory-findings closing lines, #982 dogfooding sentence and write-op allowlist explanation: shortened; every flagged and allowed class and "none block" stay.
- Verifier matching rules: dropped the per-form examples and evasion list. Owner: `scripts/loop/check-retro-tooling.mjs` and `test/loop/check-retro-tooling.test.mjs`.
- "Lifecycle reconciliation": removed (history). Owner: `RETRO-ADVISORY-NEVER-GATE`.
- Cycle scoping: dropped the `git log --merges` note and the short-sha and previously-optional history. Every MUST and fail-closed branch stays.
- `RETRO-CHECKPOINT-REPO-ROOT`: dropped the cwd-relative rationale; the resolver, fallback and vendored copy stay.
- Durable artifact: merged the `missing`/`none` notes into the marker and skip sections; removed the tests and AGENTS rows from the source table.

`skills/docs/copilot-loop-state-graph.md`:

- Overview, round-cap note and snapshot lead-in: shortened.
- `COPILOT-STATE-ACTIVE-REQUEST-WAIT`: shortened the timeline comparison; the single derivation path, newer/older rule and fail-closed `requested` stay.
- Clean convergence: shortened; the suppression condition, eligibility, `--force-rerequest-review` and `sameHeadCleanConverged` consumption stay.
- `unavailable` section: merged two paragraphs.
- Green re-request list: replaced by the owner citation and the snapshot predicates. Owners: `COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE` in `skills/copilot-pr-followup/SKILL.md` and the Copilot CI Status Contract.

`skills/docs/merge-preconditions.md`:

- Conflict-free section and resolver: shortened. Every state, bounded re-poll, fail-closed recheck and additive-only rule stays.
- Item 2: dropped the removed `--local-validation-head-sha` flag name (see the contradiction register). The `crediblyGreen` rule stays.
- Runner lock and stranded-request notes: shortened; the takeover command, never-takeover-active, withdraw guards, agent prohibition and the head-advanced conditions stay.
- Wrapper bullets: dropped the `check-retro-tooling.mjs` restatement. Owner: `RAW-GH-PR-MERGE-BYPASS` in `anti-patterns.md`.
- Server-side gate-evidence check: split the single paragraph into sub-bullets and dropped narration. Every trigger, definitive-status rule, two-job split, recovery path, `reconcile-gate-evidence-status.mjs` behavior, the unresolve residual and the branch-protection window stay.
- `MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS`, fan-out ledger exception, head-config resolution and #1172 separation: shortened; every MUST and fallback stays.
- Title markers: restructured into constructions plus exemptions; every construction, exemption and enforcement point stays. Owner of mechanics: `findBlockingTitleMarkers`.
- Size-budget gate: the populated-fields bullet now cites `GATE-COMMENT-SIZE-BUDGET-FIELDS` in `gate-review-comment-contract.md`.
- Post-merge duties (reserved, issue 2438): byte-identical.

`skills/docs/projects-queue-contract.md`:

- GraphQL query bodies for discovery, fields and items: removed. Owners: the `scripts/projects/*` helpers and the "Required GraphQL operations" table, which stays.
- Owner/project table, position semantics and error-shape prose: shortened.
- Result-shape and reorder/dry-run/archive JSON samples: replaced by the field lists. Owners: `move-queue-item.mjs`, `reorder-queue-item.mjs` and `archive-done-items.mjs` output.
- `QUEUE-ENQUEUE-REFINEMENT-GATE`: the matrix description now cites `ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR`. Every finding code, the interactive MUST, the headless MUST NOT and the park-column MUST stay.
- Setup "Why", "How queue helpers use the board", repeated fail-closed, bootstrap and configuration pointers, Usage "How to opt in", "Typical workflow" and "How dev-loop treats board state": removed as restatements. Owners: `QUEUE-NEXTUP-SOURCE` and its fail-closed rules, `QUEUE-BOARD-DEVLOOPS-RESOLUTION`, "Fail-closed behavior", "Idempotent bootstrap exception" and "Configuration shape". The board reconcile step moved into the pickup behavior list.
- "See also" issue list: reduced to the SPEC and the parent epic.

`skills/docs/artifact-authority-contract.md`:

- Intro: one paragraph. `ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR` and migration: shortened; the MUST, every finding code, the completeness-only boundary and the resolved-doc condition stay.
- Lightweight notes, settings jobs, layer list and own-mode bullets: shortened. `inputSource` is defined once in the table.
- "Distinction" subsection and non-goals: shortened to one sentence each.

`skills/docs/worktree-guidance.md`:

- Purpose, lifecycle intro, `WORKTREE-CREATE-PROVISION` fetch parenthetical, branch resolution, output and guard paragraphs: shortened. Every branch origin, the `diverged` report, fields and fail-soft rule stay.
- Provisioning `node_modules` bullet: cites `WORKTREE-DEPS-ISOLATED`.
- `WORKTREE-DEFAULT-BRANCH-GUARD`, `WORKTREE-WRONG-CHECKOUT-GUARD`, underlying-mechanism fallback, cleanup flow and `WORKTREE-NO-STASH`: shortened; every refusal, reduced-coverage path, override, fail-safe and prohibition stays. The second cleanup command block is replaced by a link to "Post-merge cleanup".
- `WORKTREE-COMMIT-MSG-GUARD` section (reserved, issue 2438): byte-identical.

`skills/docs/main-agent-contract.md`:

- Shared intro: merged the restated coordinator write boundary and states its ceilings inline, because the Claude projection strips the Pi-only "Guarded surface" section it pointed to. The line that opens the reserved verify-delegation passage stays byte-identical to origin/main, so its pointer is kept and qualified with "On Pi, see".
- Pi-only coordinator write bullet: replaced by a reference to the intro. Pi-only ceilings list: shortened.
- Sub-delegate commit bullet: dropped the `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT` history; the hook enforcement stays.
- Model tier and async dispatch: shortened; `kind: "angle"`, null tiers and the no-`subagent_wait` MUST NOT stay.
- Reserved (issue 2438), byte-identical: the intro verify-delegation passage, `COORDINATOR-VERIFY-BOUNDARY` and `MAIN-AGENT-FILING-BLOCKER-ONLY`.

`skills/docs/conductor-routing-contract.md`:

- Overview, relationship table, boundary list and non-goals: merged into one overview and one boundary list with the same issue references.
- Ownership retirement notes: stated once in "Ownership availability note".
- Scenario matrix: six tables merged into one; the noise-field non-goal moved to "Routing inputs".

`skills/docs/pr-lifecycle-contract.md`:

- Rationale line and history rows: removed.
- Title-marker constructions: cited to "Title markers" in `merge-preconditions.md`.
- `LIFECYCLE-CHANGELOG-COMPLETENESS`: shortened; the MUST, fragment path, Unreleased format, validator, exemption and release assembly stay.

Phase 3b:

`skills/docs/ui-artifact-contract.md` and `skills/docs/ui-designer-review-loop.md`:

- Report dedup claim: replaced by the implemented behavior (see the contradiction register). Enforcement: `packages/core/src/loop/ui-review-report.mjs` posts only diagnosed findings; `packages/core/src/loop/ui-review-diagnose.mjs` reads only the drive's failure feed.
- Per-artifact path list: merged into the state directory plus the five file names. `test/contracts/ui-artifact-contract.test.mjs` pins the directory literal and the five names.
- `snapshot.json`, `axe.json` and `console.json` "always emitted, never skipped, referenced from `state.json`": stated once under "Best-effort evidence files".
- Designer loop axe mapping: cites `#axejson-contract` in the artifact contract. Enforcement: `mapAxeImpactToFindingSeverity` in `scripts/loop/ui-designer-review-contract.mjs`.
- Designer loop console paragraph: cites `#consolejson-contract` for the two views of the events. The mechanical fail-closed signal and never-dropped rule stay in both files.
- Designer loop "Current minimal validation seam" lens list: merged into "Four lenses" (`UI_REVIEW_LENSES`, `validateUiReviewLensResults`, `convergeUiReviewLenses`, `convergeUiReviewRouteFindings`). Heading renamed "Entry validation seam"; no file links to either heading.
- Coverage attribution: dropped the "Reworking the dedupe key is a non-goal" aside. The `satisfied → continue` only direction stays.
- Five vision-mode path-suffix bullets: merged into one bullet with the same five pairs. Enforcement: `validateUiDesignerReviewInput`.

`skills/docs/ui-validation-contract.md`, `ui-smoke-harness.md`, `ui-e2e-scoping-step.md`, `ui-review-recipe-contract.md`:

- Validation contract glob list and the "no annotation" paragraph: replaced by a citation. Owner: [UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md) "Trigger" and "Fail-closed semantics".
- Smoke harness scoping sentences and slug explanation: owners are the scoping step and "Deterministic path contract" in the artifact contract.
- Scoping step: dropped the "So a deck- or article-only PR has a CI check" and "bloats the suite" rationale. Every job name, glob and outcome stays.
- Recipe contract: dropped the intro repetition, the optional-peer rationale, the viewport rationale, the hosting enhancement narration and the config-key test description (the test path stays in the intro). Row-drop details cite `uiReview.run.rowTeardown`.

`skills/docs/pre-pr-review-contract.md`:

- "Why this phase exists": removed (rationale).
- `PRE-PR-ONE-FRESH-REVIEWER`: dropped the "implementer rationalizes" rationale. The MUST, fresh-context and separate-agent requirements stay; `test/contracts/pre-pr-review-contract.test.mjs` pins the keywords.
- Checklist MUST: dropped "so the strong model reviews systematically".
- `PRE-PR-MODEL-CONFIG-RESOLVED`: dropped the harness-parity sentence; resolution per harness stays.
- `PRE-PR-EPHEMERAL-NO-ARTIFACTS`, `PRE-PR-BOUNDED-TWO-ROUNDS`, `PRE-PR-NOT-GATE-EVIDENCE`: dropped one rationale sentence each. `LOCAL-DEV-SELF-CHECK-NO-FANOUT` stays cited in `PRE-PR-ONE-FRESH-REVIEWER`.
- Delta mode intro: dropped the regression-cost rationale and the gate-coordinator-returned aside. Step 3 and `PRE-PUSH-DELTA-EXIT-BOUND` (issue 2447) are byte-identical.

`skills/docs/sub-issue-tree-contract.md`:

- Step 7 lean-body restatement: cites "Lean parent issue bodies" (`SUBISSUE-LEAN-BODY-NO-DUPLICATE`).
- `reorder` priority-call internals and the separate `missing`/`unexpected` paragraph: merged. Owner: `scripts/github/manage-sub-issues.mjs`.

`skills/docs/spec-authority-contract.md`:

- ADR 0061 adoption closing sentence and the #2016 section: shortened. Every edit class, the fail-closed fallback and the no-exemption statement stay.
- Act-list enforcement paragraph: shortened; all three outcome effects stay. Enforcement: `scripts/loop/judge-pass.mjs`.
- `--carry-forward-proof` sentence: cites the carry-forward bullet above it.
- Composition paragraph: cites `COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE`, `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY` and the gate sub-loop contract. The non-weakening list stays.

`skills/docs/spike-mode-contract.md`:

- Shipping-phase history and canonical-sequence sentence: removed.
- Gate profile "Why for a spike" column: removed; the advisory meaning of `required: false` stays in its cell.
- Non-goals: dropped the docs-only slice bullet and the discard bullet. Owner of the discard rule: `SPIKE-DISCARD-ZERO-MUTATION`.
- Worked example closings: cite `SPIKE-DISCARD-ZERO-MUTATION` and the promotion path. Idempotence stays in "graduate".

`skills/docs/tracker-first-loop-state.md` and `tracker-seam-contract.md`:

- §4.2 event trigger table: replaced by one sentence; "report to user" moved into the §4.1 `pr_closed_unmerged` row. §4.3 is renumbered §4.2; nothing links to it.
- §5 text diagrams: removed. Owners: §4.1 (actions) and §5.2 (transitions). "Report and stop" for `no_tracker_item` moved into §5.1.
- Snapshot notes: merged. §6 scope table: one sentence citing §1 and §3.2.
- Tracker seam: dropped rationale in the `fieldMappings`, `github-first`, board-wiring, singleton and non-goal bullets. Every method, key and non-goal topic stays.

`skills/docs/local-planning.md`:

- Step 1 payload description: cites [Validator](../skills/docs/local-planning.md#validator).
- Step 3 and step 4 size-estimate restatements: cite [Size estimate (refinement)](../skills/docs/local-planning.md#size-estimate-refinement).
- Front-matter plan↔PR link and idempotence: cite step 4, which keeps both.
- Worked-example intro and closing restatements: shortened.

`skills/docs/release-runbook.md`:

- v1.0.0 incident narration and npm-vs-Bun rationale: removed. The non-transferable approval and the npm publish tooling stay.
- Changelog assembly restatement in step 1: removed; the bump description above keeps it. The fail-closed Unreleased check stays.
- Approval refusals: shortened; every refusal class stays. Enforcement: `scripts/release/verify-release-approval.mjs` (`resolveApprovalState`, `stripNonAssertionMarkdown`, `instructsApproval`).

`skills/docs/reviewer-loop-state-graph.md`:

- Observable-versus-prior-action rationale and the guarantees meta sentence: removed.
- Detector reviewer-scope bullets: cite the `reviewerScope` values above.

`skills/docs/epic-tree-refinement-procedure.md`:

- AC/DoD matrix explanation in Phase A, Phase B and the completion table: stated once in Definitions (with the no-checklist rule). `EPIC-REFINEMENT-REQUIRED-CONTRACTS` keeps the full rule.
- "Parallelism rule", "Parallelism model" and "Fan-out rule": removed. Owners: Phase B and Phase C intros and `EPIC-REFINEMENT-SERIAL-PHASE-GATE`.
- Apply-step wrapper note and relationship table: removed. Owners: `EPIC-REFINEMENT-SCOPE-BOUNDARY` (keeps the raw fallback) and the intro.

`skills/docs/acceptance-criteria-verification.md`:

- Fork intro, P4 arm and #1951 asides in steps 3, 5 and 7: shortened. Every skip, validator command, failure reason and verdict row stays; `test/contracts/acceptance-criteria-verification-doc.test.mjs` parses the tick command and step 8.
- Step 6: cites the step 5 call. The `--pr`-alone case stays.

`skills/docs/workflow-handoff-contract.md`:

- First `sanctionedCommands` snippet: merged into the envelope schema, which now carries its comments.
- Terminal reconciliation stop rules: stated once under "Stop rules".
- #1462 relocation history: shortened to the read path and the version rule.
- Line 176, "Spawn fresh review subagents each round": now descriptive. Owner of the fresh-context-per-round obligation: `skills/docs/gate-review-sub-loop-contract.md` Phase 1 and its fan-out rules.

`skills/docs/wait-watch-procedure.md`, `decision-record-contract.md`, `entrypoint-strategies.md`, `structural-quality.md`, `cross-harness-regression-contract.md`, `copilot-ci-status-contract.md`, `docs-grill-step.md`, `ab-contrast-deslop-step.md`, `slides-story-review-loop.md`:

- Wait-watch: dropped the "conditional reads" and "startup still checks retrospective" sentences.
- Decision record: the tripwire paragraph is a trigger list; the "no longer purely advisory" history and the duplicate tracker cross-reference are removed. Enforcement: `scripts/loop/check-adr-tripwire.mjs`.
- Entrypoint strategies, structural quality, cross-harness, CI status, docs-grill, deslop and slides loop: rationale and duplicate lead-ins only; see the rows above.

### Phase 3 test changes

- `test/contracts/issue-intake-doc-contracts.test.mjs`: `assertApprovalStopGates` replaces the mermaid-edge pins. It parses the gate table rows and requires `final_approval` to route to the human approval checkpoint and `waiting_for_merge_authorization` to be a `stop`. Negative cases flip the route kind and the checkpoint text.
- `test/contracts/issue-intake-doc-contracts.test.mjs`: `assertMutationPassContract` and `assertPlanDocClosedStop` replace the pins on a duplicated sentence and a duplicated bullet. `assertPlanDocClosedStop` locates the plan-doc list item by role (closed issue, stop, user decision); a reworded positive case passes. Negative cases drop the approved-proposal input, the verification artifact and the closed-issue stop, and replace the stop with "reopen it and continue".
- `test/contracts/issue-intake-doc-contracts.test.mjs`: `assertIntakePrEditUsesWrapper` replaces the raw `gh pr edit` pin. It parses the example with `parseEditPrCliArgs` and rejects a raw `gh pr edit` at line start, indented, or inline after a backtick, parenthesis, whitespace or shell separator. Negative cases cover the raw command, an added raw line, an indented raw line, an inline code span and a missing `--repo`.
- `test/contracts/review-doc-contracts.test.mjs`: `assertReviewOwnershipExempt` replaces two sentence pins. It locates the ownership-gate sentences by role and requires all six write-capable strategies to be gated, `review` to be exempt through `STRATEGY_OWNERSHIP_GATE`, and write-capable routes to stay gated. Negative cases drop `reviewer_fixer`, remove `review` from the exempt list and add `review` to the gated list.

### Phase 3 measurements

Method: `wc -c` and `wc -w` after the phase 3a commits, compared with the start revision.

| Surface | Baseline bytes / words | Phase 3a bytes / words |
| --- | --- | --- |
| `skills/docs/public-dev-loop-contract.md` | 43,380 / 5,607 | 36,891 / 4,648 |
| `skills/docs/merge-preconditions.md` | 46,741 / 6,224 | 36,762 / 4,739 |
| `skills/docs/projects-queue-contract.md` | 51,007 / 7,233 | 34,876 / 4,949 |
| `skills/docs/gate-review-comment-contract.md` | 33,421 / 4,415 | 28,115 / 3,634 |
| `skills/docs/retrospective-checkpoint-contract.md` | 27,388 / 3,432 | 22,256 / 2,707 |
| `skills/docs/copilot-loop-state-graph.md` | 27,644 / 3,549 | 25,402 / 3,222 |
| `skills/docs/artifact-authority-contract.md` | 23,844 / 3,093 | 20,974 / 2,666 |
| `skills/docs/worktree-guidance.md` | 21,054 / 2,925 | 18,132 / 2,484 |
| `skills/docs/copilot-loop-operations.md` | 20,103 / 2,534 | 18,489 / 2,303 |
| `skills/docs/issue-intake-procedure.md` | 18,671 / 2,298 | 16,274 / 1,970 |
| `skills/docs/main-agent-contract.md` | 18,291 / 2,420 | 15,332 / 2,020 |
| `skills/docs/conductor-routing-contract.md` | 17,864 / 2,223 | 13,691 / 1,671 |
| `skills/docs/pr-lifecycle-contract.md` | 17,021 / 2,115 | 15,204 / 1,863 |
| `skills/docs/anti-patterns.md` | 9,580 / 1,196 | 8,536 / 1,036 |
| The 14 phase 3a files | 376,009 / 49,264 | 310,934 / 39,912 |
| Total canonical `skills/` Markdown prose (70 files) | 1,105,439 / 144,970 | 1,028,004 / 133,751 |
| Bundle A. Startup | 94,393 / 12,156 | 85,620 / 10,846 |
| Bundle B. Copilot follow-up | 178,374 / 22,288 | 162,179 / 19,917 |
| Bundle C. Gate coordinator | 251,582 / 33,069 | 245,232 / 32,128 |

The 14 files shrink by 17.3% (bytes). Bundle C still holds the blocked `gate-review-sub-loop-contract.md` at its baseline size.

Phase 3b and final result. Method: `wc -c` and `wc -w` after the phase 3b commits and the phase 3a review fixes, compared with the start revision. The phase 3b file row includes the phase 3b review fix to `stop-conditions.md` and excludes the phase 3a review fixes.

| Surface | Baseline bytes / words | Final bytes / words | Change (bytes) |
| --- | --- | --- | --- |
| The 32 phase 3b files | 265,964 / 35,424 | 238,900 / 31,446 | -10.2% |
| Total canonical `skills/**/*.md` (70 files) | 1,105,439 / 144,970 | 1,001,041 / 129,793 | -9.4% |
| Bundle A. Startup | 94,393 / 12,156 | 85,641 / 10,852 | -9.3% |
| Bundle B. Copilot follow-up | 178,374 / 22,288 | 161,769 / 19,863 | -9.3% |
| Bundle C. Gate coordinator | 251,582 / 33,069 | 245,322 / 32,138 | -2.5% |
| Reference: all tracked `skills/` files (80) | 1,203,872 / 154,175 | 1,099,167 / 138,959 | -8.7% |

Phase 3a review fixes per file (bytes / words, phase 3a to final): `public-dev-loop-contract.md` 36,891 / 4,648 to 36,912 / 4,654; `merge-preconditions.md` 36,762 / 4,739 to 36,846 / 4,748; `anti-patterns.md` 8,536 / 1,036 to 8,628 / 1,046; `retrospective-checkpoint-contract.md` 22,256 / 2,707 to 22,266 / 2,710; `copilot-loop-operations.md` 18,489 / 2,303 to 18,289 / 2,278; `gate-review-comment-contract.md` 28,115 / 3,634 to 28,113 / 3,634; `main-agent-contract.md` 15,332 / 2,020 to 15,428 / 2,037. The fixes restore dropped predicates and the reserved main-agent line, so five files grow slightly.

Phase 3b per file (bytes / words, before to after): `ab-contrast-deslop-step.md` 3,705 / 570 to 3,572 / 556; `acceptance-criteria-verification.md` 11,071 / 1,607 to 9,630 / 1,376; `copilot-ci-status-contract.md` 6,135 / 710 to 5,814 / 665; `cross-harness-regression-contract.md` 4,652 / 601 to 4,534 / 583; `decision-record-contract.md` 6,770 / 970 to 6,383 / 918; `docs-grill-step.md` 3,640 / 486 to 3,359 / 449; `entrypoint-strategies.md` 5,130 / 515 to 4,889 / 477; `epic-tree-refinement-procedure.md` 12,641 / 1,750 to 10,629 / 1,471; `local-planning.md` 14,958 / 2,055 to 12,526 / 1,701; `pre-pr-review-contract.md` 15,218 / 2,149 to 13,755 / 1,919; `release-runbook.md` 12,159 / 1,675 to 10,931 / 1,483; `reviewer-loop-state-graph.md` 11,826 / 1,368 to 11,059 / 1,284; `slides-story-review-loop.md` 4,899 / 695 to 4,697 / 667; `spec-authority-contract.md` 11,698 / 1,511 to 10,581 / 1,345; `spike-mode-contract.md` 13,362 / 1,801 to 12,346 / 1,628; `structural-quality.md` 2,971 / 410 to 2,793 / 380; `sub-issue-tree-contract.md` 6,271 / 869 to 5,880 / 812; `tracker-first-loop-state.md` 13,639 / 1,983 to 12,096 / 1,750; `tracker-seam-contract.md` 7,965 / 963 to 6,533 / 747; `ui-artifact-contract.md` 12,323 / 1,644 to 10,462 / 1,395; `ui-designer-review-loop.md` 15,885 / 2,176 to 12,649 / 1,690; `ui-e2e-scoping-step.md` 6,889 / 933 to 6,138 / 816; `ui-review-recipe-contract.md` 16,744 / 2,161 to 15,633 / 1,971; `ui-smoke-harness.md` 5,430 / 649 to 4,224 / 492; `ui-validation-contract.md` 5,193 / 658 to 3,841 / 473; `wait-watch-procedure.md` 7,340 / 959 to 7,177 / 937; `workflow-handoff-contract.md` 10,957 / 1,373 to 10,152 / 1,263; `stop-conditions.md` (review fix) 3,674 / 495 to 3,798 / 510. The four `unchanged` files keep their baseline size.

Phase 3 did not pursue the deeper `copilot-pr-followup` condensation carried from phase 2 (the Required-PR-comment bullets and the `COPILOT-FOLLOWUP-ROUND-CAP` sub-bullets). That item is deferred to the next cleanup pass.

Bundle A holds no phase 3b file. In phase 3b, Bundle B changed only through `entrypoint-strategies.md` and Bundle C did not change. The phase 3a review fixes then changed all three bundles slightly. In Bundle C, `gate-review-sub-loop-contract.md` (208,581 bytes) is blocked and is 85% of the bundle.

### Phase 3 contradiction register

| Files | Conflict | Owner and evidence | Resolution |
| --- | --- | --- | --- |
| `public-dev-loop-contract.md` | "Its tests are" named `packages/core/test/public-dev-loop-routing.test.mjs`, which does not exist. | The routing tests are split into `packages/core/test/public-dev-loop-routing-*.test.mjs` (`ls`). | Resolved. The contract names the glob. |
| `merge-preconditions.md` item 2 versus `copilot-ci-status-contract.md` | Item 2 still named the removed `--local-validation-head-sha` flag as the `crediblyGreen` exception. | Commit `2b6b9533` removed the flag; the CI status contract states the CLI rejects it (folded item B, #2139). | Resolved. Item 2 keeps the `crediblyGreen` rule without the flag name. |
| `main-agent-contract.md` shared intro versus its Pi-only block | The shared intro pointed to "Guarded surface and deliberate ceilings", which sits inside `<!-- pi-only -->` and is absent from `.claude/skills/docs/main-agent-contract.md`. | Generated projection (67 lines, no such section). | Resolved. The shared intro states the ceilings. The pointer line stays byte-identical to origin/main because it opens the reserved verify-delegation passage, so the preceding line qualifies it with "On Pi, see". The Pi-only list stays. |
| `issue-intake-procedure.md` Phase 4 versus `SANCTIONED_COMMANDS` | The example prescribed a raw `gh pr edit`, which `SANCTIONED_COMMANDS.forbidden` bars; `edit-pr.mjs` is the sanctioned wrapper. | `scripts/loop/sanctioned-commands.mjs`; `edit-pr.mjs --help`. | Resolved. The example uses `edit-pr.mjs`; `assertIntakePrEditUsesWrapper` parses it. |
| `retrospective-checkpoint-contract.md` cycle scoping versus `SANCTIONED_COMMANDS` | The `--merge-commit` guidance prescribed a raw `gh pr view` read, which the index bars. | `scripts/loop/sanctioned-commands.mjs`; `view-pr.mjs` returns the oid under `.pr.mergeCommit.oid` (checked against PR 2479). | Resolved. The guidance uses `view-pr.mjs`. Descriptive raw-read mentions in `merge-preconditions.md` and `copilot-loop-state-graph.md` now name the field or the wrapper. |
| `issue-intake-procedure.md` Phase 3b and `sub-issue-tree-contract.md` versus `SANCTIONED_COMMANDS.orchestratorOwned` | Child issues are created with raw `gh issue create`, while issue creation is orchestrator-owned through `create-issue.mjs`. | `main-agent-contract.md` "Sanctioned tooling" records both steps as known gaps outside its scope; `gh issue create` is not in `SANCTIONED_COMMANDS.forbidden`; #2173 tracks child-origin enforcement. | False for this pass. The "Sanctioned tooling" section of `main-agent-contract.md` already records and owns this gap. The intake text keeps the existing command. |
| Reserved table versus `main-agent-contract.md` | The issue reserves `COORDINATOR-VERIFY-DELEGATION`, but no rule has that ID. The passage is the intro verify-delegation text plus `COORDINATOR-VERIFY-BOUNDARY`; `claude-hooks-settings.test.mjs` calls it the "coordinator-verify-delegation boundary". | `git grep` finds the ID only in this ledger. | Reserved (issue 2438). Both passages are byte-identical. |
| `anti-patterns.md` `RAW-GH-PR-READY-BYPASS` versus `OPS-DRAFT-FIRST-PR` | Both describe the restore-ready exit. | `OPS-DRAFT-FIRST-PR` owns the exits; `restoreReady()` calls `readyForReview()`. | False. The texts agree; anti-patterns now cites the owner. |
| `copilot-loop-operations.md` item 7 and `merge-preconditions.md` item 10 versus `COPILOT-STATE-CARRIED-CONVERGENCE` | Both restated the carry modes. | `copilot-loop-state-graph.md` owns the rule (ADR 0090). | False. The texts agree. Operations item 7 is now a bare citation of the owner, because a partial restatement dropped the preconditions. Item 10 is unchanged. |
| `ui-artifact-contract.md` `console.json` contract and `ui-designer-review-loop.md` console section versus the ui-review stage scripts (open phase 2 item) | Both docs claimed that "the final report dedups" per-state `console.json` attribution against the captured-failures list, so an error is not posted twice. | No stage deduplicates. `packages/core/src/loop/ui-review-diagnose.mjs` consumes only the drive's captured-failures feed; `packages/core/src/loop/ui-review-report.mjs` posts only those diagnosed findings and never reads `console.json`; the vision template tells the reviewer not to re-file `console.json` errors. | Resolved. Both docs now state that the report posts only diagnosed findings, does not read `console.json`, and that no stage deduplicates. The fail-closed signal and never-dropped rule are unchanged. The same stale claim remains in the `attachPageListeners` comment in `scripts/loop/ui-review-drive.mjs`, which is outside `skills/` and out of bounds for this run; reported to the orchestrator for a follow-up. |
| `acceptance-criteria-verification.md` step 1 versus `SANCTIONED_COMMANDS` | Step 1 prescribed a raw `gh pr view ... --json closingIssuesReferences,body` read, which the index bars. | `scripts/loop/sanctioned-commands.mjs`; `view-pr.mjs --help` accepts any `--json` field list. | Resolved. Step 1 uses `view-pr.mjs` with the same fields. The remaining `gh pr view` mentions in `copilot-ci-status-contract.md` and `ui-e2e-scoping-step.md` describe helper internals and prescribe no agent call. |
| `reviewer-loop-state-graph.md` `REVIEWER-STATE-GATE-ANGLE-MAPPING` versus `extension-defaults.yaml` | The rule said the default config ships `dry`, `kiss`, `yagni`. The shipped `gates.preApproval.angles` holds 16 angles, starting with those three. | `packages/core/src/config/extension-defaults.yaml` lines 257-368. | Resolved. The rule names the shipped set and its first three angles. The MUST text and modality are unchanged; the required lens set grows to the real one, which tightens nothing the resolver did not already enforce. |
| `stop-conditions.md` `STOP-WAIT-001` versus `wait-watch-procedure.md` Claude Code paragraph | `STOP-WAIT-001` said a `waiting` state MUST be treated as a healthy wait and re-dispatched from the main session. The wait-watch procedure says that under Claude Code the agent continues pending waits inline and does not exit for a parent re-dispatch; only the Pi-only block re-dispatches from the main session. | Owner of per-harness wait behavior: `skills/docs/wait-watch-procedure.md` (Pi-only block and Claude Code paragraph). Evidence: the Claude harness has no async wake, per `END-TURN-AND-AWAIT-WAKE` (reserved, issue 2442, not edited). | Resolved. `STOP-WAIT-001` keeps its MUST and rule marker and now cites the owner: Pi re-dispatches from the main session, and Claude Code continues inline. No test pinned the old sentence; `rule-id-doc-contracts.test.mjs` checks ownership by rule ID. `check-adr-tripwire.mjs` reports no modality reversal and no removed rule. |
| `scripts/loop/ui-review-drive.mjs:124` `attachPageListeners` comment | The comment still says "The final human-facing report dedups", which the `console.json` row above shows is false. | Same evidence as the `console.json` row. | Follow-up emitted to the orchestrator for filing (runtime comment, out of scope). The script was not edited. |
| `tracker-first-loop-state.md` §3.2 versus `decision-record-contract.md` `ADR-LINKS-ONLY` | Phase 3b removed the §6 scope table, which held ADR/RFC link-only rows that `ADR-LINKS-ONLY` cites. | §3.2 keeps the ADR and RFC rows ("Link only; no decision sync"). | False. The cited linkage rows still exist in §3.2. |
| `skills/ui-review/SKILL.md` Stage 4 hosting and Non-goals versus `decideHosting` | The stage said a non-Claude harness fails closed with `{ hosting: "unavailable", reason, followup }`. The Non-goals paragraph listed "ship the GitHub-native hosted-artifact fallback" as out of scope. | `decideHosting` (`packages/core/src/loop/ui-review-report.mjs`) returns `github-gist` on a non-Claude harness. `publishGist` in `scripts/loop/ui-review-report.mjs` publishes a secret gist and sets `unavailable` only when the gist publish fails. `ui-review-recipe-contract.md` documents the gist path. | Resolved. Stage 4 now describes the gist publish and the fail-closed case when the publish yields no URL. The Non-goals paragraph no longer lists the gist fallback (draft_gate round 2). |
| `skills/ui-review/SKILL.md` teardown row-drop paragraph versus `dropRows` | The paragraph said the drive does not tag the rows it creates and that the CLI row-drop seam is not wired, so a confirmed manifest always fails closed. | `packages/core/src/loop/ui-review-drive.mjs` stamps each manifest row with the drive-session id. `dropRows` and `sessionFromManifest` in `scripts/loop/ui-review-teardown.mjs` run `uiReview.run.rowTeardown.deleteCommand` for the single tagged session. They fail closed on an untagged or mixed-session manifest, a missing `deleteCommand` or a nonzero exit. With no manifest, `packages/core/src/loop/ui-review-teardown.mjs` drops nothing and reports "may remain (untagged)". `ui-review-recipe-contract.md` documents the wired drop. | Resolved (draft_gate round 2). The paragraph now states the tagged drop and each fail-closed case. `MUST NOT guess` and its modality stay. |
| `skills/ui-review/SKILL.md` teardown invocation versus `scripts/loop/ui-review-teardown.mjs --help` | The invocation omitted `--report-result`, and the destructive-step list omitted the confirmation-gated gist prune. | The CLI accepts `--report-result` and prunes the recorded gist only with `--confirm` (`packages/core/src/loop/ui-review-teardown.mjs` step 4). `ui-review-recipe-contract.md` Stage 5 documents the prune. | Resolved (draft_gate round 2 sweep). The invocation lists the flag, and the destructive-step list names the gist prune. |
| `epic-tree-refinement-procedure.md` intro versus `issue-intake-procedure.md` Phase 3b | The intro said Phase 3b "creates a new tree and calls this procedure". On main the related-docs list carried the same false claim, and the removed "Relationship to other procedures" table corrected it. | Owner: `issue-intake-procedure.md` Phase 3b. Phase 3b creates the tree with `manage-sub-issues.mjs` and never invokes the refinement procedure. Its closing paragraph states that the refinement procedure owns refinement of an existing tree and that Phase 3b creates the tree. | Resolved (Copilot round 1). The intro now says Phase 3b creates a new tree and this procedure refines it afterwards. A sweep of the other removed relationship, see-also and cross-reference sections (`conductor-routing-contract.md`, `copilot-loop-operations.md`, `issue-intake-procedure.md`, `pr-lifecycle-contract.md`, `artifact-authority-contract.md`, `spike-mode-contract.md`) found no other false handoff. |

Cumulative cross-file review. All 42 `skills/docs/` files changed in phases 3a and 3b, plus the phase 2 files, were checked against each other and against their implementation owners for these classes: rule restatements that disagree with the owner, stale commands or flags, raw `gh` reads that `SANCTIONED_COMMANDS` bars, config defaults stated in prose, and inbound anchors. Checked pairs include the UI doc family against the stage scripts and `ui-vision-review.md`; the scoping step, validation contract and smoke harness against `ui-e2e-scoping.mjs`; `spike-mode-contract.md` against `gates.spike` and `local-planning.md` anchors; `docs-grill-step.md` and `reviewer-loop-state-graph.md` against `gates.preApproval.angles`; `agent-stall-detection.md` against `workflow.stallDetection`; `validation-policy.md` against `copilot-ci-status-contract.md`; `wait-watch-procedure.md` against `copilot-loop-operations.md` timeouts, `stop-conditions.md` and `anti-patterns.md`; and `acceptance-criteria-verification.md` against `SANCTIONED_COMMANDS`. The rows above record every conflict found. No other contradiction was found.

### Per-phase semantic review record

Each phase had one semantic review. Each reviewer was a fresh-context, independent, review-only general-purpose agent on model `opus`.

| Phase | Reviewed range | Reviewer | Findings (by severity) | Fix commit | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `6202c2ed..7d3e583d` | Pre-PR reviewer, `pre-pr-review-contract.md` full mode | 0 high, 0 medium, 0 low, 2 nit. Nit 1: historical rows said "see current-run". Nit 2: previous-run H2 headings could be H3. | `ef5634e2` fixed nit 1. Nit 2 was accepted as is, because it is heading-only and the intro already scopes it. | No blocking findings. No loosened obligation. |
| 2 | `ef5634e2..702829c7` | Semantic reviewer | 0 high, 1 medium, 3 low, 6 nit. Medium: a vacuous negative case in the planning-doc lightweight test. Low: a dangling re-baseline reference in copilot-pr-followup; the loop-grill credential-capture prune sentence was dropped; the ui-review sort order and dedup statements were dropped. | `7b778c4e`. The dedup sentence was not restored, because no code backs it. Phase 3b resolved it later. | No weakened MUST or MUST NOT. No removed marker or anchor. The reviewer judged phase 2 largely cosmetic, at about 1% of total prose. That judgment was recorded, and deeper condensation was carried forward. |
| 3a | `7b778c4e..4b0d0db9` | Semantic reviewer | 0 high, 1 medium, 4 low, 5 nit. Medium: the tracker-backed "do not read or update a duplicate phase doc" rule lost its home. Low: title-marker case-insensitivity and the underscore exemption; the `RAW-GH-PR-READY-BYPASS` predicate; apostrophe mangling from perl edits ("loop.s", "envelope.s"); preconditions of the carried-convergence restatement. | `7b4502da` | No weakened MUST or MUST NOT after the fixes. Reserved passages are byte-identical. |
| 3b | `4b0d0db9..0fd258e6` | Semantic reviewer | 0 high, 1 medium, 1 low, 1 nit. Medium: the `STOP-WAIT-001` contradiction was marked reserved without an owner. Low: the stale dedup comment in `scripts/loop/ui-review-drive.mjs` was untracked. Nit: a missing trace line for `workflow-handoff-contract.md:176`. | `43ff228b`. `STOP-WAIT-001` now follows its owner, `wait-watch-procedure.md`. The `ui-review-drive.mjs` comment is recorded as a follow-up emitted to the orchestrator. | No weakened obligation. The measurements reproduce. |

The PR gate rounds (draft_gate rounds 1 and 2) are recorded on the PR as gate verdict comments. Their durable ledgers are under `tmp/gate-findings/`.

## Previous run — 2026-09-19 (issue 2236)

### Contradiction-resolution pass — current authority

The user's clarification supersedes the earlier decision to leave pre-existing conflicts merely documented. The matrix below is the current conflict disposition; earlier phase records are historical. Final runtime-correction head reviewed for this reconciliation: `b6f49bd279f52d397a4515ce36c0a48b32c3b117`; refreshed spec digest `sha256:53b8dc344056f2710640c67b074d0b597b81b4a26ad42503b0cc79962f84f611`, supplied content identity `sha256:3ef2415652b1a4816f19719f8cb9eaf80a5587d0c0ec454e3c8f0aba773d5852`. This identity precedes the final C03 hook-description/status reconciliation commit; its own validation is reported separately. Phase-1/2 prose can be amended.

The subsequent authorization on issue2236/PR2237 permits narrow C17 and C21 runtime corrections. C17 is committed at `965d618cd179f370340d8f0ee2341257ae46659e`; C21 is committed at `b6f49bd279f52d397a4515ce36c0a48b32c3b117`. Exact committed-tree validation passed for both corrections. Unrelated runtime, dependencies and schema remain excluded.

Current classification: **18 resolved, four false conflicts (distinct scope or already reconciled); 22 candidates total, zero open.** Fresh Sol review findings for C17 and C21 are corrected and committed. Exact C21 committed-tree validation passed **9,388 tests across 391 files, zero skips/failures**, plus docs, workflows, **92 generated assets** and diff checks. Final cumulative Sol review found the remaining C03 hook descriptions and stale status; this reconciliation corrects those two findings. No issue closure, lifecycle gate, current-head CI or merge clearance is claimed. “Resolved” means the competing instruction was corrected using governing authority, not that the prose test suite proves agent compliance. Canonical sources were corrected before generating Claude projections. Pi/Codex consume the same canonical source; no harness-specific behavior changed.

Final reconciliation precommit validation: **425 tests across five hook/projection/gate suites, zero skips/failures**, docs, workflows, **92-asset parity** and diff checks pass. Log directory: `/private/tmp`; file: `2237-final-focused.log`. Exact reconciliation-commit full verification is required before push and recorded by the completing run; these local checks do not supply lifecycle or CI evidence.

| ID / competing instructions at baseline | Canonical owner, callers and authority | Classification / resolution / executable evidence |
| --- | --- | --- |
| C01 Ready: intake Phase 4 prescribes `gh pr ready <pr-number> --repo <resolved-repo>`; `RAW-GH-PR-READY-BYPASS` says “never call `gh pr ready` directly”. | `skills/docs/anti-patterns.md` owns the prohibition; `issue-intake-procedure.md` is the caller; `scripts/github/ready-for-review.mjs`, sanctioned-command map and ready-wrapper tests enforce gate/thread/size checks. | **Resolved.** Intake now calls the existing wrapper with repo/PR identity. The existing intake contract test parses the actual example through `parseReadyForReviewCliArgs` and rejects raw ready commands; ready-wrapper tests exercise refusals. |
| C02 Human-only merge: merge owner says “the wrapper refuses outright” but later tells the human to merge “through the sanctioned wrapper”. | `skills/docs/merge-preconditions.md`; ADR0007 and ADR0050 describe the human click under `humanMergeOnly`; `scripts/github/merge-pr.mjs` refuses unconditionally before merge work. Intake/follow-up consume this owner. | **Resolved.** Owner names human GitHub action and explicitly says the wrapper also refuses a human invocation. Agent wrapper-only rule is scoped to agent-executed merges in the owner and anti-pattern caller. Existing `merge-pr.test.mjs` proves refusal despite fresh approval and zero merge subprocesses. No config bypass added. |
| C03 Draft head: lifecycle core says “A PR MUST clear the draft-stage gate for the current head before Copilot review may be requested”; its post-draft rule says “non-draft PRs do not need per-head draft_gate evidence”. Anti-pattern, gate-sub-loop and hook summaries also claimed both gates current-head. | `GATE-COMMENT-DRAFT-REQUIREMENTS` in `gate-review-comment-contract.md` owns the one-time transition; lifecycle, anti-pattern, sub-loop and hook descriptions consume it. `evaluatePrGateCoordination` and `buildPreMergeGateCheck` distinguish draft from non-draft. | **Resolved; final Sol finding corrected.** Current-head draft clearance applies when leaving draft; non-draft requests/re-requests retain the transition record. Shared hook source and hand-authored Bash hook now cite the owner and describe unconditional raw-merge refusal; the bundle is regenerated. Structural coverage rejects the old current-head draft condition. Coordination tests contrast stale draft refusal with non-draft advancement; real merge-evidence tests accept an older draft record and reject stale pre-approval. Runtime gate behavior is unchanged. |
| C04 Standing authorization: merge owner/ADR0050 require “clean draft_gate and pre_approval_gate verdicts at the current head”; general lifecycle retains an older draft transition record. | ADR0050 explicitly records the operator's stronger condition for standing authorization; `merge-preconditions.md` owns authorization, while lifecycle/evidence describe gate readiness. `merge-pr.mjs` consumes an asserted `--standing-authorization`, not an independently derived grant. | **False — different scope.** Retained the accepted authorization condition and explicitly distinguished it from detector acceptance. An older draft record can satisfy lifecycle without satisfying that standing grant; use fresh per-scope approval when its condition is unmet, never re-post a prohibited non-draft draft gate. Existing wrapper tests cover standing versus fresh approval and the config-alone refusal. Human authorization truth remains an agent obligation. |
| C05 Retro NONE: `RETRO-ABSENT-NEVER-BLOCKS` says absence is “the only case” resolving NONE; the same owner's state table/example maps `{ "state": "none" }` to NONE. | `retrospective-checkpoint-contract.md`; `resolveCheckpointStateFromArtifact`, checkpoint writer and startup resolver agree on explicit none. | **Resolved.** Both absence and explicit none resolve NONE; malformed presence still fails closed. Extended the existing core test to run both inputs with recency true/false, rejecting the interpretation that recency can arm either. |
| C06 Retro path: the absence paragraph says “per-working-copy” and “a brand-new worktree has never seen a checkpoint”; `RETRO-CHECKPOINT-REPO-ROOT` says “once per repo, not once per worktree”. | Same owner; checkpoint CLI/startup and Pi extension use main-root resolution. Dev-loop entrypoint already names that shared path. | **Resolved.** Removed per-copy reset claims in paragraph and state table. Existing checkpoint integration tests create a linked worktree and prove writes/reads resolve to its main root. A fresh clone is distinct from a new linked worktree. |
| C07 Retro arming: cycle section says “There is no write-time arming step”; durable-format section documents the extension's `required` writer. | Same owner separates read-time recency of complete/skipped records from the Pi extension's best-effort completion-message writer; pure resolver treats required/missing as pending independently of recency. | **False — separate triggers, overbroad summary clarified.** Recency requires no re-arming of an existing discharge; it does not eliminate the explicit writer or arm absent/none. Existing state-machine tests cover required/missing and recency; C05 adds their negative boundary. |
| C08 Judge/write ordering: dev-loop says “after the durable ledger is written ... dispatch the dedicated judge”; Phase 3.5 requires judge verdicts before that durable write, and follow-up step 5 already follows it. | `GATE-EXEC-JUDGE-PHASE` in `gate-review-sub-loop-contract.md`; dev-loop and follow-up are callers. `write-gate-findings-log --judge-verdict` consumes an existing file; `judge-pass` consumes current spec/head verdicts and filters the act list. | **Resolved.** Dev-loop now links Phase 3.5 and orders fan-in → judge artifacts → durable log → visible verdict, retaining spec identities and act-only fixer bridge. Existing spec-authority command tests, writer verdict ingestion and judge-pass stale/invalid/partial-verdict refusals exercise the seams; actual agent scheduling needs semantic review. |
| C09 Preflight/isolation: local skill says other strategies “may edit code from any checkout”; worktree owner/entrypoint require isolation. | `worktree-guidance.md` owns isolation; local skill owns only its strategy-specific preflight. Public routing's isolated-bootstrap handoff is a caller. `pre-flight-gate.mjs` checks local branch/dependency isolation; other strategies do not call that gate. | **Resolved.** Explicitly separated preflight applicability from continuing isolation duties, with an owner link. Existing preflight tests cover branch/core-resolution refusal; intake contracts retain isolated follow-up handoff. No new requirement to give read-only reviewers separate worktrees. |
| C10 Phase docs: local planning says “Otherwise ... create or update the durable phase doc” after excluding only lightweight; its earlier tracker rule forbids duplication. | `ARTIFACT-TRACKER-FIRST-NO-DUP` in `artifact-authority-contract.md`; local bootstrap/planning and tracker-spec resolver are consumers. | **Resolved.** Planning now explicitly routes tracker changes to the issue and creates phase docs only for phase-doc-backed sessions. Existing artifact-authority/local-planning structural tests and tracker-spec/envelope tests retain source selection; agent file-writing discipline remains semantic review. |
| C11 Grill synthesis/count: count rule says synthesize into `## Acceptance criteria` and calls per-angle dispatch a “default”; Step 4 requires `## AC / DoD matrix`, while ADR0072 makes grouped dispatch default. | `loop-grill/SKILL.md` Step 4 owns write-back; `detectIssueRefinementArtifact` consumes the matrix and derives PR checklists. Emitter/sentinel owners distinguish emitted units from angles. | **Resolved.** Count rule now sends outcome/evidence to the matrix and validates per-angle plus grouped modes, with one sentinel per emitted unit. Existing count-unit structural checks, matrix detector negatives and emitter cap/split tests retain the executable distinctions. `resolveFanoutGroups` no longer falsely described as a sentinel writer. |
| C12 Handoff: local skill claims the derivation owner contains “a mandatory 8-step checklist”; that owner defines `buildDevLoopHandoffEnvelope()` with resolver-derived `requiredReads`/`nextAction`. | `workflow-handoff-contract.md` owns envelope derivation, `pr-lifecycle-contract.md` owns lifecycle sequence; local delegation consumes both. | **Resolved.** Removed stale checklist attribution and linked both owners. Replaced the existing sentence pin with section-scoped owner-link/field checks; real handoff-envelope tests prove derived fields and unknown-strategy refusal. |
| C13 Queue rename: `QUEUE-COLUMN-NO-REMOVE` forbids renaming canonical columns; authorized `--repair-rename` “Renames recognized equivalent columns to the canonical standard names”. | `projects-queue-contract.md`; `ensure-queue-board.mjs` restore operation and rename tests distinguish canonical target from drifted source. | **False — opposite directions.** Kept prohibition and repair, clarified that repair restores names and default repair does not rename. Removed the example's apparent permission to introduce drift. Existing tests prove no rename by default, explicit restoration and conflict/no-mutation behavior. |
| C14 Release/main: AGENTS says “No direct commits to main”; release runbook says “a sanctioned release commits and pushes with DEVLOOPS_ALLOW_MAIN=1”, supported by worktree guard prose. | Accepted ADR0044 explicitly sanctions the override for a deliberate release/reconcile commit/push. `WORKTREE-DEFAULT-BRANCH-GUARD` and release runbook implement that decision; the generic AGENTS summary omitted its exception. | **Resolved after fresh Sol review.** AGENTS now references ADR0044 and the narrow release/reconcile exception. Agents may prepare the release commit on main; stable tag/publish approval remains operator-owned. Existing guard tests prove ordinary main commit/push refusal and explicit override acceptance. No release action or new exception was authorized by this prose correction. |
| C15 Tree verification: epic completion says `verify --ordered` “exits 0”; sub-issue owner says mismatches also exit 0 and report JSON. | `sub-issue-tree-contract.md`; `computeVerifyResult`/`manage-sub-issues.mjs` distinguish command success (`ok`) from matched contents/order (`verified`). Epic refinement consumes them. | **Resolved.** Canonical owner and epic completion now require exit 0 AND `verified: true`; `ok: true` alone is insufficient. Existing CLI tests execute missing/unexpected and order-mismatch cases, assert exit 0/ok true/verified false, plus matching positives. |
| C16 Stash enforcement: registry note says “no mechanical check”; Claude Bash hook explicitly denies stash. | `WORKTREE-NO-STASH` in worktree owner governs all agents; `required-rules.json` reports enforcement; Claude hook is an additional harness-specific guard. | **Resolved.** Only registry prose note changed; enforcement remains `agent` across harnesses, with Claude mechanical support named. Existing managed/unmanaged config-variant hook tests prove the actual boundary; no Pi/Codex hook guarantee invented and no schema changed. |
| C17 Split-tail provenance: ADR0072 requires the original resolved group on every split sub-unit; the emitter discarded it on a one-angle tail. | ADR0072 and `GATE-EXEC-FANOUT-DISPATCH-EMIT`; `resolveFanoutDispatch` → `expandDispatchUnits` → emitter output/keyed plan → `verifyEmitPlanProvenance`/ledger. Narrow runtime correction explicitly authorized on issue2236/PR2237. | **Resolved; fresh Sol finding corrected.** Emission carries the already-resolved `unit.group`; the ledger guard accepts a grouped one-angle tail only after a same-group full-cap sibling, retaining non-empty groups on multi-angle units and exact group/angle/identity correspondence. Real-module configured and auto-chunk fixtures reproduce the old loss, then preserve the original group through stdout, persisted plan and ledger. Negatives reject dropped/changed tail groups, arbitrary standalone grouped singletons, reordered/non-cap siblings, mixed identities within a unit, reused identities across split units and null multi-angle groups. Existing non-split, multi-angle split, carry and no-plan guards remain unchanged. |
| C18 “Disputed coverage”: historical ledger reports unconditional foreign-angle refusal and no-mandatory gates “unaffected”; current Phase 3 already says foreign angles warn when `rejectForeignAngles: false` and supplied provenance is checked without mandatory angles. | `GATE-EXEC-ANGLE-COVERAGE`, Phase 3 and `checkFanoutAngleCoverage` agree; writer, verdict and merge-evidence readers consume the shared resolver. | **False — already reconciled in Phase 1.** No active competing instruction remains. Current matrix closes the stale limitation rather than changing policy. Writer tests cover false warning mode, disabled mandatory angles, dynamic pool and mandatory-proof absence; provenance/coverage suites reject foreign angles by default. |
| C19 Intake approval: intake example runs `gh pr review ... --approve`; `GATE-REVIEW-SUBMIT-MODES` restricts approve to the interactive review choice/token, with lifecycle gates always COMMENT. | `gate-review-comment-contract.md` owns review submission; review skill and verdict helper enforce it; intake is neither an interactive review nor approval authority. | **Resolved.** Removed raw approval example and linked the submission owner/boundary. Intake test rejects the raw approval command; existing verdict CLI/runtime tests reject headless or unconfirmed approval. No human approval was synthesized. |
| C20 Retro ready allowlist: retro prose says raw ready “has no internal wrapper today”; sanctioned map and C01 owner name `ready-for-review.mjs`. | Retro owner describes `check-retro-tooling.mjs` classification; anti-pattern owner defines permitted calls. Verifier intentionally still classifies ready as an allowed write operation. | **Resolved.** Corrected missing-wrapper claim and explicitly distinguished legacy advisory classification from permission. Existing verifier tests preserve classification, while ready-wrapper tests enforce workflow guards. No runtime allowlist changed or new exception granted. |
| C21 Context completion marker: gate-context owner says “A mid-set write failure must never leave a complete-looking context pointing at missing or stale siblings”; writer preserved the old JSON marker whenever prefix bytes were unchanged. | Gate-sub-loop “Write ordering”; shared `writeGateContext` serves the CLI and builder; `readGateContext`, dispatch emission and reviewer `--context-path` consume its marker. Narrow runtime correction explicitly authorized on issue2236/PR2237. | **Resolved; fresh Sol finding corrected.** Required write failures remove the marker, including same-prefix volatile/plan failures. Sol found that scoped briefings and full diffs still overwrote references before validation/refusal. Both callers now prepare diffs without persistence; the writer validates/refuses before any referenced write, invalidates changed stable bytes first and publishes JSON last. Unchanged stable reruns retain the marker, optional diff/variant fallback remains, and landed siblings, sentinels and other contexts survive. Real-module tests prove reference preservation on plan/volatile/live-sentinel refusal, marker absence after write failure, unchanged-prefix/full-diff invalidation, reader refusal and successful repair. |
| C22 CI opt-out: lifecycle says `gates.preApproval.requireCi: false` opts “final approval / merge readiness” out; merge owner and wrapper require current-head green CI unconditionally. | PR lifecycle owns configurable gate entry; `merge-preconditions.md`/`evaluateMergePreconditions` own actual merge. | **Resolved.** Lifecycle now scopes the opt-out to its gate and explicitly links the separate merge precondition. Existing gate-coordination opt-out tests and merge-wrapper CI refusal cover both sides; no knob or merge permission changed. |

Semantic trace: actor/permission changes correct stale caller descriptions only; no gate exemption, new approval, runtime fallback or changed refusal is introduced. Identity-bearing CLI flags remain intact. Ready, merge, judge, retrospective and tree-verification consumers retain fail-closed behavior. Standing authorization remains stronger than generic gate readiness. Read-only review shares the conductor worktree, while mutating routes retain isolation. Canonical regeneration provides the Claude counterpart rather than a separately edited policy copy.

Precommit validation: `bun scripts/run-bun-test.mjs` on six directly affected contract/core suites: **89 pass, zero skip/fail**; on 13 executable-seam suites (ready, merge, gate coordination, checkpoint, judge, preflight, matrix, envelope, queue repair, sub-issues, hooks, findings writer, emitter): **786 pass, zero skip/fail**. `bun run test:doc-guard`: **356 pass, one skip, zero fail** (packaging registry smoke is not counted as executed); docs, workflows, 92-asset parity and diff whitespace checks pass. Logs: `/private/tmp/2237-contradiction-{initial-tests,seams,docguard,docs,assets}.log`. At that checkpoint, the source-only C21 reproduction was separate evidence of an unresolved defect, not a passing acceptance check; the later correction is recorded below.

Fresh cumulative Sol precommit review found one High: C14 had missed accepted ADR0044. Corrected AGENTS and this matrix under that authority; focused guard suites pass **93 tests**. Final restricted verification failed **52 tests** (9322 pass, two skips), including localhost/Git fixture restrictions; it is not reported as green. The unrestricted rerun removed those environment failures but exposed **22 create-PR test failures** (9354 pass, zero skips): the prior Phase-3 commit's rewritten `init-phase.mjs` comments retained forbidden issue-number references. Removed only those two incidental references; comment-discipline/initializer checks pass **12 tests**, behavior unchanged. Because that guard compares committed HEAD, the coordinator authorized commit before final exact-committed-tree verification, with push conditional on full verify/docs/workflows/assets passing. No additional Sol round is required for this deterministic validation correction. Logs use `/private/tmp/2237-contradiction-{correction-tests,comment-correction,final-verify,final-verify-unrestricted}.log`. This is the precommit checkpoint; exact-commit final validation and remote identity are reported by the completing run. No lifecycle gate or issue completion is claimed.

### C17 runtime correction checkpoint (historical precommit evidence)

Authorized baseline `ce8cb66c87ba64eaa53eb7edc9ead46e25f53eeb`; current content identity `sha256:092d09feb66bee67c7eac5cbe0311fbf1b01e5e8f8a7ed24c6905de43fe3fbe2`. ADR0072 already assigns the original resolved unit's name to every split sub-unit. `expandDispatchUnits` implements that correctly; the final emitter projection reclassified a one-angle tail as ungrouped, and the provenance writer enforced the same incorrect shape. The correction preserves the expansion's `group` and allows that shape at the writer guard. Scope, ordering, cap, concurrency, normal singleton/multi-angle behavior, carry proof, key identity and no-plan paths are unchanged. Canonical owner/caller prose explicitly distinguishes an unsplit singleton from a split tail; Claude projections are regenerated.

The two new real-module cases first failed on the old emitter's null tail group, then passed for configured and auto-chunk groups through config resolution, context generation, CLI stdout, the keyed plan and actual ledger writing. Fresh Sol review found one High: the initial consumer exception also accepted arbitrary grouped singletons. The corrected shared guard requires a preceding same-group full-cap sibling; added matching-plan/provenance negatives reject an arbitrary standalone singleton, a wrong tail group, reversed order and an undersized sibling. Null tail-plan provenance mismatch and the existing identity/group negatives also refuse. Corrected focused emitter/writer/fan-in/config suites: **1020 pass, zero skip/fail**; prompt-layout, carry-routing and generated-asset contracts: **49 pass, zero skip/fail**. Docs/link/rule/ADR/changelog checks, generator parity (**92 assets**) and whitespace checks pass. Logs: `/private/tmp/2237-c17-{red,green,corrected-focused,contracts,docs,assets}.log`. Per the coordinator's direction, no repeat review is run; exact-committed-tree full verification and push are the remaining completion steps for this correction. C21, live harness execution, lifecycle gates and final issue completion are not claimed.

Completion: C17 committed at `965d618cd179f370340d8f0ee2341257ae46659e`, pushed and remote-verified. Its exact committed tree passed **9,378 tests across 391 files, zero skips/failures**, docs, workflows, **92-asset parity** and diff checks. Logs: `/private/tmp/2237-c17-final-{verify,assets}.log`. The precommit tail above describes its original checkpoint, not outstanding work.

### C21 runtime correction checkpoint (historical precommit evidence)

Authorized baseline `965d618cd179f370340d8f0ee2341257ae46659e`. The shared writer previously kept the JSON marker whenever the prefix was unchanged, even if a later volatile/plan overwrite failed. The correction removes the marker after a failed required write. Fresh Sol review found one High: scoped briefings and full diffs were still persisted before validation/refusal, so the prior marker could reference new bytes after a rejected rebuild. The corrected builder and CLI prepare diffs without writing them; scoped rendering also stays in memory. Validation/refusal precedes referenced writes, changed stable bytes invalidate the marker first, and JSON is published last. Unchanged stable reruns retain the marker. Optional diff failure rebuilds pointers/hash/plan without the failed path; optional variant failure downgrades its scope, preserving existing fallback semantics. Cleanup retains landed siblings and unrelated history, and reports both errors if cleanup itself fails. This is handled-write recovery, not a concurrent-writer transaction or process-crash guarantee.

The two real-module same-prefix regressions first failed on the old readable marker (**296 pass, two expected failures**), then passed. They check both volatile and plan EISDIR failures, original error/path, `readGateContext` absence, the real reviewer guard's refusal, in-place marker retention on success, other head/gate contexts and sentinel preservation, and repair/rebuild. Sol-correction tests retain scoped briefings and full diff bytes on malformed plan/volatile input and live-sentinel refusal, remove the marker after a later write failure, preserve the CLI's prior diff on late validation failure, and invalidate a marker when filtering hides a full-diff change from the prefix. Existing optional fallback, changed-prefix failure, retirement/rebuild, prefix-hash and prior-disposition tests pass. Corrected focused writer/consumer/emitter/retirement suites: **461 pass, zero skip/fail**; coupled contract/generated-asset suites: **25 pass, zero skip/fail**. Docs/link/rule/ADR/changelog checks, generated-asset parity (**92 assets**) and whitespace checks pass. Logs: `/private/tmp/2237-c21-{red,green,corrected-focused,corrected-contracts,docs,assets}.log`. Canonical write-order prose and its Claude projection are updated. Per coordinator direction, no repeat review is run; final committed-tree verification and push remain pending. No live harness execution, lifecycle gate or issue completion is claimed.

Completion: C21 committed at `b6f49bd279f52d397a4515ce36c0a48b32c3b117`, pushed and remote-verified. Its exact committed tree passed **9,388 tests across 391 files, zero skips/failures**, docs, workflows, **92-asset parity** and diff checks. Logs: `/private/tmp/2237-c21-final-{verify,assets}.log`. The precommit tail above describes its original checkpoint, not outstanding work. Both runtime corrections are included in the current 18-resolved/four-false matrix; live harness, lifecycle, CI and merge clearance remain unclaimed.

### Previous phase completion record (historical)

The user selected A for all three phases on `issue-2236`/PR2237; B is now a pinned read-only reference, not an equivalent-scope competition. Issue2236 records this direction and the narrow runtime exception tracked separately by issue2273. Phase 1 is accepted and complete at `b8bfe5b077f917e22330455f311540fd90e42b4d` for prose inspection, condensation, relevant test audit, independent review and local validation. Phase 2 is complete at `2aa6cc4468ee631a43de96fa31ae4ad2c7ac55ba` under the same bounded review cadence, with its trace below; Phase 3 inspection/cleanup and local validation are complete, with unresolved policy conflicts recorded. The inventory now has 36 changed, 32 unchanged, six non-prose and three blocked rows; none remain pending. Blocked rows were inspected but contain unresolved policy conflicts, not completed policy repairs. This is not whole-issue completion or lifecycle-gate clearance.

### Historical Phase-3 transition — bookkeeping only

Phase 2 completed all six entrypoint dispositions: `dev-loop`, `local-implementation`, `loop-grill`, `review` and `ui-review` changed; `final-approval` was inspected and retained unchanged. Their obligation traces, coupled-test audit, regenerated projections, Sol review correction and final local validation are recorded below. The earlier paused Phase-2 candidate is historical, not outstanding work.

At that transition, Phase 3 became active, but the transition changed only this ledger and the PR description; it does not start Phase-3 source/projection/test edits or mark pending inventory rows reviewed. All remaining shared docs, references, templates and script comments/help, applicable coupled-test audit, cumulative measurement/verification, independent full-scope A review and bounded read-only B-reference review remain to be completed. The Phase-2 discrepancies and semantic/live-harness limits below remain visible; this bookkeeping chooses no new policy. B stays unchanged, no new runtime change is authorized, PR2237 stays draft and unmerged, and normal final lifecycle gates and explicit human merge approval remain required.

### Historical phase transition — bookkeeping only

The Phase-1 full-owner completion record below is the accepted phase boundary. Earlier per-slice status, validation and parked-checkpoint statements are historical snapshots, not current unresolved work or current-head clearance. The ambiguity register below now separates resolved Phase-1 items from remaining limitations.

Phase 2 covers the six routed entrypoints `dev-loop`, `final-approval`, `local-implementation`, `loop-grill`, `review` and `ui-review`, their generated projections and coupled contracts/tests. At this transition, an initial uncommitted candidate for five entrypoints and two tests was paused, preserved byte-for-byte and excluded from the separate bookkeeping commit. That checkpoint claimed no Phase-2 completion, independent review, commit or validation clearance. Bookkeeping completed before Phase-2 edits resumed. Phase 3, cumulative finalization, lifecycle gates and explicit human merge approval remain outstanding; PR2237 stays draft and unmerged.

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

### Historical Phase-1 slice: keyed all-carried plan (issue2273)

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

The brittle-test audit replaces gate-heading pins with field-scoped Markdown selection; renamed headings pass and missing/sibling fields cannot supply the selected gate's obligations. Phase selection tolerates renamed labels and wrapping while command-bound flags, ownership links, generated parity and the declared verbatim dispatch payload remain checked. Known-findings routing still requires the full-body capture helper and disposition owner. Carry-default and known-findings-placement sentence pins were removed in favor of those routing checks, existing carry/prompt behavior tests and this semantic review: the conductor must run the carry seam by default, preserve refusal/full-fallback behavior, and deliver all-author open/resolved known findings by reference through `--known-findings`, never appended to the compact `dispatchPrompt`. Keyword matching cannot establish those agent decisions. Polling bans, round-cap stops, conflict authorization and human merge approval were compared against the unchanged owner text; request/watch tests cover only their executable portions.

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

Known limits remain explicit. ADR0064 resolves the historical clean-only prose in favor of evidenced findings-present carry; the active owners no longer assert a competing clean-only rule. Issue2273's accepted all-carried path requires a keyed emitted plan and complete resolver proof: empty completed-only resumes still refuse, with no no-plan exemption. Runtime current-head context rebuilding remains distinct from offline lineage composition under ADR0070. The one-angle split-tail `group` discrepancy and disputed coverage wording remain unresolved. Fixer identity was resolved in the preceding owner audit: a fingerprint accompanies, never replaces, the required thread id. Prompt recovery still requires actual redispatch, not just rewriting emission records.

Counts use `wc -w -c`, including code examples/frontmatter, not tokens. From this candidate's starting HEAD to the current source pair: 35,637 / 275,856 → 32,082 / 251,837 words/bytes (3,555 / 24,019 removed). The corresponding regenerated Claude pair is 31,888 / 250,848. All 77 tracked skills files are 141,042 / 1,104,704. The same conservative 24-file source/Pi normal-draft set defined below is 78,265 / 606,699; no removed text was transferred to an additional read. These are static surfaces, not measured live loading or cache savings.

Final validation after Sol's test correction: the focused key suite passed three tests, the complete contract/doc-guard run passed 357 without skips or failures, and full `bun run verify` passed 9,376 tests across 391 files without skips or failures, plus docs and workflows. The earlier ten focused runtime suites passed 754 tests without skips or failures. Canonical generation, the 92-asset parity check and `git diff --check` passed. Logs use the private prefix `/private/tmp/2237-phase1-complete-`; the final full run is `verify.log`. Phase 1 was completed under the selected one-review cadence and committed as `b8bfe5b077f917e22330455f311540fd90e42b4d`; phases 2/3 were pending at that checkpoint. These are local working-tree results, not current-head lifecycle evidence or CI clearance.

### Phase 2: routed-entrypoint completion

All six Phase-2 entrypoints were read end to end before edits, with their startup `requiredReads`, handoff derivation, routed callers, referenced owner boundaries and applicable tests. The candidate began at the accepted Phase-1 head `b8bfe5b077f917e22330455f311540fd90e42b4d`. The separate transition commit `3ce3f6196dad4f8c874f55b084434b86d4b4af0e` preserved all twelve initial Phase-2 dirty files byte-for-byte and unstaged. Fresh Sol pre-commit review found one low-severity orphaned grill heading/paragraph, removed from the canonical source before regeneration. No other semantic defect was found. Phase 2 is complete for this inspection/condensation/test-audit scope after that correction and final local validation; this is not lifecycle clearance.

| Complete file inspected | Disposition / obligation trace |
| --- | --- |
| `dev-loop/SKILL.md` | Condensed async-wait rationale, duplicated worktree failure story, timeout incidents and headless-refinement narration. Retained public facade, explicit-start/artifact authority, review-intent versus lifecycle-gate routing, bounded CLI discovery, resolver/envelope/preflight order, retrospective reconciliation, checkpoint branches, route table, fallback poster, exact spec/fan-in/judge commands, round-cap/human-approval boundaries and no gate exemptions. Worktree and gate-owner reads are explicit. Parked refinement still skips interactive/specific-target runs, processes ascending issue numbers once each, promotes only refined items with `queue move`, leaves failures parked with reasons and idles after one pass. |
| `final-approval/SKILL.md` | Unchanged: its nineteen-line redirect already has one purpose and explicitly loads the follow-up owner's Step-7 Human approval checkpoint. Repeating merge requirements here would create another owner. |
| `local-implementation/SKILL.md` | Condensed repeated variant requirements, persona-pass instructions, planning-review explanation, comment discipline, obsolete commit-exemption history and dirty-exit rationale. Retained every artifact mode and tracker boundary, preflight and failure-triage sequence, phase/test-first limits, scaffold/bootstrap/clarification paths, all planning/review outputs, specialist table, Pi model resolution, summaries, fresh retrospective, dev-mode pass, finalization and commit/worktree rules. Editing roles still validate, commit and push their own tracker-backed work; read-only roles retain the dirty-work advisory exemption. |
| `loop-grill/SKILL.md` | Removed the count-AC incident narrative and repeated CONTEXT/idempotency explanations. Retained argument validation, zero-iteration refinement detection, resource/visual confinement and unavailable-resource handling, count units and both dispatch modes, interactive/auto source rules, full rewrite plus separate rationale/raw-transcript surfaces, body-size refusal, write-back verification and verdicts. |
| `review/SKILL.md` | Condensed ownership rationale, submit-choice repetition and non-evidence parser explanation. Requires the shared gate owner before execution; keeps exact context/primer/dispatch/fan-in/ledger/post pipeline, keyed-plan/provenance guards, canonical poster and terminal stop. Interactive review begins pending; same-round submission preserves inline comments, leave-pending stays invisible, discard removes the draft, and approve/request-changes/discard require actual interactive confirmation and refuse headless use. GitHub branch-protection effects remain distinct from lifecycle evidence. |
| `ui-review/SKILL.md` | Condensed introductory orchestration, setup-failure rationale, deterministic-ranking explanation and report/teardown introductions. Retained all five ordered CLI stages, JSON handoffs, trusted-branch recipe boundary, worktree/destructive-migration checks, browser/a11y setup, bounded flow selection/authentication/capture/error attribution, never-drop diagnosis and changed-line anchoring, exact-head pending review, harness-aware artifact hosting, explicit teardown confirmation and complete side-effect ledger. Untagged-row/drop-seam limitations remain explicit. |

No owner document, runtime/dependency file or Phase-1/3 source changed. Source edits were regenerated through the existing Claude generator; five projections changed and final-approval remained byte-identical. No new contract file or mandatory reference path was introduced; existing owner reads were made explicit where shortening a caller's explanation could otherwise hide the owner.

Coupled-test audit: the execution-guardrails contract keeps literal bounded commands and count-unit vocabulary scoped to its unique owner, while removing incident numbers and timing stories. The review contract checks actual entrypoint/owner links and retains the real foreign-owned-review versus blocked-write-route differential. Existing local-planning/delegation, failure-triage, spec-authority, public-facade, UI-owner, packaging, command-shipping and projection checks were inspected and retained for their unchanged surfaces. Literal API flags, rule IDs, payloads and generated bytes remain exact. Owner/link/token checks do not prove agent semantics: timeout discipline, count-unit reasoning, review-only conduct and full write-back meaning still require semantic review. Existing watch, verdict/evidence, refinement, UI stage, comment-discipline and cross-harness envelope tests exercise their executable portions.

Pre-existing discrepancies discovered during inspection remain unchanged, not resolved by this condensation: the public entrypoint describes durable-ledger writing before judge dispatch while Phase 3.5 requires the judge first; local preflight says other routes may edit any checkout while the worktree owner requires isolation; the phase-planning default says create a phase doc despite the earlier tracker exclusion; and the grill count-AC paragraph still names synthesis into Acceptance criteria while Step 4 owns the AC/DoD matrix. The local workflow-handoff summary also names an eight-step checklist absent from its current envelope-derivation owner. These are review/follow-up limits, not permission to choose a new behavior. Previously recorded split-tail provenance and coverage limitations remain.

Static `wc -w -c` measurements from the Phase-1 head, including the review correction: six source entrypoints 18,993 / 144,857 → 17,038 / 131,337 words/bytes; six Claude equivalents 18,517 / 141,447 → 16,624 / 128,325. All 77 tracked skills files 141,042 / 1,104,704 → 139,087 / 1,091,184. The same 24-file source/Pi normal-draft conductor set is 78,265 / 606,699 → 77,587 / 602,422. These count complete named files, including examples/frontmatter; they are not live token/cache measurements or a complete transitive read audit for every route.

Pre-review validation: 447 focused tests across sixteen entrypoint/refinement/UI/handoff suites and 447 watch/verdict/evidence/comment-discipline tests across five suites passed. The first focused run's Git-worktree fixture failed under filesystem restrictions; its permitted isolated rerun and the complete focused rerun passed. Doc guard passed 356 with one network-dependent packaging skip; that packaging test separately passed with registry access. After Sol's correction, 27 affected grill/guardrail/projection tests passed and full `bun run verify` passed 9,376 tests across 391 files with no skips or failures, plus docs and workflows. Canonical regeneration, 92-asset parity and diff whitespace checks passed; docs were checked again after recording completion. Logs use `/private/tmp/2237-phase2-`; the full final run is `verify-final.log`. These are local working-tree results, not lifecycle or current-head CI evidence.

### Phase 3: shared-owner, template and script inspection

The candidate starts at `cfd17ef0a486ade10e3a4a7697e799632598e08b`. All 65 remaining source rows now have explicit dispositions: 25 changed, 31 unchanged, six non-prose and three blocked. Whole inventory: 36 changed, 32 unchanged, six non-prose, three blocked, zero pending. Blocked files were inspected but contain unresolved authority conflicts. Fresh Sol pre-commit semantic review passed the frozen candidate without findings (diff SHA256 `38e59143d437d9693ad1227ad03c8d2cdfba8cef019c9d3a1ac9d778037eeeb3`). Phase-3 inspection/cleanup, bounded semantic review and local validation are complete. The conflicts below remain unresolved; this is not lifecycle or CI clearance.

Inspection covered complete documents/templates, script comments/help and registry enforcement notes, their direct caller references and relevant consumers. Dense schemas/state tables and short scaffolds were retained where each clause carries a distinct input, predicate, authority, evidence or failure boundary. Canonical edits produced 23 changed Claude projections through the existing generator; the two changed scripts contain comment-only edits. No mandatory owner became an optional read; runtime, dependency/schema, branch topology and B remain unchanged.

| Obligation / isolated scenario | Preserved decision and evidence |
| --- | --- |
| Quiet child has a pending supervisor request or sanctioned-watch heartbeat | Stall owner retains both exemptions, conjunctive threshold, config/probe fields, verify-before-bail order, fresh recovery brief and operator stop. Pure detector tests cover the predicate; live redispatch was not observed. |
| In-flight policy decision versus standalone RFC issue | Same-file ADR rules retain implementing-PR versus decision-only deliverable, numbering/acceptance evidence, tripwire waiver and unreadable-rule refusal. Existing tripwire tests cover mechanical detection, not ADR-worthiness judgment. |
| Epic sibling finishes before its peers | A remains first; B/C retain serial level gates despite sibling parallelism, D remains last. Per-edit prepared body and confirmation remain required unless unattended authorization applies. Removed complexity narration supplied no permission. |
| UI finding spans lenses, a criterion is uncovered, or console captures a failure | All five same-state artifacts remain required. Route MUST forward AC/passes and emit raw findings; convergence owns normalized dedupe, worse severity and outcome. Template retains criterion refs, human-conflict blocking, axe severity mapping and mechanical-error ownership. Executable template example and existing lens tests cover refusal/outcome branches. |
| Slides iteration has no findings | Full input/optional-screenshot completeness, skip/refusal, narrative lens and iteration handoff remain. Actual template JSON passes the existing result validator; empty iteration findings and foreign outcomes fail. Narrative quality remains semantic review. |
| Verified AC coexists with unverified or falsely checked labels | Three non-tracker forks, exact-label dual sync, linked-ready-issue completeness scope and reviewer/judge truthfulness duty remain. Documented tick example executes through its parser; existing tick/verdict suites cover behavior, not truthful agent verification. |
| Fresh round changes head/CI/timestamp; Claude write points at main | Handoff keeps fresh reviewers, invariant body, volatile-last gateState, ordered owner reads and sanctioned commands; provider cache reuse is conditional. Worktree owner retains cwd anchoring, scratch/no-op boundaries, ambiguous-target refusal, overrides and explicit command paths. |
| Core-less fallback posts, or gate evidence exists only as a PR review | Fallback keeps full identity, caller severity duty, one-shot/degraded limits, warning and nonzero posting stop. Gate owner retains both audit streams, disjoint claim keys, visible finding carriers and fallback/opt-in exceptions. |

Coupled-test audit: acceptance-verification, slides-story and UI-designer tests replace incidental titles/history/negation pins with command-bound parser checks, Markdown owner links, literal fields/outcomes and executable template examples. Other applicable suites retain ownership, command/payload/schema literals, generated parity, state conformance and explicit normative order/negative clauses. Issue-intake, planning, public-facade and UI harness/validation tests still include prose checks over unchanged obligations; these are bounded alarms, not semantic proof. This phase does not claim to remove every natural-language assertion. No framework or production helper was added.

#### Phase-3 conflict register and limits

Pre-existing discrepancies remain unresolved:

- **Ready transition:** intake Phase 4 prescribes raw `gh pr ready`; `RAW-GH-PR-READY-BYPASS` requires `ready-for-review.mjs`. The intake test also pins the raw example. Intake is blocked for reconciliation.
- **Human-only merge:** merge-preconditions says the wrapper refuses when `humanMergeOnly` is set, yet tells the human to use that wrapper. `scripts/github/merge-pr.mjs` refuses unconditionally for that config. No bypass was invented; owner remains blocked.
- **Draft evidence:** lifecycle core requires current-head draft clearance before requesting Copilot, while its post-draft rule accepts the one-time transition record; merge standing-authorization prose again asks for both gates at current head.
- **Retrospective:** absent-only `NONE` text conflicts with its state table, explicit `none` example and `resolveCheckpointStateFromArtifact`. Per-working-copy wording conflicts with `RETRO-CHECKPOINT-REPO-ROOT`'s shared main-root file. No-write-time-arming prose coexists with the documented extension `required` writer. Owner is blocked; fresh-context provenance remains self-attested.
- **Queue rename:** `QUEUE-COLUMN-NO-REMOVE` forbids renaming conventional columns while the same owner documents authorized `--rename` repair. Only repeated rationale changed; no precedence selected.
- **Release branch:** runbook explicitly commits/pushes on main with `DEVLOOPS_ALLOW_MAIN=1`; AGENTS forbids direct main commits. Historical prose was shortened without choosing policy.
- **Tree verify:** epic completion accepts `verify --ordered` exit 0, but sub-issue owner/helper distinguish command success from `verified: false`; helper returns `ok: true` on mismatch. No correction included.
- **Registry note:** `WORKTREE-NO-STASH` says no mechanical check while the Claude hook refuses it. Registry schema/enforcement classification remains untouched; no cross-harness guarantee inferred.

Inherited Phase-1/2 limits still apply: split-tail provenance, disputed coverage, judge/ledger ordering, preflight/isolation, tracker phase-doc creation, grill synthesis and absent eight-step handoff checklist. No live Pi/Claude/Codex end-to-end execution, delivered-prompt/cache experiment, lifecycle gate, CI clearance or merge authorization is claimed. Full-scope A/B-reference review and lifecycle decisions remain with the coordinator.

#### Phase-3 static measurements

Method: `wc -w -c` over complete named files including frontmatter/examples/code; before is Phase-3 starting HEAD. The canonical tree includes all 77 tracked skills files. Ledger growth and projections are separate from source savings.

| Surface | Before words / bytes | Candidate words / bytes |
| --- | --- | --- |
| All 77 canonical files | 139,087 / 1,091,184 | 137,435 / 1,080,064 |
| 25 changed canonical files | 43,985 / 332,948 | 42,333 / 321,828 |
| 23 changed Claude projections | 40,927 / 305,612 | 39,350 / 295,024 |
| Prior named 24-file normal-draft set | 77,587 / 602,422 | 77,247 / 600,058 |
| Named 10-file UI set | 17,467 / 132,346 | 17,117 / 130,150 |
| Transitive Markdown closure of either set (101 files) | 236,300 / 1,833,869 | 234,723 / 1,823,281 |

UI seeds: AGENTS, main-agent contract, dev-loop/ui-review entrypoints, ui-review-recipe, ui-designer-review-loop, ui-artifact, ui-smoke-harness, ui-e2e-scoping and ui-vision template. Normal-draft seeds are the same 24 files in the historical Render-budget slice. Closure recursively follows repository-local Markdown links via existing `extractRelativeMarkdownLinks` (anchors stripped) plus literal backticked `skills/...md` paths; each tracked non-generated Markdown target is counted once. Optional links are included, so both seed sets reach the same 101 files. No target was added or removed. This is a static reference closure, not dynamically selected mandatory reads: wildcard/example paths, runtime artifacts, system prompts and non-Markdown consumers are excluded. Reproducible manifests/script: `/private/tmp/2237-phase3-measure.*`.

Incremental Phase-3 reduction: **1,652 words / 11,120 bytes**. Pinned main had 152,940 / 1,185,234; cumulative reduction is **15,505 / 105,170**, of which **13,853 / 94,050** predates Phase 3. These are static text counts, not token/cache/live-context savings.

Pre-review validation: first focused UI/slides/fallback run 109 passed; affected runtime/ADR/routing/stall/init/envelope/tick suites 243 passed. Full doc guard passed 356 with one network packaging skip; that packaging suite separately passed with registry access. After the last source edits, all 38 focused contracts/envelope tests passed across six files, and docs/links/rules/decisions/changelog, workflows, 92-asset parity and whitespace passed. After Sol passed the unchanged candidate, full `bun run verify` passed **9,376 tests across 391 files, zero skipped/failed**, plus docs and workflows. Separate final docs/workflows/assets (92) and whitespace checks passed. The subsequent ledger-only completion update was rechecked with docs/whitespace before commit. Logs: `/private/tmp/2237-phase3-*`, full run `verify-final.log`.


## Historical parked checkpoint — 2026-09-16

Paused at the user's request; resume only when requested, not automatically on Saturday. PR2237 remains draft and unmerged. Latest implementation/test commit pushed before this note: `cef3de0b` on `issue-2236`. Its full verification passed 9,293 tests across 390 files, plus docs/workflows; doc guard passed 354 with one skip.

Preserved uncommitted work in `tmp/worktrees/dev-loops/issue-2236`: `skills/docs/copilot-ci-status-contract.md` and its canonically regenerated `.claude/skills/docs/copilot-ci-status-contract.md` mirror. This draft condenses repeated check-exclusion explanations; zero-suite exception, inputs, outputs and precedence are unchanged. Its 82 focused CI/prober/workflow tests passed. Independent post-edit semantic review, docs/assets checks, measurement update and full verification are pending; the preceding full-suite result does not cover this draft. This checkpoint note is committed separately, without staging those two files.

On explicit resume: fetch origin, refresh canonical startup/envelope and issue2236 spec, preserve the two-file diff, review it against `cef3de0b`, finish its semantic scenarios and checks, then commit/push the coherent slice. Continue phase1 afterward; remaining 77-file inventory is not complete. Next candidates include the issue-intake persistence prose pins and the safe proportionality-floor explanation block. The ambiguity register remains unresolved, including carry eligibility, zero-unit dispatch, grouping, fixer identity and lineage/context requirements; no new policy choice is authorized by parking. No review workers or validation jobs remain intentionally running.

## File inventory

Current disposition at the final runtime-correction head `b6f49bd279f52d397a4515ce36c0a48b32c3b117`: **41 changed, 30 unchanged, six non-prose, zero blocked/pending; 77 total**. The current matrix supersedes historical unresolved-conflict statements in earlier phase records.

| File | Phase | Disposition | Evidence / remaining work |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 1 | changed | Full owner and applicable tests inspected; remaining lifecycle/reattachment/coordination prose condensed. Fresh Sol semantic review and final local verification passed; see previous-run trace. |
| `skills/dev-loop/SKILL.md` | 2 | changed | Full entrypoint inspected; duplicate rationale condensed, point-of-use commands/branches retained. Sol review and final validation complete; see Phase-2 trace. |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | 3 | non-prose | Inspected complete context extraction and local-implementation dev-mode caller: behavior, payload keys and diagnostics only; no standalone instructional prose to condense. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | 3 | non-prose | Inspected complete fixtures/assertions for extraction, settings and context fallback. Test names identify observable behavior; retained executable coverage and literal payloads. |
| `skills/dev-loop/scripts/init-phase.mjs` | 3 | changed | Condensed duplicate explanatory comments only. ARTIFACT-TRACKER-FIRST-NO-DUP, issue-worktree recognition, durable-doc refusal and ephemeral manifest behavior are unchanged; traced local-implementation/init-phase smoke consumer. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | 3 | non-prose | Inspected full re-export shim and local-implementation command reference. Export surface only; no editorial content or compatibility change. |
| `skills/dev-loop/scripts/phase-files.mjs` | 3 | non-prose | Inspected full re-export shim and init-phase/render-template consumers. Canonical phase-file functions remain untouched; no standalone prose. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | 3 | changed | Removed opening comment duplication; kept the complete degraded-semantics list, caller count responsibility, stderr warning, parser-stable identity and posting-failure stop. Full script/test and dev-loop fallback caller inspected; no executable/help literal changed. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | 3 | unchanged | Full suite inspected: full-SHA identity, duplicate/create behavior, hostile text, literal render markers, gate/severity validation and CLI failure tests protect the degraded poster. Comments explain security/compatibility cases rather than duplicate workflow instructions. |
| `skills/dev-loop/scripts/render-template.mjs` | 3 | non-prose | Full renderer and local-implementation/template consumers inspected. Placeholder resolution, confinement and CLI diagnostics are behavioral surface; no prose-only reduction. |
| `skills/dev-loop/scripts/render-template.test.mjs` | 3 | non-prose | Full fixtures inspected for placeholders, path confinement, failures and rendering. Literal examples/assertions exercise behavior, not source-document wording. |
| `skills/dev-loop/templates/bootstrap-agents.md` | 3 | unchanged | Complete bootstrap template and local-implementation bootstrap caller inspected. Existing short project rules, phase authority and workflow links are point-of-use instructions; placeholders retained. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | 3 | unchanged | Complete state scaffold and bootstrap caller inspected. Active phase, accepted/deferred decisions and canonical document links have separate purposes; no duplicate explanation to remove. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | 3 | unchanged | Complete workflow scaffold and bootstrap caller inspected. Its minimal phase sequence and durable-document roles are required first-use content; retaining avoids an optional-link-only bootstrap. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | 3 | unchanged | Complete template and dev-mode context/caller inspected. Short required retrospective output fields carry distinct evidence; retained placeholders and section shape. |
| `skills/dev-loop/templates/dev-mode-review.md` | 3 | unchanged | Complete template and local-implementation dev-mode pass inspected. Each question supplies a distinct review input; already compact, no generic commentary removed. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | 3 | unchanged | Complete 22-word scaffold and dev-mode caller inspected. Skill-change outcome fields only; retaining all fields is the smallest usable template. |
| `skills/dev-loop/templates/merged-phase-plan.md` | 3 | unchanged | Complete merged-plan scaffold and planning synthesis caller inspected. Chosen plan, dependencies, acceptance and unresolved decisions remain separate required output slots. |
| `skills/dev-loop/templates/phase-doc.md` | 3 | unchanged | Complete phase scaffold, init-phase renderer and plan-file validator contract inspected. Section names/placeholders are input grammar and durable authority, not prose repetition. |
| `skills/dev-loop/templates/phase-summary.md` | 3 | unchanged | Complete summary scaffold and local-implementation completion caller inspected. Validation/evidence and residual work fields retained; no explanatory paragraphs to condense. |
| `skills/dev-loop/templates/phase-variant.md` | 3 | unchanged | Complete variant scaffold and refinement fan-out caller inspected. Alternative plan, rationale and risks are distinct output fields; already minimal. |
| `skills/dev-loop/templates/retrospective.md` | 3 | unchanged | Complete template, fresh-retrospective caller and checkpoint owner inspected. Neutral fresh-context evidence and process observations remain explicit; cannot infer compliance from record labels. |
| `skills/dev-loop/templates/review.md` | 3 | unchanged | Complete review scaffold and planning/implementation review callers inspected. AC/DoD coverage, validation, findings and RFC escalation are distinct obligations; exact fields and ordering retained. |
| `skills/dev-loop/templates/slides-story-review.md` | 3 | unchanged | Complete template and slides-story owner/validator inspected. Input fields, six narrative lenses, grounding/refusal and JSON output are needed at reviewer point of use. JSON example now runs through existing result validator in the coupled contract test. |
| `skills/dev-loop/templates/ui-vision-review.md` | 3 | changed | Condensed repeated convergence explanation. Retained route MUST-forward AC/pass inputs, raw per-lens output, normalized dedupe identity/worse severity, evidence ownership, all fields, coverage and conflict outcomes; executable JSON-template handoff test added at existing convergence seam. |
| `skills/docs/ab-contrast-deslop-step.md` | 3 | changed | Complete three-pass procedure and config/deslop consumer inspected. Removed historical first-runs paragraph only; trigger globs, normative-contract/light/spike exemptions, independent verification, factual distinctions and rewrite guidance retained. |
| `skills/docs/acceptance-criteria-verification.md` | 3 | unchanged | Complete eight-step procedure and follow-up/tick/verdict consumers inspected. Three non-tracker forks, linkage/identity, exact-label dual sync, completeness scope versus truthfulness and non-clean visible posting are distinct. Replaced incidental test sentences with command-parser/field wiring checks. |
| `skills/docs/agent-stall-detection.md` | 3 | changed | Complete detector contract and public caller inspected. Removed rc.5 incident/missing-feature history; kept conjunctive stall predicate, supervisor/watch exemptions, config/defaults, probe inputs/results, verify-before-bail order, fresh recovery and operator stop. |
| `skills/docs/anti-patterns.md` | 3 | changed | All sixteen items inspected. Merge summary now delegates evidence to its owner and distinguishes agent-executed wrapper path from human-only handoff; raw-ready caller corrected under C01. |
| `skills/docs/artifact-authority-contract.md` | 3 | unchanged | Complete origin/mode definitions, settings layers and P1–P5 flow inspected with local-planning, startup and local-implementation references. Tracker/no-dup, lightweight PR-body authority and promotion branches are not interchangeable; retained normative table and examples. |
| `skills/docs/conductor-routing-contract.md` | 3 | changed | Removed repeated opening/overview/boundary definition. Full input/output schemas, ownership-unavailable integration note, priority table, reconcile/refusal, transitions, isolation handoff and scenarios retained; traced outer-loop/evaluator references. |
| `skills/docs/confirmation-rules.md` | 3 | unchanged | Full confirmation table and entrypoint/merge consumers inspected. Exact-action/latest-input authority and pre-authorized scope are compact distinct constraints; no weakening or policy reconciliation. |
| `skills/docs/contract-style-guide.md` | 3 | unchanged | Complete style-rule table and ownership-validator consumers inspected. IDs, modality, single-owner/reference and conflict/drift norms each encode an independent rule; retained exact markers. |
| `skills/docs/copilot-ci-status-contract.md` | 1 | changed | Full owner and normalization/detector/prober consumers inspected. Parked exclusion condensation retained; inputs/output, precedence, failure/timeout, unsupported-completed override and zero-suite identity prerequisites unchanged. Both exclusion names stay explicit; missing current-head evidence remains fail-closed failure. 82 focused CI/prober/workflow tests; docs/assets pass. Fresh Terra `/root/dev_loop/ci_owner_review` required restoring the explicit missing-evidence predicate, then verified the fix with no remaining defect. |
| `skills/docs/copilot-loop-operations.md` | 1 | changed | Full owner/callers inspected and condensed; authority/watch/stop/approval/draft/closing-reference/checkpoint contracts retained. Fresh `/root/dev_loop/phase1_authority_review` semantic review and corrected structural tests; see previous-run evidence. |
| `skills/docs/copilot-loop-state-graph.md` | 3 | changed | Removed duplicate opening definition only. Complete snapshots, precedence/transitions, terminal/wait/persistence and action mapping retained against detector/evaluator callers; current-head and unresolved-feedback distinctions unchanged. |
| `skills/docs/cross-harness-regression-contract.md` | 3 | unchanged | Complete harness matrix, no-op cases and required test lists inspected with generator/hook callers. Pi, Claude and Codex limitations remain distinct; compact coverage obligations retained. |
| `skills/docs/decision-record-contract.md` | 3 | changed | Condensed repeated in-flight/RFC-issue explanation into a pointer within the same loaded owner. Complete rule table, accepted decision paths, ADR-only RFC outcome, modality tripwire/read failures/waiver, numbering and consumer-repo location remain. |
| `skills/docs/docs-grill-step.md` | 3 | changed | Condensed introduction and removed historical first-run account. Kept autonomous refinement and pre-approval surfaces, pure-core boundary, classifier outcomes/refusal, cosmetic nonblocking and human merge authority; traced refiner/config/classifier consumers. |
| `skills/docs/entrypoint-strategies.md` | 3 | changed | Removed retired-file history and repeated tracker-route rationale. Full state vocabulary, ordered first commands, required reads and standalone-versus-routed tracker detector distinction retained with startup/follow-up callers. |
| `skills/docs/epic-tree-refinement-procedure.md` | 3 | changed | Removed reassurance and duplicate complexity formula; full A–D ordered procedure, within-level parallelism, serial gates, per-edit confirmation, matrix/scope/non-goals and CLI examples retained. C15 resolves verify-exit prose to require `verified: true`; tooling behavior is unchanged. |
| `skills/docs/gate-review-comment-contract.md` | 3 | changed | Condensed purpose and incident history after complete owner/poster/reader inspection. Tier identity, single visible review, per-finding carriers, minimization, two-surface audit, exact fields/flags, size/failure/current-head and review-only limits are load-bearing and retained. |
| `skills/docs/gate-review-sub-loop-contract.md` | 1 | changed | Full owner inspected and condensed; C03 draft-evidence summary aligned. C17 follows ADR0072 through emission and provenance writing. C21 removes failed-write markers and preserves references on refusal, including the corrected Sol finding. Both corrections are committed; exact-tree full verification, docs/workflows and 92-asset parity passed at the recorded heads. |
| `skills/docs/issue-intake-procedure.md` | 3 | changed | Full procedure inspected. C01 ready wrapper and C19 approval boundary corrected against existing owners; actual command example is parser-tested. |
| `skills/docs/local-planning.md` | 3 | unchanged | Complete validator/flow/worked example inspected with start/refine/promote helpers and local-implementation caller. Required sections, stage stop/approval, promotion authority and full evolving example retain distinct input/output boundaries. |
| `skills/docs/main-agent-contract.md` | 3 | unchanged | Complete baseline read alongside AGENTS; traced entrypoint and generated harness consumer. Read-only boundary, delegated mutation, notification/wait behavior and Claude inline exception are authority-sensitive and already concentrated in their owner. |
| `skills/docs/merge-preconditions.md` | 3 | changed | C02 human-only handoff aligned with ADR0007/runtime refusal. C04 standing authorization retained and distinguished from general transition evidence; no authorization weakened. |
| `skills/docs/pr-lifecycle-contract.md` | 3 | changed | C03 current-head draft scope reconciled with transition owner/runtime; C22 gate CI opt-out distinguished from actual merge precondition. States and fail-closed branches retained. |
| `skills/docs/projects-queue-contract.md` | 3 | changed | Condensed repeated board rationale; full contract/setup/usage inspected with queue helper references. Configured membership/order, Next Up empty/unreachable refusal, bootstrap authorization, mappings/repair, pagination/reorder/archive examples remain. C13 distinguishes restoring canonical names from forbidden renaming of canonical columns; no runtime change. |
| `skills/docs/public-dev-loop-contract.md` | 3 | unchanged | Complete facade/routing/bootstrap/ownership/concurrency contract and entrypoint callers inspected. Dense actor/authority, stop, stale state, linked-PR, isolated continuation and race limitations carry distinct obligations; retained full owner availability and pre-existing Phase-2 discrepancies. |
| `skills/docs/release-runbook.md` | 3 | changed | Inspected/condensed in prior phase. C14 resolved by accepted ADR0044: AGENTS summary now references its existing release/reconcile exception. Stable tag/publish approval remains operator-owned. |
| `skills/docs/required-rules.json` | 3 | changed | All notes inspected. C16 corrects only no-stash enforcement prose to name Claude's additional mechanical check; IDs, enforcement values and schema unchanged. |
| `skills/docs/retrospective-checkpoint-contract.md` | 3 | changed | C05/C06 state/path corrected; C07 separates recency and explicit arming; C20 separates legacy verifier classification from ready-call permission. Fresh-context self-attestation limits retained. |
| `skills/docs/reviewer-loop-state-graph.md` | 3 | changed | Removed duplicate opening definition only. Complete snapshot, review ownership/submission/invalidated states, transition table and gate-angle mapping retained with reviewer detector/staging consumers. |
| `skills/docs/slides-story-review-loop.md` | 3 | changed | Removed duplicate purpose/rationale and first-runs history. Kept same-file narrative lens, full input/output, optional screenshot completeness, skip/refusal, iteration and satisfied boundaries, handoff order and validation seam; executable template test replaces title/history pins. |
| `skills/docs/spec-authority-contract.md` | 3 | unchanged | Complete whole-spec decision table, identities, invalidation and conflict escalation inspected with Phase-3.5/spec-context consumers. Revision/content/head evidence and last-resort human choice remain explicit; compact normative owner retained. |
| `skills/docs/spike-mode-contract.md` | 3 | unchanged | Complete start/relaxed profile/timebox/graduation/discard contract and startup/local-planning consumers inspected. Eligibility, plan-file requirement, zero-mutation discard and graduation phase boundaries are distinct exceptions; retained all command/schema literals. |
| `skills/docs/stop-conditions.md` | 3 | unchanged | Complete stop-state table and entrypoint/merge consumers inspected. Approval, merge authorization, startup uncertainty, legitimate waits and terminal/reconcile stops have different predicates; compact rule ownership retained. |
| `skills/docs/structural-quality.md` | 3 | unchanged | Complete design/review principles and anti-patterns inspected with local-implementation references. Each prompt targets a distinct structural smell or boundary; retaining the short checklist avoids losing reviewer criteria. |
| `skills/docs/sub-issue-tree-contract.md` | 3 | changed | Removed duplicate opening definition only. Full decomposition/reference-choice table, conservative follow-up boundary, canonical tooling, hierarchy/no-duplicate rules and verification payload/exit distinction retained with intake/planning consumers. |
| `skills/docs/tracker-first-loop-state.md` | 3 | changed | Removed duplicate dual-purpose list already expressed by opener/component table. Full PR and loop state machines, metadata/identity, reverse sync/idempotency, blocked behavior and ADR link-only scope retained; standalone routing distinction unchanged. |
| `skills/docs/tracker-seam-contract.md` | 3 | unchanged | Complete provider seam/config/ownership contract inspected with tracker state and queue references. GitHub issue/PR truth versus scheduling/provider capabilities remain distinct; minimal surface and future-provider limits retained. |
| `skills/docs/ui-artifact-contract.md` | 3 | changed | Merged repeated five-file list/explanation into one table; removed historical/minimality narration. Full manual/smoke/CI levels, naming/collision, schema, nullable always-emitted evidence, severity mapping, mechanical error ownership and required-suite failure retained. |
| `skills/docs/ui-designer-review-loop.md` | 3 | changed | Removed historical opener and duplicate purpose; complete inputs, designer/vision modes, four-lens convergence, evidence/coverage/outcome and required-recording boundaries inspected. Coupled test now executes template output; existing validator/lens suites retain executable refusal coverage. |
| `skills/docs/ui-e2e-scoping-step.md` | 3 | changed | Removed historical broken-margin anecdote. Full globs/registries, exact-path disambiguation, current-head CI signal, registration refusal, visual inspection/no-bespoke-tests and defect-red proof procedure retained with gate/scoping consumers. |
| `skills/docs/ui-review-recipe-contract.md` | 3 | unchanged | Complete recipe schema/examples, trusted-branch inputs, authentication, provision/drive/teardown contracts inspected with UI-review stage callers. Keys/literals and phase-specific responsibilities retained; no runtime/config change. |
| `skills/docs/ui-smoke-harness.md` | 3 | changed | Condensed historical opener. Complete WebKit/fixture scope, runtime capture versus test harness ownership, registry-derived projects, required spec naming, adoption and outputs retained with UI consumers. |
| `skills/docs/ui-validation-contract.md` | 3 | unchanged | Complete trigger and worked intro-deck path inspected with UI-e2e owner and local-implementation caller. Keeping globs, registry and CI mapping at this point of use avoids turning required UI validation into an optional linked read. |
| `skills/docs/validation-policy.md` | 1 | changed | Full source inspected; CI exception now requires its current owner. Default validation, coverage admission and meaningful exception rules intentionally retained. |
| `skills/docs/wait-watch-procedure.md` | 1 | changed | Full-file old/new review complete; duplicate capture commands and obsolete CI history removed. Remaining route-local decisions intentionally retained to avoid loading the full follow-up bundle. |
| `skills/docs/workflow-handoff-contract.md` | 3 | changed | Condensed repeated cache explanation and removed guaranteed-provider-hit claim. Full derivation tables/schema, terminal tuple, sanctioned-map boundary, required-read order and volatile-last prohibition retained with envelope builder/validator; tests prove bytes, not actual cache reuse. |
| `skills/docs/worktree-guidance.md` | 3 | changed | Removed wrong-checkout/cwd incident narration. Complete create/reuse/provision/fetch branches, detached/fallback limitations, dependencies, guards and overrides, explicit paths, cleanup and collision rules retained with lifecycle/hook consumers; Pi/Claude distinctions unchanged. |
| `skills/final-approval/SKILL.md` | 2 | unchanged | Fully inspected; existing minimal redirect explicitly loads the human-approval owner. Sol review and final validation complete. |
| `skills/local-implementation/SKILL.md` | 2 | changed | Fully inspected; repeated planning/commit explanations condensed, artifact/delegation/worktree/exit rules retained. Sol review and final validation complete. |
| `skills/loop-grill/SKILL.md` | 2 | changed | Fully inspected; repeated incident/idempotency prose removed, refinement/write-back semantics retained. Sol's orphaned-heading correction applied; final checks passed. |
| `skills/review/SKILL.md` | 2 | changed | Fully inspected; ownership/submit/non-evidence repetition condensed, exact confirmation and terminal boundaries retained. Sol review and final validation complete. |
| `skills/ui-review/SKILL.md` | 2 | changed | Fully inspected; repeated orchestration rationale condensed, all five stages and failure/side-effect constraints retained. Sol review and final validation complete. |

## Historical Phase-1 validation plan

Reviewed first slice: simplify the follow-up skill's startup/path-resolution prose and the shared wait procedure; replace generated-projection prose pins using existing transformation tests. Subsequent slices condense fan-out/fan-in with its owner while preserving unresolved conflicting instructions. This PR is variant A; the issue now defines an independent variant-B comparison. Neither variant is selected for merge.

Compare old/new instructions for actors, permissions, triggers, conditions, order, exceptions, stop rules, evidence and revision identity. Preserve frontmatter, rule IDs, command examples and the declared verbatim dispatch payload. Independently evaluate high-risk scenarios with no live writes. Replace incidental prose pins with existing structural/behavior seams; keep exact API/projection checks. Run docs, contract, generated-asset and default verification before draft handoff.

## Ambiguity register — inherited Phase-1/2 disposition

- Fan-in count: corrected to actual emitted/spawned units following the existing owner's explicit authority and emitter tests; unsplit `pendingGroups.length` was obsolete advice.
- CI evidence flag: removed executable use of unsupported `--local-validation-head-sha`; the existing CI owner retains prerequisites and now states that ordinary CLI refresh cannot activate the exception. See the code-backed correction below.
- Carry eligibility — resolved: ADR0064 and the owner/runtime permit evidenced `findings_present` carry with unchanged findings and retained identity; obsolete clean-only prose was removed.
- Zero-unit rounds — resolved within issue2273: an all-carried round emits a keyed plan backed by complete resolver proof. Mandatory plan consumption remains; completed-only and unsupported empty plans refuse. No no-plan exemption was introduced.
- Proportionality grouping — resolved: ADR0072 and `expandDispatchUnits` govern grouped emitted units, preserving size/risk/tier/mandatory floors. The separate one-angle split-tail provenance `group` discrepancy remains unresolved and outside issue2273.
- Fixer handoff identity — resolved: `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` requires `threadId`; a fingerprint is optional additional identity. The existing validator was retained.
- Review lineage — resolved: the authorized ADR0070 clarification distinguishes offline append-only composition from mandatory fresh current-head runtime context rebuilding.
- Remaining limitations: one-angle split-tail provenance `group`, disputed coverage wording and the additional discrepancies recorded in the Phase-2 trace; the Phase-3 record above adds completed inspection/review/local validation and further conflicts. Final lifecycle gates and human approval remain outstanding.

The detector's `--help` lists no `--local-validation-head-sha` option; its removed executable use is resolved, while the CI owner's existing prerequisites remain intact. The dispatch emitter returns its expanded unit count, with split coverage in its tests. The accepted Phase-1 trace above establishes the scope of these resolutions, not whole-issue or lifecycle clearance. Historical accounts below retain the uncertainty and validation state of their original slices.

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

## Zero-unit findings correction (issue2273)

PR2237 request-changes comment `issuecomment-5744387334` exposed an incomplete proof check: the findings-log writer consumed every expected carried finding but accepted leftover supplied findings. The shared `verifyEmitPlanProvenance` now rejects leftovers, requiring exact canonical finding contents and multiplicities while retaining its order-independent matching. A zero-unit round cannot add a finding or duplicate a proven one. The canonical all-carried contract and its generated Claude projection state that rule; the caller already requires that owner's Phase 2 procedure.

The real resolver → context → emitter → fan-in → writer test reproduces and rejects a findings-present carry plus a new High, the same carry plus a duplicate legitimate finding, and a clean carry plus a new High. Both valid carry verdicts still write; refused input preserves the existing ledger. Missing/altered findings, stale heads, reviewer and round identities, incomplete/duplicate proof, and fresh provenance safeguards remain covered. The new rejection failed before the one-line guard and passed after it. Focused emitter/writer/fan-in validation passed under Bun 1.4.1. Independent precommit review, exact committed-tree validation and current-head CI remain separate evidence; this entry claims no lifecycle-gate clearance.
