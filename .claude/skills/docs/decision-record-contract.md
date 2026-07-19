# Decision record contract

Canonical owner for the ADR (Architecture Decision Record) practice: when an accepted decision must be persisted, where the record lives, and how it connects to the existing RFC-escalation path.

The workflow already has a proposal mechanism: RFC-worthy technical decisions are escalated to the parent session / human operator (refiner escalation notes, the grill rationale comment, the review template's RFC-escalation sanity check). This contract adds the terminal artifact for that path: once such a decision is accepted, it is recorded as an ADR — a short, durable, versioned markdown file — instead of surviving only in PR threads, issue comments, and session transcripts. There is no separate RFC document type; the escalation path is the proposal, the ADR is the record.

The practice is advisory-first: no gate detector or contract test enforces ADR presence. Reviewers apply it through the existing RFC-escalation sanity check.

## Rule ownership

| Rule ID | Rule |
|---|---|
| <!-- rule: ADR-WORTHY-PERSIST --> `ADR-WORTHY-PERSIST` | An accepted policy-level choice, architecture-shaping decision, or reversal of previously established policy or contract modality MUST be persisted as an ADR under `docs/decisions/`. |
| <!-- rule: ADR-RFC-TERMINAL --> `ADR-RFC-TERMINAL` | The existing RFC-escalation path (refiner escalation notes, grill rationale, operator checkpoint) is the proposal mechanism; when the operator accepts an escalated decision, the implementing PR MUST include the ADR alongside the change. No separate RFC document type SHALL be introduced. |
| <!-- rule: ADR-PATH-NUMBERING --> `ADR-PATH-NUMBERING` | An ADR MUST live at `docs/decisions/NNNN-<slug>.md` with a monotonically increasing zero-padded four-digit number; numbers are never reused or renumbered. |
| <!-- rule: ADR-TEMPLATE-SECTIONS --> `ADR-TEMPLATE-SECTIONS` | An ADR MUST contain the sections `Status`, `Context`, `Decision`, and `Consequences`, in that order (see `docs/decisions/0000-template.md`). |
| <!-- rule: ADR-STATUS-VALUES --> `ADR-STATUS-VALUES` | The `Status` section MUST be exactly one of `Proposed`, `Accepted`, or `Superseded by` followed by a markdown link to the superseding record. |
| <!-- rule: ADR-SUPERSEDE-NOT-REWRITE --> `ADR-SUPERSEDE-NOT-REWRITE` | Changing an accepted decision MUST be recorded as a new ADR that supersedes the old one; the old record's body is never rewritten beyond flipping its `Status` to the superseded form. |
| <!-- rule: ADR-LINKS-ONLY --> `ADR-LINKS-ONLY` | ADRs are referenced from issue and PR bodies as plain links only; no decision content is synchronized into tracker artifacts (owned linkage model: [Tracker-first loop state](./tracker-first-loop-state.md)). An ADR SHOULD link its source issue/PR URLs in `Context`. |

## What is ADR-worthy

`ADR-WORTHY-PERSIST` intentionally excludes routine implementation choices. Signals that a decision qualifies:

- the operator decided it at a policy checkpoint (link scheme, external coupling, release policy);
- it reverses or re-scopes an established contract rule's modality;
- it shapes an architectural seam other work must build against (adapter boundaries, enforcement layers, artifact locations);
- it was escalated as RFC-worthy and accepted.

A decision that only affects one PR's internals is not ADR-worthy.

## Cross-references

- [Contract style guide](./contract-style-guide.md) — rule ID and RFC-2119 conventions
- [Tracker-first loop state](./tracker-first-loop-state.md) — ADR / RFC linkage rows (links only, no decision sync)
- `docs/decisions/0000-template.md` — the record template
