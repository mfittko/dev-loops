#!/usr/bin/env node
/**
 * Sanctioned read-only work-order pull (ADR 0106). A
 * worker receives only a compact envelope that tells it to run this CLI with
 * its workOrderRef, workOrderDigest and executionIdentity, or its executionIdentity
 * alone (ADR 0115), to fetch and verify its own immutable work order. The only
 * write is the pull receipt.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { formatCliError, isDirectCliRun, readJsonIfExists as readJson } from "../_core-helpers.mjs";
import { EXECUTION_IDENTITY_RE, WorkOrderRefusal, executionIndexPath, pullWorkOrder, registerWorkOrderRole } from "./_work-order-protocol.mjs";
import { buildGateEmitPlanPath } from "./write-gate-context.mjs";
import { TOOLCHAIN_ROOT, isOtherDevLoopsCheckout, resolveGateArtifactTmpRoot, resolveLedgerCheckouts, resolveMainWorktreeRoot } from "../loop/_repo-root-resolver.mjs";
import "../loop/emit-fixer-work-order.mjs"; // registers the fixer role adapter
import "../loop/emit-judge-work-order.mjs"; // registers the judge role adapter

const USAGE = `Usage: pull-work-order.mjs <executionIdentity> [--tmp-root <path>]
       pull-work-order.mjs --ref <workOrderRef> --digest <workOrderDigest> --execution <executionIdentity> [--tmp-root <path>]
The short form resolves the executionIdentity to its workOrderRef and workOrderDigest
through the emitter's tmp/work-order-executions/ index (ADR 0115). Both forms verify
the compact reference against the role's canonical emitted unit, print
the exact emitted work order, and write a pull receipt under the MAIN checkout's
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
const EXECUTION_ROUND_RE = /^(r(\d+)-[0-9a-f]+)-u/;

// The retirement predicate, shared with the fixer hooks (their vendored copy).
export { findRetirementAfter };

// Digests are equal across checkouts, so the search prefers a digest match whose
// plan round is this execution's (not stale), then any digest match, then the first unit.
async function locateReviewUnit({ ref, digest, execution, tmpRoots }) {
  const match = REVIEW_REF_RE.exec(ref);
  if (!match) return null;
  const [, repo, pr, gate, headSha] = match;
  // A typed gate/pr/repo the path builder rejects is a retryable typo, never an IO error.
  try { buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot: "tmp" }); } catch { return null; }
  const [, executionRound, emittedAtMs] = EXECUTION_ROUND_RE.exec(execution) ?? [];
  const rank = (unit) => (unit.workOrderDigest === digest) * 2 + !unit.stale;
  let best = null;
  for (const tmpRoot of tmpRoots) {
    const plan = await readJson(buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot }));
    const unit = plan?.units?.find((candidate) => candidate.workOrderRef === ref);
    if (!unit) continue;
    const retired = executionRound ? await findRetirementAfter(tmpRoot, gate, headSha, Number(emittedAtMs)) : null;
    // A parsed round other than the plan's was superseded by a re-emission.
    const superseded = executionRound && executionRound !== plan.roundId
      && `execution ${execution} belongs to ${gate} round ${executionRound} at ${headSha}, superseded by round ${plan.roundId}`;
    const located = {
      ...unit,
      materializationPath: unit.promptPath,
      subject: { repo, pr: Number(pr), gate, headSha, roundId: plan.roundId, scope: unit.scope },
      stale: superseded || (retired && `execution ${execution} belongs to a ${gate} round at ${headSha} retired as ${retired}`),
    };
    if (!best || rank(located) > rank(best)) best = located;
  }
  return best;
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

// ADR 0117: on a self-hosting PR the emitter wrote the execution index entry in the PR worktree. That
// checkout is the review root, so its own pull script serves the pull. The marker stops a second hop.
// The pull never delegates back to the main checkout. A main-anchored entry (the fixer index) can be
// emitted from any checkout, so its location names no review root and the local toolchain serves it.
const PULL_DELEGATED_ENV = "DEV_LOOPS_PULL_DELEGATED";
const PULL_SCRIPT = "scripts/github/pull-work-order.mjs";

/** The dev-loops checkout whose pull script must serve `execution`, or null to pull locally. */
export function pullDelegationTarget(execution, tmpRoots, { toolchainRoot = TOOLCHAIN_ROOT, env = process.env } = {}) {
  if (env[PULL_DELEGATED_ENV] || !EXECUTION_IDENTITY_RE.test(String(execution))) return null;
  const tmpRoot = tmpRoots.find((root) => existsSync(executionIndexPath(root, execution)));
  const checkout = tmpRoot ? path.dirname(tmpRoot) : null;
  if (!checkout || !existsSync(path.join(checkout, PULL_SCRIPT)) || !isOtherDevLoopsCheckout(checkout, toolchainRoot)) return null;
  const mainRoot = resolveMainWorktreeRoot(toolchainRoot);
  if (!isOtherDevLoopsCheckout(checkout, mainRoot)) return null;
  // Only a linked worktree of this same repository may serve the pull, never an unrelated checkout.
  if (realpathSync(resolveMainWorktreeRoot(checkout)) !== realpathSync(mainRoot)) return null;
  return checkout;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), receiptTmpRoot } = {}) {
  // A parseArgs error throws to the CLI wrapper (exit 2).
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ref: { type: "string" }, digest: { type: "string" }, execution: { type: "string" }, "tmp-root": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Step 1 of ADR 0115: the short form (one positional) or the full 3-flag form, nothing in between.
  const threeFlag = Boolean(values.ref && values.digest && values.execution) && positionals.length === 0;
  const short = positionals.length === 1 && !values.ref && !values.digest && !values.execution;
  if (!threeFlag && !short) {
    process.stderr.write(`pass one <executionIdentity>, or all of --ref, --digest and --execution\n${USAGE}\n`);
    return 2;
  }
  const tmpRoots = values["tmp-root"] ? [path.resolve(cwd, values["tmp-root"])] : resolveLedgerCheckouts(cwd).map((root) => path.join(root, "tmp"));
  // An injected receiptTmpRoot pins where the receipt lands, which the child cannot honor: pull locally.
  const target = receiptTmpRoot ? null : pullDelegationTarget(short ? positionals[0] : values.execution, tmpRoots);
  if (target) {
    // stdout, stderr and the exit code pass through unchanged. The child runs under cwd `target`, so a
    // --tmp-root goes over as the absolute path this process resolved.
    const childArgs = [
      ...(short ? [positionals[0]] : ["--ref", values.ref, "--digest", values.digest, "--execution", values.execution]),
      ...(values["tmp-root"] ? ["--tmp-root", tmpRoots[0]] : []),
    ];
    const r = spawnSync(process.execPath, [path.join(target, PULL_SCRIPT), ...childArgs], { cwd: target, stdio: "inherit", env: { ...process.env, [PULL_DELEGATED_ENV]: "1" } });
    if (r.error) process.stderr.write(`pull-work-order: delegated pull failed to start: ${r.error.message}\n`);
    return r.status ?? 2;
  }
  try {
    const { workOrderText } = await pullWorkOrder({
      ...(short ? { execution: positionals[0] } : { ref: values.ref, digest: values.digest, execution: values.execution }), cwd, tmpRoots,
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
