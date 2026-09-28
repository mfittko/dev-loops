/**
 * Fixer grant loading shared by the Bash gate and the Write/Edit guard (ADR 0106).
 *
 * Edge I/O only: list the repo's checkouts and the CURRENT fixer grants. The pure deciders
 * (decideFixerBashGate / decideFixerWriteGuard in `./_hook-decisions.mjs`) own the decision.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { realpathNearestExisting } from "./_worktree-guard.mjs";

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

/**
 * Current fixer grants `[{ branch, allowedPaths, outputRef }]` of the main checkout `mainRoot`:
 * a receipt with role "fixer" whose plan lives under `<mainRoot>/tmp/gate-fixer/` and still names
 * the same ref, digest and execution. Any other receipt grants nothing.
 */
export function loadFixerGrants(mainRoot) {
  const receiptsDir = path.join(mainRoot, "tmp", "work-order-receipts");
  let planRoot;
  let names = [];
  try {
    planRoot = realpathSync(path.join(mainRoot, "tmp", "gate-fixer"));
    names = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
  } catch { /* no plans or receipts: no grant */ }
  const grants = [];
  // ponytail: parses every receipt per fixer call; key receipts by role if the directory grows large.
  for (const name of names) {
    try {
      const receipt = JSON.parse(readFileSync(path.join(receiptsDir, name), "utf8"));
      if (receipt?.role !== "fixer") continue;
      const planPath = realpathSync(receipt.subject.planPath);
      if (!planPath.startsWith(`${planRoot}/`)) continue;
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      if (plan.workOrderRef !== receipt.workOrderRef || plan.workOrderDigest !== receipt.workOrderDigest || plan.executionIdentity !== receipt.executionIdentity) continue;
      const { branch, allowedPaths } = plan.workOrder.mutationAuthority;
      grants.push({ branch, allowedPaths, outputRef: realpathNearestExisting(plan.workOrder.outputRefs[0]) });
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
