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
  const { envelope, allowedFiles = [], attempt = 1 } = input ?? {};
  const valid = validateHandoffEnvelope(envelope);
  if (!valid.ok) throw new CoordinatorWorkOrderRefusal(`handoff envelope is invalid: ${valid.errors.map((e) => e.field).join(", ")}`);
  if (envelope.overrides !== undefined) throw new CoordinatorWorkOrderRefusal("handoff envelope overrides are not a coordinator source; re-resolve without overrides");
  if (!Number.isInteger(attempt) || attempt < 1) throw new CoordinatorWorkOrderRefusal("attempt must be a positive integer");
  if (!Array.isArray(allowedFiles) || allowedFiles.some((p) => typeof p !== "string" || /[\u0000-\u001f\u007f\\]/.test(p))) {
    throw new CoordinatorWorkOrderRefusal("allowedFiles must be repository-relative paths without control characters or backslashes");
  }
  const ownGlob = changesFragmentGlob(envelope.target);
  const normalized = allowedFiles.map((p) => p.split("/").filter((seg) => seg !== "" && seg !== ".").join("/"));
  if (normalized.some((p, i) => p === "" || p.split("/").includes("..") || allowedFiles[i].startsWith("/"))) {
    throw new CoordinatorWorkOrderRefusal("allowedFiles must be repository-relative paths");
  }
  // Own-fragment guard: any other entry whose first segment is `changes` or a glob could cover other units' fragments.
  const coversChanges = (p) => p !== ownGlob && (p.split("/")[0] === "changes" || /[*?[{]/.test(p.split("/")[0]));
  if (normalized.some(coversChanges)) {
    throw new CoordinatorWorkOrderRefusal(`allowedFiles may name only the unit's own ${ownGlob}`);
  }
  // gateState.derivedAt is a collection timestamp, not semantic; every other envelope field is retained.
  const { gateState, ...handoff } = envelope;
  const { derivedAt: _derivedAt, ...semanticGateState } = gateState ?? {};
  // stopRules order is semantic (reconciliation tuple) and stays verbatim; requiredReads is an unordered set of validated strings.
  if (Array.isArray(handoff.requiredReads)) handoff.requiredReads = [...handoff.requiredReads].sort();
  const workOrder = {
    role: "coordinator",
    operation: "coordinate",
    target: envelope.target,
    attempt,
    handoff: { ...handoff, gateState: semanticGateState },
    allowedFiles: [...new Set([...normalized, ownGlob])].sort(),
  };
  return { workOrder, workOrderDigest: workOrderDigest(workOrder) };
}
