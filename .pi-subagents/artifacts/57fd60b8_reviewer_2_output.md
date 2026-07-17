# Scope 7c/7d — Semantic dedup + condensation lens (independent)

Reviewer: fresh semantic pass over the epic #1104 contract-normalization slice
(baseline `8cda46da` → HEAD `4d57797e`). Mechanical roll-up source:
`tmp/audits/GLM-5.2-FP8/mechanical/07ab-wordcount-rollup.md`.
Ownership model: `skills/docs/required-rules.json` + `skills/docs/contract-style-guide.md`
(`STYLE-SINGLE-OWNER`, `STYLE-REFERENCE-BY-ID`, `STYLE-RULE-MARKER`, `STYLE-TERM-MARKER`,
`STYLE-DEFINED-TERMS`).

---

## AC5 VERDICT

**Epic #1104 AC5 ("total corpus word count reduced with zero information loss") is NOT
met against the pre-epic baseline, as literally worded.**

| Metric | Baseline (`8cda46da`) | HEAD (`4d57797e`) | Delta |
|---|---|---|---|
| Words | 99,734 | 100,444 | **+710** |
| Lines | 11,969 | 12,073 | **+104** |

The total is net-**positive**, not reduced. The epic did execute substantial genuine
condensation — `skills/local-implementation/SKILL.md` (-827), `docs/projects-queue-usage.md`
(-318), `skills/copilot-pr-followup/SKILL.md` (-239), `docs/queue-board-setup.md` (-96),
`docs/worktree-guidance.md` (-64) — by replacing restated behavior with rule-ID references.
But that condensation was outweighed by the **new ownership substrate** it had to erect to
make the dedup machine-checkable:

- `skills/docs/contract-style-guide.md` — brand-new doc, +502 words (≈71% of net growth)
- rule-ID marker lines (`<!-- rule: ... -->` + `` `RULE-ID` `` headers) added across ~11
  contract docs (65 new markers counted across the top-growing docs)
- `## Terms` tables (`<!-- term: ... -->`) added to `stop-conditions.md`, `pr-lifecycle-contract.md`,
  `reviewer-loop-state-graph.md`, `copilot-loop-state-graph.md`, `steering-contract.md`
- `## Required transitions` sections added to three state-graph docs (net-new normative
  content replacing ASCII art — defensible, but still words)

**Information-loss check:** no rule semantics were dropped. Every behavior present at
baseline survives at HEAD, either in-place or migrated to an owning rule table. The
"zero information loss" half of AC5 is satisfied; the "word count reduced" half is not.

**Net assessment:** AC5 needs either (a) a re-baseline against a post-substrate reference
point, or (b) execution of the condensation candidates below to push the corpus below
99,734 words. The candidates in §4 total an estimated **~520–600 words** of recoverable
verbosity — enough, if applied, to bring HEAD to roughly 99,844–99,924 words, still above
baseline. Closing the remaining gap requires either accepting the substrate as the new
floor (re-baseline) or trimming the briefing-prefix over-specification (candidate #1, the
single largest residual).

---

## 1. Ownership model summary (what the semantic pass checks against)

`STYLE-SINGLE-OWNER`: each rule has exactly one defining source doc; every other doc
references by ID and MUST NOT restate the rule text. `STYLE-REFERENCE-BY-ID` enforces the
no-duplicate clause. `STYLE-RULE-MARKER`/`STYLE-TERM-MARKER` make ownership machine-checkable.
`contract-style-guide.md` grants: *"A short orientation paragraph introduces the document;
normative rules live only in the rule table."* — one orientation paragraph per doc that
introduces no rules is allowed.

The semantic lens below finds cases a lexical scanner misses: same-behavior rules phrased
differently, procedures narrated around an already-owned rule, and orientation paragraphs
that cross into restating a rule.

---

## 2. Semantic dedup findings (7c)

### Finding 1 — Briefing-prefix invariant specified ~5× in one doc (HIGH)

**Owner:** `docs/gate-review-sub-loop-contract.md`, rule `GATE-EXEC-BRIEFING-PREFIX` (lines
~148–173).

The invariant-prefix requirement is restated, with overlapping prose, in five places within
the same file:

1. `GATE-EXEC-BRIEFING-PREFIX` rule body (lines ~148–160) — canonical owner, ~120 words.
2. "**Enforcement.**" paragraph immediately after (lines ~162–173) — ~180 words re-explaining
   the `--prefix-hash`/`--prefix-file` mechanism, the `verify-briefing-prefixes.mjs`
   fail-closed semantics, the hashless-sentinel rule, and the same-head caveat. This is
   normative detail that the rule body already covers or could absorb.
3. Phase 1 "Mandatory" line (line ~64): *"every gate-review subagent must run
   `scripts/github/verify-fresh-review-context.mjs --scope <angle> --context-path <path>
   --prefix-hash <sha256>` (or `--prefix-file <path>`) ... and `--prefix-hash`/`--prefix-file`
   to record the invariant-briefing prefix hash enforced by `GATE-EXEC-BRIEFING-PREFIX`."*
4. Phase 2 reviewer "Mandatory" line (line ~135): restates the **same** invocation ("the same
   invocation Phase 1 mandates") then re-explains every flag (`--scope`, `--context-path`,
   `--prefix-hash`/`--prefix-file`) plus the head-SHA sentinel lifecycle — ~140 words.
5. Phase 3 pre-consolidation check (lines ~217–221): *"Before consolidating, run
   `scripts/github/verify-briefing-prefixes.mjs --head-sha <sha>` (the
   `GATE-EXEC-BRIEFING-PREFIX` enforcement check); a fail-closed result ... MUST stop the
   pass."* — a third restatement of the enforcement outcome.

This is the single largest cluster of residual verbosity the epic left behind. The rule body
+ one short Phase-2 pointer + the Phase-3 one-liner would carry the full invariant.
**Estimated recoverable: ~250–300 words.** See candidate #1.

### Finding 2 — `verify-fresh-review-context.mjs` invocation duplicated Phase 1 ↔ Phase 2 (MEDIUM)

Same doc, `docs/gate-review-sub-loop-contract.md`. Phase 1 (line ~64) and Phase 2 (line ~135)
both spell out the full `verify-fresh-review-context.mjs --scope ... --context-path ...
--prefix-hash ...` command and re-explain the `--scope`/`--context-path` rationale. Phase 2
explicitly says "the same invocation Phase 1 mandates" then re-derives the rationale anyway.
A lexical scanner sees different surrounding words; semantically it is the same procedure
stated twice. **Recoverable: ~70–90 words** by collapsing Phase 2 to a one-line reference.

### Finding 3 — Stop-boundary behavior restated without rule-ID reference (MEDIUM)

**Location:** `skills/docs/public-dev-loop-contract.md` lines 44–48, "Stop-boundary contract
for this shorthand":

> 1. continue through the normal GitHub/Copilot loop ... unless a genuine stop condition is reached
> 2. stop at the final human approval decision by default
> 3. after formal approval, stop again in `waiting_for_merge_authorization` unless merge authorization is explicitly granted for the active issue/PR scope
> 4. merge only after explicit merge authorization for the active issue/PR scope

Items 2–4 behaviorally restate `STOP-APPROVAL-001`, `STOP-MERGE-AUTH-001`, and
`STOP-HUMAN-MERGE-001` (owned in `skills/docs/stop-conditions.md`) **without** a rule-ID
reference. This is exactly the "procedure narrated around an already-owned rule" pattern
`STYLE-REFERENCE-BY-ID` forbids. Note: this section was not touched by the epic, so it is
pre-existing drift, not a regression — but it is live semantic duplication the dedup pass
should close. **Recoverable: ~30–40 words** by replacing items 2–4 with ID references.

### Finding 4 — `STOP-RECONCILE-001` vs `ROUTING-FAIL-CLOSED-RECONCILE` overlap (LOW — not a true duplicate)

`stop-conditions.md` `STOP-RECONCILE-001`: *"Ambiguous or contradictory state ... The loop
MUST fail closed to `needs_reconcile`."* `conductor-routing-contract.md`
`ROUTING-FAIL-CLOSED-RECONCILE`: *"The evaluator MUST fail closed to `needs_reconcile` rather
than guessing a handoff when: [4 routing-specific conditions]."* These share the
`needs_reconcile` sink and the fail-closed modality, but the conductor rule is scoped to the
**routing evaluator** with routing-specific preconditions (unresolved target, absent state
inputs, duplicate owners, unrecognized combined state). This is a defensible scope split, not
a restatement. **No action.** Flagged only because a lexical scan would surface it.

### Finding 5 — Disposition-ledger restatement largely resolved (GOOD, residual LOW)

Pre-epic, the disposition-ledger rule was restated across `gate-review-sub-loop-contract.md`,
`gate-review-comment-contract.md`, and `pr-lifecycle-contract.md`. The epic consolidated
ownership into `GATE-EXEC-DISPOSITION-LEDGER` and replaced the cross-doc restatements with
ID references:

- `gate-review-comment-contract.md` "Disposition ledger" section now reads:
  *"Durable-ledger sequencing and content are owned by `GATE-EXEC-DISPOSITION-LEDGER` ..."*
- `pr-lifecycle-contract.md` evidence class 3 collapsed to:
  *"durable disposition ledger — owned by `GATE-EXEC-DISPOSITION-LEDGER`"*
- `gate-review-sub-loop-contract.md` Phase 3 now defers: *"Ledger content and
  write-before-comment sequencing are owned by `GATE-EXEC-DISPOSITION-LEDGER` below."*

This is the model the rest of the corpus should follow. **Residual:** the `GATE-EXEC-DISPOSITION-LEDGER`
rule body itself (~40 words) and the `write-gate-findings-log.mjs` shell block below it
overlap slightly with `GATE-EXEC-POST-BEFORE-FIX`'s "before the visible PR comment" sequencing
— minor, not worth a separate condensation pass.

### Finding 6 — Orientation-paragraph exception respected (GOOD)

Checked the openers of the top-growing docs against the `STYLE-CANONICAL-OPENER` /
one-orientation-paragraph allowance:

- `contract-style-guide.md`: *"Canonical owner for contract style, rule IDs, and definitional
  discipline."* — introduces no rules. ✓
- `gate-review-sub-loop-contract.md`: opener + "## Purpose" one-liner — orientation only. ✓
  (The old "## Relationship to the checkpoint verdict comment contract" prose section was
  **deleted** and folded into a one-line scope bullet — a net condensation win.)
- `stop-conditions.md`, `pr-lifecycle-contract.md`, `projects-queue-contract.md`,
  `reviewer-loop-state-graph.md`, `copilot-loop-state-graph.md`, `steering-contract.md`:
  openers introduce the doc, rules live in marked tables. ✓

No orientation paragraph was found that restates a rule. Finding 3 (public-dev-loop-contract)
is the one exception, and it is a numbered procedure list, not an orientation paragraph.

---

## 3. Growth attribution (7b semantic overlay)

For the five top-growing docs, the added lines are classified as: **(i)** machine
annotation / rule-ID marker, **(ii)** genuinely new normative prose, **(iii)** residual
verbosity.

### `skills/docs/contract-style-guide.md` — +502 W / +37 L (0 → 502)
Entirely new doc. **(ii) ~95%** genuinely new normative prose (the style substrate:
RFC-2119 keywords, single-owner, rule/term markers, ID scheme, precedence, contradiction
lens, lexical-scan-limit). **(i) ~5%** the rule/term markers themselves. **(iii) 0%.**
This is the substrate that enables every other dedup; it is net-new infrastructure, not
condensable.

### `docs/gate-review-sub-loop-contract.md` — +400 W / +36 L
- **(i) ~35%** — 9 new `<!-- rule: GATE-EXEC-* -->` markers + `` `RULE-ID` `` headers +
  the inline `STYLE-RULE-MARKER` lines.
- **(ii) ~40%** — genuinely new normative prose: `GATE-EXEC-BRIEFING-PREFIX` (the
  invariant-prefix rule did not exist at baseline), `GATE-EXEC-LIGHT-ESCALATION`
  (two-trigger escalation), the Phase-3 pre-consolidation check, `--prefix-hash`/`--prefix-file`
  flag wiring.
- **(iii) ~25%** — residual verbosity: the briefing-prefix invariant restated ~5×
  (Finding 1), the Phase 1↔Phase 2 `verify-fresh-review-context.mjs` duplication (Finding 2).
  This is the doc with the most recoverable slop.

### `docs/reviewer-loop-state-graph.md` — +341 W / +51 L
- **(i) ~20%** — `<!-- term: state:* -->` markers on 4 states + 2 `<!-- rule: -->` markers.
- **(ii) ~75%** — the entire `## Required transitions` section (net-new normative: explicit
  transition list with per-edge guards, terminal-state declaration, legacy-state ownership
  note). This replaces the baseline's implicit graph and is defensible new content.
- **(iii) ~5%** — the `REVIEWER-BOUNDARY-CONTRACT` rule absorbed three pre-existing bullets
  into one rule body; minor overlap with the "Default forward-progress rule" bullets that
  follow it.

### `skills/docs/stop-conditions.md` — +291 W / +15 L
- **(i) ~70%** — 11 `<!-- rule: STOP-* -->` markers + `` `RULE-ID` `` column added to two
  existing tables + the new `## Terms` table (9 `<!-- term: -->` markers). The underlying
  rules are unchanged from baseline; this is almost pure annotation overhead.
- **(ii) ~25%** — RFC-2119 keyword upgrades ("Stop for human decision" → "The loop MUST stop
  for a human decision") and the `## Terms` definitions (state/reason canonicalization).
- **(iii) ~5%** — negligible.

### `docs/conductor-routing-contract.md` — +31 W / +13 L
- **(i) ~45%** — 4 `<!-- rule: ROUTING-* -->` markers.
- **(ii) ~40%** — `## Required transitions` section (net-new), the fail-closed-no-live-handoff
  paragraph.
- **(iii) ~15%** — the "Direct routing vs reconcile" rewrite is a condensation (collapsed
  two tables into one paragraph) but the `ROUTING-FAIL-CLOSED-RECONCILE` reference sentence
  is slightly circular.

### `docs/copilot-loop-state-graph.md` — +146 W / +2 L
- **(i) ~30%** — 5 rule/term markers.
- **(ii) ~60%** — `## Required transitions` (net-new), `internal_tooling_direct_gate` state +
  transition, `done`-definition broadening.
- **(iii) ~10%** — the `COPILOT-STATE-WATCH-PERSISTENCE` rule body re-cites
  `STOP-COPILOT-REVIEW-001`/`STOP-QUIET-WATCHER-001` inline (correct referencing, slight
  restatement of the continuation-not-completion idea).

**Attribution summary:** of the +710 net words, roughly **+502** is the new style-guide
substrate, **~+150** is net-new normative content (Required-transitions sections, new
rules like BRIEFING-PREFIX/LIGHT-ESCALATION), and **~+60** is rule-ID annotation overhead.
Residual verbosity recoverable via condensation is concentrated almost entirely in
`gate-review-sub-loop-contract.md` (the briefing-prefix cluster).

---

## 4. Condensation candidates (7d) — ranked

Every candidate below is a zero-semantic-change condensation (replace restatement with an
ID reference or collapse a duplicated procedure). Candidates worth >~50 words become filed
`pre-v0.8` condensation issues unless waived.

| Rank | Location (path + rule/section) | What to condense | Expected word savings | Semantic change? (must be NO) | Waive? (Y/N + reason) |
|---|---|---|---|---|---|
| 1 | `docs/gate-review-sub-loop-contract.md` — `GATE-EXEC-BRIEFING-PREFIX` rule + "Enforcement." para + Phase 1 Mandatory line + Phase 2 Mandatory line + Phase 3 pre-consolidation check | Collapse the 5 restatements of the invariant-prefix invariant into: the rule body (owner) + one short Phase-2 pointer ("run the `GATE-EXEC-BRIEFING-PREFIX` invocation") + the Phase-3 one-liner. Move the `verify-briefing-prefixes.mjs` fail-closed/hashing detail into the rule body once; delete the standalone "Enforcement." paragraph. | ~250–300 | NO — same invariant, single owner | N |
| 2 | `docs/gate-review-sub-loop-contract.md` — Phase 2 reviewer "Mandatory" `verify-fresh-review-context.mjs` line (line ~135) | Replace the re-derived `--scope`/`--context-path`/`--prefix-hash` rationale with "run the Phase-1 `verify-fresh-review-context.mjs` invocation; the sentinel is head-keyed (see Sentinel lifecycle)." | ~70–90 | NO | N |
| 3 | `skills/docs/public-dev-loop-contract.md` — "Stop-boundary contract for this shorthand" items 2–4 (lines 46–48) | Replace the three behavioral restatements with rule-ID references to `STOP-APPROVAL-001`, `STOP-MERGE-AUTH-001`, `STOP-HUMAN-MERGE-001`. | ~30–40 | NO | N — pre-existing drift, but live dup; small savings, file as part of a stop-conditions cross-ref sweep |
| 4 | `docs/gate-review-sub-loop-contract.md` — `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK` rule body vs the deleted "Reviewers run in parallel when practical" prose | Already partially condensed (old prose replaced by the rule). Residual: the rule body repeats "when parallel execution is impractical" twice. Trim to one clause. | ~10 | NO | Y — below 50-word threshold, fold into candidate #1's edit |
| 5 | `docs/reviewer-loop-state-graph.md` — `REVIEWER-BOUNDARY-CONTRACT` rule body vs the "Default forward-progress rule" bullets that follow it | The rule body already states the boundary; the following bullets re-narrate forward-progress/early-stop conditions. Tighten the bullets to reference the rule. | ~20–30 | NO | Y — below threshold; the bullets add operator-facing guidance not fully in the rule |
| 6 | `docs/copilot-loop-state-graph.md` — `COPILOT-STATE-WATCH-PERSISTENCE` rule body | Rule re-cites `STOP-COPILOT-REVIEW-001`/`STOP-QUIET-WATCHER-001` (correct) but re-narrates the "continuation-not-completion" idea already owned by the STOP rules. Trim the re-narration. | ~15 | NO | Y — below threshold; the re-narration is the rule's own scoping, mildly useful |

**Total estimated recoverable: ~375–470 words** from the actionable candidates (1–3);
~520–600 including the waived micro-trims if folded in.

---

## 5. Notes for the release gate

- The epic's dedup **mechanism is sound**: ownership tables, rule-ID markers, and term
  markers are correctly placed, and the high-dup targets (`local-implementation/SKILL.md`,
  `projects-queue-usage.md`, `copilot-pr-followup/SKILL.md`) were genuinely condensed by
  replacing restatements with ID references. The information-loss half of AC5 holds.
- The word-count-reduced half of AC5 does **not** hold as written. The new style-guide
  substrate (+502) plus annotation overhead outweighed the condensation wins. Two paths to
  close AC5:
  1. **Re-baseline** the corpus against a post-substrate reference commit (the substrate is
     now the floor; future condensation is measured against it). Recommended — the substrate
     is non-recurring infrastructure.
  2. **Execute candidate #1** (the briefing-prefix over-specification, ~250–300 words) plus
     candidates #2–3 (~100–130 words). This alone would not quite reach -710, so path 1 is
     also needed.
- The biggest single residual-verbosity cluster is `GATE-EXEC-BRIEFING-PREFIX` in
  `docs/gate-review-sub-loop-contract.md` (Finding 1 / candidate #1). It is the one place
  the epic introduced new normative content **and** over-specified it across five locations
  in the same file. Filing this as a `pre-v0.8` condensation issue is warranted.

---

*Review method: read the mechanical roll-up, the ownership model
(`required-rules.json`, `contract-style-guide.md`), and the full `git diff` of every
top-growing doc plus the high-reduction docs. Cross-referenced rule IDs against
`required-rules.json` to confirm single-ownership. No files mutated.*