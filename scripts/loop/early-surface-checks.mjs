import { buildAdrTripwireField, buildSizeBudgetField } from "@dev-loops/core/loop/pr-gate-coordination";
import { evaluateAdrTripwire } from "./check-adr-tripwire.mjs";
import { evaluatePrSizeBudget } from "./check-size-budget.mjs";

/**
 * ADR-TRIPWIRE-EARLY-SURFACE: evaluate the ADR tripwire and the size budget
 * for `origin/<baseRefName>...<head>` and return the typed `adrTripwire` and
 * `sizeBudget` fields. Never fetches refs: an unresolvable ref yields an
 * `unknown` outcome.
 */
export async function evaluateEarlySurface({
  baseRefName,
  head,
  prBody = "",
  repoRoot = process.cwd(),
  evaluateAdrTripwireFn = evaluateAdrTripwire,
  evaluatePrSizeBudgetFn = evaluatePrSizeBudget,
} = {}) {
  const base = `origin/${baseRefName}`;
  const settle = async (fn) => { try { return await fn(); } catch { return null; } };
  const [adr, size] = await Promise.all([
    settle(() => evaluateAdrTripwireFn({ base, head, prBody, repoRoot })),
    settle(() => evaluatePrSizeBudgetFn({ base, head, repoRoot })),
  ]);
  return { adrTripwire: buildAdrTripwireField(adr), sizeBudget: buildSizeBudgetField(size) };
}
