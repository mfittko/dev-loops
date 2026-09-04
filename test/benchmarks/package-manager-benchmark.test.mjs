import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { analyzeBenchmark } from "../../scripts/benchmarks/analyze-package-manager.mjs";
import { buildPairOrders, dependencyInventory, materializeGitRepository, MEASURED_REPETITIONS } from "../../scripts/benchmarks/run-package-manager.mjs";

const run = (tool, measured, durationMs, exitCode = 0) => ({ tool, measured, durationMs, exitCode });
const phase = (tool, duration) => ({ warmups: [run(tool, false, duration)], measured: Array.from({ length: 7 }, () => run(tool, true, duration)) });

function session(id, root, startTool) {
  const npmWarm = { prime: [run("npm", false, 80)], ...phase("npm", 80) };
  const bunWarm = { prime: [run("bun", false, 40)], ...phase("bun", 40) };
  const verify = [run("npm", false, 99), run("bun", false, 70)];
  for (const order of buildPairOrders(startTool)) for (const tool of order) verify.push(run(tool, true, tool === "npm" ? 100 : 70));
  return {
    protocolVersion: 2, sessionId: id, sessionRoot: root, startTool,
    environment: { platform: "linux", arch: "x64", cpu: "fixture", node: "v24", bun: "1.4.1", npm: "11", powerState: "AC power" },
    sourceFingerprint: { npm: "npm-sha", bun: "bun-sha" }, suiteInventory: { npm: ["a"], bun: ["a"] },
    inventory: { npm: { packages: ["a@1"], bins: ["a"], workspaceLinks: [] }, bun: { packages: ["a@1"], bins: ["a"], workspaceLinks: [] } },
    installs: { npm: { cold: phase("npm", 100), warm: npmWarm }, bun: { cold: phase("bun", 50), warm: bunWarm } }, verify,
  };
}

test("pair order alternates within one invocation and supports reversed session starts", () => {
  assert.equal(MEASURED_REPETITIONS, 7);
  assert.deepEqual(buildPairOrders("npm").slice(0, 3), [["npm", "bun"], ["bun", "npm"], ["npm", "bun"]]);
  assert.deepEqual(buildPairOrders("bun").slice(0, 2), [["bun", "npm"], ["npm", "bun"]]);
});

test("benchmark copies are deterministic standalone main-branch git repositories with origin/main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-loops-benchmark-git-"));
  const project = path.join(root, "project");
  try {
    await mkdir(project);
    await writeFile(path.join(project, "package.json"), '{"name":"fixture"}\n');
    await materializeGitRepository(project);
    const git = (...args) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
    assert.equal(git("rev-parse", "--is-inside-work-tree").stdout.trim(), "true");
    assert.equal(git("branch", "--show-current").stdout.trim(), "main");
    assert.equal(git("rev-parse", "HEAD").stdout.trim(), git("rev-parse", "origin/main").stdout.trim());
    assert.equal(git("config", "--get", "remote.origin.url").stdout.trim(), "https://github.com/mfittko/dev-loops.git");
    assert.equal(git("show", "-s", "--format=%an|%ae|%aI", "HEAD").stdout.trim(), "dev-loops benchmark|benchmark@dev-loops.invalid|2000-01-01T00:00:00Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency inventory canonicalizes npm nested and Bun hoisted layouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-loops-benchmark-inventory-"));
  const npmRoot = path.join(root, "npm");
  const bunRoot = path.join(root, "bun");
  const packageJson = (name) => JSON.stringify({ name, version: "1.0.0" });
  try {
    await mkdir(path.join(npmRoot, "node_modules", "a", "node_modules", "b"), { recursive: true });
    await mkdir(path.join(bunRoot, "node_modules", "a"), { recursive: true });
    await mkdir(path.join(bunRoot, "node_modules", "b"), { recursive: true });
    await writeFile(path.join(npmRoot, "node_modules", "a", "package.json"), packageJson("a"));
    await writeFile(path.join(npmRoot, "node_modules", "a", "node_modules", "b", "package.json"), packageJson("b"));
    await writeFile(path.join(bunRoot, "node_modules", "a", "package.json"), packageJson("a"));
    await writeFile(path.join(bunRoot, "node_modules", "b", "package.json"), packageJson("b"));
    assert.deepEqual(await dependencyInventory(npmRoot), await dependencyInventory(bunRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzer requires two independent sessions and uses seven-sample install medians", () => {
  const verdict = analyzeBenchmark([session("one", "/tmp/one", "npm"), session("two", "/tmp/two", "bun")]);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.installs[0].cold.ratio, 0.5);
  assert.deepEqual(verdict.verify.map(({ wins, pass }) => ({ wins, pass })), [{ wins: 7, pass: true }, { wins: 7, pass: true }]);
});

test("analyzer fails closed on missing, failed, inventory, identity, or fingerprint mismatches", () => {
  const good = () => [session("one", "/tmp/one", "npm"), session("two", "/tmp/two", "bun")];
  assert.equal(analyzeBenchmark([good()[0]]).pass, false);
  const failed = good(); failed[0].installs.bun.cold.measured[3].exitCode = 1; assert.equal(analyzeBenchmark(failed).pass, false);
  const missing = good(); missing[0].verify.pop(); assert.equal(analyzeBenchmark(missing).pass, false);
  const packages = good(); packages[1].inventory.bun.packages.push("extra@1"); assert.ok(analyzeBenchmark(packages).errors.includes("session 2: dependency package identities differ"));
  const bins = good(); bins[1].inventory.bun.bins.push("extra"); assert.ok(analyzeBenchmark(bins).errors.includes("session 2: root executable bins differ"));
  const workspaces = good(); workspaces[1].inventory.bun.workspaceLinks.push({ location: "node_modules/example", kind: "symlink", target: "../example" }); assert.ok(analyzeBenchmark(workspaces).errors.includes("session 2: workspace links differ"));
  const missingInventory = good(); delete missingInventory[0].inventory.bun.bins; assert.ok(analyzeBenchmark(missingInventory).errors.includes("session 1: missing root executable bin inventories"));
  const identity = good(); identity[1].sessionRoot = "/tmp/one"; assert.equal(analyzeBenchmark(identity).pass, false);
  const ordering = good(); ordering[1].startTool = "npm"; assert.equal(analyzeBenchmark(ordering).pass, false);
  const fingerprint = good(); fingerprint[1].sourceFingerprint.bun = "changed"; assert.equal(analyzeBenchmark(fingerprint).pass, false);
});
