# Audit Scope 3 & 4: Contradiction Scan + Phrase-Pin Zero-State

Audit date: 2026-07-06
Repo: /Users/mfittko/github/dev-loops
Context: v0.8 release gate contract audit (#1192), epic #1104

---

## Scope 3: Contradiction Scan

### 3.1 Deterministic Modality-Conflict Scanner Status

**Status: CLEAN and GATING.**

The scanner `scripts/docs/validate-rule-ownership.mjs` runs the full RFC-2119 modality-conflict check (`detectModalityConflicts`) as part of `validateRuleOwnership()`. It is gating (exit 1 on findings, verified by test `validateRuleOwnership gates on a modality conflict (no longer advisory)` in `test/docs/validate-rule-ownership.test.mjs:149`).

Current run result:
```
Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.
```

Scanner coverage:
- **Positive positive pairs**: MUST/SHALL vs SHOULD/MAY (MUST→SHOULD downgrade) — caught
- **Negative pairs**: MUST NOT/SHALL NOT vs SHOULD NOT/MAY NOT — caught
- **Order insensitivity**: verified by `test/docs/validate-rule-ownership.test.mjs:111-136`
- **SHALL/SHALL NOT equivalence**: treated as strong forms per RFC 2119 — verified by `test/docs/validate-rule-ownership.test.mjs:138-149`
- **Near-duplicate detection**: separate `detectNearDuplicates` pas with modality-stripped body comparison
- **Duplicate imperative sentence scan**: cross-file identical imperative prose detected
- **Rule-ID ownership**: duplicate definitions, unresolved references, undefined terms — all gating

### 3.2 Known Semantic Contradiction (Not Lexically Caught)

**Rule**: `VALIDATE-COVERAGE-THRESHOLD` vs `LOCAL-TEST-FIRST-COVERAGE`

| Aspect | Owner (`skills/docs/validation-policy.md:20`) | Non-owner (`skills/local-implementation/SKILL.md:111`) |
|---|---|---|
| Modality | MUST | SHOULD |
| Text | "Changed files MUST have ≥90% coverage for lines, statements, functions, and branches, and non-trivial logic MUST be test-first." | "You MUST work test-first for all non-trivial logic and SHOULD maintain 90% coverage thresholds (coverage is not enforced by the shipped verify config; treat it as the working target)." |
| Classification | **Modality downgrade (MUST→SHOULD)** on coverage thresholds | Restates same subject with weaker modality + "not enforced" disclaimer |

**Why the scanner doesn't catch it**: The lexical subject after normalization differs enough:
- Owner subject: `changed files have 90 coverage for lines statements functions and branches and non trivial logic be test first`
- Non-owner subject: `you work test first for all non trivial logic and maintain 90 coverage thresholds coverage is not enforced by the shipped verify config treat it as the working target`

The scanner normalizes by stripping modalities and non-alpha chars, but the wordings are too divergent for a lexical match. This is a **semantic contradiction** that requires the gate contradiction lens (`STYLE-CONTRADICTION-LENS` in `contract-style-guide.md`), not the lexical scanner.

**Pre-existing finding**: This contradiction was previously identified in reviewer outputs (`.pi-subagents/artifacts/57fd60b8_reviewer_0_output.md:16`).

### 3.3 No Other RFC-2119 Conflicts Found

- Scanner exit 0 across 100 files, 141 rules
- No duplicate rule definitions detected
- No unresolved rule references detected
- No undefined term uses detected
- No near-duplicate rule bodies detected
- No duplicate imperative sentences beyond intentional mirrors documented in `KNOWN_INTENTIONAL_DUPLICATE_SENTENCES`

### 3.4 Rule-ID Referenced Rules vs Owner Doc Wording

All `assertNotRestated` checks in contract tests (`test/contracts/*.test.mjs`) verify that non-owner docs do NOT restate the owner's exact wording. Verified non-restatement pairs include:
- `STOP-COPILOT-REVIEW-001` not restated in `public-dev-loop-contract.md` or `copilot-pr-followup/SKILL.md`
- Worktree rules not restated in referencing docs
- `ARTIFACT-TRACKER-FIRST-NO-DUP` not restated in `issue-intake-procedure.md`
- Intake lifecycle rules not restated outside owner

No rule referenced by ID was found to contradict its owner doc's wording beyond the known `VALIDATE-COVERAGE-THRESHOLD`/`LOCAL-TEST-FIRST-COVERAGE` downgrade above.

---

## Scope 4: Phrase-Pin Zero-State

### 4.1 AC2 Verification: Zero Exact-Sentence Pins on Normative Prose

**Status: CONFIRMED — zero exact-sentence pins remain.**

Evidence:

#### 4.1.1 Contract test helpers are structural, not phrase-based

`test/contracts/_rule-helpers.mjs` defines three assertion helpers:

| Helper | Mechanism | Phrase-pin? |
|---|---|---|
| `assertRulePresent(id)` | Checks `<!-- rule: ID -->` marker exists in repo | No — structural marker check |
| `assertRuleOwned(id, ownerPath)` | Checks marker appears exactly once in owner file | No — structural ownership check |
| `assertNotRestated(id, otherDocs)` | Checks other docs do NOT contain the owner's exact text | No — anti-restatement (negative check) |

`assertNotRestated` uses `content.includes(ownedText)` (line 81), which is an exact string match, but it asserts **absence** (restatement prevention), not presence. This is the anti-phrase-pin guard, not a phrase-pin.

#### 4.1.2 Loose regex token checks in contract tests

Contract tests use `assert.match(content, /pattern/i)` for structural presence checks — e.g.:
- `/MUST NOT request Copilot by posting literal/i` (`copilot-review-doc-contracts.test.mjs:73`)
- `/clean submitted Copilot review and an approved human review/i` (`inspect-run-viewer-rendering.test.mjs:723`)

These are **loose regex patterns**, not exact-sentence literal comparisons. They verify that docs cover specific topics/nouns, not that exact prose is verbatim in a specific location.

#### 4.1.3 Canonical PR creation contract

`test/contracts/canonical-pr-creation-contract.test.mjs` has a per-path allowlist (`ALLOWLIST`) for exact sentences but it is **empty by design** (`Object.freeze({})`). The heuristic uses regex-based safe-context markers, not sentence equality.

#### 4.1.4 Migration markers confirm completion

Multiple contract test files carry comments referencing the phrase-pin→rule-ID migration:
- `rule-id-doc-contracts.test.mjs:6`: "stop-conditions rules are owned by rule ID, not phrase pins"
- `issue-intake-doc-contracts.test.mjs:331`: "Stop-state behavior is rule-owned (INTAKE-STOP-STATES) rather than phrase-pinned"
- `review-doc-contracts.test.mjs:37`: "loose token check instead of the exact sentence (#1159)"
- `review-doc-contracts.test.mjs:86`: "loose token checks on the agent surface, not exact sentences (#1159)"
- `copilot-review-doc-contracts.test.mjs:354`: "the agent surface keeps a loose stop-and-ask token, not the exact sentence (#1159)"
- `copilot-review-doc-contracts.test.mjs:447`: "by ID rather than restating the phrase-pinned prose (#1154)"
- `gate-sub-loop-no-fork-claim-contract.test.mjs:63`: "durable via single-owner rule ID, not phrase-pinned prose"

Issues #1154 and #1159 drove the migration from phrase-pins to rule-ID/structural checks. All references to the old approach are within comments explaining why the current approach is different.

### 4.2 No Test Files Use Phrase-Pin Assertions

Searched entire `test/` directory for:
- Exact normative sentences from docs (`MUST stop before merge`, `MUST fail closed to reconcile`, etc.) — found only in test fixtures, not as assertions
- `assert.equal(content, exactProse)` patterns — none found
- `assert.ok(content.includes(exactNormativeSentence))` outside `assertNotRestated` — none found

The `validate-rule-ownership.test.mjs` test at line 150-158 is the repository-wide integration test:
```js
test("repository rule ownership fixture is valid", async () => {
  const result = await validateRuleOwnership();
  assert.equal(result.ok, true, ...);
});
```
This validates the entire rule corpus structurally — no prose comparison.

---

## Summary

| Scope | Finding | Status |
|---|---|---|
| 3.1 | Deterministic modality-conflict scanner is gating and clean | ✅ |
| 3.2 | `VALIDATE-COVERAGE-THRESHOLD` / `LOCAL-TEST-FIRST-COVERAGE` semantic downgrade | ⚠️ Known, not lexically catchable |
| 3.3 | No other RFC-2119 conflicts across 100 docs / 141 rules | ✅ |
| 3.4 | No rule-ID-referenced rules contradict owner wording (beyond 3.2) | ✅ |
| 4.1 | AC2: zero exact-sentence pins on normative prose remain | ✅ |
| 4.2 | No test files use phrase-pin assertions instead of rule-ID/structural checks | ✅ |

---