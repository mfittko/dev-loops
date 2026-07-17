# Lane A v0.8 release audit — rule ownership / phrase pins / modality

Issue source: `gh issue view 1192 --json body,comments,title,number,state,url` showed issue #1192 is open and has `comments: []` / `commentCount: 0`.

## Verdict

**Blocking findings present.** `validate-rule-ownership.mjs` and related tests are green, but the lane contract is not clean: canonical-owner opening lines are missing in 10 rule-bearing normative docs, and at least one exact-sentence phrase pin remains in `test/contracts`.

## Blocking findings

### B1 — Canonical-owner opener zero-state not met

The #1192 lane requires every normative doc to open with a canonical-owner line. Scanning rule-bearing docs as normative found 25 docs, with 10 first prose lines not matching `Canonical owner for ...`.

Evidence command: inline Node scanner over `skills`, `agents`, `commands`, `docs` markdown; skipped frontmatter/headings; selected files containing `<!-- rule: ... -->`.

Output excerpt:

```text
rule-bearing normative docs=25
missing canonical owner opener=10
- skills/copilot-pr-followup/SKILL.md:16 This skill is the canonical internal `copilot_pr_followup` route behind the public `dev-loop` façade.
- skills/docs/artifact-authority-contract.md:3 This document is the canonical authority for the artifact-selection model: whether a work item originates from a GitHub issue (tracker-first) or from a persisted markdown plan file (local-planning).
- skills/docs/copilot-loop-operations.md:3 This document is the canonical operational reference for the deterministic Copilot PR follow-up state machine used by the routed `copilot_pr_followup`, `wait_watch`, `reviewer_fixer`, and `final_approval` paths behind `dev-loop`.
- skills/local-implementation/SKILL.md:16 This skill is the canonical internal `local_implementation` route behind the public `dev-loop` façade.
- docs/IMPLEMENTATION_WORKFLOW.md:3 This repository supports both a local phased workflow and a GitHub-first remote workflow.
- docs/conductor-routing-contract.md:3 This document defines the **conductor routing contract** for an already-targeted active run: which loop family
- docs/copilot-loop-state-graph.md:3 This document defines the deterministic state machine for the async Copilot review/fix loop.
- docs/reviewer-loop-state-graph.md:3 This document defines the deterministic reviewer-side PR loop state machine.
- docs/sub-issue-tree-contract.md:3 This document defines the deterministic pattern for epic/umbrella issue decomposition using
- docs/worktree-guidance.md:5 This document is the canonical repo-level owner for local worktree usage guidance in
```

Blocking reason: #1192 says “every normative doc opens with a canonical-owner line”; these do not.

### B2 — Phrase-pin zero-state not met in `test/contracts`

At least one exact sentence from normative prose is still pinned in a contract test.

Evidence:

- Source normative prose: `skills/copilot-pr-followup/SKILL.md:190`

```text
Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.
```

- Exact test pin: `test/contracts/copilot-review-doc-contracts.test.mjs:125`

```js
/Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA\. Do not stop or report completion without this evidence\./i,
```

- Adjacent stronger pin: `test/contracts/copilot-review-doc-contracts.test.mjs:120` asserts the doc says `Every async dev-loop dispatch task body must include this clause verbatim`, matching `skills/copilot-pr-followup/SKILL.md:188`.

Scanner output:

```text
exact sentence pins with normative-doc hits=1
- test/contracts/copilot-review-doc-contracts.test.mjs:125 -> skills/copilot-pr-followup/SKILL.md :: Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.
```

Blocking reason: #1192 scope item 4 requires “no exact-sentence pins on normative prose remain in test/contracts.”

## Passing / non-blocking checks

- `scripts/docs/validate-rule-ownership.mjs` is green.
- Required-rules manifest coverage is clean: 141 rule definitions, 141 manifest entries, no missing or extra IDs.
- Exact owned rule text is not restated outside owner docs by direct scan: 0 findings.
- Deterministic modality-conflict scan is present and covered:
  - `scripts/docs/validate-rule-ownership.mjs:264-299` groups by normalized subject and compares all pairs, order-insensitive.
  - `test/docs/validate-rule-ownership.test.mjs:118-162` covers order-insensitivity, `MUST`/`SHOULD`, negative downgrades, and `SHALL` equivalence.
- Relevant tests pass.

## Commands and exit codes

| Command | Exit | Evidence |
|---|---:|---|
| `gh issue view 1192 --json number,title,comments --jq '{number,title,commentCount:(.comments|length)}'` | 0 | `{"commentCount":0,"number":1192,"title":"Release gate: independent contract audit before rolling v0.8"}` |
| `node scripts/docs/validate-rule-ownership.mjs` | 0 | `Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.` |
| `npm run test:docs` | 0 | `Markdown links OK (97 files, 512 links checked).` and rule ownership passed. |
| `node --test --test-reporter ./test/failure-summary-reporter.mjs test/docs/validate-rule-ownership.test.mjs test/contracts/rule-id-doc-contracts.test.mjs test/contracts/worktree-rule-ownership-contract.test.mjs test/contracts/intake-spike-epic-lifecycle-rule-ownership-contract.test.mjs test/contracts/copilot-review-doc-contracts.test.mjs test/contracts/issue-intake-doc-contracts.test.mjs` | 0 | `tests 59`, `pass 59`, `fail 0`. |
| Inline Node manifest scanner | 0 | `validator ok=true`, `rules=141`, `requiredRules=141`, `manifest count matches rules=true`. |
| Inline Node canonical opener scanner | 0 | `rule-bearing normative docs=25`, `missing canonical owner opener=10`. |
| Inline Node exact owned-text restatement scanner | 0 | `rules checked=141`, `exact owned-text restatements=0`. |
| Inline Python exact-sentence pin scanner | 0 | `exact sentence pins with normative-doc hits=1`. |
| `git diff --name-only && git diff --cached --name-only && git status --short --untracked-files=no` | 0 | no output; no tracked or staged changes before audit artifact writes. |

## Residual risks

- The canonical-opener scan treats rule-marker docs as normative. If release scope uses a broader normative-doc definition, more opener misses may exist.
- The phrase-pin scanner is conservative for exact full sentences; broader exact phrase pins also remain, but B2 is enough to block the lane.
- `validate-rule-ownership.mjs` currently passes despite B1/B2, so the release gate should not rely on that validator alone for these two zero-state checks.

## Audit classification

- **Blocking:** B1, B2.
- **Non-blocking/pass:** manifest coverage, no exact owned-text restatements, modality-conflict determinism, current validator/test status.