// Child process of interrupt-recovery.test.mjs (#3421): runs one unit of work step by step and SIGKILLs itself after
// the step named by INTERRUPT_AFTER, so the parent sees the on-disk state a killed harness leaves behind.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beginFixerEmission } from "../../scripts/github/_fixer-emission-evidence.mjs";
import { workOrderDigest } from "../../scripts/github/_work-order-protocol.mjs";
import { retireStaleRound } from "../../scripts/github/_stale-round-retirement.mjs";
import { buildGateContextPath, buildGateFaninLedgerPath, buildGateReviewsDir, repoSlugFor } from "../../scripts/github/_gate-artifact-paths.mjs";

const [unit, root] = process.argv.slice(2);
const consolidateScript = new URL("../../scripts/loop/consolidate-fanin.mjs", import.meta.url).pathname;
// The production paths of one draft_gate round: gate context, per-angle findings directory and fan-in ledger.
const FIXER_HEAD = process.env.GATE_HEAD; // the PR head the gh stub reports, defined in interrupt-recovery.test.mjs
// The reviewer sentinel is keyed by the checkout's real head (verify-fresh-review-context.mjs), so the round's
// sentinel, findings artifact, ledger and retirement all use that one head.
// An ambient GIT_DIR or GIT_WORK_TREE (a git hook running the suite) would key the round to the outer repo's head.
const { GIT_DIR: _gitDir, GIT_WORK_TREE: _gitWorkTree, ...gitEnv } = process.env;
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: gitEnv }).trim();
const gateKey = { repo: "owner/repo", pr: 266, gate: "draft_gate", headSha: HEAD, tmpRoot: path.join(root, "tmp") };
const contextFile = buildGateContextPath(gateKey);
const angleFile = path.join(buildGateReviewsDir(gateKey), "coverage.json");
const ledgerFile = buildGateFaninLedgerPath(gateKey);
const angleArtifact = JSON.stringify({ angle: "coverage", verdict: "clean", headSha: HEAD, findings: [] });
const sentinelScript = new URL("../../scripts/github/verify-fresh-review-context.mjs", import.meta.url).pathname;
const atomicWrite = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };
// The plan dir the coordinator reads (detect-pr-gate-coordination-state.mjs). The temporary plan name is the real
// emitter's `<plan>.tmp-<executionIdentity>`, with a fresh identity per process.
const planDir = path.join(root, "tmp", "gate-fixer", repoSlugFor("owner/repo"), "pr-266");
const plan = path.join(planDir, "fixer-emit-plan.json");
const tempPlan = `${plan}.tmp-f${Date.now()}${process.pid}-${process.pid.toString(16).padStart(8, "0")}`;
// A full-phase plan whose digest the coordinator verifies, so it reports the fixer disposition as incomplete (a
// hand-built order: the real emitter needs a worktree, delta record and review fixtures this child does not have).
const fixerOrder = { role: "fixer", target: { repo: "owner/repo", pr: 266 }, phase: "full", source: "threads", headSha: FIXER_HEAD, outputRefs: [], requiredReads: [{ kind: "completion-input" }] };
// PREFIX_HASH models a rebuilt briefing; SAME_HEAD_RETRY is the sanctioned retry for a reviewer killed after its sentinel.
const prefixHash = process.env.PREFIX_HASH ?? "a".repeat(64);
let emission;
// A reviewer unit and a fixer emission unit; each step is one durable state change.
const UNITS = {
  round: {
    // This step runs the shared retirement helper (issue 3416) only for a rebuilt briefing (PREFIX_HASH), because
    // write-gate-context.mjs retires only when the prefix bytes change. It never runs write-gate-context.mjs itself.
    context: async () => {
      const stale = process.env.PREFIX_HASH ? await retireStaleRound(gateKey) : {};
      if (stale.refusal) { process.stderr.write(JSON.stringify(stale.refusal)); process.exit(5); }
      atomicWrite(contextFile, "{}\n");
    },
    sentinel: () => {
      const args = [sentinelScript, "--scope", "draft-gate-coverage", "--prefix-hash", prefixHash, ...(process.env.SAME_HEAD_RETRY ? ["--same-head-retry"] : [])];
      const run = spawnSync("node", args, { cwd: root, encoding: "utf8", env: gitEnv });
      if (run.status !== 0 || !run.stdout.includes('"fresh": true') && !run.stdout.includes('"fresh":true')) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(3); }
    },
    "artifact-tmp": () => { mkdirSync(path.dirname(angleFile), { recursive: true }); writeFileSync(`${angleFile}.tmp`, angleArtifact); },
    artifact: () => renameSync(`${angleFile}.tmp`, angleFile),
    fanin: () => {
      const run = spawnSync("node", [consolidateScript, "--findings-dir", path.dirname(angleFile), "--head-sha", HEAD, "--gate", "draft_gate", "--ledger-out", ledgerFile], { cwd: root, encoding: "utf8" });
      if (run.status !== 0) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(4); }
    },
  },
  fixer: {
    lock: async () => { emission = await beginFixerEmission(planDir); },
    "plan-tmp": () => writeFileSync(tempPlan, `${JSON.stringify({ workOrder: fixerOrder, workOrderDigest: workOrderDigest(fixerOrder), executionIdentity: "f1790000000000-0000abcd" })}\n`),
    plan: () => renameSync(tempPlan, plan),
    release: async () => { await emission.release(); },
  },
};

for (const [step, run] of Object.entries(UNITS[unit])) {
  await run();
  if (process.env.INTERRUPT_AFTER === step) process.kill(process.pid, "SIGKILL");
}
