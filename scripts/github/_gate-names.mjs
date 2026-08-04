// Canonical gate vocabulary — the single source of truth for gate names shared
// across the gate-review tooling. Imported by write-gate-context.mjs (artifact
// gate validation) and verify-briefing-prefixes.mjs (wrong-gate scope check) so
// the two can never drift.
export const GATE_NAMES = ["draft_gate", "pre_approval_gate"];

// Sentinel scopes spell the gate with dashes (draft-gate-<angle>); this is the
// one place that derives the dashed scope prefix from a gate name.
export const gateScopePrefix = (gate) => `${String(gate).replace(/_/g, "-")}-`;
