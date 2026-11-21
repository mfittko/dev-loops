// Child process of interrupt-recovery.test.mjs (#3421): runs one unit of work step by step and SIGKILLs itself after
// the step named by INTERRUPT_AFTER, so the parent sees the on-disk state a killed harness leaves behind.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beginFixerEmission } from "../../scripts/github/_fixer-emission-evidence.mjs";

const [unit, root] = process.argv.slice(2);
const sentinelScript = new URL("../../scripts/github/verify-fresh-review-context.mjs", import.meta.url).pathname;
const atomicWrite = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };
let emission;
// A reviewer unit and a fixer emission unit; each step is one durable state change.
const UNITS = {
  round: {
    context: () => atomicWrite(path.join(root, "tmp/gate-context/context.json"), "{}\n"),
    sentinel: () => {
      const run = spawnSync("node", [sentinelScript, "--scope", "draft-gate-coverage", "--prefix-hash", "a".repeat(64)], { cwd: root, encoding: "utf8" });
      if (run.status !== 0 || !run.stdout.includes('"fresh": true') && !run.stdout.includes('"fresh":true')) { process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exit(3); }
    },
    "artifact-tmp": () => { mkdirSync(path.join(root, "tmp/findings"), { recursive: true }); writeFileSync(path.join(root, "tmp/findings/coverage.json.tmp"), "{}\n"); },
    artifact: () => renameSync(path.join(root, "tmp/findings/coverage.json.tmp"), path.join(root, "tmp/findings/coverage.json")),
    fanin: () => atomicWrite(path.join(root, "tmp/findings/fanin.json"), "{}\n"),
  },
  fixer: {
    lock: async () => { emission = await beginFixerEmission(path.join(root, "tmp/fixer")); },
    "plan-tmp": () => writeFileSync(path.join(root, `tmp/fixer/fixer-emit-plan.json.tmp-${process.pid}`), "{}\n"),
    plan: () => renameSync(path.join(root, `tmp/fixer/fixer-emit-plan.json.tmp-${process.pid}`), path.join(root, "tmp/fixer/fixer-emit-plan.json")),
    release: async () => { await emission.release(); },
  },
};

for (const [step, run] of Object.entries(UNITS[unit])) {
  await run();
  if (process.env.INTERRUPT_AFTER === step) process.kill(process.pid, "SIGKILL");
}
