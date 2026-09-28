/**
 * Fixer grant loading shared by the Bash gate and the Write/Edit guard (ADR 0107).
 *
 * Edge I/O only: list the repo's checkouts and the CURRENT fixer grants. The pure deciders
 * (decideFixerBashGate / decideFixerWriteGuard in `./_hook-decisions.mjs`) own the decision.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { realpathNearestExisting } from "./_worktree-guard.mjs";
import { workOrderDigest } from "./_work-order-digest.mjs";

const isInside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Nearest existing directory at or above `p` (absolute). */
export function nearestExistingDir(p) {
  let dir = path.resolve(p);
  while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory() && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** `git worktree list` from `dir` as `[{ root, branch }]` (realpath roots, main first); [] outside git. */
export function listCheckouts(dir) {
  try {
    const porcelain = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
const EXECUTION_RE = /^f(\d+)-[0-9a-f]{8}$/u;

// The pull's staleness predicate (locateFixerUnit), re-checked on every hook call: a required read
// changed or vanished, the gate round was retired after emission, or the authority branch no longer
// contains the work order head. A stale unit grants nothing even though its receipt still exists.
function isStale(mainRoot, order, executionIdentity) {
  for (const read of order.requiredReads ?? []) {
    let bytes = null;
    try { bytes = readFileSync(read.path); } catch { /* vanished */ }
    if (bytes === null || sha256(bytes) !== read.sha256) return true;
  }
  if (order.source === "act-list") {
    const emittedAtMs = Number(EXECUTION_RE.exec(executionIdentity)[1]);
    const retiredRoot = path.join(mainRoot, "tmp", "retired-gate-rounds", order.headSha);
    let rounds = [];
    try { rounds = readdirSync(retiredRoot); } catch { /* none retired */ }
    for (const round of rounds) {
      try {
        const record = JSON.parse(readFileSync(path.join(retiredRoot, round, "retirement.json"), "utf8"));
        if (record?.gate === order.gate && Date.parse(record.retiredAt) >= emittedAtMs) return true;
      } catch { /* unreadable record: not a retirement */ }
    }
  }
  try {
    execFileSync("git", ["-C", mainRoot, "merge-base", "--is-ancestor", order.headSha, `refs/heads/${order.mutationAuthority.branch}`], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

/**
 * Current fixer grants `[{ branch, allowedPaths, phase, outputRef }]` of the main checkout `mainRoot`:
 * a receipt with role "fixer" whose plan lives under `<mainRoot>/tmp/gate-fixer/`, still names
 * the same ref, digest and execution, still reproduces that digest and is not stale by the pull's
 * own predicate. The outputRef is derived from the plan location and execution, never read from
 * the plan's unbound outputRefs field. Any other receipt grants nothing.
 */
export function loadFixerGrants(mainRoot) {
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
      if (receipt?.role !== "fixer") continue;
      const planPath = realpathSync(receipt.subject.planPath);
      if (!planPath.startsWith(`${planRoot}/`)) continue;
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      if (plan.workOrderRef !== receipt.workOrderRef || plan.workOrderDigest !== receipt.workOrderDigest || plan.executionIdentity !== receipt.executionIdentity) continue;
      // An in-place edited plan no longer reproduces its digest and grants nothing.
      if (workOrderDigest(plan.workOrder) !== plan.workOrderDigest) continue;
      if (!EXECUTION_RE.test(plan.executionIdentity) || isStale(mainRoot, plan.workOrder, plan.executionIdentity)) continue;
      const { branch, allowedPaths } = plan.workOrder.mutationAuthority;
      const outputRef = realpathNearestExisting(path.join(path.dirname(planPath), plan.executionIdentity, "fixer-disposition.json"));
      grants.push({ branch, allowedPaths, phase: plan.workOrder.phase, outputRef });
    } catch { /* unreadable receipt or plan: no grant */ }
  }
  return grants;
}

/**
 * Checkouts listed from every dir in `dirs` (merged, de-duplicated, the first repo's main first)
 * and the current fixer grants of that main checkout.
 */
export function loadFixerContext(dirs) {
  const checkouts = [];
  for (const dir of dirs) {
    for (const checkout of listCheckouts(dir)) if (!checkouts.some((c) => c.root === checkout.root)) checkouts.push(checkout);
  }
  return { checkouts, grants: checkouts[0] ? loadFixerGrants(checkouts[0].root) : [] };
}

/** Branch checked out in the most specific listed checkout containing `dir`, or null. */
export function branchCheckedOutAt(dir, checkouts) {
  const real = realpathNearestExisting(dir);
  return checkouts.filter((c) => isInside(real, c.root)).sort((a, b) => b.root.length - a.root.length)[0]?.branch ?? null;
}
