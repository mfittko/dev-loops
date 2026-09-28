/**
 * Role-independent work-order pull protocol (ADR 0106).
 *
 * One canonical serializer, one compact dispatch envelope, one role-keyed
 * reader and one receipt primitive for every worker role. Role behavior (where
 * a role's emitted work orders live, when a round is stale, what a valid
 * payload is) lives in a registered role adapter, never here.
 *
 * `workOrderDigest` is the sha256 of the canonical SEMANTIC work order: object
 * keys sorted, machine-local material excluded (LOCAL_MATERIAL_KEYS and every
 * absolute-path string). Repository-relative paths stay semantic. Two checkouts
 * that emit the same unit get the same digest. `materializationHash` is the
 * sha256 of the exact local work-order bytes.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "@dev-loops/core/loop/phase-files";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";

// Local-only fields: the materialized file, absolute output refs, tmp roots,
// and hashes/sizes of files that embed absolute paths (the briefing prefix, and
// the required reads: the evidence file's validation pointer and validation.json).
// Readers still verify each required read's sha256 from the materialized work order.
const LOCAL_MATERIAL_KEYS = new Set(["promptPath", "outputRefs", "tmpRoot", "prefixSha256", "sha256", "bytes"]);

/** Hard cap for the compact dispatch envelope every role sends (bytes). */
export const DISPATCH_POINTER_MAX_BYTES = 499;

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

export const workOrderDigest = (workOrder) => sha256Hex(JSON.stringify(canonicalizeWorkOrder(workOrder)));

export const materializationHash = sha256Hex;

// The compact dispatch envelope, the ONLY text relayed to a worker: a self-describing pull instruction
// (a lagging agent definition still pulls), never task prose. Values go unquoted, so each is one shell-inert word.
export function buildDispatchPointer({ workOrderRef, workOrderDigest: digest, executionIdentity }) {
  const unsafe = [workOrderRef, digest, executionIdentity].find((value) => !/^[A-Za-z0-9][\w.:/#-]*$/.test(String(value)));
  if (unsafe !== undefined) throw new Error(`dispatch envelope value ${JSON.stringify(unsafe)} is not shell-safe`);
  const text = `Run \`dev-loops-run scripts/github/pull-work-order.mjs --ref ${workOrderRef} --digest ${digest} --execution ${executionIdentity}\`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`;
  const bytes = Buffer.byteLength(text);
  if (bytes > DISPATCH_POINTER_MAX_BYTES) throw new Error(`dispatch envelope for ${workOrderRef} is ${bytes} bytes, over DISPATCH_POINTER_MAX_BYTES ${DISPATCH_POINTER_MAX_BYTES}`);
  return text;
}

/**
 * Role registry. A role adapter is
 *   { locate({ ref, digest, execution, cwd, tmpRoots }) -> Promise<located|null>, validate(workOrder) -> string|null }
 * where `located` is { workOrder, workOrderDigest, executionIdentity,
 * materializationPath, materializationHash, subject, stale?: string } for the
 * canonical emitted unit that holds `ref`. The ref's leading `<role>:` selects
 * the adapter; the located work order's header `role` must name the same role.
 */
export const WORK_ORDER_ROLES = new Map();
export const registerWorkOrderRole = (role, adapter) => WORK_ORDER_ROLES.set(role, adapter);

export class WorkOrderRefusal extends Error {
  constructor(refusal, message, retryable = false) { super(message); Object.assign(this, { refusal, retryable }); }
}

/** Receipt location: one file per work-order ref under the MAIN checkout's tmp root. */
export const pullReceiptPath = (receiptTmpRoot, workOrderRef) => path.join(receiptTmpRoot, "work-order-receipts", `${sha256Hex(workOrderRef)}.json`);

/**
 * Verify a compact reference and pull its work order. Returns
 * { workOrderText, receipt, receiptPath }; throws WorkOrderRefusal.
 */
export async function pullWorkOrder({ ref, digest, execution, cwd, tmpRoots, receiptTmpRoot }) {
  const role = String(ref).split(":", 1)[0];
  const adapter = WORK_ORDER_ROLES.get(role);
  if (!adapter) throw new WorkOrderRefusal("unknown_role", `work-order role ${JSON.stringify(role)} has no registered adapter`);
  const unit = await adapter.locate({ ref, digest, execution, cwd, tmpRoots });
  // Stale first: a retired or superseded round never retargets onto the newest unit.
  if (unit?.stale) throw new WorkOrderRefusal("stale_dispatch", `${unit.stale}; never retarget to the newest round, reconcile and re-dispatch the current lawful unit`);
  if (!unit || unit.workOrderDigest !== digest) throw new WorkOrderRefusal("dispatch_reference_mismatch", `ref/digest ${ref} ${digest} matches no canonical emitted unit; re-dispatch the SAME unit with its canonical compact reference`, true);
  if (unit.executionIdentity !== execution) throw new WorkOrderRefusal("dispatch_identity_mismatch", `execution ${execution} is not the execution emitted for ${ref}; do not count this worker's result`);
  if (unit.workOrder?.role !== role) {
    const refusal = WORK_ORDER_ROLES.has(unit.workOrder?.role) ? "dispatch_identity_mismatch" : "unknown_role";
    throw new WorkOrderRefusal(refusal, `work order header role ${JSON.stringify(unit.workOrder?.role)} does not match ref role ${JSON.stringify(role)}`);
  }
  if (workOrderDigest(unit.workOrder) !== unit.workOrderDigest) throw new WorkOrderRefusal("semantic_identity_mismatch", `the canonical work order for ${ref} no longer reproduces workOrderDigest ${unit.workOrderDigest}; fail closed and re-emit against current authority`);
  const invalid = adapter.validate(unit.workOrder);
  if (invalid) throw new WorkOrderRefusal("invalid_work_order", invalid);
  const workOrderText = await readFile(unit.materializationPath, "utf8").catch(() => null);
  if (workOrderText === null || materializationHash(workOrderText) !== unit.materializationHash) throw new WorkOrderRefusal("local_materialization_integrity_failure", `local work order ${unit.materializationPath} is missing or no longer matches materializationHash while workOrderDigest still reproduces; never re-dispatch a different work order`);
  const receipt = { executionIdentity: execution, role, workOrderRef: ref, workOrderDigest: digest, materializationHash: unit.materializationHash, subject: unit.subject, pulledAt: new Date().toISOString() };
  const receiptPath = pullReceiptPath(receiptTmpRoot, ref);
  await writeJson(receiptPath, receipt);
  return { workOrderText, receipt, receiptPath };
}

/**
 * Receipt-verification seam for every result consumer (gate fan-in first).
 * Returns { ok: true, receipt } or { ok: false, reason } where reason is one of
 * receipt_missing, unit_mismatch, role_mismatch, execution_mismatch, digest_mismatch.
 */
export async function verifyPullReceipt({ receiptTmpRoot, workOrderRef, workOrderDigest: digest, executionIdentity, role }) {
  const receipt = await readFile(pullReceiptPath(receiptTmpRoot, workOrderRef), "utf8").then(JSON.parse).catch(() => undefined);
  if (receipt === undefined) return { ok: false, reason: "receipt_missing" };
  if (receipt?.workOrderRef !== workOrderRef) return { ok: false, reason: "unit_mismatch" };
  if (receipt.role !== role) return { ok: false, reason: "role_mismatch" };
  if (receipt.executionIdentity !== executionIdentity) return { ok: false, reason: "execution_mismatch" };
  if (receipt.workOrderDigest !== digest) return { ok: false, reason: "digest_mismatch" };
  return { ok: true, receipt };
}

/**
 * verifyPullReceipt plus result binding: the result at `resultPath` counts only
 * when it was written at or after the matching pull. A missing result, or one
 * older than the pull (a replayed or prior-execution result), is reason
 * result_missing / result_predates_pull.
 */
export async function verifyPulledResult({ resultPath, ...receiptQuery }) {
  const check = await verifyPullReceipt(receiptQuery);
  if (!check.ok) return check;
  const writtenMs = await stat(resultPath).then((stats) => stats.mtimeMs, () => null);
  if (writtenMs === null) return { ok: false, reason: "result_missing" };
  // An unparseable pulledAt compares false, so it fails closed.
  return writtenMs >= Date.parse(check.receipt.pulledAt) ? check : { ok: false, reason: "result_predates_pull" };
}
