// Canonical gate vocabulary — the single source of truth for gate names shared
// across the gate-review tooling. Imported by write-gate-context.mjs (artifact
// gate validation) and verify-briefing-prefixes.mjs (wrong-gate scope check) so
// the two can never drift.
export const GATE_NAMES = ["draft_gate", "pre_approval_gate"];

// Canonical gate-verdict vocabulary — the single source of truth shared by
// every gate-review script that parses/validates a --verdict or ledger
// overallVerdict value (upsert-checkpoint-verdict.mjs, _gate-finding-surface.mjs,
// write-gate-findings-log.mjs), so the three can never drift.
export const GATE_VERDICTS = ["clean", "findings_present", "blocked"];

const GATE_NAMES_SET = new Set(GATE_NAMES);
const GATE_VERDICTS_SET = new Set(GATE_VERDICTS);

// Sentinel scopes spell the gate with dashes (draft-gate-<angle>); this is the
// one place that derives the dashed scope prefix from a gate name.
export const gateScopePrefix = (gate) => `${String(gate).replace(/_/g, "-")}-`;

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
