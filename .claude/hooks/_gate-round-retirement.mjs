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

/**
 * The retired round id under `<tmpRoot>/retired-gate-rounds/<headSha>/`, or null. A malformed record throws.
 * A record without `scopes` retires the whole round. A record with `scopes` (a body-only rerun,
 * GATE-EXEC-BODY-ONLY-RERUN) retires only the named dispatch units: it matches when `scope` is given and listed,
 * and never matches a whole-round query. `ANY_SCOPE` as `scope` matches any record for the gate and head, scoped or not
 * (the judge round, which reads the body-bound results of every unit).
 */
export const ANY_SCOPE = Symbol("any-scope");
export function findRetirementAfter(tmpRoot, gate, headSha, emittedAtMs, scope = null) {
  const retiredRoot = path.join(tmpRoot, "retired-gate-rounds", headSha);
  let rounds = [];
  try { rounds = readdirSync(retiredRoot); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const round of rounds) {
    let text;
    try {
      text = readFileSync(path.join(retiredRoot, round, "retirement.json"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const record = JSON.parse(text);
    if (record?.gate !== gate || !(Date.parse(record.retiredAt) >= emittedAtMs)) continue;
    if (!Array.isArray(record.scopes) || scope === ANY_SCOPE || (scope !== null && record.scopes.includes(scope))) return round;
  }
  return null;
}
