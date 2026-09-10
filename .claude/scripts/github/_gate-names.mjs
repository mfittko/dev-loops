// Canonical gate vocabulary — the single source of truth for gate names shared
// across the gate-review tooling. Imported by write-gate-context.mjs (artifact
// gate validation) and verify-briefing-prefixes.mjs (wrong-gate scope check) so
// the two can never drift.
//
// The vocabulary is TIERED, not flat, so "gate" implies gating. The
// discriminator is one question: DOES IT BLOCK A LIFECYCLE TRANSITION?
//
// - LIFECYCLE_GATES answer YES: `draft_gate` blocks draft→ready and
//   `pre_approval_gate` blocks ready→merge. These are the gates a "run through
//   the gates" / "gate this PR" request means.
// - REVIEW_GATE (`review`, #1808) answers NO: it is a standalone informational
//   pass reachable on any PR with NO gate obligations (it never blocks
//   merge/ready, never satisfies draft_gate or pre_approval_gate evidence, and
//   carries no config section of its own — see resolveReviewGateAngles in
//   write-gate-context.mjs and the deliberate absence of a "review" entry in
//   GATE_CONFIG_KEY, @dev-loops/core/loop/gate-fanin). It gates nothing, so a
//   "run the gates" request must NOT route to it (see the review-intent
//   short-circuit carve-out in skills/dev-loop/SKILL.md).
//
// `GATE_NAMES` is DERIVED from the two tiers below so the tier is load-bearing,
// not a parallel comment that can drift — its value/order stays exactly
// ["draft_gate", "pre_approval_gate", "review"], so every existing consumer is
// unaffected.
export const LIFECYCLE_GATES = ["draft_gate", "pre_approval_gate"];
export const REVIEW_GATE = "review";
export const GATE_NAMES = [...LIFECYCLE_GATES, REVIEW_GATE];

// Canonical gate-verdict vocabulary — the single source of truth shared by
// every gate-review script that parses/validates a --verdict or ledger
// overallVerdict value (upsert-checkpoint-verdict.mjs, _gate-finding-surface.mjs,
// write-gate-findings-log.mjs), so the three can never drift.
export const GATE_VERDICTS = ["clean", "findings_present", "blocked"];

const GATE_NAMES_SET = new Set(GATE_NAMES);
const GATE_VERDICTS_SET = new Set(GATE_VERDICTS);

// Canonicalize a reviewer-scope name to the hyphen-only convention every scope
// validator (VALID_SCOPE_RE) enforces. Gate ids canonically carry underscores
// (draft_gate, pre_approval_gate), so a scope hand-composed from a gate id
// (e.g. `${gate}-group-<name>` → `draft_gate-group-docs-surface`) inherits the
// underscore and fails the hyphen-only validator, forcing per-cycle self-
// correction (#1957). Every --scope entry point canonicalizes through here so a
// gate-id-derived scope validates on the first attempt and keys to the same
// canonical sentinel as its already-hyphenated twin. This is the single source
// of the underscore→hyphen scope normalization; gateScopePrefix reuses it.
export const canonicalizeScope = (scope) => String(scope).replace(/_/g, "-");

// Sentinel scopes spell the gate with dashes (draft-gate-<angle>); this is the
// one place that derives the dashed scope prefix from a gate name.
export const gateScopePrefix = (gate) => `${canonicalizeScope(gate)}-`;

// The one normalizeGate/normalizeVerdict/normalizeHeadSha implementation,
// shared by every CLI (--gate/--verdict/--head-sha parsing) and ledger reader
// that previously hand-copied this trim+lowercase+membership-check. Returns
// null for every non-member input, including any non-string (a typeof guard,
// never String() coercion, so a non-string can never accidentally stringify
// into a real member).
export function normalizeGate(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_NAMES_SET.has(normalized) ? normalized : null;
}

export function normalizeVerdict(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_VERDICTS_SET.has(normalized) ? normalized : null;
}

export function normalizeHeadSha(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}
