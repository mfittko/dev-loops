# Skills prose cleanup coverage

Current run: tracking issue [2454](https://github.com/mfittko/dev-loops/issues/2454). Start revision: `6202c2ed70b5cd438051a90bee9aae89e56326f3`. The current run has its own inventory, phases and baseline measurements in the section below.

A pending row is not reviewed coverage. This record tracks execution; the tracking issue remains the canonical specification.

Dispositions: `pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`. Generated `.claude/skills/` projections are outside this source inventory and must be regenerated, never edited by hand. In the previous run, runtime changes were limited to the explicitly authorized C17/C21 corrections; schema and dependencies were excluded.

Previous-run phases: 1 = Copilot follow-up and directly coupled references/tests; 2 = other routed entrypoints and their workflow contracts; 3 = remaining shared documentation, references, templates and script comments/help. The previous run's cross-phase contradiction pass has a final disposition for every decision row in its section.

## v1.0.6 slice 1 — gate-round contract surface (issue 2603)

Slice 1 of the v1.0.6 prose cleanup condenses the three files the gate coordinator and the gate reviewer load: `skills/docs/gate-review-sub-loop-contract.md`, `agents/gate-coordinator.agent.md` and `agents/review.agent.md`. Start revision: `410eccba0` (contract bytes equal to `d8252e39`). No rule ID, rule marker, heading slug, flag, script name or modality is removed or weakened. `skills/docs/required-rules.json` and `FORWARD_RULE_REFERENCES` are unchanged. The contract keeps the same 42 `<!-- rule: ... -->` markers (sorted `git grep -o` list identical before and after) and every linked heading, so the 11 inbound anchors resolve.

### v1.0.6 slice 1 measurements

| File or bundle | Before bytes / words | After bytes / words | Change |
| --- | --- | --- | --- |
| `skills/docs/gate-review-sub-loop-contract.md` | 225,283 / 29,755 | 191,402 / 24,934 | -33,881 bytes (-15.0%) |
| `agents/gate-coordinator.agent.md` | 2,520 / 365 | 2,153 / 306 | -367 bytes |
| Coordinator bundle (both files) | 227,803 / 30,120 | 193,555 / 25,240 | -34,248 bytes (-15.0%) |
| `agents/review.agent.md` (reviewer bundle) | 21,413 / 2,952 | 19,225 / 2,625 | -2,188 bytes (-10.2%) |

Targets: contract at most 191,500, coordinator bundle at most 193,600, reviewer bundle at most 19,270. All three hold. The Claude projections regenerate byte-identically for the contract (191,402) and shrink for the two agents (`.claude/agents/gate-coordinator.md` 2,460 to 2,093, `.claude/agents/review.md` 21,379 to 19,191).

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
- Phase 2 "Each reviewer" bullets: shortened the "fresh" definition, the composer bullet (now cites `GATE-EXEC-FANOUT-DISPATCH-EMIT`) and the `--scope` rationale; the 429 paragraph now cites `GATE-EXEC-DISPATCH-RETRY-BACKOFF` for the retry schedule and the halving, the wave recompute and the foreground one-at-a-time fallback moved into the `GATE-EXEC-DISPATCH-RETRY-BACKOFF` rule body. Grouped-dispatch paragraph: dropped the "emitter shares every multi-angle unit" repeat (owner: the emit rule bullet).
- `GATE-EXEC-SOURCE-READ-WORKTREE`, `GATE-EXEC-NO-CWD-DEPENDENCE`, `GATE-EXEC-ARTIFACT-HEAD-STAMP`: dropped one rationale sentence each (stale installed copies, wrong-tree reads, "distinguishable from a fresh verdict"). Every MUST, the `git show HEAD:<path>` check and both exemptions stay.
- `GATE-EXEC-BRIEFING-PREFIX`: shortened the findings-write-path rationale, the cache-alignment paragraph and the composer paragraph. Byte identity, the angle-only-in-suffix MUST, the ledger `--tmp-root` MUST NOT and "reference seeding ... is compliant" stay.
- `GATE-EXEC-FANOUT-DISPATCH-EMIT`: dropped the "merged-config sha256 (informational)" aside and the internal repeat of the wave bound; shortened the persona and shared-reviewer bullets and dropped the "angle list is normalized once" sentence. Owners: `emit-fanout-dispatch.mjs`, `resolveReviewerRole`, `fanoutReviewerPairingError`. Pull-refusal codes, the 30 KB ceiling and the keyed emit plan stay.
- Content inlining, filtered-diff and scoped-variant paragraphs: merged and shortened; dropped the hunk-collapse paragraph and the per-mode bullets (kept as one sentence about the recorded mode), and the excluded-path listing detail. Owners: `collapsePureSubstitutionRuns`, `filterDiffForInline`, `renderScopedBriefingVariant`. The required `diff` read, `raw-diff` widening read, config-source exclusion guard and variant retention MUSTs stay. The `dispatch_identity_mismatch` meaning ("execution or role disagrees") and the `.yaml`/`.yml`/`.json` extension clause for `packages/core/src/config/extension-defaults` stay.
- Records-floor: shortened. The plan-is-authority and fail-closed rules stay. `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`: dropped the repo-config parenthetical. Re-run rule: replaced by a pointer to `GATE-EXEC-ANGLE-CARRY-FORWARD` (duplicate of Phase 5).
- `GATE-EXEC-DISPATCH-RETRY-BACKOFF`: dropped the "encoded, testable policy" sentence and three rationale clauses ("rather than keep retrying at full concurrency", "instead of retrying into the same wall", and "a transient failure's" before "cap window"). `planDispatchRetry`, the schedule, the ~3-attempt halving and the immediate hard 4xx escalation stay, and the halving, wave recompute and foreground one-at-a-time fallback now live in this rule body (moved from the 429 paragraph); `STICKY-PROVIDER-PIN` still defines the cap window.
- `GATE-EXEC-CACHE-TELEMETRY`, `GATE-EXEC-EXECUTION-RECORD`: dropped the "Section D honesty invariant" restatements, the pre-slice-4 example and the live-producer pointer. The fail-closed conditions and the optional-telemetry carve-out stay.
- Sentinel lifecycle: shortened. The same-head retry and `GATE-EXEC-ROUND-RETIREMENT` rules are unchanged in substance.
- Phase 3 fan-in: shortened the CLI, `--carried-angles`, coverage-table, withheld-round and ledger paragraphs. Dropped "no improvised `--jq` extraction" asides. The pair-required fail-closed rule, exit codes and render-budget table stay.
- Classification bullet: moved the question, reject-close and nit detail to `GATE-EXEC-THREAD-DISPOSITION` (the owner). The calibration rule and the `Examined on merits:` MUST stay here.
- Post-before-fix: shortened the opt-in comment paragraph and the slot explanation. `GATE-EXEC-POST-BEFORE-FIX` MUSTs stay.
- Phase 3.5: shortened disposition memory (dropped "each ledger is checked on its own"; "checked in both prefix directions" and the carried-reviewer aside stay), the AC1 paragraph (the four writer-plus-flag pairs stay verbatim), the judge-not-fresh rationale and the merge-seam purpose sentence.
- Phase 4 `GATE-EXEC-BLOCKING-ONLY-FIX`: dropped the restated low, question and nit semantics and the duplicated gate-close detail (owner: `GATE-EXEC-THREAD-DISPOSITION`). The window rule, the two-layer rule and ADR 0089 composition stay.
- `GATE-EXEC-THREAD-DISPOSITION`: restructured into per-severity bullets and removed the repeated low-triage, judge-`act` and nit sentences (the filing bar now lives only in the per-severity bullets; later paragraphs reference them). The round-1 low-defer allowance now appears once, with the judge-acted-low exception in the same sentence.
- `GATE-EXEC-DEFERRAL-RECORD`: dropped the restated stamp rules for nits, questions and unstamped lows (owner: `GATE-EXEC-THREAD-DISPOSITION`). The three record places, comment-target rule, never-creates-an-issue rule, marker format and idempotency stay.
- `GATE-EXEC-FINDING-THREADS`: dropped the aggregate-line and per-angle-breakdown detail (owner: `GATE-COMMENT-SINGLE-SURFACE` and `GATE-COMMENT-INLINE-LAYOUT` in `gate-review-comment-contract.md`, cited by ID). The two-track split, one-carrier rule and marker stay. Close paragraph: shortened the known-findings snapshot restatement (owners: Phase 1, Sentinel lifecycle and the Copilot follow-up fan-out procedure).
- `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`: shortened the helper-behavior prose. The ordered boundary, containment rule and forbidden-action rule stay.
- Carry-forward: shortened the Phase 5 retry bullet, the eligibility paragraph, `GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED`, the delta basis, the same-rebuild disposition-memory paragraph, the config-source and rename explanations and the provenance paragraph. Dropped the `GIT_DIR`/`GIT_WORK_TREE` scrub note (owner: `scripts/lib/git-delta.mjs`) and the parenthetical "honest attribution" aside. The fail-closed defaults, the CLI refusal list and the review-surface mapping stay.
- Copilot round-cap interplay: shortened the strict-mode seam. The `suppressed_post_convergence` results, `converged_once` grant and the fail-closed decision stay. Owners: `COPILOT-FOLLOWUP-ROUND-CAP`, `COPILOT-STATE-CARRIED-CONVERGENCE`.
- Execution-mode paragraph: dropped the epic #867 sentence. Light-mode, proportionality and diff-class tier sections: shortened wording (dropped one-clause rationales, the "a tier is needed because `dynamic.subtractive` keeps per-category width" rationale and the repeated degenerate-pool fallback; the light-mode "exclusion applies only to the cap" scope statement stays); every floor, the precedence order and the merge-time re-verify stay. ADR paths shortened to ADR numbers.
- Fan-out provenance and angle coverage: shortened the one-reviewer-per-unit, `distinctReviewers` floor, caveat and CI paragraphs; dropped the `#1601` repeat and the "may additionally be pool-configured" aside. The pairing check, grouped exception, `gates.requireFanoutProvenance` floor and fan-in-synthetic-angle rule stay.
- Fail-closed fan-out-unavailable section: dropped the Pi-bridge driving-command sentence. The quoted `FANOUT_UNAVAILABLE_MESSAGE` string and the routing to the conductor stay.

`agents/gate-coordinator.agent.md`: dropped the typed-result field list (owner: `GATE-EXEC-GATE-COORDINATOR`, cited). The join line keeps both rule citations. Dispatch relay, boundary and file-ops citation stay.

`agents/review.agent.md`: shortened the work-order description, the required-reads bullet, the build-once citation bullet, the bounded-unit bullet, the grouped-dispatch paragraph, the severity and `contextWidened` clauses of the findings-shape text, the `defectKey` paragraph (the location condition "on one file and line, or one file with no line" and "findings without a key merge only on identical summaries" stay), the full-PR blocked-angle clause and the Tool strategy section (dropped the `Grep`/`Glob` allowlist sentence, the `tools:` rationale and the "reads the diff, the plan, and the source" clause; the `tools:` frontmatter stays) and the "(ADR 0115)" aside. The adversarial defect-class parenthetical (edge cases, input validation, numeric coercion, null/undefined, boundary conditions, caller/callee contracts, dedup/identity bugs) stays, because `COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING` owns the behavior but the work order does not carry the class list. Shortened the `question` clause to "An unanswered `question` blocks gate-close like a defect" and dropped "on the severity axis" from the nit clause; the nit treatment stays. Shortened the "`42` is a placeholder value, not literal example syntax" clause to "`42` is a placeholder, not syntax to copy"; the obligation stays. Every other reviewer rule the work order does not deliver stays.

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
- Step 7 item 11: replaced the restatement of `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` with a point-of-use citation plus the operative step (run `verify-fixer-disposition.mjs` to complete the tackled set; an incomplete set warns and blocks no request or gate action, ADR 0155). Owner: `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` in `skills/docs/gate-review-sub-loop-contract.md`.
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
