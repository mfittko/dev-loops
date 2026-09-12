import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildAngleNamingSuffix, dispatchUnitScope, expandDispatchUnits, sanitizeScopeSegment } from "../../scripts/github/emit-fanout-dispatch.mjs";
import { buildGateEmitPlanPath } from "../../scripts/github/write-gate-context.mjs";

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
// an AUTO-CHUNK leftover unit (group:...), and a singleton. Only the configured
// group shares a reviewer; the auto-chunk unit splits into per-angle singletons.
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

test("requires --repo/--pr/--gate/--head-sha", () => {
  assert.equal(runEmitCli([]).status, 2);
  assert.equal(runEmitCli(["--repo", REPO, "--pr", PR, "--gate", GATE]).status, 2);
});

test("shares a reviewer only for a configured group; splits an auto-chunk unit into per-angle singletons", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir);
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    // design-simplicity (shared) + determinism + state-concurrency + contradiction-lens
    assert.equal(payload.count, 4);
    // the coordinator waves the EMITTED units by this bound, not the stale wavePlan
    assert.equal(typeof payload.maxConcurrent, "number");
    assert.ok(payload.maxConcurrent >= 1);

    const bySc = Object.fromEntries(payload.units.map((u) => [u.scope, u]));
    // configured group → shared reviewer, group = configured name
    const cfg = bySc["pre-approval-gate-group-design-simplicity"];
    assert.ok(cfg, "configured group scope present");
    assert.deepEqual(cfg.angles, ["dry", "kiss"]);
    assert.equal(cfg.group, "design-simplicity");
    // auto-chunk unit's angles each become their own singleton reviewer (no shared group)
    const det = bySc["pre-approval-gate-determinism"];
    const stc = bySc["pre-approval-gate-state-concurrency"];
    assert.ok(det && stc, "auto-chunk angles dispatched as distinct singletons");
    assert.equal(det.group, null);
    assert.equal(stc.group, null);
    assert.deepEqual(det.angles, ["determinism"]);
    // no shared unit carries the auto-chunk `group:...` name as provenance
    assert.ok(!payload.units.some((u) => u.group === "group:determinism+state-concurrency"));
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

test("fails closed (exit 1) when two split singletons derive a colliding scope", async () => {
  await withTmpDir(async (tmpDir) => {
    // A non-configured unit whose two angles sanitize to the same scope segment.
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "u", angles: ["foo.bar", "foo-bar"] }] } });
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

test("expandDispatchUnits: trims padded angles", () => {
  assert.deepEqual(expandDispatchUnits([{ name: "u", angles: [" a ", "b "] }], new Set()), [
    { name: "a", angles: ["a"] },
    { name: "b", angles: ["b"] },
  ]);
});

test("expandDispatchUnits: configured group stays shared, everything else splits to singletons", () => {
  const configured = new Set(["design-simplicity"]);
  const units = [
    { name: "design-simplicity", angles: ["dry", "kiss"] },
    { name: "group:a+b", angles: ["a", "b"] }, // auto-chunk leftover
    { name: "solo", angles: ["solo"] },
  ];
  const out = expandDispatchUnits(units, configured);
  assert.deepEqual(out, [
    { name: "design-simplicity", angles: ["dry", "kiss"] },
    { name: "a", angles: ["a"] },
    { name: "b", angles: ["b"] },
    { name: "solo", angles: ["solo"] },
  ]);
});

test("expandDispatchUnits: a configured-name unit with one resolved angle is a singleton, not a shared group", () => {
  const out = expandDispatchUnits([{ name: "design-simplicity", angles: ["dry"] }], new Set(["design-simplicity"]));
  assert.deepEqual(out, [{ name: "dry", angles: ["dry"] }]);
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
