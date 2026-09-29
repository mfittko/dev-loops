/**
 * Role-independent work-order pull protocol (ADR 0106).
 *
 * One canonical serializer, one compact dispatch envelope, one role-keyed
 * reader and one receipt primitive for every worker role. Role behavior (where
 * a role's emitted work orders live, when a round is stale, what a valid
 * payload is) lives in a registered role adapter, never here.
 *
 * `workOrderDigest` / `canonicalizeWorkOrder` live in @dev-loops/core/loop/work-order-digest
 * (vendored into the Claude hooks) and are re-exported here. `materializationHash` is the
 * sha256 of the exact local work-order bytes.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "@dev-loops/core/loop/phase-files";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { DISPATCH_POINTER_MAX_BYTES, EXECUTION_IDENTITY_RE, executionIndexPath, workOrderDigest } from "@dev-loops/core/loop/work-order-digest";

export { DISPATCH_POINTER_MAX_BYTES, EXECUTION_IDENTITY_RE, canonicalizeWorkOrder, executionIndexPath, workOrderDigest } from "@dev-loops/core/loop/work-order-digest";

export const materializationHash = sha256Hex;

// The compact dispatch envelope, the ONLY text relayed to a worker: a self-describing pull instruction
// (a lagging agent definition still pulls), never task prose. It carries the execution identity alone
// (ADR 0115); the pull resolves the ref and digest from the emitter's execution index.
export function buildDispatchPointer({ executionIdentity }) {
  if (!EXECUTION_IDENTITY_RE.test(String(executionIdentity))) throw new Error(`execution identity ${JSON.stringify(executionIdentity)} does not match EXECUTION_IDENTITY_RE`);
  const text = `Run \`dev-loops-run scripts/github/pull-work-order.mjs ${executionIdentity}\`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`;
  const bytes = Buffer.byteLength(text);
  if (bytes > DISPATCH_POINTER_MAX_BYTES) throw new Error(`dispatch envelope for ${executionIdentity} is ${bytes} bytes, over DISPATCH_POINTER_MAX_BYTES ${DISPATCH_POINTER_MAX_BYTES}`);
  return text;
}

/** Write one emitted unit's execution index entry (wx); an existing entry with other content refuses the emission. */
export async function writeExecutionIndex(tmpRoot, { executionIdentity, workOrderRef, workOrderDigest: digest }) {
  const file = executionIndexPath(tmpRoot, executionIdentity);
  const text = `${JSON.stringify({ executionIdentity, workOrderRef, workOrderDigest: digest })}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    if (await readFile(file, "utf8") !== text) throw new WorkOrderRefusal("execution_index_collision", `execution index ${file} already names a different unit; emit a new execution identity`);
  }
}

const IDENTITY_ROLES = { r: "review", j: "judge", f: "fixer" };

/** The one `{ workOrderRef, workOrderDigest }` the execution index holds for `execution` across `tmpRoots`. */
async function resolveExecutionIndex(execution, tmpRoots) {
  let found = null;
  if (EXECUTION_IDENTITY_RE.test(String(execution))) {
    for (const tmpRoot of tmpRoots) {
      const entry = await readFile(executionIndexPath(tmpRoot, execution), "utf8").then(JSON.parse, () => null);
      if (!entry) continue;
      if (found && (found.workOrderRef !== entry.workOrderRef || found.workOrderDigest !== entry.workOrderDigest)) {
        throw new WorkOrderRefusal("local_materialization_integrity_failure", `execution ${execution} has conflicting execution index entries; re-emit the round`);
      }
      found ??= entry;
    }
  }
  if (!found) throw new WorkOrderRefusal("dispatch_reference_mismatch", `execution ${execution} matches no emitted execution index entry; re-dispatch the SAME unit with its emitted dispatchPrompt`, true);
  return found;
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
 * Resolve an execution identity through the execution index, verify the unit and pull its
 * work order. Returns { workOrderText, receipt, receiptPath }; throws WorkOrderRefusal.
 */
export async function pullWorkOrder({ execution, cwd, tmpRoots, receiptTmpRoot }) {
  const { workOrderRef: ref, workOrderDigest: digest } = await resolveExecutionIndex(execution, tmpRoots);
  const role = String(ref).split(":", 1)[0];
  const adapter = WORK_ORDER_ROLES.get(role);
  if (!adapter) throw new WorkOrderRefusal("unknown_role", `work-order role ${JSON.stringify(role)} has no registered adapter`);
  if (IDENTITY_ROLES[execution[0]] !== role) throw new WorkOrderRefusal("dispatch_identity_mismatch", `execution ${execution} names role ${IDENTITY_ROLES[execution[0]]}, but its index entry names ref ${ref}`);
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
 * when its mtime is at or after the matching receipt file's mtime. A missing result, or one
 * older than the pull (a replayed or prior-execution result), is reason
 * result_missing / result_predates_pull; those two failures still carry the verified receipt.
 */
export async function verifyPulledResult({ resultPath, ...receiptQuery }) {
  const check = await verifyPullReceipt(receiptQuery);
  if (!check.ok) return check;
  const writtenMs = await stat(resultPath).then((stats) => stats.mtimeMs, () => null);
  if (writtenMs === null) return { ok: false, reason: "result_missing", receipt: check.receipt };
  // Both mtimes come from the same filesystem clock, so a coarse mtime never refuses a post-pull result.
  const pulledMs = await stat(pullReceiptPath(receiptQuery.receiptTmpRoot, receiptQuery.workOrderRef)).then((stats) => stats.mtimeMs, () => null);
  return pulledMs !== null && writtenMs >= pulledMs ? check : { ok: false, reason: "result_predates_pull", receipt: check.receipt };
}
