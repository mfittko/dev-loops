// Child process of interrupt-recovery.test.mjs (#3421): runs one unit of work step by step and SIGKILLs itself after
// the step named by INTERRUPT_AFTER, so the parent sees the on-disk state a killed harness leaves behind.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beginFixerEmission } from "../../scripts/github/_fixer-emission-evidence.mjs";
import { repoSlugFor } from "../../scripts/github/_gate-artifact-paths.mjs";

const [unit, root] = process.argv.slice(2);
const sentinelScript = new URL("../../scripts/github/verify-fresh-review-context.mjs", import.meta.url).pathname;
const atomicWrite = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };
// The plan dir the coordinator reads (detect-pr-gate-coordination-state.mjs). The temporary plan name is the real
// emitter's `<plan>.tmp-<executionIdentity>`, with a fresh identity per process.
const planDir = path.join(root, "tmp", "gate-fixer", repoSlugFor("owner/repo"), "pr-266");
const plan = path.join(planDir, "fixer-emit-plan.json");
const tempPlan = `${plan}.tmp-f${Date.now()}${process.pid}-${process.pid.toString(16).padStart(8, "0")}`;
// PREFIX_HASH models a rebuilt briefing; SAME_HEAD_RETRY is the sanctioned retry for a reviewer killed after its sentinel.
const prefixHash = process.env.PREFIX_HASH ?? "a".repeat(64);
let emission;
// A reviewer unit and a fixer emission unit; each step is one durable state change.
const UNITS = {
  round: {
    context: () => atomicWrite(path.join(root, "tmp/gate-context/context.json"), "{}\n"),
    sentinel: () => {
      const args = [sentinelScript, "--scope", "draft-gate-coverage", "--prefix-hash", prefixHash, ...(process.env.SAME_HEAD_RETRY ? ["--same-head-retry"] : [])];
      const run = spawnSync("node", args, { cwd: root, encoding: "utf8" });
      if (run.status !== 0 || !run.stdout.includes('"fresh": true') && !run.stdout.includes('"fresh":true')) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(3); }
    },
    "artifact-tmp": () => { mkdirSync(path.join(root, "tmp/findings"), { recursive: true }); writeFileSync(path.join(root, "tmp/findings/coverage.json.tmp"), "{}\n"); },
    artifact: () => renameSync(path.join(root, "tmp/findings/coverage.json.tmp"), path.join(root, "tmp/findings/coverage.json")),
    fanin: () => atomicWrite(path.join(root, "tmp/findings/fanin.json"), "{}\n"),
  },
  fixer: {
    lock: async () => { emission = await beginFixerEmission(planDir); },
    "plan-tmp": () => writeFileSync(tempPlan, "{}\n"),
    plan: () => renameSync(tempPlan, plan),
    release: async () => { await emission.release(); },
  },
};

for (const [step, run] of Object.entries(UNITS[unit])) {
  await run();
  if (process.env.INTERRUPT_AFTER === step) process.kill(process.pid, "SIGKILL");
}
