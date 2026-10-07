import { readFileSync } from "node:fs";

const REGISTRY = new URL("../../skills/docs/required-rules.json", import.meta.url);

/** The rule IDs registered in skills/docs/required-rules.json (required and opt-out rules). */
export function loadKnownRuleIds() {
  const parsed = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const entries = [...(parsed.requiredRules ?? []), ...(parsed.optOutRules ?? [])];
  return new Set(entries.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter(Boolean));
}
