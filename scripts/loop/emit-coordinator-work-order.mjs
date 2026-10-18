#!/usr/bin/env node
/**
 * Coordinator work order adapter (issue 2483, slice 1). Derives the envelope from the
 * startup resolver output through build-handoff-envelope.mjs and prints the coordinator
 * work order and its digest. It accepts no brief, summary file, overrides or payload JSON.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildCoordinatorWorkOrder } from "@dev-loops/core/loop/coordinator-work-order";
import { realpathNearestExisting } from "@dev-loops/core/loop/worktree-guard";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { WorkOrderRefusal, buildDispatchPointer, executionIndexPath, materializationHash, registerWorkOrderRole, writeExecutionIndex } from "../github/_work-order-protocol.mjs";
import { repoSlugFor } from "../github/_gate-artifact-paths.mjs";
import { assertTmpRootOutsideLinkedWorktree, resolveGateArtifactTmpRoot, resolveLedgerCheckouts, resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { buildHandoffEnvelopeCli } from "./build-handoff-envelope.mjs";

const USAGE = `Usage: emit-coordinator-work-order.mjs --input <resolver-output.json> [--repo <owner/name>] [--allowed-file <path>]... [--harness <claude|pi> --entry <queue|direct> [--tmp-root <path>]]
Derives the coordinator work order from the resolved handoff envelope. The allowed-file list
always includes changes/<issue>-*.md (the PR number for a unit without an issue).
With --harness and --entry it also materializes the order under <tmp-root>/coordinator-work-orders/
(default: the main checkout's tmp/) and prints {ok,workOrderRef,workOrderDigest,executionIdentity,
dispatchPrompt,dispatchPayload,planPath}. Dispatch dispatchPayload unchanged. A changed order has a new
digest and ref; a resume re-emits the same ref under a fresh execution identity. Any other harness refuses.
${JQ_OUTPUT_USAGE}
Stdout: {ok:true,workOrder,workOrderDigest} on success, {ok:false,refusal?,error} on failure (refusal is unsupported_adapter or invalid_entry for a refused emit) (nothing under --silent).
A failure ignores --fields and --jq.
Exit codes: 0 emitted, 1 refused or runtime failure, 2 invalid --jq/--fields usage on success output.`;

// ref = coordinator:<owner/repo>#<issueOrPr>:<entry>:<12 hex of the digest>; executionIdentity = c<emit ms>-<8 hex>.
const COORDINATOR_REF_RE = /^coordinator:([^/\s#]+\/[^/\s#]+)#(\d+):(queue|direct):([0-9a-f]{12})$/;
const ENTRIES = ["queue", "direct"];

const unitDir = (tmpRoot, repo, n, entry, hex) => path.join(tmpRoot, "coordinator-work-orders", repoSlugFor(repo), String(n), `${entry}-${hex}`);

export function renderCoordinatorWorkOrder(workOrder) {
  return `# Coordinator work order (ADR 0106)

Treat the handoff below as the complete envelope for ${workOrder.target.repo}. Follow its nextAction, stopRules, requiredReads and sanctionedCommands; ruleReferences name the rule owners.

\`\`\`json
${JSON.stringify(workOrder, null, 2)}
\`\`\`
`;
}

/** The Claude dev-loop agent type: repo-local in a dev-loops source checkout, else the plugin's. */
export function claudeDevLoopAgentType(cwd = process.cwd(), env = process.env) {
  if ((env.DEVLOOPS_AGENT_OVERRIDES ?? "").split(",").map((role) => role.trim()).includes("dev-loop")) return "dev-loop";
  const root = resolveRepoRoot(cwd);
  try {
    if (existsSync(path.join(root, "scripts")) && JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "dev-loops") return "dev-loop";
  } catch { /* not a source checkout */ }
  return "dev-loops:dev-loop";
}

// Each adapter carries the fixed pointer and its tool's required routing fields; any other harness refuses.
const DISPATCH_ADAPTERS = {
  claude: (prompt, cwd) => ({ subagent_type: claudeDevLoopAgentType(cwd), description: "coordinator work order", prompt }),
  pi: (prompt) => ({ agent: "dev-loop", task: prompt }),
};

export function buildCoordinatorDispatchPayload({ harness, dispatchPrompt, cwd }) {
  if (!Object.hasOwn(DISPATCH_ADAPTERS, harness)) throw new WorkOrderRefusal("unsupported_adapter", `harness ${JSON.stringify(harness)} has no coordinator dispatch adapter; supported: ${Object.keys(DISPATCH_ADAPTERS).join(", ")}`);
  return DISPATCH_ADAPTERS[harness](dispatchPrompt, cwd);
}

/** Materialize one coordinator order under `tmpRoot` and index a fresh execution identity for it. */
export async function materializeCoordinatorWorkOrder({ workOrder, workOrderDigest, entry, tmpRoot, executionIdentity = `c${Date.now()}-${randomBytes(4).toString("hex")}` }) {
  if (!ENTRIES.includes(entry)) throw new WorkOrderRefusal("invalid_entry", `--entry must be one of ${ENTRIES.join(", ")}, got ${entry}`);
  const { repo, issue, pr } = workOrder.target;
  const n = issue ?? pr;
  const hex = workOrderDigest.slice("sha256:".length, "sha256:".length + 12);
  const dir = unitDir(tmpRoot, repo, n, entry, hex);
  const text = renderCoordinatorWorkOrder(workOrder);
  const promptPath = path.join(dir, "order.md");
  const planPath = path.join(dir, "plan.json");
  const identity = { workOrderRef: `coordinator:${repo}#${n}:${entry}:${hex}`, workOrderDigest, executionIdentity };
  const dispatchPrompt = buildDispatchPointer(identity);
  await mkdir(dir, { recursive: true });
  // Atomic (temp + rename): a concurrent pull never reads a half-written file.
  const writeAtomic = async (target, body) => {
    const tempPath = `${target}.tmp-${executionIdentity}`;
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, target);
  };
  await writeAtomic(promptPath, text);
  // The plan holds no execution identity: a resume re-emits identical bytes.
  await writeAtomic(planPath, `${JSON.stringify({ workOrderRef: identity.workOrderRef, workOrderDigest, materializationHash: materializationHash(text), promptPath, workOrder }, null, 2)}\n`);
  await writeExecutionIndex(tmpRoot, identity);
  return { ...identity, dispatchPrompt, planPath };
}

// Coordinator adapter: the ref names the unit directory; the execution index binds an execution identity to the ref.
async function locateCoordinatorUnit({ ref, digest, execution, tmpRoots }) {
  const match = COORDINATOR_REF_RE.exec(ref);
  if (!match) return null;
  const [, repo, n, entry, hex] = match;
  for (const tmpRoot of tmpRoots) {
    const planPath = path.join(unitDir(tmpRoot, repo, n, entry, hex), "plan.json");
    const plan = await readFile(planPath, "utf8").then(JSON.parse).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw new WorkOrderRefusal("local_materialization_integrity_failure", `coordinator plan ${planPath} is unreadable; re-emit the coordinator work order`);
    });
    if (!plan || plan.workOrderRef !== ref) continue;
    const indexed = await readFile(executionIndexPath(tmpRoot, execution), "utf8").then(JSON.parse).catch(() => null);
    // A plan that kept its reference but lost its order cannot render: refuse by name, not with a TypeError.
    let rendered;
    try { rendered = materializationHash(renderCoordinatorWorkOrder(plan.workOrder)); } catch {
      throw new WorkOrderRefusal("local_materialization_integrity_failure", `coordinator plan ${planPath} has no renderable workOrder; re-emit the coordinator work order`);
    }
    return {
      workOrder: plan.workOrder, workOrderDigest: plan.workOrderDigest, executionIdentity: indexed?.workOrderRef === ref ? execution : null,
      materializationPath: plan.promptPath, materializationHash: rendered, subject: { repo, target: Number(n), entry },
    };
  }
  return null;
}

registerWorkOrderRole("coordinator", {
  locate: locateCoordinatorUnit,
  validate: (order) => order.operation !== "coordinate" ? "coordinator work order operation must be coordinate"
    : typeof order.handoff?.target !== "object" || typeof order.handoff?.nextAction !== "string" || !order.handoff.nextAction ? "coordinator work order has no handoff target and nextAction"
      : null,
});

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  let values;
  const options = {
    input: { type: "string" }, repo: { type: "string" }, "allowed-file": { type: "string", multiple: true },
    harness: { type: "string" }, entry: { type: "string" }, "tmp-root": { type: "string" },
    help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS,
  };
  // One failure shape: {ok:false,refusal?,error} on stdout unless --silent; --fields and --jq never apply to a failure.
  const fail = (error, stderrText, refusal) => {
    // Without parsed values, scan argv itself: a missing option value would make a non-strict parse swallow --silent.
    const terminator = argv.indexOf("--");
    const silent = values?.silent ?? argv.slice(0, terminator < 0 ? undefined : terminator).some((a) => a === "--silent" || a === "-s");
    if (!silent) stdout.write(`${JSON.stringify({ ok: false, ...(refusal ? { refusal } : {}), error })}\n`);
    stderr.write(`${stderrText}\n`);
    return 1;
  };
  try {
    ({ values } = parseArgs({ args: argv, options }));
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!values.input) {
      return fail("--input is required", USAGE);
    }
    if (Boolean(values.harness) !== Boolean(values.entry)) return fail("--harness and --entry go together", USAGE);
    if (values.harness) buildCoordinatorDispatchPayload({ harness: values.harness, dispatchPrompt: "", cwd }); // refuse an unknown harness before emitting
    const envelope = await buildHandoffEnvelopeCli({ inputPath: values.input, repo: values.repo });
    const { workOrder, workOrderDigest } = buildCoordinatorWorkOrder({
      envelope, allowedFiles: values["allowed-file"] ?? [],
    });
    const out = { ok: true, workOrder, workOrderDigest };
    if (values.harness) {
      let tmpRoot = resolveGateArtifactTmpRoot(cwd);
      if (values["tmp-root"]) {
        tmpRoot = path.resolve(cwd, values["tmp-root"]);
        assertTmpRootOutsideLinkedWorktree(tmpRoot, resolveRepoRoot(cwd));
        // The pointer carries no root selector and the pull scans only listed checkouts' tmp directories.
        const allowed = resolveLedgerCheckouts(cwd).map((root) => realpathNearestExisting(path.join(root, "tmp")));
        if (!allowed.includes(realpathNearestExisting(tmpRoot))) throw new Error(`--tmp-root ${tmpRoot} is not a checkout's tmp root (${allowed.join(", ")}); the pull cannot find an order elsewhere, so omit --tmp-root or pass one of these`);
      }
      const unit = await materializeCoordinatorWorkOrder({ workOrder, workOrderDigest, entry: values.entry, tmpRoot });
      const { workOrderRef, executionIdentity, dispatchPrompt, planPath } = unit;
      return emitResult({ ok: true, workOrderRef, workOrderDigest, executionIdentity, dispatchPrompt, dispatchPayload: buildCoordinatorDispatchPayload({ harness: values.harness, dispatchPrompt, cwd }), planPath },
        { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
    }
    return emitResult(out, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), formatCliError(err), err?.refusal);
  }
}

if (isDirectCliRun(import.meta.url)) process.exitCode = await runCli();
