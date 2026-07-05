# Contract style guide

Canonical owner for contract style, rule IDs, and definitional discipline.

A short orientation paragraph introduces the document; normative rules live only in the rule table.

## Terms

| Term | Definition |
|---|---|
| <!-- term: gate:pre_approval_gate --> `pre_approval_gate` | Review gate that checks changed contract rules against the registry before approval. |

## Rule ownership

| Rule ID | Rule |
|---|---|
| <!-- rule: STYLE-RFC2119-KEYWORDS --> `STYLE-RFC2119-KEYWORDS` | Normative contract text MUST use RFC-2119 keywords (`MUST`, `MUST NOT`, `SHALL`, `SHALL NOT`, `SHOULD`, `MAY`) when declaring requirements. |
| <!-- rule: STYLE-SINGLE-OWNER --> `STYLE-SINGLE-OWNER` | Each normative rule MUST have one single owner: exactly one source document defines the rule and every other document references that rule by ID instead of restating it. |
| <!-- rule: STYLE-RULE-MARKER --> `STYLE-RULE-MARKER` | A rule definition MUST place an HTML marker immediately before the rule body using `&lt;!-- rule: AREA-TOPIC-NNN --&gt;`; markers are invisible in rendered Markdown and MUST pass through mirror generation verbatim. |
| <!-- rule: STYLE-ID-SCHEME --> `STYLE-ID-SCHEME` | Rule IDs MUST be stable uppercase identifiers using the descriptive `AREA-TOPIC-NNN` shape or a short descriptive suffix when clearer. |
| <!-- rule: STYLE-ID-STABILITY --> `STYLE-ID-STABILITY` | A rule ID is stable forever: semantic changes MUST retire the old ID and mint a new ID through a dedicated semantic-change issue, never silent mutation. |
| <!-- rule: STYLE-REFERENCE-BY-ID --> `STYLE-REFERENCE-BY-ID` | A non-owner document MUST reference an owned rule by ID, preferably with a link to the owner, and MUST NOT duplicate the owned rule text. |
| <!-- rule: STYLE-DEFINED-TERMS --> `STYLE-DEFINED-TERMS` | State tokens, reason codes, and gate names MUST have exactly one canonical definition before annotated rule text uses them. |
| <!-- rule: STYLE-TERM-MARKER --> `STYLE-TERM-MARKER` | A canonical term definition MUST use `&lt;!-- term: kind:value --&gt;`, where `kind` is `state`, `reason`, or `gate`. |
| <!-- rule: STYLE-PRECEDENCE-CONFLICT --> `STYLE-PRECEDENCE-CONFLICT` | When two contract statements conflict, the document that owns the referenced rule ID wins until a semantic-change issue retires or replaces the rule. |
| <!-- rule: STYLE-CANONICAL-OPENER --> `STYLE-CANONICAL-OPENER` | A contract document SHOULD open with `Canonical owner for X` and SHOULD end with a Cross-references section. |
| <!-- rule: STYLE-CONTRADICTION-LENS --> `STYLE-CONTRADICTION-LENS` | A contract-touching PR MUST include an RFC-2119 contradiction check in `pre_approval_gate`: every added or changed rule is checked against the rule registry for opposing modality or a weaker restatement. |
| <!-- rule: STYLE-LEXICAL-SCAN-LIMIT --> `STYLE-LEXICAL-SCAN-LIMIT` | The ownership validator's contradiction scan is lexical only; behavioral contradictions belong to the L2/L3 harness and semantic contradictions belong to the gate contradiction lens. |

## Reference syntax

Use `&lt;!-- rule-ref: RULE-ID --&gt;` next to a cross-reference when a machine-checkable reference is useful. Markdown links may also use the rule ID as link text.

## Cross-references

- [Stop conditions](stop-conditions.md)
- [State-machine conformance + invariant harness](../../scripts/docs/validate-state-machine-conformance.mjs) — L2 (doc ↔ code) conformance and L3 (completeness/safety/liveness) graph invariants; its header comment documents the registration path for adding a machine
