// GENERATED from packages/core/src/loop/gate-round-retirement.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * The gate-round retirement predicate shared by the work-order pull and the fixer hooks (ADR 0107).
 *
 * A round is retired once a GATE-EXEC-ROUND-RETIREMENT record for its gate+head
 * (retire-gate-round.mjs) was written at or after the round's emission time.
 * Synchronous and dependency-free (node: builtins only) so the Claude hook bundle can vendor it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The retired round id under `<tmpRoot>/retired-gate-rounds/<headSha>/`, or null. A malformed record throws. */
export function findRetirementAfter(tmpRoot, gate, headSha, emittedAtMs) {
  const retiredRoot = path.join(tmpRoot, "retired-gate-rounds", headSha);
  let rounds = [];
  try { rounds = readdirSync(retiredRoot); } catch { /* none retired */ }
  for (const round of rounds) {
    let text;
    try {
      text = readFileSync(path.join(retiredRoot, round, "retirement.json"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const record = JSON.parse(text);
    if (record?.gate === gate && Date.parse(record.retiredAt) >= emittedAtMs) return round;
  }
  return null;
}
