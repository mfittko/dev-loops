/**
 * Fixer grant loading for the Write/Edit guard, plus the pull binding the Bash gate records (ADR 0107).
 *
 * Edge I/O only: list the repo's checkouts and the CURRENT fixer grants. The pure
 * decider (decideFixerWriteGuard in `./_hook-decisions.mjs`) owns the decision.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findRetirementAfter } from "./_gate-round-retirement.mjs";
import { parseSanctionedPullLine } from "./_hook-decisions.mjs";
import { realpathNearestExisting } from "./_worktree-guard.mjs";
import { EXECUTION_IDENTITY_RE, executionIndexPath, workOrderDigest } from "./_work-order-digest.mjs";

/**
 * Env for every git call in this module: an inherited GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE overrides `-C`, so a pointer at
 * another repo would list that repo's checkouts and fail the fixer boundary open. The hook bundle cannot import
 * scripts/, so this strips the four override variables itself. It is a superset of gitEnvNoDirOverrides in
 * scripts/loop/_repo-root-resolver.mjs, which clears only GIT_DIR and GIT_WORK_TREE.
 */
export const gitEnv = () => ({ ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined });

/** Nearest existing directory at or above `p` (absolute). */
export function nearestExistingDir(p) {
  let dir = path.resolve(p);
  while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory() && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** `git worktree list` from `dir` as `[{ root, branch }]` (realpath roots, main first); [] outside git. */
export function listCheckouts(dir) {
  try {
    const porcelain = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] });
    return porcelain.split(/\n\s*\n/u).map((block) => {
      const lines = block.split("\n");
      const field = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
      const root = field("worktree");
      return root ? { root: realpathNearestExisting(root), branch: field("branch")?.replace(/^refs\/heads\//u, "") ?? null } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// A fixer execution: the shared identity pattern with an `f` prefix and no `-u<n>` unit suffix.
export const isFixerExecution = (id) => typeof id === "string" && id[0] === "f" && !id.includes("-u") && EXECUTION_IDENTITY_RE.test(id);

// Grant-to-agent binding. Verified by a headless PreToolUse stdin probe: a subagent's hook input
// carries `agent_id` (e.g. "abea5f653d974dbf2"), identical across all tool calls of that subagent;
// the main agent's input carries no `agent_id`. The fixer's write guard denies Write/Edit under the
// main checkout's tmp/, but the hooks do not stop a Bash write (a redirect, cp, an
// interpreter) to a marker: ADR 0107 records that ceiling, closed by process-owned worker I/O (#2343).
// Keyed by ref, digest AND execution, so a pull line with a wrong digest or execution never
// overwrites the pulling fixer's marker.
const bindingPath = (mainRoot, workOrderRef, workOrderDigest, executionIdentity) =>
  path.join(mainRoot, "tmp", "work-order-receipts", "fixer-agents", `${sha256(`${workOrderRef}\n${workOrderDigest}\n${executionIdentity}`)}.json`);

/**
 * `{ workOrderRef, workOrderDigest, executionIdentity }` of an exact sanctioned fixer pull line. The
 * 3-flag line carries them with a `fixer:` ref. The short line (ADR 0115) resolves them through the
 * execution index under `<mainRoot>/tmp`. Null for any other command, an `r`/`j` identity, a missing
 * or unreadable entry, an entry for another execution or a non-`fixer:` ref.
 */
export function parseFixerPullCommand(command, mainRoot) {
  const line = parseSanctionedPullLine(command);
  if (line?.workOrderRef) return line.workOrderRef.startsWith("fixer:") ? line : null;
  const executionIdentity = line?.executionIdentity;
  if (!isFixerExecution(executionIdentity)) return null;
  try {
    const entry = JSON.parse(readFileSync(executionIndexPath(path.join(mainRoot, "tmp"), executionIdentity), "utf8"));
    const valid = entry.executionIdentity === executionIdentity && String(entry.workOrderRef).startsWith("fixer:") && typeof entry.workOrderDigest === "string";
    return valid ? { workOrderRef: entry.workOrderRef, workOrderDigest: entry.workOrderDigest, executionIdentity } : null;
  } catch {
    return null;
  }
}

/**
 * Record that `agentId` pulls `workOrderRef`. Keyed by the ref, digest and execution hash, so a replacement
 * fixer re-pulling the same unit takes the binding over. The marker is written before the pull runs,
 * so it also carries the pull's `--digest`: boundTo honors it only when that digest equals the
 * receipt's, and a pull that the digest check refuses never takes over or revokes a receipt's grant.
 * A non-string or empty agentId records nothing.
 */
export function recordFixerAgentBinding(mainRoot, { agentId, workOrderRef, workOrderDigest, executionIdentity }) {
  if (typeof agentId !== "string" || !agentId) return;
  const file = bindingPath(mainRoot, workOrderRef, workOrderDigest, executionIdentity);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agentId, workOrderRef, workOrderDigest, executionIdentity, recordedAt: new Date().toISOString() })}\n`);
}

const boundTo = (mainRoot, receipt, agentId) => {
  try {
    const marker = JSON.parse(readFileSync(bindingPath(mainRoot, receipt.workOrderRef, receipt.workOrderDigest, receipt.executionIdentity), "utf8"));
    return marker.agentId === agentId && marker.workOrderRef === receipt.workOrderRef
      && marker.workOrderDigest === receipt.workOrderDigest && marker.executionIdentity === receipt.executionIdentity;
  } catch {
    return false;
  }
};

// The pull's staleness predicate (locateFixerUnit), re-checked on every hook call: a required read
// changed or vanished, the gate round was retired after emission (the pull's own retirement
// predicate over every checkout's tmp/, as the pull scans), or the authority branch no longer
// contains the work order head. A stale unit grants nothing even though its receipt still exists.
// A malformed retirement record throws, and the caller grants nothing.
function isStale(mainRoot, checkoutRoots, order, executionIdentity) {
  for (const read of order.requiredReads ?? []) {
    let bytes = null;
    try { bytes = readFileSync(read.path); } catch { /* vanished */ }
    if (bytes === null || sha256(bytes) !== read.sha256) return true;
  }
  if (order.source === "act-list") {
    const emittedAtMs = Number(executionIdentity.slice(1, executionIdentity.indexOf("-")));
    if (checkoutRoots.some((root) => findRetirementAfter(path.join(root, "tmp"), order.gate, order.headSha, emittedAtMs) !== null)) return true;
  }
  try {
    execFileSync("git", ["-C", mainRoot, "merge-base", "--is-ancestor", order.headSha, `refs/heads/${order.mutationAuthority.branch}`], { env: gitEnv(), stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

/**
 * Current fixer grants `[{ branch, allowedPaths, outputRef }]` of the main checkout `mainRoot`:
 * a receipt with role "fixer" whose plan lives under `<mainRoot>/tmp/gate-fixer/`, still names
 * the same ref, digest and execution, still reproduces that digest, whose materialized work order
 * still matches the receipt's materializationHash, that is not stale by the pull's own predicate, and whose binding marker names `agentId` (the pulling fixer). The outputRef is
 * derived from the plan location and execution, never read from the plan's unbound outputRefs
 * field. Any other receipt grants nothing; a missing agentId grants nothing. `checkoutRoots` are
 * every listed checkout root; the retirement check scans each root's tmp/, as the pull does.
 */
export function loadFixerGrants(mainRoot, agentId, checkoutRoots) {
  if (typeof agentId !== "string" || !agentId) return [];
  const receiptsDir = path.join(mainRoot, "tmp", "work-order-receipts");
  let planRoot;
  let names = [];
  try {
    planRoot = realpathSync(path.join(mainRoot, "tmp", "gate-fixer"));
    names = readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).sort();
  } catch { /* no plans or receipts: no grant */ }
  const grants = [];
  // ponytail: parses every receipt (and runs one git call per fixer receipt) per fixer call; key receipts by role if the directory grows large.
  for (const name of names) {
    try {
      const receipt = JSON.parse(readFileSync(path.join(receiptsDir, name), "utf8"));
      if (receipt?.role !== "fixer" || !boundTo(mainRoot, receipt, agentId)) continue;
      const planPath = realpathSync(receipt.subject.planPath);
      if (!planPath.startsWith(`${planRoot}/`)) continue;
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      if (plan.workOrderRef !== receipt.workOrderRef || plan.workOrderDigest !== receipt.workOrderDigest || plan.executionIdentity !== receipt.executionIdentity) continue;
      // An in-place edited plan no longer reproduces its digest and grants nothing.
      if (!isFixerExecution(plan.executionIdentity) || workOrderDigest(plan.workOrder) !== plan.workOrderDigest) continue;
      // The pull's integrity check, re-run on every call: the materialized work order at its derived path
      // still hashes to the receipt's materializationHash, and its embedded order (never the mutable plan's)
      // is the authority. A missing or changed materialization grants nothing, so a refused re-pull whose
      // binding marker was already written cannot ride an older receipt.
      const text = readFileSync(path.join(path.dirname(planPath), "work-orders", `${plan.executionIdentity}.md`), "utf8");
      if (`sha256:${sha256(text)}` !== receipt.materializationHash) continue;
      const order = JSON.parse(text.slice(text.lastIndexOf("\n```json\n") + "\n```json\n".length, text.lastIndexOf("\n```")));
      if (workOrderDigest(order) !== receipt.workOrderDigest || isStale(mainRoot, checkoutRoots, order, plan.executionIdentity)) continue;
      const { branch, allowedPaths } = order.mutationAuthority;
      const outputRef = realpathNearestExisting(path.join(path.dirname(planPath), plan.executionIdentity, "fixer-disposition.json"));
      grants.push({ branch, allowedPaths, outputRef });
    } catch { /* unreadable receipt or plan: no grant */ }
  }
  return grants;
}

/**
 * Checkouts listed from every dir in `dirs` (merged, de-duplicated, the first repo's main first)
 * and the current fixer grants of that main checkout bound to `agentId`.
 */
export function loadFixerContext(dirs, agentId) {
  const checkouts = [];
  for (const dir of dirs) {
    for (const checkout of listCheckouts(dir)) if (!checkouts.some((c) => c.root === checkout.root)) checkouts.push(checkout);
  }
  return { checkouts, grants: checkouts[0] ? loadFixerGrants(checkouts[0].root, agentId, checkouts.map((c) => c.root)) : [] };
}
