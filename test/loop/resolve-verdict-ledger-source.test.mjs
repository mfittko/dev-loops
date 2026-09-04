import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode as runNodeHelper } from "../_helpers.mjs";
import {
  splitVersion,
  compareVersions,
  resolveVerdictLedgerSource,
} from "../../scripts/loop/resolve-verdict-ledger-source.mjs";

const scriptPath = path.resolve("scripts/loop/resolve-verdict-ledger-source.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

test("splitVersion parses core and rc.N prerelease", () => {
  assert.deepEqual(splitVersion("1.0.0-rc.5"), { core: [1, 0, 0], pre: "rc.5" });
  assert.deepEqual(splitVersion("v1.2.3"), { core: [1, 2, 3], pre: null });
  assert.deepEqual(splitVersion("1.2.3"), { core: [1, 2, 3], pre: null });
  assert.equal(splitVersion("garbage"), null);
  assert.equal(splitVersion(null), null);
});

test("compareVersions orders rc and release versions", () => {
  // rc.1 < rc.5 < final release
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.5"), -1);
  assert.equal(compareVersions("1.0.0-rc.5", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.5", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.5"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);
  // core bump dominates prerelease
  assert.equal(compareVersions("1.1.0-rc.1", "1.0.0-rc.9"), 1);
  assert.equal(Number.isNaN(compareVersions("nope", "1.0.0-rc.5")), true);
});

test("resolveVerdictLedgerSource prefers worktree when installed is stale", () => {
  const stale = resolveVerdictLedgerSource({ installedVersion: "1.0.0-rc.1", sourceVersion: "1.0.0-rc.5" });
  assert.equal(stale.stale, true);
  assert.equal(stale.preferredSource, "worktree");

  const current = resolveVerdictLedgerSource({ installedVersion: "1.0.0-rc.5", sourceVersion: "1.0.0-rc.5" });
  assert.equal(current.stale, false);
  assert.equal(current.preferredSource, "installed");

  const installedNewer = resolveVerdictLedgerSource({ installedVersion: "1.0.0", sourceVersion: "1.0.0-rc.5" });
  assert.equal(installedNewer.stale, false);
  assert.equal(installedNewer.preferredSource, "installed");
});

test("CLI reports worktree preference for an older installed root", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vls-"));
  try {
    const src = path.join(tmp, "src");
    const inst = path.join(tmp, "inst");
    await mkdir(src, { recursive: true });
    await mkdir(inst, { recursive: true });
    await writeFile(path.join(src, "package.json"), JSON.stringify({ version: "1.0.0-rc.5" }));
    await writeFile(path.join(inst, "package.json"), JSON.stringify({ version: "1.0.0-rc.1" }));
    const { code, stdout } = await runNode([
      "--source-root", src,
      "--installed-root", inst,
      "--jq", ".preferredSource",
    ]);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "worktree");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(tmp, { recursive: true, force: true }));
  }
});

test("CLI defaults to installed layout when a version cannot be read", async () => {
  const { code, stdout } = await runNode(["--source-root", "/nonexistent-root-xyz", "--jq", ".preferredSource"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "installed");
  const { code: c2, stdout: s2 } = await runNode(
    ["--source-root", "/nonexistent-root-xyz", "--jq", ".stale"],
  );
  assert.equal(c2, 0);
  assert.equal(s2.trim(), "false");
});
