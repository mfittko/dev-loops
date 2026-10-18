import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { pullWorkOrder } from "../../scripts/github/_work-order-protocol.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { initGitFixture } from "../_helpers.mjs";

export const coverageRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delta-pulled-")));
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "pipe"] }).trim();
initGitFixture(coverageRepo, { branch: "issue-1" });
export const A = git(coverageRepo, "rev-parse", "HEAD");
git(coverageRepo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "candidate");
export const B = git(coverageRepo, "rev-parse", "HEAD");
let next = 0;

// Actual emission, registered canonical pull and an output written AFTER the pull.
export async function boundArgs(argv, seam = {}) {
  const args = [...argv];
  if (!args.includes("--worktree")) args.push("--worktree", coverageRepo);
  if (!args.includes("--act-list") || args.includes("--handback")) return { args, seam };
  const get = (flag) => args[args.indexOf(flag) + 1];
  const cwd = get("--worktree"), actList = get("--act-list");
  const baseline = seam.revParse ? seam.revParse(cwd, get("--baseline")) : git(cwd, "rev-parse", get("--baseline"));
  const candidate = seam.revParse ? seam.revParse(cwd, "HEAD") : git(cwd, "rev-parse", "HEAD");
  if (!fs.existsSync(actList) || !JSON.parse(fs.readFileSync(actList)).length || baseline === candidate) {
    args.push("--fixer-plan", "unused", "--site-coverage", "unused");
    return { args, seam };
  }
  const unit = await emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: baseline, phase: "commit_only", actListFile: actList, gate: "draft_gate", cwd,
    fetchPr: async () => ({ headRefName: git(cwd, "branch", "--show-current"), headRefOid: baseline }), fetchVerdictMarkers: async () => ({ draft_gate: { visible: true } }), executionIdentity: `f${Date.now()}-${(++next).toString(16).padStart(8, "0")}` });
  const tmpRoot = resolveGateArtifactTmpRoot(cwd);
  const pulled = await pullWorkOrder({ ref: unit.workOrderRef, digest: unit.workOrderDigest, execution: unit.executionIdentity, cwd, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
  const output = unit.workOrder.outputRefs[0];
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const reviewedHead = args.includes("--result") ? JSON.parse(fs.readFileSync(get("--result"))).candidateHead : candidate;
  const text = args.includes("--site-coverage") ? fs.readFileSync(get("--site-coverage"), "utf8") : JSON.stringify({ headSha: reviewedHead, siteCoverage: [] });
  fs.writeFileSync(output, text);
  const raw = JSON.parse(text);
  const binding = { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: sha256Hex(raw.siteCoverage).slice(7), handbackBytesDigest: sha256Hex(Buffer.from(text)).slice(7),
    origin: { workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest, executionIdentity: unit.executionIdentity } };
  if (args.includes("--site-coverage")) args[args.indexOf("--site-coverage") + 1] = output;
  else args.push("--site-coverage", output);
  args.push("--fixer-plan", unit.planPath);
  if (args.includes("--result")) {
    const file = get("--result");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...binding }));
  }
  return { args, seam, unit, pulled, binding, output, tmpRoot };
}
