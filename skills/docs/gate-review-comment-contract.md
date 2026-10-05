# Checkpoint Verdict Comment Contract

Canonical owner for gate-review **verdict field** rules for the two gate boundaries in
the dev-loop workflow: `draft_gate` and `pre_approval_gate`.

## Gate tiers (issue #1913)

A gate's tier depends on one question: does it block a lifecycle transition? The canonical
encoding lives in `scripts/github/_gate-names.mjs` (`LIFECYCLE_GATES` / `REVIEW_GATE`).

| Gate | Tier | Blocks a transition? | Verdict evidence? |
|---|---|---|---|
| `draft_gate` | lifecycle | yes — draft→ready | yes (this contract) |
| `pre_approval_gate` | lifecycle | yes — ready→merge | yes (this contract) |
| `review` | informational | no — gates nothing | no (never satisfies lifecycle-gate evidence) |

A "run through the gates" / "gate this PR" request means the lifecycle gates, never the
informational `review` pass — see the review-intent short-circuit carve-out in
[Dev Loop Skill](../dev-loop/SKILL.md).

## Purpose

Gate-review verdicts expose the gate, reviewed head, result and currency in the PR conversation.

<!-- rule: GATE-COMMENT-SINGLE-SURFACE -->
`GATE-COMMENT-SINGLE-SURFACE`: A gate round produces exactly ONE new visible surface: a single PR
review of type COMMENT, posted by `upsert-checkpoint-verdict.mjs`. Its body carries the required
verdict fields below. With `--findings-ledger`, the same review also carries the round's
findings: locatable ones as its inline comments, the rest body-filed in full in the body list.
Each finding carries an invisible fingerprint+disposition marker that `GATE-EXEC-FINDING-THREADS`
reads back for cross-round suppression and deferral tracking
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition)).
No separate verdict issue comment and no separate findings review is posted. Two exceptions exist:
the opt-in findings comment (`gates.postFindingsComments`, `GATE-COMMENT-IDENTITY-DISJOINT`) and
the batched deferral comment (`<!-- dev-loops:deferred-summary -->`) that `judge-pass.mjs` and
`close-gate-findings.mjs` post for a round's deferred findings, at most one per tool run, on the
linked spec issue or the PR (ADR 0092, `GATE-EXEC-DEFERRAL-RECORD`).

`GATE-COMMENT-SUPERSEDE-OUTDATED`: When a new `draft_gate` (resp. `pre_approval_gate`) verdict
is created, `upsert-checkpoint-verdict.mjs` folds the SAME gate's prior verdict reviews recorded
at EARLIER heads via GitHub's `minimizeComment(classifier: OUTDATED)`. It runs only when the
poster already holds evidence of a prior same-gate verdict at a different head (never on a
first-ever verdict). It never touches the just-posted current-head verdict or the OTHER gate's
verdicts, skips already-minimized reviews, and is bounded by a cap. It is BEST-EFFORT and
fail-open: a minimize failure logs a `minimizeWarning` on the result and never fails the verdict
post. Minimizing collapses and never deletes.

The body's per-angle breakdown has up to THREE TRACKS, rendered at TOP LEVEL, NEVER as a markdown
table. The third, folded, track is severity-gated (`GATE-COMMENT-INLINE-SEVERITY-FLOOR` below):
1. **Locatable findings** (each carried by its own inline PR review comment, or by one merged comment per `GATE-COMMENT-INLINE-LAYOUT`) are never
   enumerated per-finding in the body. The body states only one aggregate `**Inline findings:**`
   line: the count, a severity breakdown (leading emoji per the legend below, with the severity
   word), and the distinct touched angle names, pointing the reader to the inline comments.
2. **Non-locatable (body-only) findings** render in full, each as its own plain bulleted list
   item (never a table row), findings-first and severity-ordered, with a leading severity emoji
   marker (🔴 high · 🟠 medium · 🟡 low · ⚪ nit · 🔵 question, alongside the severity word), the
   finding's summary, its `file:line` linked to the blob at the reviewed head SHA when known, and
   its contributing angle(s) in trailing brackets.

<!-- rule: GATE-COMMENT-INLINE-SEVERITY-FLOOR -->
`GATE-COMMENT-INLINE-SEVERITY-FLOOR` (#2263): a finding whose severity ranks below
`gates.<gate>.inlineSeverityFloor` skips both tracks and folds into a THIRD track instead,
regardless of locatability. The floor's valid values are `medium` (default), `low`, `nit`. The
severity rank order is high, question, medium, low, nit, so `medium`/`high`/`question` always
post inline and only `low`/`nit` can ever fold. Folding produces one collapsed
`<details><summary>Suppressed low/nit findings (N) — below the inline severity
floor</summary>...</details>` block, its own top-level section after the body-only list and
clean-angle roster, before the gate-evidence note. Each folded finding renders as a
`file:line`-prefixed (when locatable) severity/angle/summary bullet plus its own INVISIBLE
fingerprint+`disposition=deferred` marker, the same shape a body-filed marker carries, so
cross-round fingerprint suppression still applies and a folded finding renders exactly once. A
folded finding creates NO gate-authored review thread and never enters
`unresolvedGateThreadCount` (`GATE-EXEC-FINDING-THREADS`,
[Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition)).
Lowering `inlineSeverityFloor` (e.g. to `"low"` or `"nit"`) restores full inline/body-filed
posting. The config schema rejects an out-of-vocabulary value, including `"high"`. An
unrecognized severity fails OPEN (posts inline, never silently folded). A `question` NEVER folds
at any floor, because its resolvable thread blocks gate-close until answered
(`GATE-EXEC-THREAD-DISPOSITION`). `blockCleanOnFindingSeverities` semantics are unaffected: the
verdict is computed upstream from the ledger, never from which track a finding renders on.

Every clean (zero-finding) angle is collapsed into one trailing comma-joined `**Clean (N):**`
line, never a list/table row. A finding's full text always lives in EXACTLY ONE reader-reachable
carrier — its own inline review comment (locatable) or its own body-list bullet (non-locatable) —
never both, never neither, and never only the on-disk disposition ledger. The two exceptions are in `GATE-COMMENT-INLINE-LAYOUT`: a capped field points at its ledger entry, and a same-defect merged comment or bullet carries its members together and renders each distinct summary once, so a non-primary member's Failing case and any repeated text live in the ledger. Budget pressure on an
over-long round SHORTENS a body-only finding's rendered text rather than degrading it to an
omitted-count/ledger pointer. Both tracks render at TOP LEVEL, never through the
`--findings-summary`/`--findings-file` blockquoted continuation-line path. Verdict evidence
is read from that review body; a verdict posted as an ISSUE comment still validates and is still
corrected on its own surface (back-compat read).

<!-- rule: GATE-COMMENT-INLINE-LAYOUT -->
`GATE-COMMENT-INLINE-LAYOUT`: an inline finding renders in a fixed layout. The header line reads
`**<severity>** · <angle>[, <angle>][ · judge: <disposition>]`. The body lines are `**Problem:**`,
`**Failing case:**` (when the finding carries `failingCase`) and `**Fix:**` (numbered steps when
the recommendation holds more than one action). The renderer bounds each field at a sentence
boundary, never inside a code span or fence, and appends `Full text: ledger entry <fingerprint>`
after a cut. The ledger keeps the full text. Reviewer inline code spans survive into the thread,
and every other backtick is escaped as an entity. Findings from different angles that describe the
same defect post as one comment. Two findings describe the same defect only when they resolve the
same file, their lines are equal or both absent, both or neither are questions, they carry the same
judge disposition, and their keys match. Keys match when both findings carry an equal `defectKey`,
or when neither carries one and their normalized summaries are identical. A `defectKey` on only one
of the two findings blocks the merge. A finding with no file never merges. The normalized summary is
the one `fingerprintFinding` uses: lowercase, every non-alphanumeric run collapsed to one space,
trimmed. The `defectKey` never renders and never enters the fingerprint or the marker. One merged
comment holds at most eight findings. That comment lists every angle in the header and keeps one
marker per merged finding, so each fingerprint stays suppressible. It renders the primary member's
Problem, Failing case and Fix. Each further member whose normalized summary differs from every
earlier rendered member adds one `**Problem (<angle>):**` line and, when it has a recommendation, one
`**Fix (<angle>):**` line, under the same field caps. Non-locatable findings merge by the same rule
into one body-only bullet that lists every angle in its angle suffix and joins each distinct summary
with `; `, and each member keeps its own invisible marker. The bulleted findings comment and
body-filed blocks stay single-line and never render `failingCase`; that field appears only on the
inline surface.

<!-- rule: GATE-COMMENT-REVIEWER-STYLE -->
`GATE-COMMENT-REVIEWER-STYLE`: reviewers MUST write each finding by these rules.

1. Lead with the point.
2. Give one action per recommendation. Use numbered steps for more than one action.
3. Write no preamble, recap or closer.
4. Cap every list at five ranked items. The ledger holds the rest.
5. Use a matter-of-fact tone.
6. Before sending, run a pre-send check that deletes every announcing, recapping and hedging
   sentence.
7. Apply the deslop style at write time, per the
   [A/B contrast removal step](./ab-contrast-deslop-step.md).

The renderer bounds each field (`GATE-COMMENT-INLINE-LAYOUT`). A filler-phrase lint flags reviewer
filler and never rewrites it.

<!-- rule: GATE-EVIDENCE-AUDIT-TWO-SURFACES -->
`GATE-EVIDENCE-AUDIT-TWO-SURFACES`: any gate-evidence completeness audit or reporting path MUST
scan BOTH verdict surfaces — the PR-review stream (`pulls/<n>/reviews`, the primary surface per
GATE-COMMENT-SINGLE-SURFACE) and the visible issue-comment stream (`issues/<n>/comments`, the
back-compat read). The deterministic post-drive audit helper is
`scripts/github/audit-gate-evidence.mjs`. It reads both surfaces through
`fetchGateEvidenceComments` and reports each gate's verdict as visible regardless of which
surface carries it. The sanctioned poster never creates an issue-comment verdict. Two documented
exceptions exist: the opt-in findings comment (`gates.postFindingsComments`,
`GATE-COMMENT-IDENTITY-DISJOINT` below), and the zero-dep fallback poster
(`skills/dev-loop/scripts/post-gate-verdict-fallback.mjs`), used only when `@dev-loops/core`
is absent, which posts a verdict issue comment as a degraded audit-trail artifact.

<!-- rule: GATE-COMMENT-IDENTITY-DISJOINT -->
`GATE-COMMENT-IDENTITY-DISJOINT`: The verdict surface and the opt-in findings comment
(`gates.postFindingsComments`, `post-gate-findings.mjs`) identify "their" comment by different
claim keys, and each tool's upsert MUST NOT ever claim the other's comment.
The verdict is claimed through its parsed verdict fields (gate name plus reviewed head); the
findings comment through its own `dev-loops:gate-findings gate=` marker. The claim seam enforces
this: the marker summarizer treats a body carrying a known machine-artifact marker token (owned by
the artifact filter in `copilot-helpers.mjs`, delimiter-anchored so no suffixed `<token>-<x>`
variant matches) as a non-candidate UNLESS it also carries the producer-owned verdict body
heading. Within its OWN claim key each tool keys identity as it needs (the findings comment's
marker is deliberately gate-only).

<!-- rule: GATE-COMMENT-SCOPE-ONLY -->
`GATE-COMMENT-SCOPE-ONLY`: This document owns the visible checkpoint verdict evidence contract only.
The relevant workflow skill owns the full PR follow-up procedure, and
[PR Lifecycle Contract](./pr-lifecycle-contract.md) owns the lifecycle that consumes this evidence.

## Scope

This contract covers exactly two gates with distinct lifecycle semantics:

- `draft_gate` — **one-time transition boundary.** Runs right before `gh pr ready`
  (draft → ready-for-review boundary). Once a clean comment exists and the PR leaves
  draft, the gate is permanently satisfied; later head changes must not re-trigger it.
- `pre_approval_gate` — **recurring per-head gate.** Runs right before final approval /
  merge readiness on the current head SHA. A new pass is required for each new head
  after post-draft changes.

A THIRD gate, `review` (`GATE_NAMES`, `scripts/github/_gate-names.mjs`), is a standalone,
on-demand review pass with no lifecycle obligation ([Review skill](../review/SKILL.md)). It posts
through the same single-surface poster and required-fields shape, but is a NON-EVIDENCE gate.
`review` IS a recognized gate name in the gate-comment header vocabulary
(`@dev-loops/core/github/copilot-helpers`). A `review` header makes the parser return
non-evidence immediately, with or without `--findings-ledger` or the gate-findings-review marker.
The parser takes the gate name only from a labeled gate field line and the head SHA only from a
labeled head-SHA field line. It never scans free text for either. A `review` comment
never satisfies `draft_gate` or `pre_approval_gate` evidence, and `GATE-COMMENT-NON-SUBSTITUTION`
applies to it symmetrically.

<!-- rule: GATE-REVIEW-SUBMIT-MODES -->
### `review` gate submit modes (#1840)

`GATE-REVIEW-SUBMIT-MODES`: `upsert-checkpoint-verdict.mjs`'s `--submit
<pending|comment|request-changes|approve|discard>` flag is SCOPED TO `--gate
review` ONLY. Passing it on `draft_gate`/`pre_approval_gate` is rejected with a
named error (never silently ignored); those two gates always submit a `COMMENT`
review per `GATE-COMMENT-SINGLE-SURFACE` and `GATE-COMMENT-NON-SUBSTITUTION`.

| Mode | GitHub review `event` | Effect |
|---|---|---|
| `pending` | omitted | Creates an author-only draft review — invisible to other reviewers until a human submits it |
| `comment` (default when `--submit` is omitted) | `COMMENT` | Submits the review immediately |
| `request-changes` | `REQUEST_CHANGES` | Submits the review; a GitHub-native branch-protection signal that can BLOCK merge until dismissed |
| `approve` | `APPROVE` | Submits the review; a GitHub-native branch-protection signal that SATISFIES a required-approvals rule |
| `discard` | n/a (DELETE) | Deletes the caller's own pending draft review (`DELETE /pulls/<pr>/reviews/<id>`); leaves nothing behind |

A headless/non-interactive review run (`--auto`) is restricted to `pending`/`comment`; `--submit
approve`/`--submit request-changes`/`--submit discard` are REFUSED headless. Since #1888,
`approve`/`request-changes` (and `discard`, #1912) also REQUIRE the explicit
`--interactive-confirm` token, passed only by the [Review skill](../review/SKILL.md)'s interactive
submit step after a human made the choice. Both the CLI parser and the
`upsertCheckpointVerdict()` runtime entry refuse these modes without the token. `--auto` still
refuses those modes even WITH the token. Headless/agent callers may use `--submit pending` or
`--submit comment`.

Submit-existing-pending (#1912, part of `GATE-REVIEW-SUBMIT-MODES`): GitHub allows only ONE
pending review per user per PR, whatever head it sits on. When the caller already has an own
SAME-HEAD PENDING review, a `--submit comment|request-changes|approve` re-run SUBMITS it via
`POST /pulls/<pr>/reviews/<id>/events` (mapped event, preserving the pending review's inline
comments) instead of POSTing a second review; `--submit discard` DELETES it; `--submit pending`
leaves it in place (a noop). A STALE own pending review on a DIFFERENT head is DELETED before the
round creates a fresh review at the current head. `--submit discard` deletes the caller's own
pending review regardless of head. The submit path detects the own pending review directly off
the raw reviews list, because the same-head marker scan (`summarizeExistingComment`) cannot see an
author-only review.

A `fanout_fanin` verdict posted with `--findings-json` but NO `--findings-ledger` emits a
one-line advisory warning naming `--findings-ledger` as the missing inline-comment source,
because `--findings-json` alone files ZERO inline comments. The warning never blocks the post.

Every submit mode, including `approve`, stays a NON-evidence `review` verdict for dev-loops
gates: the `review`-header guard reads only the comment body, never the review's
`event`/`state`, so `detect-checkpoint-evidence.mjs`/`detect-pr-gate-coordination-state.mjs`
report no draft/pre-approval evidence from it.

## Separate chains per gate

Each gate runs its own independent review chain (`GATE-EXEC-SEPARATE-CHAINS`, owned by
[Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#separate-chains-per-gate)).
This section owns only the comment-visible ledger path per gate:

| Gate | Own disposition ledger path |
|---|---|
| `draft_gate` | `tmp/gate-findings/.../draft_gate-<sha>.json` |
| `pre_approval_gate` | `tmp/gate-findings/.../pre_approval_gate-<sha>.json` |

## Review-angle ownership and non-substitution rules

Each gate's review angles are defined in the project config (`gates.draft.angles` and `gates.preApproval.angles` in `.pi/dev-loop/defaults.yaml`). A reviewer resolves each angle's authoritative persona, focus prompt, and model from the fully merged config with `dev-loops gate resolve-role --gate <draft_gate|pre_approval_gate> --angle <name>` — never by reading `packages/core/src/config/extension-defaults.yaml` directly, which carries only the shipped default and misses a consumer repo's `.devloops` override. Use the returned payload only on exit 0; a nonzero exit means stop and treat the angle as blocked. The owning definition of this rule is the Persona mapping bullet under [Pre-approval gate contract](../copilot-pr-followup/SKILL.md#pre-approval-gate-contract) in `skills/copilot-pr-followup/SKILL.md`. Consumer repos may override an angle's persona/prompt via its own `gates.<gate>.angles[]` entry in their config.

Resolve angles at runtime with `resolveGateAngles(config, "draft")` and `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Do not hardcode angle names in skill procedures or review prompts.

| Gate | Boundary it governs | Review angles | What a clean comment authorizes | What it does **not** authorize |
|---|---|---|---|---|
| `draft_gate` | Draft → ready for review | Resolved from `gates.draft.angles` in config | `gh pr ready` / leaving draft for the reviewed head SHA | final-approval readiness, merge-ready claims, or satisfaction of `pre_approval_gate` |
| `pre_approval_gate` | Final approval / merge readiness | Resolved from `gates.preApproval.angles` in config | approval-ready / final-human-approval readiness for the reviewed head SHA | draft-stage `gh pr ready` decisions for a different gate run |

<!-- rule: GATE-COMMENT-NON-SUBSTITUTION -->
`GATE-COMMENT-NON-SUBSTITUTION`: A clean `draft_gate` comment does **not** satisfy `pre_approval_gate` requirements.
A clean `pre_approval_gate` comment does **not** retroactively replace the required `draft_gate` evidence for leaving draft.

## Required fields

<!-- rule: GATE-COMMENT-REQUIRED-FIELDS -->
`GATE-COMMENT-REQUIRED-FIELDS`: Every gate-review verdict body MUST include:

| Field | Description |
|---|---|
| **Gate name** | `draft_gate` or `pre_approval_gate` |
| **Head SHA reviewed** | The exact commit SHA that was reviewed |
| **Verdict** | `clean`, `findings_present`, or `blocked` |
| **Blocking severities** | (clean verdicts only) Which severity levels must be clean per gate config |
| **Findings summary** | Short truthful audit summary. Use `no issues found` only when the reviewed head needed no corrective change for that gate pass. |
| **Next action** | One of: `stay draft and fix`, `rerun gate`, `mark ready for review`, `await final human approval` |

## Optional size-budget fields

<!-- rule: GATE-COMMENT-SIZE-BUDGET-FIELDS -->
`GATE-COMMENT-SIZE-BUDGET-FIELDS`: A `pre_approval_gate` verdict MUST render the three size-budget
fields below. The [Size-budget merge gate](./merge-preconditions.md#size-budget-merge-gate-issue-1480)
adds them beyond `GATE-COMMENT-REQUIRED-FIELDS`, and they are OPTIONAL at the CLI layer
(`upsert-checkpoint-verdict.mjs` never requires `--size-budget-json`). A `pre_approval_gate`
verdict renders them whether `--size-budget-json` is supplied or omitted. Omitting it
auto-derives the size budget in-process (`evaluatePrSizeBudget` against the PR's base ref) and
fails closed with an actionable error, naming `--size-budget-json` as the escape hatch, if the
base ref or diff cannot be resolved. The standard `pre_approval_gate` procedure
([Copilot PR Followup](../copilot-pr-followup/SKILL.md)) supplies the precomputed JSON explicitly
as the preferred path. `draft_gate` and `review` verdicts do not auto-derive: they render the
fields only when `--size-budget-json` is supplied.

| Field | Rendered line | Values |
|---|---|---|
| **Size-budget outcome** | `**Size-budget outcome:** <outcome>` | The recorded `gates.size` outcome, e.g. `pass`, `escalate`, `block` |
| **Size-budget T1 slice** | `**Size-budget T1 slice:** touched` or `**Size-budget T1 slice:** not touched` | Whether the diff touches the T1 tier |
| **Size-budget waiver** | `**Size-budget waiver:** none`, `**Size-budget waiver:** granted`, or `**Size-budget waiver:** granted by <approver>` | Whether a size-budget waiver was granted, and by whom if known |

All three fields are rendered together or not at all, and only when the outcome is supplied. A
body without them reads back as `null` (not a parse failure) and stays valid evidence for every
other rule in this document. All three `null` is absent size evidence. The size-budget merge gate,
consulted live by `buildPreMergeGateCheck` (`scripts/github/detect-checkpoint-evidence.mjs`) on
the authoritative pre-merge path in addition to `evaluateMergePreconditions`/the lifecycle state
machine, reads absent size evidence as "human approval required", never as a silent pass.

## Verdict definitions

<!-- rule: GATE-COMMENT-VERDICT-VALUES -->
`GATE-COMMENT-VERDICT-VALUES`: The verdict field MUST be one of the following values, each
with the fixed meaning below:

| Verdict | Meaning |
|---|---|
| `clean` | No findings with a severity in the gate's `blockCleanOnFindingSeverities` remain, and the judge act list is empty |
| `findings_present` | The gate found issues at blocking severities, or the judge act list is not empty; fixes are required before the gate boundary can be crossed |
| `blocked` | The gate could not complete or a hard blocker prevented a verdict |

Enforcement at write time and post time:

- The consolidator (`consolidate-fanin.mjs`) computes the severity `overallVerdict`. It threads
  through `--ledger-out`'s `{ overallVerdict, findings, verifiedItems? }` wrapper into the durable ledger
  (`write-gate-findings-log.mjs`).
- `write-gate-findings-log.mjs` refuses a `--verdict` that contradicts the
  `--findings`/`--findings-file` wrapper's `overallVerdict` before any ledger is written. The
  check is the same whether or not `--judge-verdict` was supplied: the judge only adds
  `act`/`defer`/`reject` dispositions
  ([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#phase-35--judge-relevance-disposition-1525))
  and never revises `overallVerdict`.
- `upsert-checkpoint-verdict.mjs` composes the ledger's `overallVerdict` with its open judge act
  items (ADR 0089) for the same head and gate (#1616), so a non-empty act list yields
  `findings_present`. It derives the verdict by default (passing no `--verdict` is valid),
  accepts a matching explicit value, and refuses a contradiction citing this rule. A ledger
  without `overallVerdict` still refuses an explicit `clean` while its act list is not empty.
- The act list for a verdict post comes from judge-enriched data: the ledger written with
  `--judge-verdict`, or a judge-enriched `--findings-json` (its open act items also yield
  `findings_present` over a ledger). A durable log written before the judge pass carries no
  dispositions. A fan-out `draft_gate` or `pre_approval_gate` post over such a ledger refuses
  unless a `--findings-json` finding with a `judgeDisposition` covers every unjudged ledger
  finding, where coverage means the same summary text after trimming. Pass the full enriched
  findings (judge-pass `--ledger-out`), not the `--out` act list. The post counts as fan-out when `--execution-mode` or the ledger's own
  `executionMode` is `fanout_fanin`.
- No override flag exists. A round whose verdict genuinely differs from the computed one is a
  consolidator bug to fix.
- A `blocked` verdict may sit over a completed `clean` or `findings_present` ledger only when the
  writer proves a deterministic pre-approval blocker (unchecked AC/DoD), and the comment then
  records the review verdict and the named blockers.

## Disposition ledger

`GATE-EXEC-DISPOSITION-LEDGER` owns durable-ledger sequencing and content
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#disposition-ledger-and-durable-logging)).
The visible PR comment is a summary for auditability; the disposition ledger is the
complete durable record. `GATE-EXEC-FINDING-THREADS` and `GATE-EXEC-THREAD-DISPOSITION`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition))
own finding threads on the round's own review, and `GATE-EXEC-DEFERRAL-RECORD` owns a deferred
finding's record.

## Readable deterministic format

<!-- rule: GATE-COMMENT-VALIDATION-REPORTING -->
`GATE-COMMENT-VALIDATION-REPORTING`: Keep the visible verdict body compact, deterministic, and
slightly human-friendly (labels like `Gate review`, `Reviewed head SHA`, `Verdict`,
`Blocking severities`, `Findings summary`, `Next action`); gate name and reviewed head SHA
MUST stay deterministically parseable even if label wording changes. Validation reporting
MUST stay concise by default — command names plus pass/fail status, aggregate counts, and
current-head CI/check status, never raw passing log streams. Any included command output
MUST be truncated to a deterministic retained-prefix length (a short truncation marker
suffix is allowed); a failure MUST show only a focused relevant excerpt, not an unbounded
raw log dump. Detailed logs MAY live in local/session artifacts or linked GitHub logs
instead of the visible audit comment. When a pass reached `clean` only after corrective changes, the findings
summary SHOULD briefly say what gap was found, what changed, and why the current head now
satisfies the gate.

## Behavior requirements

`GATE-EXEC-POST-BEFORE-FIX` owns post-before-fix ordering for both gate boundaries
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger)).

### Draft gate (`draft_gate`) comment requirements

<!-- rule: GATE-COMMENT-DRAFT-REQUIREMENTS -->
`GATE-COMMENT-DRAFT-REQUIREMENTS`: The PR MUST NOT leave draft unless a visible, current-head
`clean` `draft_gate` checkpoint verdict comment exists, per the rules below.

**One-time transition boundary.** `draft_gate` records exactly one decision point: the
draft → ready-for-review transition. Once a clean `draft_gate` comment exists on the PR and the
PR leaves draft, later head changes MUST NOT trigger new `draft_gate` comments. Post-draft
follow-up relies on normal review/fix loops and the recurring per-head `pre_approval_gate`.

- **Skip rule:** skip the draft gate entirely only when a clean `draft_gate` comment exists on
  the PR (any head) AND the PR has already left draft. Do not re-post it on later heads.
- While the PR is still draft, a checkpoint verdict comment for an older head SHA does not
  satisfy the current head. A new head requires a new current-head `draft_gate` comment.
- When the `draft_gate` runs (while the PR is still draft and no clean evidence exists
  for the current head), the PR MUST receive a visible checkpoint verdict comment.
- If the `draft_gate` verdict is `findings_present` or `blocked`, the comment MUST
  state that the PR stays draft and fixes are required before retrying.
- After the PR leaves draft, existing clean `draft_gate` evidence remains valid as a
  one-time transition record. Later head changes do not invalidate this record.
- If a PR is already non-draft and no clean `draft_gate` evidence exists at all (no
  valid checkpoint verdict comment was ever posted), automation MUST fail closed and reconcile
  that missing draft-stage evidence before continuing.

### Pre-approval gate (`pre_approval_gate`) comment requirements

<!-- rule: GATE-COMMENT-PREAPPROVAL-REQUIREMENTS -->
`GATE-COMMENT-PREAPPROVAL-REQUIREMENTS`: Final-approval readiness MUST NOT rely only on
local or hidden artifacts; a visible, current-head `pre_approval_gate` checkpoint verdict
comment is the required auditable evidence, per the rules below.

- When the `pre_approval_gate` runs, the PR MUST receive a visible checkpoint verdict comment.
- If the `pre_approval_gate` verdict is `findings_present` or `blocked`, the comment
  MUST state that follow-up fixes are required before final approval.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head.

## Rerun rules

<!-- rule: GATE-COMMENT-RERUN-RULES -->
`GATE-COMMENT-RERUN-RULES`: A gate rerun MUST follow the same-head vs. new-head handling
defined below, scoped per gate recurrence (`GATE-COMMENT-SCOPE-ONLY` above): this table
governs the **recurring** `pre_approval_gate`; the **one-time** `draft_gate` is exempt from
the new-head row once its one-time transition record exists (`GATE-COMMENT-DRAFT-REQUIREMENTS`)
so the two rules do not conflict.

| Scenario | Rule |
|---|---|
| Same head SHA rerun | Idempotent behavior: do not post a second visible surface for the same gate+head. An identical rerun posts nothing; if correction is needed, update the existing review's body in place (a legacy verdict issue comment is corrected on its own surface). Inline finding comments are never re-posted — a same-head correction body-files any still-unposted finding, since GitHub exposes no endpoint to add inline comments to a submitted review. |
| New head SHA rerun on the recurring `pre_approval_gate` | A new visible checkpoint verdict review MUST be posted for the new head; the older-head surface remains but does not satisfy readiness for the new head |
| New head SHA change on the one-time `draft_gate` after a clean transition record already exists | No new `draft_gate` verdict is triggered for the new head — the one-time transition boundary already closed (`GATE-COMMENT-DRAFT-REQUIREMENTS`) |

## Fail-closed behavior

<!-- rule: GATE-COMMENT-FAIL-CLOSED -->
`GATE-COMMENT-FAIL-CLOSED`: If the required checkpoint verdict review cannot be posted
(for example due to a GitHub API error, permission restriction, or tooling failure), the
workflow MUST NOT cross the gate boundary:

- do not run `gh pr ready` (for `draft_gate`)
- do not declare final-approval readiness (for `pre_approval_gate`)

The gate boundary is not crossed until both the review verdict is `clean` **and** the
required visible PR review is confirmed posted for the current head SHA.

## Relationship to other contracts

| Contract | Relationship |
|---|---|
| `draft_gate` boundary | Governs the draft → ready-for-review transition in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) Step 7 |
| `pre_approval_gate` boundary | Governs final-approval readiness in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) Step 7 and the narrowed [Final Approval](../final-approval/SKILL.md) route |
| Local/session artifacts | These remain complementary; the visible PR review is the minimum required auditable surface, not a replacement for all local artifacts |
| [Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md) | Execution shape for gate inspection work |
| [Contract style guide](./contract-style-guide.md) | Rule ID and RFC-2119 conventions |
