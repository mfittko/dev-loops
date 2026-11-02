// docs/decisions/0234: a PR head that adds a config key only its own schema
// knows must not fail the trusted default-branch gate-evidence run with config_load_failed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadDevLoopConfig, stripConfigKeyPaths } from "@dev-loops/core/config";
import { buildFanoutEnforcement, parseHeadDeclaredKeys } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { reportHeadDeclaredKeys } from "../../scripts/github/report-head-declared-keys.mjs";

const BASE = "version: 1\ngates:\n  requireFanoutEvidence: true\n";

// Base commit has a valid config; the PR head commit adds `headExtra` lines.
async function enforceWithHead(headExtra, headDeclaredKeys) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-head-declared-keys-"));
  try {
    const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    await writeFile(path.join(dir, ".devloops"), BASE, "utf8");
    g("add", "-A");
    g("commit", "-qm", "base");
    const baseSha = g("rev-parse", "HEAD").trim();
    await writeFile(path.join(dir, ".devloops"), BASE + headExtra, "utf8");
    g("add", "-A");
    g("commit", "-qm", "head");
    const headSha = g("rev-parse", "HEAD").trim();
    g("checkout", "-q", baseSha);
    const { config } = await loadDevLoopConfig({ repoRoot: dir });
    return await buildFanoutEnforcement({
      repo: "owner/repo", pr: 2662, currentHeadSha: headSha,
      draftGateMarker: { visible: false }, preApprovalGateMarker: { visible: false },
      config, cwd: dir, hasFullLabel: false, headDeclaredKeys,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rejectsConfigLoadFailed = (promise) => assert.rejects(promise, (error) => error.code === "config_load_failed");

test("a head-only unknown config key declared by the head schema is tolerated", async () => {
  const enforcement = await enforceWithHead("futureKey:\n  nested: 1\n", ["futureKey", "futureKey.nested"]);
  assert.equal(enforcement.required, true);
});

test("a head-only unknown config key fails closed with an empty or non-matching declared set", async () => {
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\n", []));
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\n", undefined));
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\n", ["otherKey"]));
});

test("a mixed error (declared unknown key plus undeclared one) still fails closed", async () => {
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\nsecondFutureKey: 2\n", ["futureKey"]));
});

test("an error that is not unknown-keys-only still fails closed even with the key declared", async () => {
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\nstrategy: 42\n", ["futureKey"]));
});

test("parseHeadDeclaredKeys accepts an array or object and treats bad or oversized input as empty", () => {
  assert.deepEqual(parseHeadDeclaredKeys('["a","b.c"]'), ["a", "b.c"]);
  assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":["a"]}'), ["a"]);
  assert.deepEqual(parseHeadDeclaredKeys("not json"), []);
  assert.deepEqual(parseHeadDeclaredKeys(JSON.stringify(["x".repeat(70 * 1024)])), []);
});

test("stripConfigKeyPaths removes nested paths from a bare file and stays loadable", () => {
  const out = stripConfigKeyPaths("a: 1\nb:\n  c: 2\n  d: 3\n", ".devloops", ["a", "b.c", "missing.path"]);
  assert.deepEqual(JSON.parse(out), { b: { d: 3 } });
});

async function headRoot(devloops) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-head-root-"));
  await symlink(path.resolve("packages"), path.join(dir, "packages"));
  await symlink(path.resolve("node_modules"), path.join(dir, "node_modules"));
  await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  await writeFile(path.join(dir, ".devloops"), devloops, "utf8");
  return dir;
}

test("report-head-declared-keys lists every dotted key path of a valid head config", async () => {
  const dir = await headRoot("version: 1\ngates:\n  requireFanoutEvidence: true\n");
  try {
    assert.deepEqual(await reportHeadDeclaredKeys(dir), ["version", "gates", "gates.requireFanoutEvidence"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report-head-declared-keys reports an empty set when the head config does not load", async () => {
  const dir = await headRoot("version: 1\nfutureKey: 1\n");
  try {
    assert.deepEqual(await reportHeadDeclaredKeys(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
