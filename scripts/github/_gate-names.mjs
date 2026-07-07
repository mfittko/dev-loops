// Canonical gate vocabulary — the single source of truth for gate names shared
// across the gate-review tooling. Imported by write-gate-context.mjs (artifact
// gate validation) and verify-briefing-prefixes.mjs (wrong-gate scope check) so
// the two can never drift.
export const GATE_NAMES = ["draft_gate", "pre_approval_gate"];
