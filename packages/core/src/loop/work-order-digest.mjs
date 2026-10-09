/**
 * The canonical work-order serializer and `workOrderDigest` (ADR 0106).
 *
 * `workOrderDigest` is the sha256 of the canonical SEMANTIC work order: object
 * keys sorted, machine-local material excluded (LOCAL_MATERIAL_KEYS and every
 * absolute-path string). Repository-relative paths stay semantic. Two checkouts
 * reproduce the same digest for the same execution-bound semantic work order;
 * separate reviewer emissions intentionally have different execution identities
 * and digests. Dependency-free (node: builtins only) so the Claude hook bundle
 * can vendor it.
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

/** Hard cap for the compact dispatch envelope every role sends (bytes). */
export const DISPATCH_POINTER_MAX_BYTES = 499;

/** Execution identity: `r` review unit (with `-u<n>`), `j` judge round, `f` fixer execution (ADR 0115). */
export const EXECUTION_IDENTITY_RE = /^[rjf]\d+-[0-9a-f]{8}(?:-u\d+)?$/;

/** The emitter's execution index entry `{ executionIdentity, workOrderRef, workOrderDigest }` for one unit. */
export const executionIndexPath = (tmpRoot, executionIdentity) => path.join(tmpRoot, "work-order-executions", `${executionIdentity}.json`);

/** `sha256:<hex>` of the canonical work order's JSON text. */
export const workOrderDigest = (workOrder) =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeWorkOrder(workOrder))).digest("hex")}`;
