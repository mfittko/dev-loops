// GENERATED from packages/core/src/loop/work-order-digest.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * The canonical work-order serializer and `workOrderDigest` (ADR 0106).
 *
 * `workOrderDigest` is the sha256 of the canonical SEMANTIC work order: object
 * keys sorted, machine-local material excluded (LOCAL_MATERIAL_KEYS and every
 * absolute-path string). Repository-relative paths stay semantic. Two checkouts
 * that emit the same unit get the same digest. Dependency-free (node: builtins
 * only) so the Claude hook bundle can vendor it.
 */
import { createHash } from "node:crypto";
import path from "node:path";

// Local-only fields: the materialized file, absolute output refs, tmp roots,
// and hashes/sizes of files that embed absolute paths (the briefing prefix, and
// the required reads: the evidence file's validation pointer and validation.json).
// Readers still verify each required read's sha256 from the materialized work order.
const LOCAL_MATERIAL_KEYS = new Set(["promptPath", "outputRefs", "tmpRoot", "prefixSha256", "sha256", "bytes"]);

const isLocal = (value) => typeof value === "string" && path.isAbsolute(value);

export function canonicalizeWorkOrder(value) {
  if (Array.isArray(value)) return value.filter((item) => !isLocal(item)).map(canonicalizeWorkOrder);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (LOCAL_MATERIAL_KEYS.has(key) || value[key] === undefined || isLocal(value[key])) continue;
    out[key] = canonicalizeWorkOrder(value[key]);
  }
  return out;
}

/** `sha256:<hex>` of the canonical work order's JSON text. */
export const workOrderDigest = (workOrder) =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeWorkOrder(workOrder))).digest("hex")}`;
