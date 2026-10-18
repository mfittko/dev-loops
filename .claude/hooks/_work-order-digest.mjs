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
const LOCAL_MATERIAL_KEYS = new Set(["promptPath", "outputRefs", "tmpRoot", "prefixSha256", "sha256", "bytes", "handbackCheck"]);

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

/** Execution identity: `r` review unit (with `-u<n>`), `j` judge round, `f` fixer execution (ADR 0115), `c` coordinator execution (ADR 0159). */
export const EXECUTION_IDENTITY_RE = /^[rjfc]\d+-[0-9a-f]{8}(?:-u\d+)?$/;

/** The emitter's execution index entry `{ executionIdentity, workOrderRef, workOrderDigest }` for one unit. */
export const executionIndexPath = (tmpRoot, executionIdentity) => path.join(tmpRoot, "work-order-executions", `${executionIdentity}.json`);

/** `sha256:<hex>` of the canonical work order's JSON text. */
export const workOrderDigest = (workOrder) =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeWorkOrder(workOrder))).digest("hex")}`;

// Content identity preserves every JSON key and absolute string, unlike work-order identity.
const sortJsonKeys = (value) => {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid fixer review baseline: non-finite JSON number");
  return Array.isArray(value) ? value.map(sortJsonKeys)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])])) : value;
};

/** Authenticate optional full-ACT reviewed-baseline authority from the exact required-read entries. */
export function assertFixerReviewBaseline(order, bytesByRead) {
  if (!Object.hasOwn(order.authority ?? {}, "reviewBaselineHead")) return null;
  const { reviewBaselineHead, sourceDigest, deltaResultDigest } = order.authority;
  const refuse = (reason) => { throw new Error(`Invalid fixer review baseline: ${reason}`); };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (typeof reviewBaselineHead !== "string" || !/^[0-9a-f]{40}$/.test(reviewBaselineHead)
    || order.role !== "fixer" || order.phase !== "full" || order.source !== "act-list") refuse("requires a full ACT fixer and a lowercase 40-character head");
  if (!Array.isArray(order.requiredReads) || !isDigest(sourceDigest) || !isDigest(deltaResultDigest)) refuse("missing ACT/Delta semantic authority");
  const [actList, delta] = ["act-list", "delta-result"].map((kind, index) => {
    const reads = order.requiredReads.filter((read) => read?.kind === kind);
    if (reads.length !== 1 || reads[0].required !== true) refuse(`requires one required ${kind} read`);
    const read = reads[0];
    const bytes = bytesByRead?.get(read);
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(read.bytes) || read.bytes !== bytes.length
      || !isDigest(read.sha256) || hash(bytes) !== read.sha256) refuse(`${kind} bytes, length or hash differ`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { refuse(`${kind} is not valid JSON`); }
    if (hash(JSON.stringify(sortJsonKeys(parsed))) !== [sourceDigest, deltaResultDigest][index]) refuse(`${kind} semantic authority differs`);
    return parsed;
  });
  if (delta?.reviewBaselineHead !== reviewBaselineHead) refuse("Delta reviewed head differs");
  return { reviewBaselineHead, actList, delta };
}
