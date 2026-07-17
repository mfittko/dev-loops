# Lane C audit: semantic drift spot-checks + epic closeout

Repo: `/Users/mfittko/github/dev-loops`  
HEAD audited: `bd71a006328b66fc60900586da13611e96515f4f` (`main`)  
Baseline: `02bd0de0^` = `8cda46daea2f838962f1fc653ddd123fbb167278`  
GitHub inputs read: #1192 body/comments; #1104 body/comments.

## Blockers

1. **#1104 AC3 is not met: `public-dev-loop-routing` is named in the epic but not registered in the L2/L3 harness.**
   - #1104 AC3 requires all named state machines, including `public-dev-loop-routing`, to be L2-conformance-checked and pass L3 invariants.
   - Local evidence: `node scripts/docs/validate-state-machine-conformance.mjs` prints only:
     - `Machine pr-gate-coordination: PASS`
     - `Machine conductor-routing: PASS`
     - `Machine copilot-loop-state: PASS`
     - `Machine reviewer-loop-state: PASS`
   - Test evidence: `test/docs/validate-state-machine-conformance.test.mjs:190` only requires `["pr-gate-coordination", "conductor-routing", "copilot-loop-state", "reviewer-loop-state"]`.
   - `public-dev-loop-routing` is exported and tested elsewhere, but it is not part of this L2/L3 conformance registry, so AC3's stated coverage is false.

2. **Post-epic #1210 introduces semantic contradiction in artifact authority rules.**
   - `skills/docs/artifact-authority-contract.md:12` still says: “Every work item MUST originate from exactly one authoritative artifact: a GitHub issue or a persisted markdown plan file. Work MUST NOT originate from a PR or a direct local change unless explicitly requested.”
   - Same file now says issue-less PR-first is valid:
     - `skills/docs/artifact-authority-contract.md:55`: “when the PR is the sole artifact with no backing issue (`--lightweight` alone, issue-less PR-first)”
     - `skills/docs/artifact-authority-contract.md:58`: “It composes with `--issue` ... or stands alone (issue-less PR-first, #1210...)”
     - `skills/docs/artifact-authority-contract.md:67`: lightweight GitHub issue required is “Conditional ... absent for issue-less PR-first.”
   - Root repo contract is also stale/contradictory: `AGENTS.md:19` still says all work must originate from a GitHub issue or persisted markdown plan file and “No work may originate from a PR or direct local change unless explicitly requested.”
   - This is a real semantic drift, not wording-only condensation. Either the two-tier rule and repo contract need the #1210 exception, or #1210 must not allow issue-less PR-first.

3. **#1104 AC5 / #1192 release audit word-count lens fails at audited HEAD.**
   - Corpus counted per #1192 scope: `skills/docs`, `docs/`, `skills/*/SKILL.md`, `agents/`, `commands/` markdown files.
   - Baseline `8cda46d`: 86 files, **99,734 words**, **11,970 lines**.
   - Epic sweep commit `4c50e1c9` (#1159/#1204): 87 files, **99,437 words** (**-297**), **12,013 lines** (**+43**).
   - Post-pin-sweep `43c67753` (#1205/#1206): 87 files, **99,495 words** (**-239**), **12,016 lines** (**+46**).
   - Audited HEAD `bd71a006`: 87 files, **100,253 words** (**+519**), **12,068 lines** (**+98**) vs pre-epic baseline.
   - Largest positive word deltas at HEAD: `skills/docs/contract-style-guide.md` +502, `docs/gate-review-sub-loop-contract.md` +400, `docs/reviewer-loop-state-graph.md` +341, `skills/docs/stop-conditions.md` +291.
   - #1192 asks the release audit to judge AC5 against pre-epic baseline at audited head, not batch arithmetic. That verdict is **not met**.

4. **#1104 DoD3 closeout evidence is absent.**
   - #1104 remains `OPEN`, `closedAt: null`.
   - #1104 has 4 comments, all pre-execution architecture/conformance discussion. No closing comment exists with the required word-count roll-up and final validator/harness status.
   - Therefore DoD3 is not met even where local validators pass.

5. **Residual exact normative phrase pin remains after #1205 “zero-pin end state.”**
   - `test/contracts/public-facade-doc-contracts.test.mjs:382` asserts the exact sentence `/When creating GitHub issues via `gh issue create`, always include `--assignee @me`/i`.
   - Source sentence is normative repo contract text at `AGENTS.md:16`.
   - #1104 AC2 and #1205 AC1 require zero exact-sentence pins on normative prose in `test/contracts/*`. This is at least one remaining exact normative phrase pin.

## Non-blocking evidence / passes

- #1104 sub-issue tree is closed: #1147, #1148, #1149, #1150, #1151, #1152, #1153, #1154, #1155, #1156, #1157, #1158, #1159 are all `CLOSED`.
- Post-epic issues sampled are closed: #1190, #1193, #1200, #1205, #1207, #1210.
- Required-rules ownership validator passes locally: `141 rules, 13 references, 30 terms, 100 files scanned`.
- No stale known-gap allowlist for #1190 remains in L2 output; grep shows the old entry-ordering gap is now documented as fixed and tested.
- `npm run verify`, `npm run test:docs`, `npm run test:assets`, and `node scripts/docs/validate-state-machine-conformance.mjs` pass locally.

## Semantic drift spot-checks

Sample method: diff sampled rule rewrites against `8cda46d` baseline where the rule existed, or against the immediate introducing/fixing commit when post-epic behavior was new. Full exact sentence-by-sentence proof is not claimed; this is a lane C spot-check.

| Batch | Sample checked | Git-history verdict |
|---|---|---|
| #1147 | `STOP-HUMAN-MERGE-001`: baseline “Always stop at merge... agent never runs `gh pr merge`” → MUST stop + MUST NOT run `gh pr merge`. | No drift found. |
| #1148 | L2/L3 harness/style guide addition. | No reworded corpus rule sample; harness passes registered machines, but AC3 coverage gap found for `public-dev-loop-routing`. |
| #1149 | `GATE-COMMENT-FAIL-CLOSED`: baseline “workflow must not cross the gate boundary” → `MUST NOT cross`. | No drift found. |
| #1150 | `FACADE-BOOTSTRAP-*` table split: long bootstrap exception paragraph → discrete route/quiet/action_required/closed-unmerged/follow-up/worktree rows. | No drift found in sampled rows; separate AC3 coverage gap remains. |
| #1151 | `WORKTREE-DEFAULT-USE`: baseline “Do not use main checkout... create or reuse dedicated worktree; default creation flow should start from origin/main” → MUST use dedicated worktree; main checkout inspection-only. | No drift found; firmness increased. |
| #1156 | `QUEUE-NEXTUP-SOURCE` / fail-closed rows: baseline Next Up fail-closed source → MUST pick only Next Up and no Backlog fallback. | No drift found. |
| #1157 | `COPILOT-STATE-ACTIVE-REQUEST-WAIT` and reply-before-rerequest rules. | No drift found; later #1200 fixed reviewer graph table gap. |
| #1158 | `ARTIFACT-TWO-TIER-EXCLUSIVE`: baseline issue-or-plan origin, no PR/direct origin unless explicit. | No drift at batch time; later #1210 contradicts it. |
| #1153 | Local implementation/gate references, e.g. `GATE-EXEC-POST-BEFORE-FIX` and `LOCAL-*` ownership. | No drift found in sampled gate sequencing; references preserved owner semantics. |
| #1154 | Copilot follow-up condensation: gate fan-out and comment fields replaced by `GATE-EXEC-*`/`GATE-COMMENT-*` references. | No drift found in sampled gate reference path. |
| #1159 | Final sweep: validation and small docs got owner lines/rule IDs; agents/commands firmed wording. | Local validator passes; residual exact pin still found post-#1205. |
| #1190 | Converge-then-gate fix. | Conformance output passes; no stale known-gap output. |
| #1200 | Reviewer submission-failure edges added to `REVIEWER_TRANSITIONS` and docs. | No drift found; aligns table to interpreter fail-closed behavior. |
| #1205 | Residual normative phrase-pin migration. | Drift/blocker: at least one exact normative phrase pin remains in `test/contracts/*`. |
| #1207 | Invariant-prefix-first reviewer briefing rule. | No drift found in sampled rule; registered in required rules and verify passes. |
| #1210 | Issue-less lightweight PR-first. | Drift/blocker: contradicts same-file two-tier origin rule and `AGENTS.md`. |
| #1193 | PR lifecycle exported state machine / code-derived atlas. | No drift found in sampled doc addition; +11 words net per PR body, verify passes. |

## #1104 AC verdict

| ID | Status | Evidence |
|---|---|---|
| AC1 | Pass locally | `npm run test:docs` passed; ownership validator: 141 rules, 13 references, 30 terms, 100 files scanned. |
| AC2 | **Fail** | Residual exact normative phrase pin at `test/contracts/public-facade-doc-contracts.test.mjs:382` pinning `AGENTS.md:16`. |
| AC3 | **Fail** | #1104 names `public-dev-loop-routing`; conformance CLI/test registry only covers four machines and omits it. |
| AC4 | Partial / risk | Validator passes and #1210 contradiction is semantic, not caught deterministically. RFC-2119 semantic contradiction still exists in artifact authority. |
| AC5 | **Fail at audited HEAD** | Baseline 99,734 words / 11,970 lines; HEAD 100,253 words / 12,068 lines = +519 words / +98 lines. |
| AC6 | Pass for local validation, incomplete for closeout | `npm run verify` passed locally. Child PRs all merged, but #1104 final evidence comment is absent. |

## #1104 DoD verdict

| ID | Status | Evidence |
|---|---|---|
| DoD1 | Pass | Sub-issues #1147-#1159 including umbrellas #1152/#1155 are closed via merged PRs. |
| DoD2 | Pass locally | Required-rules manifest validated by `validate-rule-ownership.mjs`; old duplicate-rule script not present in npm `test:docs`. |
| DoD3 | **Fail** | #1104 is open and has no closing comment containing word-count roll-up plus final validator/harness status. |

## Commands run

- `git status --short` / `git rev-parse 02bd0de0^` / `git rev-parse HEAD` — confirmed baseline and no tracked mutation.
- `gh issue view 1192 --json ...` — read release-gate issue; no comments.
- `gh issue view 1104 --json ...` — read epic body/comments; state `OPEN`, no closeout comment.
- `gh issue view` for #1147/#1148/#1149/#1150/#1151/#1152/#1153/#1154/#1155/#1156/#1157/#1158/#1159/#1190/#1193/#1200/#1205/#1207/#1210 — confirmed states/comments.
- `gh pr view` for #1183/#1189/#1191/#1194/#1195/#1197/#1199/#1201/#1202/#1203/#1204/#1206/#1214/#1215/#1216/#1219/#1221 — checked merge/evidence/status rollups.
- `npm run test:docs` — passed: links OK; rule ownership validation passed.
- `node scripts/docs/validate-state-machine-conformance.mjs` — passed for 4 registered machines; exposed AC3 omission.
- `npm run test:assets` — passed: 189 tests.
- `env -u PI_SUBAGENT_RUN_ID -u DEVLOOPS_RUN_ID npm run verify` — passed all suites: assets 189, extension 81, scripts 2312 (36 skipped), core 1865, docs, dev-loop 32.
- `rg` sweeps for known gaps, exact pins, artifact contradictions, and public routing registration.
- Python/git count script over scoped markdown corpus at baseline/epic-close/post-pin/HEAD.

## Validation output highlights

```text
Markdown links OK (97 files, 512 links checked).
Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.
Machine pr-gate-coordination: PASS
Machine conductor-routing: PASS
Machine copilot-loop-state: PASS
Machine reviewer-loop-state: PASS
npm run verify: pass (all suites green)
```

## Residual risks

- This was a spot-check, not full semantic proof over every rewritten sentence.
- GitHub PR status rollups show CI success, but some formal review entries are `COMMENTED` rather than `APPROVED`; I treated merged PR + local verify as sufficient for this lane unless closeout evidence required more.
- The exact-pin sweep used regex search plus manual classification; more residual normative pins may exist.

## No tracked mutation

- No tracked file diff.
- No staged files.
- Only requested untracked `.pi-subagents/...` progress/output artifacts were written.