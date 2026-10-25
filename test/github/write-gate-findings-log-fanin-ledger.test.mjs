// The writer derives execution mode, provenance, verifiedItems and the verdict
// from the keyed emit plan and fan-in ledger of the round.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildGateEmitPlanPath, buildGateFaninLedgerPath, buildGateReviewsDir } from "../../scripts/github/_gate-artifact-paths.mjs";

const HEAD = "a1".repeat(20);
const KEY = { repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" };
const DEVLOOPS = [
  "version: 1",
  "gates:",
  "  preApproval:",
  "    angles:",
  "      - dry",
  "      - name: pr-checklist",
  "        mandatory: true",
  "      - name: holistic",
  "        enabled: false",
  "",
].join("\n");
const PROVENANCE = {
  distinctReviewers: 2,
  perAngle: [{ angle: "dry", reviewer: "reviewer-a" }, { angle: "pr-checklist", reviewer: "reviewer-b" }],
};
const PLAN = {
  ok: true, repo: KEY.repo, pr: KEY.pr, gate: KEY.gate, headSha: HEAD, count: 2,
  units: [{ angles: ["dry"], group: null }, { angles: ["pr-checklist"], group: null }],
};
const NINE_ITEMS = Array.from({ length: 9 }, (_, i) => `criterion ${i + 1}`);

async function putJson(repoRoot, relPath, value) {
  const target = path.resolve(repoRoot, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value), "utf8");
}

async function withRound({ plan = false, ledger, reviewsDir = false }, fn) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-fanin-ledger-"));
  try {
    await writeFile(path.join(repoRoot, ".devloops"), DEVLOOPS, "utf8");
    if (plan) await putJson(repoRoot, buildGateEmitPlanPath(KEY), PLAN);
    if (ledger) await putJson(repoRoot, buildGateFaninLedgerPath(KEY), ledger);
    if (reviewsDir) await mkdir(path.resolve(repoRoot, buildGateReviewsDir(KEY)), { recursive: true });
    const write = (extra = {}) => writeGateFindingsLog({
      repo: KEY.repo, pr: KEY.pr, gate: KEY.gate, headSha: HEAD, findings: "[]",
      tmpRoot: path.join(repoRoot, "tmp"), ...extra,
    }, { repoRoot });
    await fn(write, repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const LEDGER = { overallVerdict: "clean", findings: [], provenance: PROVENANCE, verifiedItems: NINE_ITEMS };

test("emit plan and fan-in ledger: omitted mode records fanout_fanin with the derived provenance", async () => {
  await withRound({ plan: true, ledger: LEDGER }, async (write) => {
    const { log } = await write();
    assert.equal(log.executionMode, "fanout_fanin");
    assert.deepEqual(log.provenance, PROVENANCE);
    assert.equal(log.verdict, "clean");
  });
});

test("emit plan present: an explicit inline_single_agent is refused and names the emit plan path", async () => {
  await withRound({ plan: true, ledger: LEDGER }, async (write, repoRoot) => {
    await assert.rejects(
      () => write({ executionMode: "inline_single_agent" }),
      (err) => err.message.includes(path.resolve(repoRoot, buildGateEmitPlanPath(KEY))),
    );
  });
});

test("emit plan without a fan-in ledger is refused and names the fan-in ledger path", async () => {
  await withRound({ plan: true }, async (write, repoRoot) => {
    await assert.rejects(
      () => write(),
      (err) => err.message.includes(path.resolve(repoRoot, buildGateFaninLedgerPath(KEY))),
    );
  });
});

test("no emit plan and no per-angle findings dir: an omitted mode records inline_single_agent", async () => {
  await withRound({}, async (write) => {
    const { log } = await write({ verdict: "clean" });
    assert.equal(log.executionMode, "inline_single_agent");
  });
});

test("per-angle findings dir without an emit plan refuses an omitted mode and inline_single_agent", async () => {
  await withRound({ reviewsDir: true }, async (write) => {
    await assert.rejects(() => write({ verdict: "clean" }), /--execution-mode is required/);
    await assert.rejects(() => write({ verdict: "clean", executionMode: "inline_single_agent" }), /inline_single_agent is refused/);
  });
});

test("a findings file without verifiedItems cannot drop the fan-in ledger's 9 verifiedItems and provenance", async () => {
  await withRound({ plan: true, ledger: LEDGER }, async (write, repoRoot) => {
    const enrichedPath = path.join(repoRoot, "enriched.json");
    await writeFile(enrichedPath, JSON.stringify({ findings: [] }), "utf8");
    const { log } = await write({ findings: undefined, findingsFile: enrichedPath });
    assert.deepEqual(log.verifiedItems, NINE_ITEMS);
    assert.deepEqual(log.provenance, PROVENANCE);
    // The trust conditions upsert-checkpoint-verdict applies before it ticks the checklist.
    assert.equal(provenanceConsistencyError(log.provenance), null);
    assert.ok(log.provenance.perAngle.some((entry) => entry.angle === "pr-checklist" && entry.carriedFromHead === undefined));
  });
});

test("with the fan-in ledger present --verdict is optional and a contradicting --verdict is refused", async () => {
  await withRound({ plan: true, ledger: LEDGER }, async (write) => {
    assert.equal((await write()).log.overallVerdict, "clean");
    assert.equal((await write({ verdict: "clean" })).log.verdict, "clean");
    await assert.rejects(() => write({ verdict: "findings_present" }), /contradicts/);
  });
});

test("an explicit --provenance that differs from the fan-in ledger's provenance is refused", async () => {
  await withRound({ plan: true, ledger: LEDGER }, async (write) => {
    const differing = { distinctReviewers: 1, perAngle: [{ angle: "dry", reviewer: "reviewer-a" }] };
    await assert.rejects(() => write({ provenance: JSON.stringify(differing) }), /differs from the fan-in ledger/);
    assert.deepEqual((await write({ provenance: JSON.stringify(PROVENANCE) })).log.provenance, PROVENANCE);
  });
});
