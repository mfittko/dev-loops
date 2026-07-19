# Decision record contract

Canonical owner for the ADR (Architecture Decision Record) practice: when an accepted decision must be persisted, where the record lives, and how it connects to the existing RFC-escalation path.

The workflow already has a proposal mechanism: RFC-worthy technical decisions are escalated to the parent session / human operator (refiner escalation notes, the grill rationale comment, the review template's RFC-escalation sanity check). This contract adds the terminal artifact for that path: once such a decision is accepted, it is recorded as an ADR — a short, durable, versioned markdown file — instead of surviving only in PR threads, issue comments, and session transcripts. There is no separate RFC document type; the escalation path is the proposal, the ADR is the record.

Decisions reach a record on two paths. A decision escalated during an in-flight change stays on that change: the implementing PR carries the ADR (unless the escalation is spun out into its own RFC issue). A decision framed as its own RFC issue is a decision node on the side track: the issue's whole deliverable is the ADR, and implementation happens afterwards as ordinary main-track (epic-tree) work that references the accepted record.

The practice is advisory-first: no gate detector or contract test enforces ADR presence. Reviewers apply it through the existing RFC-escalation sanity check.

`docs/decisions/` always means the directory at the root of the repo where the decision is made — in an installed-plugin context that is the consumer repo, which creates the directory (and a `0000-template.md` following the section structure defined here) on first use.

## Rule ownership

| Rule ID | Rule |
|---|---|
| <!-- rule: ADR-WORTHY-PERSIST --> `ADR-WORTHY-PERSIST` | An accepted policy-level choice, architecture-shaping decision, or reversal of previously established policy or contract modality MUST be persisted as an ADR under `docs/decisions/`. |
| <!-- rule: ADR-RFC-TERMINAL --> `ADR-RFC-TERMINAL` | The existing RFC-escalation path (refiner escalation notes, grill rationale, operator checkpoint) is the proposal mechanism; when the operator accepts a decision escalated from an in-flight change, the implementing PR MUST include the ADR alongside the change — unless the escalation was spun out into its own RFC issue, in which case `ADR-RFC-ISSUE-DECISION-ONLY` governs. A separate RFC document type MUST NOT be introduced. |
| <!-- rule: ADR-RFC-ISSUE-DECISION-ONLY --> `ADR-RFC-ISSUE-DECISION-ONLY` | An RFC issue — an issue opened to resolve an RFC-worthy question — MUST deliver the ADR as its sole substantive merge artifact (mechanical registration and mirror updates aside) and MUST NOT carry implementation; implementation MUST be scheduled as separate main-track (epic-tree) work that references the accepted ADR. When an in-flight escalation is spun out into its own RFC issue, this path governs: the ADR lands via the RFC issue's PR and the original change references the accepted record instead of carrying it. |
| <!-- rule: ADR-PATH-NUMBERING --> `ADR-PATH-NUMBERING` | An ADR MUST live at `docs/decisions/NNNN-<slug>.md`, where `NNNN` is the highest existing record number plus one, zero-padded to four digits, and `<slug>` is lowercase kebab-case (`[a-z0-9-]`); numbers MUST NOT be reused, and merged records MUST NOT be renumbered. A PR MUST NOT merge a record whose number already exists on the default branch: when concurrent in-flight PRs claim the same number, each later-merging PR MUST renumber its record before merge. Number `0000` is permanently reserved for the template (`0000-template.md`), which is not a record and is exempt from the ADR-* rules; records start at `0001`. |
| <!-- rule: ADR-TEMPLATE-SECTIONS --> `ADR-TEMPLATE-SECTIONS` | An ADR MUST contain the sections `Status`, `Context`, `Decision`, and `Consequences`, in that order (see `docs/decisions/0000-template.md`). |
| <!-- rule: ADR-STATUS-VALUES --> `ADR-STATUS-VALUES` | The `Status` section MUST be exactly one of `Proposed`, `Accepted`, or `Superseded by` followed by a markdown link to the superseding record. `Proposed` MAY appear only while the authoring PR is still under review; the same PR MUST flip it to `Accepted` (or remove the record) before merge. |
| <!-- rule: ADR-SUPERSEDE-NOT-REWRITE --> `ADR-SUPERSEDE-NOT-REWRITE` | Changing an accepted decision MUST be recorded as a new ADR that supersedes the old one; the old record's body is never rewritten beyond flipping its `Status` to the superseded form. |
| <!-- rule: ADR-LINKS-ONLY --> `ADR-LINKS-ONLY` | ADRs MUST be referenced from issue and PR bodies as plain links only; decision content MUST NOT be synchronized into tracker artifacts (consistent with the linkage rows in [Tracker-first loop state](./tracker-first-loop-state.md)). An ADR SHOULD link its source issue/PR URLs in `Context`. |

## What is ADR-worthy

`ADR-WORTHY-PERSIST` intentionally excludes routine implementation choices. Any single one of the following signals is sufficient to make the rule bind:

- the operator decided it at a policy checkpoint (link scheme, external coupling, release policy);
- it reverses or re-scopes an established contract rule's modality;
- it shapes an architectural seam other work must build against (adapter boundaries, enforcement layers, artifact locations);
- it was escalated as RFC-worthy and accepted.

A decision that only affects one PR's internals is not ADR-worthy.

## Cross-references

- [Contract style guide](./contract-style-guide.md) — rule ID and RFC-2119 conventions
- [Tracker-first loop state](./tracker-first-loop-state.md) — ADR / RFC linkage rows (links only, no decision sync)
- `docs/decisions/0000-template.md` — the record template
