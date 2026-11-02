// docs/decisions/0234: a PR head that adds a config key only its own schema
// knows must not fail the trusted default-branch gate-evidence run with config_load_failed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { loadDevLoopConfig, stripConfigKeyPaths } from "@dev-loops/core/config";
import { bindHeadDeclaredKeys, buildFanoutEnforcement, parseHeadDeclaredKeys } from "../../scripts/github/detect-checkpoint-evidence.mjs";
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

test("parseHeadDeclaredKeys accepts only the declaredKeys object and treats bare arrays, bad or oversized input as empty", () => {
  assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":["a","b.c"]}'), ["a", "b.c"]);
  assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":[]}'), []);
  assert.deepEqual(parseHeadDeclaredKeys('["validation"]'), []);
  assert.deepEqual(parseHeadDeclaredKeys("[]"), []);
  assert.deepEqual(parseHeadDeclaredKeys("{}"), []);
  assert.deepEqual(parseHeadDeclaredKeys(""), []);
  assert.deepEqual(parseHeadDeclaredKeys("not json"), []);
  assert.deepEqual(parseHeadDeclaredKeys(JSON.stringify({ declaredKeys: ["x".repeat(70 * 1024)] })), []);
});

test("one off-pattern entry among 600 valid entries keeps the valid ones", () => {
  const valid = Array.from({ length: 600 }, (_, i) => `k${i}`);
  assert.deepEqual(parseHeadDeclaredKeys(JSON.stringify({ declaredKeys: [...valid, "bad key"] })), valid);
});

test("the discard diagnostic is one JSON line without verdict fields", () => {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = (s) => { out += s; return true; };
  try {
    assert.deepEqual(parseHeadDeclaredKeys('{"declaredKeys":["a","bad key"]}'), ["a"]);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(out.endsWith("\n") && out.trim().split("\n").length, 1);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, { headDeclaredKeysDiscarded: 1, of: 2 });
  assert.equal("evidenceState" in parsed || "currentHeadSha" in parsed, false);
});

test("the declared set applies only to the head it was reported for", async () => {
  assert.deepEqual(bindHeadDeclaredKeys(["a"], "h1", "h1"), ["a"]);
  assert.deepEqual(bindHeadDeclaredKeys(["a"], "h1", "h2"), []);
  assert.deepEqual(bindHeadDeclaredKeys(["a"], "", "h2"), []);
  assert.deepEqual(bindHeadDeclaredKeys(["a"], undefined, "h2"), []);
  // A mismatched SHA yields the empty set, so the head-only key fails closed.
  await rejectsConfigLoadFailed(enforceWithHead("futureKey: 1\n", bindHeadDeclaredKeys(["futureKey"], "h1", "h2")));
});

test("stripConfigKeyPaths removes nested paths from a bare file and stays loadable", () => {
  const out = stripConfigKeyPaths("a: 1\nb:\n  c: 2\n  d: 3\n", ".devloops", ["a", "b.c", "missing.path"]);
  assert.deepEqual(JSON.parse(out), { b: { d: 3 } });
});

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function headRoot(devloops) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-head-root-"));
  await symlink(path.join(REPO_ROOT, "packages"), path.join(dir, "packages"));
  await symlink(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
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
  const okDir = await headRoot("version: 1\ngates:\n  requireFanoutEvidence: true\n");
  try {
    // The same headRoot setup resolves the real head schema, so the empty set is not a vacuous import failure.
    assert.ok((await reportHeadDeclaredKeys(okDir)).length > 0);
    assert.deepEqual(await reportHeadDeclaredKeys(dir), []);
  } finally {
    await rm(okDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// Composition (AC7): the reporter's key paths must equal the base schema's unknownKeys paths,
// including a key inside an array entry. The fake head schema loads cleanly, standing in for a
// head schema that declares `newProp` on a gate angle entry; the base schema does not know it.
test("reporter output for a key inside an array entry composes with the detector", async () => {
  const devloops = "version: 1\ngates:\n  requireFanoutEvidence: true\n  preApproval:\n    angles:\n      - name: threat-model\n        newProp: 1\n";
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-head-array-"));
  try {
    await mkdir(path.join(dir, "packages/core/src/config"), { recursive: true });
    await writeFile(path.join(dir, "packages/core/src/config/config.mjs"), "export async function loadDevLoopConfig() { return { errors: [] }; }\n", "utf8");
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "package.json"), "{}", "utf8");
    await writeFile(path.join(dir, ".devloops"), devloops, "utf8");
    const declared = await reportHeadDeclaredKeys(dir);
    assert.ok(declared.includes("gates.preApproval.angles.0.newProp"), declared.join(","));
    const enforcement = await enforceWithHead(devloops.slice(devloops.indexOf("  preApproval:")), declared);
    assert.equal(enforcement.required, true);
    await rejectsConfigLoadFailed(enforceWithHead(devloops.slice(devloops.indexOf("  preApproval:")), []));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
