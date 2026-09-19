import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildAngleNamingSuffix, dispatchUnitScope, expandDispatchUnits, main, sanitizeScopeSegment, splitSubUnitName } from "../../scripts/github/emit-fanout-dispatch.mjs";
import { buildGateEmitPlanPath, mapGateToConfigKey, parseWriteGateContextCliArgs, resolveFanoutDispatch, writeGateContext } from "../../scripts/github/write-gate-context.mjs";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { buildCarryForwardPlan } from "../../scripts/github/resolve-angle-carry-forward.mjs";
import { toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";
import { consolidateGateFanin, parseConsolidateFaninCliArgs } from "../../scripts/loop/consolidate-fanin.mjs";
import { verifyEmitPlanProvenance, writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { PROHIBITED_REVIEWER_OPERATIONS, REVIEWER_UNIT_BUDGET, REVIEWER_UNIT_MAX_ANGLES } from "@dev-loops/core/loop/reviewer-unit-bound";

const emitCliPath = path.resolve("scripts/github/emit-fanout-dispatch.mjs");

function runEmitCli(args = [], opts = {}) {
  return spawnSync("node", [emitCliPath, ...args], { encoding: "utf8", ...opts });
}

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-emit-fanout-dispatch-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const HEAD_SHA = "c".repeat(40);
const GATE = "pre_approval_gate";
const REPO = "o/r";
const PR = "7";
const PREFIX_BYTES = "## Invariant prefix\nrepo: o/r\nhead: c\n";
const VOLATILE_BYTES = "# volatile tail\ngate: pre_approval_gate\n";

// A CONFIGURED group (design-simplicity — in the shipped gates.fanout.groups),
// an AUTO-CHUNK leftover unit (group:...), and a singleton. Both multi-angle
// units — configured or auto-chunk — share one reviewer each (issue 2180 /
// ADR 0048); only the genuine singleton stays a singleton.
const FANOUT = {
  groups: [
    { name: "design-simplicity", angles: ["dry", "kiss"] },
    { name: "group:determinism+state-concurrency", angles: ["determinism", "state-concurrency"] },
    { name: "contradiction-lens", angles: ["contradiction-lens"] },
  ],
  pendingGroups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }],
};

async function seedBundle(tmpDir, { fanout = FANOUT, withPrefix = true, gate = GATE } = {}) {
  const dir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-7");
  await mkdir(dir, { recursive: true });
  if (withPrefix) await writeFile(path.join(dir, `${gate}-${HEAD_SHA}.briefing-prefix.txt`), PREFIX_BYTES, "utf8");
  await writeFile(path.join(dir, `${gate}-${HEAD_SHA}.briefing-volatile.txt`), VOLATILE_BYTES, "utf8");
  const artifact = fanout === null ? {} : { fanout };
  await writeFile(path.join(dir, `${gate}-${HEAD_SHA}.json`), JSON.stringify(artifact), "utf8");
  return dir;
}

test("emit-fanout-dispatch.mjs --help exits 0", () => {
  const result = runEmitCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /emit-fanout-dispatch/);
});

test("all-carried rounds consume the real emitter's keyed zero-unit plan through fan-in and ledger writing", async () => {
  await withTmpDir(async (repoRoot) => {
    const gate = "draft_gate";
    await writeFile(path.join(repoRoot, ".devloops"), "version: 1\ngates:\n  draft:\n    angles:\n      - name: pr-description\n        enabled: false\n", "utf8");
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    assert.deepEqual(errors, []);
    const findings = [{ angle: "coverage", severity: "high", summary: "Prior coverage defect remains open", recommendation: "Cover the omitted path", files: ["src/a.mjs", "src/b.mjs"], line: 7 }];
    const plan = buildCarryForwardPlan({
      log: { headSha: "b".repeat(40), verdict: "findings_present", findings,
        provenance: { perAngle: ["coverage", "correctness"].map((angle) => ({ angle, reviewer: "prior-reviewer", model: "review-model" })) } },
      changedFiles: ["docs/readme.md"],
    });
    const carriedNames = ["coverage", "correctness"];
    assert.deepEqual(plan.carried.map((entry) => entry.angle), carriedNames);
    const fanout = resolveFanoutDispatch(config, "draft", carriedNames, { carriedAngles: carriedNames });
    assert.deepEqual(fanout.pendingGroups, []);
    const contextOptions = parseWriteGateContextCliArgs([
      "--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA,
      "--angles", JSON.stringify(carriedNames), "--carried-angles", JSON.stringify(carriedNames),
    ]);
    contextOptions.config = config;
    contextOptions.fanoutDispatch = fanout;
    await writeGateContext(contextOptions, { repoRoot });
    const contextDir = path.join(repoRoot, "tmp", "gate-context", "o-r", "pr-7");
    const emitted = runEmitCli(["--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA, "--pending", "--carry-forward-plan", JSON.stringify(plan)], { cwd: repoRoot });
    assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
    const emitPlan = path.join(contextDir, `${gate}-${HEAD_SHA}.emit-plan.json`);
    const payload = JSON.parse(await readFile(emitPlan, "utf8"));
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.units, []);
    const findingsDir = path.join(repoRoot, "findings");
    await mkdir(findingsDir);
    const faninOptions = { repo: REPO, pr: Number(PR), repoRoot, tmpRoot: path.join(repoRoot, "tmp"), findingsDir, gate, headSha: HEAD_SHA, emitPlan,
      resolvedAngles: carriedNames, carriedAngles: carriedNames, carryForwardPlan: plan.carried };
    const parsedRound = parseConsolidateFaninCliArgs(["--findings-dir", findingsDir, "--repo", REPO, "--pr", PR]);
    assert.equal(parsedRound.repo, REPO);
    assert.equal(parsedRound.pr, PR);
    const fanin = await consolidateGateFanin(faninOptions);
    assert.equal(fanin.overallVerdict, "findings_present");
    assert.equal(fanin.findingsJson[0].angle, "coverage");
    const consolidatedFindings = toFindingsLogShape(fanin.findings);
    assert.deepEqual(consolidatedFindings[0], { ...findings[0], disposition: "accepted-for-fix" });
    const provenance = { distinctReviewers: 1, perAngle: plan.carried.map(({ angle, reviewer, model, carriedFromHead, prevVerdict }) =>
      ({ angle, reviewer, model, carriedFromHead, carriedVerdict: prevVerdict })) };
    const writeOptions = { repo: REPO, pr: Number(PR), gate, headSha: HEAD_SHA,
      verdict: fanin.overallVerdict, findings: JSON.stringify(consolidatedFindings), executionMode: "fanout_fanin",
      provenance: JSON.stringify(provenance), emitPlan, tmpRoot: path.join(repoRoot, "tmp") };
    const written = await writeGateFindingsLog(writeOptions, { repoRoot });
    assert.deepEqual(written.log.findings, consolidatedFindings);
    assert.deepEqual(written.log.provenance.perAngle, provenance.perAngle);
    const newFinding = { ...consolidatedFindings[0], summary: "New High without a fresh review" };
    for (const extra of [newFinding, consolidatedFindings[0]]) {
      await assert.rejects(() => writeGateFindingsLog({ ...writeOptions,
        findings: JSON.stringify([...consolidatedFindings, extra]) }, { repoRoot }), /unproven findings/);
    }
    await assert.rejects(() => writeGateFindingsLog({ ...writeOptions, findings: "[]" }, { repoRoot }), /preserved findings/);
    await assert.rejects(() => writeGateFindingsLog({ ...writeOptions,
      findings: JSON.stringify(consolidatedFindings.map((finding) => ({ ...finding, recommendation: "changed" }))) }, { repoRoot }), /preserved findings/);
    await assert.rejects(() => writeGateFindingsLog({ ...writeOptions,
      findings: JSON.stringify(consolidatedFindings.map((finding) => ({ ...finding, files: ["src/foreign.mjs"] }))) }, { repoRoot }), /preserved findings/);
    for (const identity of [{ repo: "foreign/repo" }, { pr: Number(PR) + 1 }, { repo: undefined }, { pr: undefined }]) {
      await assert.rejects(() => consolidateGateFanin({ ...faninOptions, ...identity }), /round identities/);
    }
    const invalidCarries = [
      { name: "foreign angle", rows: [{ ...provenance.perAngle[0], angle: "foreign-angle" }, provenance.perAngle[1]] },
      { name: "stale prior head", rows: [{ ...provenance.perAngle[0], carriedFromHead: "e".repeat(40) }, provenance.perAngle[1]] },
      { name: "changed reviewer", rows: [{ ...provenance.perAngle[0], reviewer: "unreviewed-identity" }, provenance.perAngle[1]] },
      { name: "missing angle", rows: [provenance.perAngle[0]] },
    ];
    const acceptedInvalidCarries = [];
    for (const { name, rows } of invalidCarries) {
      try {
        await verifyEmitPlanProvenance(emitPlan, { distinctReviewers: 1, perAngle: rows },
          { repo: REPO, pr: Number(PR), gate, headSha: HEAD_SHA }, { repoRoot });
        acceptedInvalidCarries.push(name);
      } catch { /* Every invalid carried proof must fail closed. */ }
    }
    assert.deepEqual(acceptedInvalidCarries, [], "zero-unit plan accepted invalid carry proof");
    await assert.rejects(() => consolidateGateFanin({ ...faninOptions, carryForwardPlan: [] }), /no proof|not present|carry proof/);
    for (const replacement of [{ carriedFromHead: "e".repeat(40) }, { reviewer: "unreviewed-identity" }, { findings: [{ ...findings[0], summary: "altered finding" }] }]) {
      await assert.rejects(() => consolidateGateFanin({ ...faninOptions,
        carryForwardPlan: [{ ...plan.carried[0], ...replacement }, plan.carried[1]] }), /carry proof/);
    }
    await assert.rejects(() => consolidateGateFanin({ ...faninOptions, headSha: "d".repeat(40) }), /stamped for head/);
    await assert.rejects(() => writeGateFindingsLog({ ...writeOptions,
      provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "coverage", reviewer: "fresh-reviewer" }] }) }, { repoRoot }), /zero|non-empty|fresh angles/);
    const cleanPlan = buildCarryForwardPlan({
      log: { headSha: "b".repeat(40), verdict: "clean", findings: [],
        provenance: { perAngle: provenance.perAngle.map(({ angle, reviewer, model }) => ({ angle, reviewer, model })) } },
      changedFiles: ["docs/readme.md"],
    });
    const cleanEmitted = runEmitCli(["--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA,
      "--pending", "--carry-forward-plan", JSON.stringify(cleanPlan)], { cwd: repoRoot });
    assert.equal(cleanEmitted.status, 0, cleanEmitted.stderr || cleanEmitted.stdout);
    const cleanFanin = await consolidateGateFanin({ ...faninOptions, carryForwardPlan: cleanPlan.carried });
    assert.equal(cleanFanin.overallVerdict, "clean");
    assert.deepEqual(cleanFanin.findings, []);
    const cleanWriteOptions = { ...writeOptions, verdict: "clean", findings: "[]",
      provenance: JSON.stringify({ ...provenance, perAngle: provenance.perAngle.map((entry) => ({ ...entry, carriedVerdict: "clean" })) }) };
    const cleanWritten = await writeGateFindingsLog(cleanWriteOptions, { repoRoot });
    assert.deepEqual(cleanWritten.log.findings, []);
    await assert.rejects(() => writeGateFindingsLog({ ...cleanWriteOptions,
      verdict: "findings_present", findings: JSON.stringify([newFinding]) }, { repoRoot }), /unproven findings/);
    assert.deepEqual(JSON.parse(await readFile(cleanWritten.path, "utf8")), cleanWritten.log,
      "rejected findings must not overwrite the proven ledger");
    await rm(emitPlan);
    await assert.rejects(() => consolidateGateFanin(faninOptions), /could not be read/);
    for (const invalidProof of [null, [], [plan.carried[0]], [plan.carried[0], plan.carried[0]],
      [{ ...plan.carried[0], carriedFromHead: "bad" }, plan.carried[1]]]) {
      const refused = runEmitCli(["--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA,
        "--pending", "--carry-forward-plan", JSON.stringify(invalidProof)], { cwd: repoRoot });
      assert.equal(refused.status, 1, refused.stderr || refused.stdout);
      await assert.rejects(() => readFile(emitPlan), { code: "ENOENT" });
    }
    for (const carriedAngles of [[], ["different-angle"], "coverage"]) {
      await seedBundle(repoRoot, { gate, fanout: { ...fanout, preflight: { carriedAngles, completedAngles: ["coverage"] } } });
      const refused = runEmitCli(["--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA, "--pending"], { cwd: repoRoot });
      assert.equal(refused.status, 1, refused.stderr || refused.stdout);
      await assert.rejects(() => readFile(emitPlan), { code: "ENOENT" });
    }
  });
});

test("requires --repo/--pr/--gate/--head-sha", () => {
  assert.equal(runEmitCli([]).status, 2);
  assert.equal(runEmitCli(["--repo", REPO, "--pr", PR, "--gate", GATE]).status, 2);
});

// Issue 2180 (Path A) / ADR 0048 reconciliation: a configured group AND an
// auto-chunk leftover bundle both dispatch as ONE shared reviewer recording
// the resolved unit's own name as provenance `group`; only the genuine
// singleton dispatches without a shared group.
test("shares a reviewer for a configured group AND an auto-chunk bundle alike; only a genuine singleton dispatches alone", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    // design-simplicity (shared) + the auto-chunk bundle (shared) + contradiction-lens
    // — NOT one reviewer per angle (AC9 exact-count: 3 units, not 4 angles).
    assert.equal(payload.count, 3);
    // the coordinator waves the EMITTED units by this bound, not the stale wavePlan
    assert.equal(typeof payload.maxConcurrent, "number");
    assert.ok(payload.maxConcurrent >= 1);

    const bySc = Object.fromEntries(payload.units.map((u) => [u.scope, u]));
    // configured group → shared reviewer, group = configured name
    const cfg = bySc["pre-approval-gate-group-design-simplicity"];
    assert.ok(cfg, "configured group scope present");
    assert.deepEqual(cfg.angles, ["dry", "kiss"]);
    assert.equal(cfg.group, "design-simplicity");
    // auto-chunk bundle → ONE shared reviewer, group = the bundle's own resolved name
    const autoChunk = bySc["pre-approval-gate-group-group-determinism-state-concurrency"];
    assert.ok(autoChunk, "auto-chunk bundle scope present, shared not split");
    assert.deepEqual(autoChunk.angles, ["determinism", "state-concurrency"]);
    assert.equal(autoChunk.group, "group:determinism+state-concurrency");
    // no per-angle singleton was emitted for the bundled angles
    assert.ok(!("pre-approval-gate-determinism" in bySc));
    assert.ok(!("pre-approval-gate-state-concurrency" in bySc));
    // singleton stays a singleton
    assert.equal(bySc["pre-approval-gate-contradiction-lens"].group, null);

    for (const unit of payload.units) {
      const composed = await readFile(unit.promptPath, "utf8");
      assert.ok(composed.startsWith(PREFIX_BYTES), `prefix-first for ${unit.scope}`);
      for (const angle of unit.angles) assert.match(composed, new RegExp(angle));
      assert.match(composed, /resolveReviewerRole/);
    }
  });
});

// End-to-end split-path regression (#2155 wiring slice a, Copilot follow-up):
// a CONFIGURED group of 5 angles (over REVIEWER_UNIT_MAX_ANGLES) must come out
// of the REAL emitter (main(), not just expandDispatchUnits in isolation) as
// ceil(5/3)=2 split sub-units, alongside the other configured/singleton units
// unaffected by the cap.
//
// Round-2 Copilot follow-up: the earlier fixture hand-authored a "group" of 5
// angles (dry/kiss/srp/ocp/lsp) under the name "design-simplicity" directly
// in the gate-context artifact's fanout.groups — but the SHIPPED
// extension-defaults.yaml's real "design-simplicity" group is dry/kiss/yagni/
// deep (srp/ocp/lsp live in "design-solid"), and seedBundle writes fanout
// straight onto the artifact, bypassing resolveFanoutGroups entirely. That
// fixture only proved main() can split an already-resolved, hand-rolled plan
// — never that a genuinely CONFIGURED over-cap group survives resolveFanoutGroups
// (the config->groups resolution step) before the split. This test instead
// writes a REAL .devloops declaring a fanout group of 5 real angle names,
// loads it with loadDevLoopConfig, and produces the gate-context bundle via
// writeGateContext + resolveFanoutDispatch (which calls resolveFanoutGroups)
// — the SAME production seam write-gate-context.mjs's CLI drives — before
// running the emitter against that genuinely-resolved bundle.
async function seedRealConfiguredGroupBundle(tmpDir) {
  await writeFile(
    path.join(tmpDir, ".devloops"),
    [
      "version: 1",
      "gates:",
      "  fanout:",
      "    groups:",
      "      - name: design-solid",
      "        angles: [srp, soc, ocp, lsp, isp]",
      "",
    ].join("\n"),
    "utf8",
  );
  const { config } = await loadDevLoopConfig({ repoRoot: tmpDir });
  const angles = ["srp", "soc", "ocp", "lsp", "isp", "contradiction-lens"];
  const options = parseWriteGateContextCliArgs([
    "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA,
    "--angles", JSON.stringify(angles),
  ]);
  options.config = config;
  // The exact seam write-gate-context.mjs's main() calls: resolveFanoutDispatch
  // wraps resolveFanoutGroups(config, configGate, resolvedAngles), so the
  // group/leftover split below is the REAL config resolution, not a fixture.
  options.fanoutDispatch = resolveFanoutDispatch(config, mapGateToConfigKey(GATE), angles, {});
  await writeGateContext(options, { repoRoot: tmpDir });
}

test("main(): a configured group OVER the angle cap splits into ceil(N/3) sub-units end-to-end, from a REAL resolveFanoutGroups-routed config", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedRealConfiguredGroupBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    // ceil(5/3)=2 split sub-units + 1 singleton (contradiction-lens)
    assert.equal(payload.count, 3);
    for (const unit of payload.units) {
      assert.ok(unit.angles.length <= REVIEWER_UNIT_MAX_ANGLES, `unit ${unit.scope} exceeds the cap`);
    }
    // No angle dropped, duplicated, reordered, or merged across the emitted units.
    const orderedAngles = payload.units.flatMap((u) => u.angles).filter((a) => a !== "contradiction-lens");
    assert.deepEqual(orderedAngles, ["srp", "soc", "ocp", "lsp", "isp"]);
    // Every split MULTI-angle sub-unit records the CONFIGURED group name as
    // provenance — not its own synthetic `-partN` scope-distinguishing name
    // (the "provenance documentation" fix: FIX 1).
    const splitUnits = payload.units.filter((u) => u.angles.length > 1);
    // 5 angles / cap 3 → part1 (3 angles) + part2 (2 angles), both multi-angle.
    assert.equal(splitUnits.length, 2);
    for (const u of splitUnits) assert.equal(u.group, "design-solid");
  });
});

for (const configured of [true, false]) {
  test(`C17: ${configured ? "configured" : "auto-chunk"} singleton split tail retains its original group through emission and ledger writing`, async () => {
    await withTmpDir(async (repoRoot) => {
      const angles = ["srp", "soc", "ocp", "lsp", "pr-checklist"];
      await writeFile(path.join(repoRoot, ".devloops"), JSON.stringify({ version: 1, gates: { fanout: {
        groups: configured ? [{ name: "design-solid", angles: angles.slice(0, 4) }] : [],
        maxAnglesPerGroup: 4,
      } } }));
      const { config, errors } = await loadDevLoopConfig({ repoRoot });
      assert.deepEqual(errors, []);
      const fanout = resolveFanoutDispatch(config, mapGateToConfigKey(GATE), angles, {});
      assert.deepEqual(fanout.groups.map((unit) => unit.angles), [angles.slice(0, 4), angles.slice(4)]);
      const options = parseWriteGateContextCliArgs([
        "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA,
        "--angles", JSON.stringify(angles),
      ]);
      await writeGateContext({ ...options, config, fanoutDispatch: fanout }, { repoRoot });
      const emitted = runEmitCli(["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA], { cwd: repoRoot });
      assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
      const payload = JSON.parse(emitted.stdout);
      const tmpRoot = path.join(repoRoot, "tmp");
      const emitPlan = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
      assert.deepEqual(JSON.parse(await readFile(emitPlan, "utf8")), payload);
      assert.equal(payload.count, 3);
      assert.deepEqual(payload.units.map((unit) => unit.angles), [angles.slice(0, 3), [angles[3]], [angles[4]]]);
      const group = fanout.groups[0].name;
      assert.deepEqual(payload.units.map((unit) => unit.group), [group, group, null]);
      assert.equal(payload.units[1].scope, "pre-approval-gate-lsp");
      const provenance = { distinctReviewers: 3, perAngle: payload.units.flatMap((unit, index) =>
        unit.angles.map((angle) => ({ angle, reviewer: `review-${index}`, ...(unit.group === null ? {} : { group: unit.group }) }))) };
      const writeOptions = { repo: REPO, pr: Number(PR), gate: GATE, headSha: HEAD_SHA, verdict: "clean",
        findings: "[]", provenance: JSON.stringify(provenance), emitPlan, tmpRoot };
      const written = await writeGateFindingsLog(writeOptions, { repoRoot });
      assert.deepEqual(written.log.provenance, provenance);
      for (const replacement of [undefined, "wrong-group"]) {
        const changed = structuredClone(provenance);
        changed.perAngle[3].group = replacement;
        await assert.rejects(() => writeGateFindingsLog({ ...writeOptions, provenance: JSON.stringify(changed) }, { repoRoot }), /records group/);
      }
      const mixedIdentity = structuredClone(provenance);
      mixedIdentity.perAngle[0].reviewer = "different-reviewer";
      mixedIdentity.distinctReviewers = 4;
      await assert.rejects(() => writeGateFindingsLog({ ...writeOptions, provenance: JSON.stringify(mixedIdentity) }, { repoRoot }), /multiple reviewer identities/);
      const reusedIdentity = structuredClone(provenance);
      reusedIdentity.perAngle[3].reviewer = "review-0";
      reusedIdentity.distinctReviewers = 2;
      await assert.rejects(() => writeGateFindingsLog({ ...writeOptions, provenance: JSON.stringify(reusedIdentity) }, { repoRoot }), /smaller than/);
      const nullTail = structuredClone(payload);
      nullTail.units[1].group = null;
      await writeFile(emitPlan, JSON.stringify(nullTail));
      await assert.rejects(() => writeGateFindingsLog(writeOptions, { repoRoot }), /records group/);
      for (const invalidUnits of [
        // A matching plan/provenance claim cannot manufacture a split tail.
        [{ ...payload.units[1], group: "arbitrary-group" }],
        [payload.units[0], { ...payload.units[1], group: "wrong-group" }],
        [payload.units[1], payload.units[0]],
        [{ ...payload.units[0], angles: angles.slice(0, 2) }, payload.units[1]],
      ]) {
        await writeFile(emitPlan, JSON.stringify({ ...payload, count: invalidUnits.length, units: invalidUnits }));
        const invalidProvenance = { distinctReviewers: invalidUnits.length, perAngle: invalidUnits.flatMap((unit, index) =>
          unit.angles.map((angle) => ({ angle, reviewer: `review-${index}`, group: unit.group }))) };
        await assert.rejects(() => verifyEmitPlanProvenance(emitPlan, invalidProvenance,
          { repo: REPO, pr: Number(PR), gate: GATE, headSha: HEAD_SHA }, { repoRoot }), /preceding same-group full-cap split sibling/);
      }
      const malformed = structuredClone(payload);
      malformed.units[0].group = null;
      await writeFile(emitPlan, JSON.stringify(malformed));
      await assert.rejects(() => writeGateFindingsLog(writeOptions, { repoRoot }), /non-empty for a multi-angle unit/);
    });
  });
}

// AC9 (issue 2180, Path A) end-to-end exact-count fixture: a NO-config-table
// angle set (no gates.fanout.groups match at all) routed through the REAL
// resolveFanoutGroups auto-chunk path (via resolveFanoutDispatch, the same
// seam write-gate-context.mjs's CLI drives) must dispatch ONE shared reviewer
// PER AUTO-CHUNK BUNDLE — never one reviewer per angle. 7 ungrouped angles at
// the default maxAnglesPerGroup=3 auto-chunk into exactly 3 bundles
// ([a,b,c], [d,e,f], [g]); the emitted count must be 3, not 7.
async function seedRealAutoChunkOnlyBundle(tmpDir, angles) {
  const { config } = await loadDevLoopConfig({ repoRoot: tmpDir }); // no .devloops
  // loadDevLoopConfig still layers in the shipped extension-defaults.yaml,
  // whose gates.fanout.groups table is NON-EMPTY (design-simplicity,
  // design-solid, etc.) — those just don't match angles a..g. Clear the
  // resolved table so this fixture literally models AC1/AC9's claimed
  // "repository with NO configured gates.fanout.groups table", not merely a
  // table that fails to match (Copilot review, PR 2233).
  if (config?.gates?.fanout) config.gates.fanout.groups = [];
  const options = parseWriteGateContextCliArgs([
    "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA,
    "--angles", JSON.stringify(angles),
  ]);
  options.config = config;
  options.fanoutDispatch = resolveFanoutDispatch(config, mapGateToConfigKey(GATE), angles, {});
  await writeGateContext(options, { repoRoot: tmpDir });
}

test("main(): a no-config-table angle set dispatches ONE shared reviewer per auto-chunk bundle, not one per angle (AC9, issue 2180)", async () => {
  await withTmpDir(async (tmpDir) => {
    const angles = ["a", "b", "c", "d", "e", "f", "g"];
    await seedRealAutoChunkOnlyBundle(tmpDir, angles);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    // 7 angles / cap 3 → 3 auto-chunk bundles ([a,b,c],[d,e,f],[g]), NOT 7
    // per-angle singletons.
    assert.equal(payload.count, 3);
    // Coverage (AC7): every input angle is dispatched exactly once.
    assert.deepEqual(payload.units.flatMap((u) => u.angles).sort(), [...angles].sort());
    // The two 3-angle bundles are shared reviewers recording their own
    // auto-chunk bundle name as provenance `group`; the trailing 1-angle
    // bundle is a genuine singleton with no shared group.
    const sharedUnits = payload.units.filter((u) => u.angles.length > 1);
    assert.equal(sharedUnits.length, 2);
    for (const u of sharedUnits) assert.match(u.group, /^group:/);
    const singleton = payload.units.find((u) => u.angles.length === 1);
    assert.equal(singleton.group, null);
  });
});

// #1971 — caller-boundary coverage for the Claude-harness concurrency clamp:
// this CLI is the second (of two) resolveFanoutEffectiveConcurrency call
// sites, and reads process.env directly rather than through an injectable
// seam, so a caller-level test here has to pin the env at the OS-process
// boundary (spawnSync's own `env` option) rather than via a function argument.
test("emits maxConcurrent clamped to 2 under a Claude-harness env (#1971)", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir, env: { ...process.env, CLAUDECODE: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.maxConcurrent, 2);
  });
});

test("emits the configured (unclamped) maxConcurrent under a non-Claude env (#1971)", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const nonClaudeEnv = { ...process.env };
    delete nonClaudeEnv.CLAUDECODE;
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir, env: nonClaudeEnv },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    // no config file in tmpDir → default gates.fanout.maxConcurrent (4), unclamped.
    assert.equal(payload.maxConcurrent, 4);
  });
});

test("--pending emits only the pendingGroups subset", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.units[0].angles[0], "contradiction-lens");
    assert.equal(payload.pending, true);
    // the persisted keyed plan body carries the same pending: true round marker
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    const persisted = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(persisted.pending, true);
  });
});

// AC1 (issue 2175): end-to-end pipeline pin — write-gate-context.mjs's own
// --carried-angles narrows fanout.pendingGroups (resolveFanoutDispatch), and
// --pending here emits ONLY the changed-input angles' units into the
// persisted keyed emit-plan. Angles auto-chunk (unconfigured groups) into
// units of <= maxAnglesPerGroup (default 3): "correctness"/"coverage"/"docs"
// chunk together and "determinism" chunks alone. Carrying the WHOLE first
// chunk forward (a narrow bump whose delta provably never touched their
// surface) excludes it entirely from pendingGroups; "determinism" (the
// changed-input angle) is the only unit left to dispatch.
test("end-to-end: write-gate-context.mjs's --carried-angles narrows pendingGroups, and --pending emits only the changed-input angle's unit", async () => {
  await withTmpDir(async (tmpDir) => {
    const angles = ["correctness", "coverage", "docs", "determinism"];
    const carriedAngles = ["correctness", "coverage", "docs"];
    const options = parseWriteGateContextCliArgs([
      "--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA,
      "--angles", JSON.stringify(angles),
      "--carried-angles", JSON.stringify(carriedAngles),
    ]);
    // parseWriteGateContextCliArgs only parses flags — the fanout dispatch
    // plan is resolved by main() from the loaded config; drive it directly
    // here (same seam main() itself calls) so this stays a pure programmatic
    // pipeline test with no GitHub reads.
    options.fanoutDispatch = resolveFanoutDispatch({ version: 1 }, mapGateToConfigKey(GATE), angles, { carriedAngles });
    await writeGateContext(options, { repoRoot: tmpDir });

    const tmpRoot = path.join(tmpDir, "tmp");
    const exitCode = await main(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { tmpRootDefault: tmpRoot },
    );
    assert.equal(exitCode, 0);

    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    const persisted = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(persisted.pending, true);
    const emittedAngles = persisted.units.flatMap((u) => u.angles).sort();
    assert.deepEqual(emittedAngles, ["determinism"], "only the changed-input angle's unit is emitted — the carried angles never re-dispatch");
  });
});

// GATE-EXEC-FANOUT-DISPATCH-EMIT: a successful run persists the emitted round
// plan to the keyed <gate>-<headSha>.emit-plan.json sibling of the gate-context
// bundle (buildGateEmitPlanPath), body = the emitter's own result object — never a
// fixed-path stdout capture that concurrent gates would clobber.
test("a successful run persists the keyed emit-plan artifact with the full result body", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const stdoutPayload = JSON.parse(result.stdout);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    const persisted = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(persisted.ok, true);
    assert.equal(persisted.gate, GATE);
    assert.equal(persisted.headSha, HEAD_SHA);
    assert.equal(persisted.repo, REPO);
    assert.equal(persisted.pr, PR);
    assert.equal(persisted.pending, false);
    assert.equal(persisted.count, stdoutPayload.count);
    assert.equal(persisted.maxConcurrent, stdoutPayload.maxConcurrent);
    assert.deepEqual(persisted.units, stdoutPayload.units);
    for (const unit of persisted.units) {
      assert.deepEqual(Object.keys(unit).sort(), ["angles", "group", "promptPath", "scope"].sort());
    }
  });
});

test("a failed emit-plan write removes a partially-created final artifact", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    const status = await main(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      {
        tmpRootDefault: tmpRoot,
        persistPlan: async (file, data) => {
          await writeFile(file, data.slice(0, 16), "utf8");
          throw Object.assign(new Error("simulated partial write"), { code: "ENOSPC" });
        },
      },
    );
    assert.equal(status, 2);
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Two gates at the same head/repo/pr write DISTINCT keyed plan files; the
// review plan stays byte-identical after the draft_gate emitter runs — the
// concurrent-emitter clobbering hazard the keyed artifact exists to remove.
test("two gates at the same head persist distinct, mutually-intact emit plans", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { gate: "review" });
    await seedBundle(tmpDir, { gate: "draft_gate" });
    const review = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", "review", "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(review.status, 0, review.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const reviewPlanPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: "review", headSha: HEAD_SHA, tmpRoot });
    const reviewPlanBefore = await readFile(reviewPlanPath, "utf8");

    const draft = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", "draft_gate", "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(draft.status, 0, draft.stderr);
    const draftPlanPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: "draft_gate", headSha: HEAD_SHA, tmpRoot });
    assert.notEqual(draftPlanPath, reviewPlanPath);
    assert.equal(JSON.parse(await readFile(reviewPlanPath, "utf8")).gate, "review");
    assert.equal(JSON.parse(await readFile(draftPlanPath, "utf8")).gate, "draft_gate");
    // The review plan is intact (byte-identical) after the draft_gate run.
    assert.equal(await readFile(reviewPlanPath, "utf8"), reviewPlanBefore);
  });
});

// Success-only placement: a refusal run (zero units) must leave NO plan file —
// never a half-persisted round.
test("a refusal run writes NO emit-plan artifact", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Stale-plan regression (Copilot review, emit-fanout-dispatch.mjs:350): an
// earlier SUCCESSFUL run at the same (repo, pr, gate, head) key persists the
// keyed plan; a later failed emission at that key used to leave that stale
// plan on disk, and a downstream fan-in key-checks exactly that path — the
// stale plan passes the key guard even though the current emission never
// completed. The emitter must REMOVE the keyed plan BEFORE the emission loop,
// so every refusal/error return leaves it absent.
test("a failed re-run REMOVES a pre-existing keyed emit-plan from an earlier successful run", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan.
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. A refusal at the SAME key (zero units — one of the exit-1 returns
    //    between the plan removal and the success-only persist).
    await seedBundle(tmpDir, { fanout: { groups: [] } });
    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 1, refused.stderr);

    // 3. The earlier round's keyed plan is GONE — the stale plan cannot pass a
    //    downstream fan-in key check as this round's plan.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Early-refusal regression (Copilot review, emit-fanout-dispatch.mjs:276): the
// same contract must hold when the gate-context artifact carries NO fanout plan
// at all — the plan-removal runs before any validation/refusal return, so the
// no-fanout-plan refusal (an EARLIER return than the zero-units one) also
// removes a pre-existing keyed plan from an earlier successful run.
test("the no-fanout-plan EARLY refusal REMOVES a pre-existing keyed emit-plan too", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan.
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. The EARLY refusal at the SAME key — artifact with no fanout plan at
    //    all (fanout: null seeds an empty artifact object).
    await seedBundle(tmpDir, { fanout: null });
    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(JSON.parse(refused.stdout).error, /carries no fanout dispatch plan/);

    // 3. The earlier round's keyed plan is GONE even on the early refusal path.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Missing-artifact regression (Copilot review round 3): the keyed-plan removal
// must run BEFORE the gate-context artifact read/parse, so the
// missing-artifact refusal — the EARLIEST exit in the flow — cannot leave a
// stale keyed plan from an earlier successful run at the same key.
test("the missing-artifact refusal REMOVES a pre-existing keyed emit-plan too", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan.
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. Remove the context artifact entirely, then re-run at the SAME key —
    //    the emitter refuses with "no gate-context artifact" before reading it.
    const artifactPath = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-7", `${GATE}-${HEAD_SHA}.json`);
    await rm(artifactPath, { force: true });
    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(JSON.parse(refused.stdout).error, /no gate-context artifact/);

    // 3. The earlier round's keyed plan is GONE even on the missing-artifact path.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Malformed-artifact regression (Copilot review round 3): the same contract
// holds when the gate-context artifact exists but is NOT valid JSON — the
// JSON.parse throw exits (2) before any plan validation, and the keyed plan
// from an earlier successful run must already be removed by then.
test("the malformed (non-JSON) artifact refusal REMOVES a pre-existing keyed emit-plan too", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan.
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. Corrupt the artifact to non-JSON, then re-run at the SAME key — the
    //    JSON.parse throw takes the exit-2 path.
    const artifactPath = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-7", `${GATE}-${HEAD_SHA}.json`);
    await writeFile(artifactPath, "{not valid json", "utf8");
    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 2, refused.stderr);

    // 3. The earlier round's keyed plan is GONE even on the malformed-artifact path.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

test("--pending falls back to groups only when pendingGroups is ABSENT", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, {
      fanout: {
        groups: [
          { name: "coverage", angles: ["coverage"] },
          { name: "consistency", angles: ["consistency"] },
        ],
      },
    });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, 2);
    // the fallback stamps pending: true over the full-group units in the
    // persisted keyed plan body — documented actual fallback semantics
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    const persisted = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(persisted.pending, true);
    assert.equal(persisted.units.length, 2);
    assert.deepEqual(
      persisted.units.flatMap((unit) => unit.angles).sort(),
      ["consistency", "coverage"],
    );
  });
});

test("--pending with a PRESENT-but-empty pendingGroups refuses (does not re-emit groups)", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["coverage"] }], pendingGroups: [] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /zero units/);
  });
});

test("--pending fails closed (exit 1) when pendingGroups is present but not an array", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["coverage"] }], pendingGroups: { bad: true } } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /present but not an array/);
  });
});

test("fails closed (exit 1) when the gate-context artifact is missing", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /no gate-context artifact/);
  });
});

test("fails closed (exit 1) when the artifact carries no fanout plan", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: null });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /no fanout dispatch plan/);
  });
});

test("fails closed (exit 1) when the fanout plan resolves zero units", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /zero units/);
  });
});

test("fails closed (exit 1) on an angle-less dispatch unit", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "empty", angles: ["", "  "] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /carries no angles/);
  });
});

test("fails closed (exit 1) when a unit's invariant-prefix record is missing", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["coverage"] }] }, withPrefix: false });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /failed to compose reviewer prompt/);
  });
});

test("fails closed (exit 1) when two distinct singleton units derive a colliding scope", async () => {
  await withTmpDir(async (tmpDir) => {
    // Two distinct single-angle units whose angle names sanitize to the same scope segment.
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "foo.bar", angles: ["foo.bar"] }, { name: "foo-bar", angles: ["foo-bar"] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /collides with an earlier unit/);
  });
});

test("fails closed (exit 1) when an angle sanitizes to an empty, invalid scope", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "u", angles: ["@@@"] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /not a valid reviewer scope/);
  });
});

test("normalizes a unit's angles once: a blank angle is filtered, keeping scope/group consistent", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["coverage", ""] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const unit = JSON.parse(result.stdout).units[0];
    assert.deepEqual(unit.angles, ["coverage"]);
    assert.equal(unit.group, null); // singleton after normalization — shares no reviewer
    assert.equal(unit.scope, "pre-approval-gate-coverage");
  });
});

test("trims padded angle names so the dispatched angle and scope carry no whitespace", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["  coverage  "] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const unit = JSON.parse(result.stdout).units[0];
    assert.deepEqual(unit.angles, ["coverage"]);
    assert.equal(unit.scope, "pre-approval-gate-coverage");
  });
});

test("expandDispatchUnits: trims padded angles on a singleton", () => {
  assert.deepEqual(expandDispatchUnits([{ name: "u", angles: [" a "] }], new Set()), [
    { name: "a", angles: ["a"], group: null },
  ]);
});

test("expandDispatchUnits: trims padded angles on a multi-angle (shared) unit", () => {
  assert.deepEqual(expandDispatchUnits([{ name: "u", angles: [" a ", "b "] }], new Set()), [
    { name: "u", angles: ["a", "b"], group: "u" },
  ]);
});

test("expandDispatchUnits: a configured group AND an auto-chunk bundle both stay shared; only the genuine singleton splits alone", () => {
  const configured = new Set(["design-simplicity"]);
  const units = [
    { name: "design-simplicity", angles: ["dry", "kiss"] },
    { name: "group:a+b", angles: ["a", "b"] }, // auto-chunk leftover
    { name: "solo", angles: ["solo"] },
  ];
  const out = expandDispatchUnits(units, configured);
  assert.deepEqual(out, [
    { name: "design-simplicity", angles: ["dry", "kiss"], group: "design-simplicity" },
    { name: "group:a+b", angles: ["a", "b"], group: "group:a+b" },
    { name: "solo", angles: ["solo"], group: null },
  ]);
});

// AC7 coverage: the union of angles across emitted units equals the input
// angle set — no angle dropped or duplicated by grouping a mix of configured
// groups, auto-chunk bundles, and singletons.
test("expandDispatchUnits: emitted angle coverage equals the input angle set (no drop/duplicate)", () => {
  const configured = new Set(["design-simplicity"]);
  const units = [
    { name: "design-simplicity", angles: ["dry", "kiss"] },
    { name: "group:a+b+c", angles: ["a", "b", "c"] },
    { name: "solo", angles: ["solo"] },
  ];
  const out = expandDispatchUnits(units, configured);
  const inputAngles = units.flatMap((u) => u.angles);
  const emittedAngles = out.flatMap((u) => u.angles);
  assert.deepEqual([...emittedAngles].sort(), [...inputAngles].sort());
  assert.equal(new Set(emittedAngles).size, emittedAngles.length);
});

test("expandDispatchUnits: a configured group AT the angle cap stays one shared unit", () => {
  const configured = new Set(["backend"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c"] }], configured);
  assert.equal(REVIEWER_UNIT_MAX_ANGLES, 3);
  assert.deepEqual(out, [{ name: "backend", angles: ["a", "b", "c"], group: "backend" }]);
});

test("expandDispatchUnits: a configured group OVER the cap splits into ordered ≤cap sub-units (even remainder)", () => {
  const configured = new Set(["backend"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c", "d", "e"] }], configured);
  assert.deepEqual(out, [
    { name: "backend-part1", angles: ["a", "b", "c"], group: "backend" },
    { name: "backend-part2", angles: ["d", "e"], group: "backend" },
  ]);
});

test("expandDispatchUnits: an over-cap group whose remainder is one angle yields a trailing singleton sub-unit", () => {
  const configured = new Set(["backend"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c", "d"] }], configured);
  assert.deepEqual(out, [
    { name: "backend-part1", angles: ["a", "b", "c"], group: "backend" },
    { name: "backend-part2", angles: ["d"], group: "backend" },
  ]);
});

test("expandDispatchUnits: split never drops, duplicates, or reorders angles, and every unit is within the cap", () => {
  const configured = new Set(["big"]);
  const angles = ["a", "b", "c", "d", "e", "f", "g"]; // 7 → 3 + 3 + 1
  const out = expandDispatchUnits([{ name: "big", angles }], configured);
  // No angle dropped/duplicated/merged: concatenation equals the input, in order.
  assert.deepEqual(out.flatMap((u) => u.angles), angles);
  // Every emitted unit is bounded by the reviewer-unit angle cap.
  for (const u of out) assert.ok(u.angles.length <= REVIEWER_UNIT_MAX_ANGLES, `unit ${u.name} exceeds cap`);
  assert.equal(out.length, 3);
});

// Unresolved review thread (critical): a config with a group "backend" (4
// angles, splits into "backend-part1"/"backend-part2") AND a SEPARATELY
// configured group literally named "backend-part1" makes two dispatch units
// derive the same scope, failing the whole round at the seenScopes guard.
// splitSubUnitName disambiguates the split sub-unit's name against every
// configured group name BEFORE dispatchUnitScope ever sees it; seenScopes
// stays the backstop for any residual collision it cannot predict (e.g. an
// upstream-composed name).
test("splitSubUnitName disambiguates a split sub-unit's name against a configured group name", () => {
  const configured = new Set(["backend", "backend-part1"]);
  assert.equal(splitSubUnitName("backend", 1, configured), "backend-part1-x1");
  assert.equal(splitSubUnitName("backend", 2, configured), "backend-part2");
});

test("splitSubUnitName is a no-op when the candidate name is not itself configured", () => {
  const configured = new Set(["backend"]);
  assert.equal(splitSubUnitName("backend", 1, configured), "backend-part1");
});

test("expandDispatchUnits: split sub-unit name avoids colliding with a separately-configured group name", () => {
  const configured = new Set(["backend", "backend-part1"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c", "d"] }], configured);
  assert.deepEqual(out, [
    { name: "backend-part1-x1", angles: ["a", "b", "c"], group: "backend" },
    { name: "backend-part2", angles: ["d"], group: "backend" },
  ]);
  // Distinct dispatch scopes — the seenScopes guard never has to fire.
  const scopes = out.map((u) => dispatchUnitScope("pre_approval_gate", u));
  assert.equal(new Set(scopes).size, scopes.length);
});

// Path A (issue 2180) coverage gap: splitSubUnitName now disambiguates
// against collisionNames — configuredGroupNames PLUS every sibling unit
// resolved THIS ROUND, not just the configured table. This exercises that
// sibling-unit branch with an EMPTY configured set: an over-cap "backend"
// unit (5 angles) splits, and its part1 sub-unit would naturally be named
// "backend-part1" — colliding with a genuinely separate sibling singleton
// unit already named "backend-part1" this round.
test("expandDispatchUnits: split sub-unit name avoids colliding with a SIBLING unit's name (empty configured set)", () => {
  const units = [
    { name: "backend", angles: ["a", "b", "c", "d", "e"] },
    { name: "backend-part1", angles: ["backend-part1"] },
  ];
  const out = expandDispatchUnits(units, new Set());
  assert.deepEqual(out, [
    { name: "backend-part1-x1", angles: ["a", "b", "c"], group: "backend" },
    { name: "backend-part2", angles: ["d", "e"], group: "backend" },
    { name: "backend-part1", angles: ["backend-part1"], group: null },
  ]);
  // No angle dropped/duplicated: coverage equals the input, in order.
  assert.deepEqual(out.flatMap((u) => u.angles), ["a", "b", "c", "d", "e", "backend-part1"]);
  // Distinct dispatch scopes — the split sub-unit never collides with the sibling singleton.
  const scopes = out.map((u) => dispatchUnitScope("pre_approval_gate", u));
  assert.equal(new Set(scopes).size, scopes.length);
});

test("dispatchUnitScope: split sub-units of one group derive DISTINCT scopes (no collision)", () => {
  const configured = new Set(["backend"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c", "d", "e"] }], configured);
  const scopes = out.map((u) => dispatchUnitScope("pre_approval_gate", u));
  assert.equal(new Set(scopes).size, scopes.length);
  assert.deepEqual(scopes, [
    "pre-approval-gate-group-backend-part1",
    "pre-approval-gate-group-backend-part2",
  ]);
});

// Round-2 Copilot follow-up (critical, PRRT_kwDOScHU786iZMYI): splitSubUnitName
// compared the generated `<name>-partN` candidate against the RAW configured
// group names, but dispatchUnitScope derives a multi-angle unit's scope as
// `group-${sanitizeScopeSegment(name)}` — so the collision that actually
// matters is on the SANITIZED form. A config with an over-cap "backend" group
// (4 angles) and a SEPARATELY configured "backend_part1" group (underscore,
// not hyphen) makes the generated "backend-part1" sub-unit and the configured
// "backend_part1" group BOTH sanitize to "group-backend-part1" — a raw-name
// comparison never sees this because the two strings differ. splitSubUnitName
// must disambiguate against sanitizeScopeSegment(name) over every configured
// name, not the raw name.
test("splitSubUnitName disambiguates against the SANITIZED form of a configured group name (underscore vs hyphen)", () => {
  const configured = new Set(["backend", "backend_part1"]);
  // Raw "backend-part1" is NOT itself a configured name, but it sanitizes to
  // the same segment as the configured "backend_part1" — must still bump.
  assert.equal(splitSubUnitName("backend", 1, configured), "backend-part1-x1");
  assert.equal(splitSubUnitName("backend", 2, configured), "backend-part2");
});

test("expandDispatchUnits: a split sub-unit's scope never collides with a separately-configured group's SANITIZED scope (backend / backend_part1)", () => {
  const configured = new Set(["backend", "backend_part1"]);
  const out = expandDispatchUnits([{ name: "backend", angles: ["a", "b", "c", "d"] }], configured);
  assert.deepEqual(out, [
    { name: "backend-part1-x1", angles: ["a", "b", "c"], group: "backend" },
    { name: "backend-part2", angles: ["d"], group: "backend" },
  ]);
  const splitScope = dispatchUnitScope("pre_approval_gate", out[0]);
  const configuredGroupScope = dispatchUnitScope("pre_approval_gate", { name: "backend_part1", angles: ["x", "y"] });
  assert.notEqual(splitScope, configuredGroupScope, "the split sub-unit's scope must not collide with the configured backend_part1 group's scope");
  // seenScopes never has to fire — every derived scope is already distinct.
  const scopes = out.map((u) => dispatchUnitScope("pre_approval_gate", u));
  assert.equal(new Set(scopes).size, scopes.length);
});

// Invalid---jq regression (Copilot review round 4, emit-fanout-dispatch.mjs): the
// keyed plan was persisted BEFORE finish(payload, true) evaluated the --jq
// filter, so an invalid filter (exit 2) left a keyed plan from a FAILED
// emitter invocation that a later fan-in would accept. The --jq syntax
// preflight now runs BEFORE the success-only persist (and after the
// start-of-flow plan removal), so an invalid filter exits 2 with the keyed
// plan ABSENT even when a prior successful run at the same key seeded one.
test("a pre-valid --jq filter does not affect a successful run", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--jq", ".count"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "3");
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);
  });
});

test("an invalid --jq filter exits 2 and leaves the keyed plan ABSENT after a prior successful run", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan (seeds the stale plan).
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. Re-run at the SAME key with a syntactically INVALID --jq filter —
    //    the preflight exits 2 after the start-of-flow plan removal.
    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--jq", "[unclosed"],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(JSON.parse(refused.stderr).error, /--jq/);

    // 3. The keyed plan is ABSENT — no plan from a failed emitter invocation.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

test("an empty --jq value removes a prior same-key emit plan before refusing", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot: path.join(tmpDir, "tmp") });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    const refused = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--jq", ""],
      { cwd: tmpDir },
    );
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(JSON.parse(refused.stderr).error, /--jq/);
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

// Data-invalid --jq regression (Copilot review round 5,
// emit-fanout-dispatch.mjs final-emission path): a filter that is
// SYNTACTICALLY valid but fails against the payload's DATA (`.count | length`
// — a number is not a valid `length` input) passes the syntax preflight and
// evaluates only at finish(), AFTER the success-only persist. Before the fix,
// that exit 2 left the just-persisted keyed plan on disk — a key-valid plan
// from a FAILED invocation that a later fan-in key-check would accept. The
// final-emission failure path must remove the plan, then propagate the
// exit 2.
test("a data-invalid --jq filter exits 2 AFTER the persist and REMOVES the keyed plan", async () => {
  await withTmpDir(async (tmpDir) => {
    // 1. A successful run persists the keyed plan (seeds a valid plan).
    await seedBundle(tmpDir);
    const okRun = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(okRun.status, 0, okRun.stderr);
    const tmpRoot = path.join(tmpDir, "tmp");
    const planPath = buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot });
    assert.equal(JSON.parse(await readFile(planPath, "utf8")).ok, true);

    // 2. Re-run at the SAME key with a data-invalid (syntax-valid) --jq filter:
    //    it passes the preflight, the plan is re-persisted, finish() evaluates
    //    the filter against the payload and exits 2.
    const failed = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--jq", ".count | length"],
      { cwd: tmpDir },
    );
    assert.equal(failed.status, 2, failed.stderr);
    assert.match(JSON.parse(failed.stderr).error, /--jq/);

    // 3. The keyed plan is ABSENT — the persisted plan from the FAILED
    //    invocation did not survive the exit-2 emission failure.
    await assert.rejects(() => readFile(planPath, "utf8"), { code: "ENOENT" });
  });
});

test("expandDispatchUnits: a configured-name unit with one resolved angle is a singleton, not a shared group", () => {
  const out = expandDispatchUnits([{ name: "design-simplicity", angles: ["dry"] }], new Set(["design-simplicity"]));
  assert.deepEqual(out, [{ name: "dry", angles: ["dry"], group: null }]);
});

test("dispatchUnitScope: singleton uses the angle name; multi-angle sanitizes the unit name", () => {
  assert.equal(dispatchUnitScope("draft_gate", { name: "coverage", angles: ["coverage"] }), "draft-gate-coverage");
  assert.equal(dispatchUnitScope("pre_approval_gate", { name: "design-simplicity", angles: ["dry", "kiss"] }), "pre-approval-gate-group-design-simplicity");
});

test("sanitizeScopeSegment collapses non-alphanumeric runs to single hyphens", () => {
  assert.equal(sanitizeScopeSegment("group:a+b+c"), "group-a-b-c");
  assert.equal(sanitizeScopeSegment("--edge--"), "edge");
});

test("buildAngleNamingSuffix names angles and instructs self-resolution, never inlining persona text", () => {
  const single = buildAngleNamingSuffix({ name: "coverage", angles: ["coverage"] });
  assert.match(single, /coverage/);
  assert.match(single, /resolveReviewerRole/);
  const group = buildAngleNamingSuffix({ name: "design-simplicity", angles: ["dry", "kiss"] });
  assert.match(group, /dry, kiss/);
  assert.match(group, /one findings artifact PER ANGLE/);
});

// Issue 2155 AC row 2 (slice b): the emitted suffix also carries the bounded
// reviewer contract — budget numbers derived from REVIEWER_UNIT_BUDGET (never
// hard-coded), an instruction for every PROHIBITED_REVIEWER_OPERATIONS kind,
// the assigned-angles-only scope rule, and the blocked escape hatch, which
// covers BOTH ways a unit can fail its bound (budget exhaustion AND
// incomplete angle coverage — Copilot follow-up: the producer also writes a
// blocked artifact for reviewer_coverage_incomplete, not only budget
// exhaustion), named as a directly invokable command.
test("buildAngleNamingSuffix carries the bounded reviewer contract: budget, prohibited probes, scope, blocked escape hatch for both bound failures", () => {
  assert.equal(REVIEWER_UNIT_BUDGET.maxModelTurns, 45);
  assert.equal(REVIEWER_UNIT_BUDGET.maxToolCalls, 50);
  const suffix = buildAngleNamingSuffix({ name: "design-simplicity", angles: ["dry", "kiss"] });
  assert.match(suffix, new RegExp(String(REVIEWER_UNIT_BUDGET.maxModelTurns)));
  assert.match(suffix, new RegExp(String(REVIEWER_UNIT_BUDGET.maxToolCalls)));
  assert.equal(PROHIBITED_REVIEWER_OPERATIONS.length, 7);
  const expectedProhibitedPhrases = [
    /poll PR state/,
    /poll CI state/,
    /poll Copilot state/,
    /network status probes/,
    /rerun validation/,
    /orchestration runtime/,
    /unassigned angles/,
  ];
  for (const phrase of expectedProhibitedPhrases) assert.match(suffix, phrase);
  assert.match(suffix, /review ONLY the angle\(s\) named above/);
  assert.match(suffix, /emit-reviewer-blocked\.mjs/);
  // Broadened wording: not limited to budget exhaustion — also covers being
  // unable to finish every assigned angle (reviewer_coverage_incomplete).
  assert.match(suffix, /exceed this budget/);
  assert.match(suffix, /cannot finish reviewing every assigned angle/);
  // The escape hatch is a directly invokable command, not just a pointer to
  // the script: it names --run/--head-sha/--angles/--completed-angles/
  // --model-turns/--tool-calls/--findings-dir, but every value is a
  // PLACEHOLDER the reviewer fills in — never a concrete angle name (or any
  // other concrete value) interpolated into the shell-command text, since an
  // angle name is only required to be a non-empty string and could otherwise
  // carry shell metacharacters into a copy-pasted command.
  assert.match(suffix, /--run <reviewed head sha>/);
  assert.match(suffix, /--head-sha <reviewed head sha>/);
  assert.match(suffix, /--angles <your assigned angles, comma-separated>/);
  assert.match(suffix, /--completed-angles <angles you finished>/);
  assert.match(suffix, /--model-turns <model turns you used>/);
  assert.match(suffix, /--tool-calls <tool calls you used>/);
  assert.match(suffix, /--findings-dir </);
  assert.doesNotMatch(suffix, /--angles "dry,kiss"/);
});
