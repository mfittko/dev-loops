import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildAngleNamingSuffix, dispatchUnitScope, expandDispatchUnits, sanitizeScopeSegment } from "../../scripts/github/emit-fanout-dispatch.mjs";

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

async function seedBundle(tmpDir, { fanout = FANOUT, withPrefix = true } = {}) {
  const dir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-7");
  await mkdir(dir, { recursive: true });
  if (withPrefix) await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.briefing-prefix.txt`), PREFIX_BYTES, "utf8");
  await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.briefing-volatile.txt`), VOLATILE_BYTES, "utf8");
  const artifact = fanout === null ? {} : { fanout };
  await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.json`), JSON.stringify(artifact), "utf8");
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
  });
});

test("--pending falls back to groups only when pendingGroups is ABSENT", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedBundle(tmpDir, { fanout: { groups: [{ name: "coverage", angles: ["coverage"] }] } });
    const result = runEmitCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--pending"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, 1);
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
