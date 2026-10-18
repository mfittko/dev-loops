/**
 * Coordinator work order producer (issue 2483, slice 1).
 *
 * Wraps the resolved handoff envelope (buildDevLoopHandoffEnvelope) in a coordinator
 * work order. The digest comes from the shared serializer in work-order-digest.mjs;
 * this module adds no second canonicalization. It accepts no brief, prose, summary
 * file or envelope override: every route, next-action, stop, acceptance, required-read
 * and sanctioned-command fact is the envelope's own.
 */
import { workOrderDigest } from "./work-order-digest.mjs";
import { validateHandoffEnvelope } from "./handoff-envelope.mjs";

const INPUT_KEYS = new Set(["envelope", "allowedFiles", "attempt"]);
const SET_FIELDS = ["stopRules", "requiredReads"];
const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

export class CoordinatorWorkOrderRefusal extends Error {}

/** `changes/<n>-*.md`: n is the unit's issue number, else its PR number (lightweight unit). */
export function changesFragmentGlob(target) {
  const n = target?.issue ?? target?.pr;
  if (!Number.isInteger(n) || n < 1) throw new CoordinatorWorkOrderRefusal("coordinator target names no issue or PR number");
  return `changes/${n}-*.md`;
}

/**
 * Build the coordinator work order and its digest. Throws CoordinatorWorkOrderRefusal
 * for an unknown input, an invalid envelope or an envelope carrying overrides.
 */
export function buildCoordinatorWorkOrder(input) {
  const unknown = Object.keys(input ?? {}).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) throw new CoordinatorWorkOrderRefusal(`coordinator work order accepts only envelope, allowedFiles and attempt; refused: ${unknown.join(", ")}`);
  const { envelope, allowedFiles = [], attempt = 1 } = input;
  const valid = validateHandoffEnvelope(envelope);
  if (!valid.ok) throw new CoordinatorWorkOrderRefusal(`handoff envelope is invalid: ${valid.errors.map((e) => e.field).join(", ")}`);
  if (envelope.overrides !== undefined) throw new CoordinatorWorkOrderRefusal("handoff envelope overrides are not a coordinator source; re-resolve without overrides");
  if (!Number.isInteger(attempt) || attempt < 1) throw new CoordinatorWorkOrderRefusal("attempt must be a positive integer");
  if (!Array.isArray(allowedFiles) || allowedFiles.some((p) => typeof p !== "string" || p === "" || p.startsWith("/") || p.split("/").includes(".."))) {
    throw new CoordinatorWorkOrderRefusal("allowedFiles must be repository-relative paths");
  }
  // gateState.derivedAt is a collection timestamp, not semantic; every other envelope field is retained.
  const { gateState, ...handoff } = envelope;
  const { derivedAt: _derivedAt, ...semanticGateState } = gateState ?? {};
  for (const field of SET_FIELDS) if (Array.isArray(handoff[field])) handoff[field] = [...handoff[field]].sort(byJson);
  const workOrder = {
    role: "coordinator",
    operation: "coordinate",
    target: envelope.target,
    attempt,
    handoff: { ...handoff, gateState: semanticGateState },
    allowedFiles: [...new Set([...allowedFiles, changesFragmentGlob(envelope.target)])].sort(),
  };
  return { workOrder, workOrderDigest: workOrderDigest(workOrder) };
}
