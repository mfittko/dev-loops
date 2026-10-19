/**
 * Coordinator work order producer (issue 2483, slice 1).
 *
 * Wraps the resolved handoff envelope (buildDevLoopHandoffEnvelope) in a coordinator
 * work order. The digest comes from the shared serializer in work-order-digest.mjs;
 * this module adds no second canonicalization. It accepts no brief, prose, summary
 * file or envelope override: every route, next-action, stop, acceptance, required-read
 * and sanctioned-command fact is the envelope's own.
 */
import path from "node:path";
import { workOrderDigest } from "./work-order-digest.mjs";
import { validateHandoffEnvelope } from "./handoff-envelope.mjs";

const INPUT_KEYS = new Set(["envelope", "allowedFiles"]);

export class CoordinatorWorkOrderRefusal extends Error {}

/** `changes/<n>-*.md`: n is the unit's issue number; the PR number only for a lightweight (specSource pr_body) unit. */
export function changesFragmentGlob(target, specSource) {
  const n = target?.issue ?? (specSource === "pr_body" ? target?.pr : undefined);
  if (!Number.isInteger(n) || n < 1) throw new CoordinatorWorkOrderRefusal("coordinator target names no issue number (a PR number is accepted only for a lightweight pr_body unit)");
  return `changes/${n}-*.md`;
}

/**
 * Build the coordinator work order and its digest. Throws CoordinatorWorkOrderRefusal
 * for an unknown input, an invalid envelope or an envelope carrying overrides.
 */
export function buildCoordinatorWorkOrder(input) {
  const unknown = Object.keys(input ?? {}).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) throw new CoordinatorWorkOrderRefusal(`coordinator work order accepts only envelope and allowedFiles; refused: ${unknown.join(", ")}`);
  const { envelope, allowedFiles = [] } = input ?? {};
  const valid = validateHandoffEnvelope(envelope);
  if (!valid.ok) throw new CoordinatorWorkOrderRefusal(`handoff envelope is invalid: ${valid.errors.map((e) => e.field).join(", ")}`);
  if (envelope.overrides !== undefined) throw new CoordinatorWorkOrderRefusal("handoff envelope overrides are not a coordinator source; re-resolve without overrides");
  if (!Array.isArray(allowedFiles) || allowedFiles.some((p) => typeof p !== "string" || /[\u0000-\u001f\u007f\\]/.test(p))) {
    throw new CoordinatorWorkOrderRefusal("allowedFiles must be repository-relative paths without control characters or backslashes");
  }
  const ownGlob = changesFragmentGlob(envelope.target, envelope.specSource);
  const normalized = allowedFiles.map((p) => p.split("/").filter((seg) => seg !== "" && seg !== ".").join("/"));
  if (normalized.some((p, i) => p === "" || p.split("/").includes("..") || allowedFiles[i].startsWith("/"))) {
    throw new CoordinatorWorkOrderRefusal("allowedFiles must be repository-relative paths");
  }
  // Own-fragment guard: closed allowlist. The first segment must be a plain name that is not `changes` in any case; globs, extglobs and whitespace refuse.
  const coversChanges = (p) => p !== ownGlob && !(/^[A-Za-z0-9._-]+$/.test(p.split("/")[0]) && p.split("/")[0].toLowerCase() !== "changes");
  if (normalized.some(coversChanges)) {
    throw new CoordinatorWorkOrderRefusal(`allowedFiles may name only the unit's own ${ownGlob}`);
  }
  // gateState.derivedAt is a collection timestamp, not semantic; every other envelope field is retained.
  const { gateState, ...handoff } = envelope;
  const { derivedAt: _derivedAt, ...semanticGateState } = gateState ?? {};
  // stopRules and requiredReads order is semantic (consumed in order) and stays verbatim.
  // The digest drops absolute strings, so an absolute read has no portable identity: refuse it.
  if (Array.isArray(handoff.requiredReads) && handoff.requiredReads.some((p) => path.isAbsolute(p))) {
    throw new CoordinatorWorkOrderRefusal("requiredReads must be repository-relative paths");
  }
  // gateConfig lists are unordered sets: sort them so equivalent configurations share one digest.
  if (handoff.gateConfig) {
    handoff.gateConfig = { ...handoff.gateConfig };
    for (const key of ["angles", "excludeAngles", "blockCleanOnFindingSeverities"]) {
      if (Array.isArray(handoff.gateConfig[key])) handoff.gateConfig[key] = [...handoff.gateConfig[key]].sort();
    }
  }
  const workOrder = {
    role: "coordinator",
    operation: "coordinate",
    target: envelope.target,
    handoff: { ...handoff, gateState: semanticGateState },
    allowedFiles: [...new Set([...normalized, ownGlob])].sort(),
  };
  return { workOrder, workOrderDigest: workOrderDigest(workOrder) };
}
