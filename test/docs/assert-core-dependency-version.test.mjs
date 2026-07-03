import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertCoreDependencyInLockstep,
  extractMajorMinor,
} from "../../scripts/release/assert-core-dependency-version.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const scriptPath = path.join(repoRoot, "scripts/release/assert-core-dependency-version.mjs");

test("rejects a #1033-shaped manifest (dev-loops@0.6.2 shipping @dev-loops/core@^0.2.6)", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.2.6" }),
    /does not match the release version 0\.6\.2/,
  );
});

test("accepts a manifest whose core range matches the release major.minor", () => {
  const result = assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.6.0" });
  assert.equal(result.majorMinor, "0.6");
});

test("accepts same-minor patch drift and tilde ranges", () => {
  assert.doesNotThrow(() => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.6.2" }));
  assert.doesNotThrow(() => assertCoreDependencyInLockstep({ releaseVersion: "1.4.0", coreRange: "~1.4.9" }));
});

test("rejects a major mismatch even when minor agrees", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "1.6.0", coreRange: "^0.6.0" }),
    /does not match/,
  );
});

test("fails closed on a missing core dependency", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: undefined }),
    /must declare a "@dev-loops\/core" dependency/,
  );
});

test("extractMajorMinor strips range operators and compound ranges", () => {
  assert.equal(extractMajorMinor("^0.6.0"), "0.6");
  assert.equal(extractMajorMinor("~1.4.9"), "1.4");
  assert.equal(extractMajorMinor(">=0.6.0 <0.7.0"), "0.6");
  assert.equal(extractMajorMinor("0.6.2"), "0.6");
  assert.throws(() => extractMajorMinor("latest"), /cannot parse/);
});

test("the real root package.json is in lockstep (guards against real drift at CI)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.doesNotThrow(() =>
    assertCoreDependencyInLockstep({
      releaseVersion: pkg.version,
      coreRange: pkg.dependencies?.["@dev-loops/core"],
    }),
  );
});

test("CLI exits 0 on the real in-lockstep manifest", () => {
  const res = spawnSync(
    "node",
    [scriptPath, "--manifest", "package.json"],
    { encoding: "utf8", cwd: repoRoot },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /in lockstep with release/);
});

test("CLI exits 2 on a usage error (unknown arg or a flag missing its value)", () => {
  const unknown = spawnSync("node", [scriptPath, "--nope"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /unknown argument/);

  const bareFlag = spawnSync("node", [scriptPath, "--release-version"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(bareFlag.status, 2, bareFlag.stderr);
  assert.match(bareFlag.stderr, /requires a value/);
});

test("CLI fails closed (exit 1) on a synthetic #1033 manifest", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "core-dep-"));
  const manifest = path.join(dir, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({ version: "0.6.2", dependencies: { "@dev-loops/core": "^0.2.6" } }),
  );
  try {
    const res = spawnSync("node", [scriptPath, "--manifest", manifest], { encoding: "utf8" });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /::error::/);
    assert.match(res.stderr, /does not match the release version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
