import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { quarantineGateFindingsLog } from "../../scripts/github/quarantine-gate-findings-log.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildGateFaninLedgerPath } from "../../scripts/github/_gate-artifact-paths.mjs";

const REPO = "o/r";
const PR = 7;
const GATE = "pre_approval_gate";
const HEAD = "c".repeat(40);
const PRIOR = "d".repeat(40);
const emitCli = path.resolve("scripts/github/emit-fanout-dispatch.mjs");

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quarantine-findings-log-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Prior log with a finding whose angle matches no provenance.perAngle entry
// (the PR 2838 shape), plus its keyed fan-in ledger.
async function seed(dir, { valid = false } = {}) {
  const logPath = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: PRIOR, tmpRoot: "tmp" }));
  const ledgerPath = path.join(dir, buildGateFaninLedgerPath({ repo: REPO, pr: PR, gate: GATE, headSha: PRIOR, tmpRoot: "tmp" }));
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    headSha: PRIOR, gate: GATE, repo: REPO, pr: PR,
    verdict: "findings_present",
    findings: [{ angle: valid ? "contradiction-lens" : "operator-residue", severity: "low", summary: "x" }],
    provenance: { perAngle: [{ angle: "contradiction-lens", reviewer: "r" }] },
  }), "utf8");
  await writeFile(ledgerPath, "{}\n", "utf8");
  return { logPath, ledgerPath };
}

const run = (dir) => quarantineGateFindingsLog({ repo: REPO, pr: PR, gate: GATE, prevHead: PRIOR, tmpRoot: "tmp", repoRoot: dir });

test("quarantine moves an integrity-failing log and ledger to the audit dir with the reason", async () => {
  await withRepo(async (dir) => {
    const { logPath, ledgerPath } = await seed(dir);
    const result = await run(dir);
    assert.equal(result.ok, true);
    await assert.rejects(readFile(logPath, "utf8"));
    await assert.rejects(readFile(ledgerPath, "utf8"));
    const files = await readdir(result.auditDir);
    assert.deepEqual(files.sort(), [path.basename(ledgerPath), path.basename(logPath), "quarantine.json"].sort());
    const record = JSON.parse(await readFile(path.join(result.auditDir, "quarantine.json"), "utf8"));
    assert.equal(record.reason, "findings_log_integrity_failure");
    assert.match(record.integrityFailure, /operator-residue.*matches no provenance\.perAngle entry/);
  });
});

test("after quarantine the next emit at a later head dispatches every angle with no carry", async () => {
  await withRepo(async (dir) => {
    const ctx = path.join(dir, "tmp", "gate-context", "o-r", "pr-7");
    await mkdir(ctx, { recursive: true });
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-prefix.txt`), "## prefix\n", "utf8");
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-volatile.txt`), "# volatile\n", "utf8");
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.json`), JSON.stringify({
      fanout: { groups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }], pendingGroups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }] },
    }), "utf8");
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "contradiction-lens"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    await seed(dir);
    const args = ["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--head-sha", HEAD];
    const refused = spawnSync("node", [emitCli, ...args], { encoding: "utf8", cwd: dir });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED/);

    await run(dir);
    const emitted = spawnSync("node", [emitCli, ...args], { encoding: "utf8", cwd: dir });
    assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
    const plan = JSON.parse(await readFile(path.join(ctx, `${GATE}-${HEAD}.emit-plan.json`), "utf8"));
    assert.ok(plan.count > 0);
    assert.equal(plan.carried?.length ?? 0, 0);
  });
});

test("quarantine refuses a log that passes integrity and moves nothing", async () => {
  await withRepo(async (dir) => {
    const { logPath, ledgerPath } = await seed(dir, { valid: true });
    await assert.rejects(run(dir), (err) => err.code === "quarantine_refused_log_valid");
    await readFile(logPath, "utf8");
    await readFile(ledgerPath, "utf8");
    await assert.rejects(readdir(path.join(dir, "tmp", "quarantined-gate-findings")));
  });
});
