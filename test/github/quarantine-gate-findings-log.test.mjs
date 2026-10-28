import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { parseQuarantineArgs, quarantineGateFindingsLog } from "../../scripts/github/quarantine-gate-findings-log.mjs";
import { listPriorFindingsLogHeads } from "../../scripts/github/emit-fanout-dispatch.mjs";
import { main as resolveMain } from "../../scripts/github/resolve-angle-carry-forward.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildGateFaninLedgerPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { buildCarryForwardPlanPath } from "../../scripts/github/write-gate-context.mjs";

const REPO = "o/r";
const PR = 7;
const GATE = "pre_approval_gate";
const HEAD = "c".repeat(40);
const PRIOR = "d".repeat(40);
const quarantineCli = path.resolve("scripts/github/quarantine-gate-findings-log.mjs");
const emitCli =path.resolve("scripts/github/emit-fanout-dispatch.mjs");

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
async function seed(dir, { valid = false, ledgerRoot = "ctx-tmp", withLedger = true, rawLog = null } = {}) {
  const logPath = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: PRIOR, tmpRoot: "tmp" }));
  const ledgerPath = path.join(dir, buildGateFaninLedgerPath({ repo: REPO, pr: PR, gate: GATE, headSha: PRIOR, tmpRoot: ledgerRoot }));
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(logPath, rawLog ?? JSON.stringify({
    headSha: PRIOR, gate: GATE, repo: REPO, pr: PR,
    verdict: "findings_present",
    findings: [{ angle: valid ? "contradiction-lens" : "operator-residue", severity: "low", summary: "x" }],
    provenance: { perAngle: [{ angle: "contradiction-lens", reviewer: "r" }] },
  }), "utf8");
  if (withLedger) await writeFile(ledgerPath, "{}\n", "utf8");
  return { logPath, ledgerPath };
}

const run = (dir) => quarantineGateFindingsLog({ repo: REPO, pr: PR, gate: GATE, prevHead: PRIOR, tmpRoot: "tmp", contextTmpRoot: "ctx-tmp", repoRoot: dir });

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
    assert.equal(record.status, "complete");
    assert.equal(record.ledgerAbsent, false);
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
    const cli = spawnSync("node", [quarantineCli, "--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", PRIOR, "--tmp-root", "tmp", "--context-tmp-root", "ctx-tmp"], { encoding: "utf8", cwd: dir });
    assert.equal(cli.status, 1);
    assert.equal(JSON.parse(cli.stderr).code, "quarantine_refused_log_valid");
    await readFile(logPath, "utf8");
    await readFile(ledgerPath, "utf8");
    await assert.rejects(readdir(path.join(dir, "tmp", "quarantined-gate-findings")));
  });
});

test("a missing ledger is recorded in quarantine.json", async () => {
  await withRepo(async (dir) => {
    await seed(dir, { withLedger: false });
    const result = await run(dir);
    const record = JSON.parse(await readFile(path.join(result.auditDir, "quarantine.json"), "utf8"));
    assert.equal(record.ledgerAbsent, true);
    assert.equal(record.ledgerPath, path.join(dir, buildGateFaninLedgerPath({ repo: REPO, pr: PR, gate: GATE, headSha: PRIOR, tmpRoot: "ctx-tmp" })));
  });
});

test("listPriorFindingsLogHeads ignores logs older than the quarantine but counts newer ones", async () => {
  await withRepo(async (dir) => {
    await seed(dir);
    const old = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: "e".repeat(40), tmpRoot: "tmp" }));
    const doc = (h, loggedAt) => JSON.stringify({ headSha: h, gate: GATE, repo: REPO, pr: PR, loggedAt });
    await writeFile(old, doc("e".repeat(40), new Date(Date.now() - 60000).toISOString()), "utf8");
    const query = () => listPriorFindingsLogHeads({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot: path.join(dir, "tmp") });
    assert.equal((await query()).has("e".repeat(40)), true);
    await run(dir);
    assert.equal((await query()).size, 0);
    const fresh = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: "f".repeat(40), tmpRoot: "tmp" }));
    await writeFile(fresh, doc("f".repeat(40), new Date(Date.now() + 60000).toISOString()), "utf8");
    assert.deepEqual([...(await query())], ["f".repeat(40)]);
  });
});

test("a rolled_back quarantine record sets no cutoff", async () => {
  await withRepo(async (dir) => {
    await seed(dir);
    const old = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: "e".repeat(40), tmpRoot: "tmp" }));
    await writeFile(old, JSON.stringify({ headSha: "e".repeat(40), gate: GATE, repo: REPO, pr: PR, loggedAt: new Date(Date.now() - 60000).toISOString() }), "utf8");
    const result = await run(dir);
    const recordPath = path.join(result.auditDir, "quarantine.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, status: "rolled_back" }), "utf8");
    const heads = await listPriorFindingsLogHeads({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot: path.join(dir, "tmp") });
    assert.equal(heads.has("e".repeat(40)), true);
  });
});

test("resolve-angle-carry-forward refuses a --prev-head log written before the quarantine and carries nothing", async () => {
  await withRepo(async (dir) => {
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "contradiction-lens"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    await seed(dir);
    const valid = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: GATE, headSha: "a".repeat(40), tmpRoot: "tmp" }));
    await writeFile(valid, JSON.stringify({
      headSha: "a".repeat(40), gate: GATE, repo: REPO, pr: PR, verdict: "clean", findings: [],
      provenance: { perAngle: [{ angle: "contradiction-lens", reviewer: "r" }] },
      loggedAt: new Date(Date.now() - 60000).toISOString(),
    }), "utf8");
    await run(dir);
    const prior = process.exitCode;
    await resolveMain(["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", "a".repeat(40), "--head-sha", HEAD, "--tmp-root", "tmp"], { repoRoot: dir, runGit: () => { throw new Error("git must not run"); } });
    assert.equal(process.exitCode, 1);
    process.exitCode = prior;
    const plan = JSON.parse(await readFile(path.join(dir, buildCarryForwardPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot: "tmp" })), "utf8"));
    assert.equal(plan.fallback, true);
    assert.deepEqual(plan.carried, []);
  });
});

test("quarantine classifies head mismatch, invalid JSON and an ineligible verdict", async () => {
  await withRepo(async (dir) => {
    await seed(dir, { rawLog: JSON.stringify({ headSha: "9".repeat(40), gate: GATE, repo: REPO, pr: PR, verdict: "clean" }) });
    const result = await run(dir);
    assert.match(result.integrityFailure, /which is not --prev-head/);
  });
  await withRepo(async (dir) => {
    await seed(dir, { rawLog: "{not json" });
    const result = await run(dir);
    assert.match(result.integrityFailure, /not valid JSON/);
  });
  await withRepo(async (dir) => {
    const { logPath, ledgerPath } = await seed(dir, { rawLog: JSON.stringify({ headSha: PRIOR, gate: GATE, repo: REPO, pr: PR, verdict: "blocked" }) });
    await assert.rejects(run(dir), (err) => err.code === "quarantine_refused_log_valid");
    await readFile(logPath, "utf8");
    await readFile(ledgerPath, "utf8");
    await assert.rejects(readdir(path.join(dir, "tmp", "quarantined-gate-findings")));
  });
});

test("parseQuarantineArgs rejects an empty --tmp-root and --context-tmp-root and accepts real roots", () => {
  const base = ["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", PRIOR];
  for (const flag of ["--tmp-root", "--context-tmp-root"]) {
    for (const bad of ["", "   "]) {
      assert.throws(() => parseQuarantineArgs([...base, flag, bad]), /must be non-empty|Missing value/);
    }
    for (const good of ["tmp", "/abs/tmp"]) {
      assert.doesNotThrow(() => parseQuarantineArgs([...base, flag, good]));
    }
  }
});

test("parseQuarantineArgs rejects misspelled and unknown flags and accepts every real flag", () => {
  const base = ["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", PRIOR];
  for (const bad of ["--context-tmproot", "--tmproot", "--prevhead", "--unknown"]) {
    assert.throws(() => parseQuarantineArgs([...base, bad, "x"]), /Unknown argument/);
  }
  assert.doesNotThrow(() => parseQuarantineArgs([...base, "--tmp-root", "tmp", "--context-tmp-root", "tmp"]));
  for (const help of ["--help", "-h"]) assert.deepEqual(parseQuarantineArgs([help]), { help: true });
});

test("a second quarantine in the same millisecond cannot overwrite the first audit record", async () => {
  await withRepo(async (dir) => {
    await seed(dir);
    const realIso = Date.prototype.toISOString;
    Date.prototype.toISOString = () => "2026-10-28T00:00:00.000Z";
    try {
      const first = await run(dir);
      await seed(dir);
      await assert.rejects(run(dir), (err) => err.code === "quarantine_concurrent_run");
      const record = JSON.parse(await readFile(path.join(first.auditDir, "quarantine.json"), "utf8"));
      assert.equal(record.status, "complete");
    } finally {
      Date.prototype.toISOString = realIso;
    }
  });
});

test("the audit record is replaced atomically and leaves no temp file", async () => {
  await withRepo(async (dir) => {
    await seed(dir);
    const result = await run(dir);
    assert.ok(!(await readdir(result.auditDir)).some((name) => name.endsWith(".tmp")));
    JSON.parse(await readFile(path.join(result.auditDir, "quarantine.json"), "utf8"));
  });
});

test("resolve-angle-carry-forward records a fallback plan when --prev-head is the quarantined head", async () => {
  await withRepo(async (dir) => {
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "contradiction-lens"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    await seed(dir);
    await run(dir);
    const prior = process.exitCode;
    await resolveMain(["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", PRIOR, "--head-sha", HEAD, "--tmp-root", "tmp"], { repoRoot: dir, runGit: () => { throw new Error("git must not run"); } });
    assert.equal(process.exitCode, 1);
    process.exitCode = prior;
    const plan = JSON.parse(await readFile(path.join(dir, buildCarryForwardPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot: "tmp" })), "utf8"));
    assert.equal(plan.fallback, true);
    assert.deepEqual(plan.carried, []);
  });
});

test("an unaudited missing --prev-head log stays an operational failure with no plan", async () => {
  await withRepo(async (dir) => {
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "contradiction-lens"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    const prior = process.exitCode;
    await resolveMain(["--repo", REPO, "--pr", String(PR), "--gate", GATE, "--prev-head", PRIOR, "--head-sha", HEAD, "--tmp-root", "tmp"], { repoRoot: dir, runGit: () => { throw new Error("git must not run"); } });
    assert.equal(process.exitCode, 1);
    process.exitCode = prior;
    await assert.rejects(readFile(path.join(dir, buildCarryForwardPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD, tmpRoot: "tmp" })), "utf8"));
  });
});

test("emit refuses an already-materialized carry-filtered context built before the quarantine", async () => {
  await withRepo(async (dir) => {
    const ctx = path.join(dir, "tmp", "gate-context", "o-r", "pr-7");
    await mkdir(ctx, { recursive: true });
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-prefix.txt`), "## prefix\n", "utf8");
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-volatile.txt`), "# volatile\n", "utf8");
    const contextFile = path.join(ctx, `${GATE}-${HEAD}.json`);
    await writeFile(contextFile, JSON.stringify({
      fanout: {
        groups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }], pendingGroups: [],
        preflight: { carriedAngles: ["contradiction-lens"] },
      },
    }), "utf8");
    const past = new Date(Date.now() - 60000);
    await utimes(contextFile, past, past);
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "contradiction-lens"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    await seed(dir);
    await run(dir);
    const emitted = spawnSync("node", [emitCli, "--repo", REPO, "--pr", String(PR), "--gate", GATE, "--head-sha", HEAD, "--pending"], { encoding: "utf8", cwd: dir });
    assert.equal(emitted.status, 1);
    assert.match(emitted.stdout, /GATE-EXEC-FINDINGS-LOG-QUARANTINE: refusing/);
  });
});

test("emit refuses a fresh all-carried context whose carry proof names the quarantined head", async () => {
  await withRepo(async (dir) => {
    const ctx = path.join(dir, "tmp", "gate-context", "o-r", "pr-7");
    await mkdir(ctx, { recursive: true });
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-prefix.txt`), "## prefix\n", "utf8");
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.briefing-volatile.txt`), "# volatile\n", "utf8");
    await writeFile(path.join(dir, ".devloops"), `version: 1\ngates:\n  preApproval:\n    angles:\n      - name: "coverage"\n        persona: review\n        prompt: Review the angle.\n`, "utf8");
    await seed(dir);
    await run(dir);
    // Built after the quarantine: the mtime check passes, only the proof names the stale head.
    await writeFile(path.join(ctx, `${GATE}-${HEAD}.json`), JSON.stringify({
      fanout: {
        groups: [{ name: "coverage", angles: ["coverage"] }], pendingGroups: [],
        preflight: { carriedAngles: ["coverage"] },
      },
    }), "utf8");
    const proof = JSON.stringify({ prevHead: PRIOR, carried: [{ angle: "coverage", carriedFromHead: PRIOR, reviewer: "r", model: "m", dispatchId: "d" }] });
    const emitted = spawnSync("node", [emitCli, "--repo", REPO, "--pr", String(PR), "--gate", GATE, "--head-sha", HEAD, "--pending", "--carry-forward-plan", proof], { encoding: "utf8", cwd: dir });
    assert.equal(emitted.status, 1);
    assert.match(emitted.stdout, /carry proof names quarantined head/);
  });
});
