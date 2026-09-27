#!/usr/bin/env node
/**
 * Sanctioned read-only work-order pull (ADR 0106). A
 * worker receives only a compact envelope {workOrderRef, workOrderDigest,
 * executionIdentity} and runs this CLI to fetch and verify its own immutable
 * work order. The only write is the pull receipt.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun, readJsonIfExists as readJson } from "../_core-helpers.mjs";
import { WorkOrderRefusal, pullWorkOrder, registerWorkOrderRole } from "./_work-order-protocol.mjs";
import { buildGateEmitPlanPath } from "./write-gate-context.mjs";
import { resolveGateArtifactTmpRoot, resolveLedgerCheckouts } from "../loop/_repo-root-resolver.mjs";

const USAGE = `Usage: pull-work-order.mjs --ref <workOrderRef> --digest <workOrderDigest> --execution <executionIdentity> [--tmp-root <path>]
Verifies the compact reference against the role's canonical emitted unit, prints
the exact emitted work order, and writes a pull receipt under the MAIN checkout's
tmp/work-order-receipts/. The ref's "<role>:" prefix selects the role adapter; the
work order's header "role" must match it. --tmp-root pins where emitted work orders
are searched (default: tmp/ of every checkout of this repo, current checkout first).
Refusals (stdout JSON, exit 1): dispatch_reference_mismatch (retryable: re-dispatch
the SAME unit with its canonical reference), dispatch_identity_mismatch,
stale_dispatch, unknown_role, invalid_work_order, semantic_identity_mismatch,
local_materialization_integrity_failure.
Exit codes: 0 pulled, 1 refused, 2 usage/IO error.`;

// Gate reviewer adapter. ref = review:<owner/repo>#<pr>:<gate>:<headSha>:<scope>;
// executionIdentity = r<emit ms>-<hex>-u<n> (see emit-fanout-dispatch.mjs).
const REVIEW_REF_RE = /^review:([^/\s#]+\/[^/\s#]+)#(\d+):([a-z_]+):([0-9a-f]{40}|[0-9a-f]{64}):([A-Za-z0-9-]+)$/;
const EXECUTION_MS_RE = /^r(\d+)-/;

// A round is retired once a GATE-EXEC-ROUND-RETIREMENT record for its gate+head
// (retire-gate-round.mjs) was written at or after the round's emission time.
async function findRetirementAfter(tmpRoot, gate, headSha, emittedAtMs) {
  const retiredRoot = path.join(tmpRoot, "retired-gate-rounds", headSha);
  for (const round of await readdir(retiredRoot).catch(() => [])) {
    const record = await readJson(path.join(retiredRoot, round, "retirement.json"));
    if (record?.gate === gate && Date.parse(record.retiredAt) >= emittedAtMs) return round;
  }
  return null;
}

async function locateReviewUnit({ ref, execution, tmpRoots }) {
  const match = REVIEW_REF_RE.exec(ref);
  if (!match) return null;
  const [, repo, pr, gate, headSha] = match;
  for (const tmpRoot of tmpRoots) {
    const plan = await readJson(buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot }));
    const unit = plan?.units?.find((candidate) => candidate.workOrderRef === ref);
    if (!unit) continue;
    const emittedAtMs = Number(EXECUTION_MS_RE.exec(execution)?.[1]);
    const retired = Number.isFinite(emittedAtMs) ? await findRetirementAfter(tmpRoot, gate, headSha, emittedAtMs) : null;
    return {
      ...unit,
      materializationPath: unit.promptPath,
      subject: { repo, pr: Number(pr), gate, headSha, roundId: plan.roundId, scope: unit.scope },
      stale: retired && `execution ${execution} belongs to a ${gate} round at ${headSha} retired as ${retired}`,
    };
  }
  return null;
}

registerWorkOrderRole("review", {
  locate: locateReviewUnit,
  validate: (order) => (
    !Array.isArray(order.assignedAngles) || order.assignedAngles.length === 0 ? "reviewer work order names no assignedAngles"
      : !Array.isArray(order.requiredReads) ? "reviewer work order carries no requiredReads"
        : typeof order.executionRules?.widening !== "string" ? "reviewer work order states no widening rule"
          : null
  ),
});

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), receiptTmpRoot } = {}) {
  // A parseArgs error throws to the CLI wrapper (exit 2).
  const { values } = parseArgs({ args: argv, options: { ref: { type: "string" }, digest: { type: "string" }, execution: { type: "string" }, "tmp-root": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!values.ref || !values.digest || !values.execution) {
    process.stderr.write(`--ref, --digest and --execution are required\n${USAGE}\n`);
    return 2;
  }
  const tmpRoots = values["tmp-root"] ? [path.resolve(cwd, values["tmp-root"])] : resolveLedgerCheckouts(cwd).map((root) => path.join(root, "tmp"));
  try {
    const { workOrderText } = await pullWorkOrder({
      ref: values.ref, digest: values.digest, execution: values.execution, cwd, tmpRoots,
      receiptTmpRoot: receiptTmpRoot ?? resolveGateArtifactTmpRoot(cwd),
    });
    process.stdout.write(workOrderText);
    return 0;
  } catch (err) {
    if (!(err instanceof WorkOrderRefusal)) throw err;
    process.stdout.write(`${JSON.stringify({ ok: false, refusal: err.refusal, retryable: err.retryable, error: err.message })}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
