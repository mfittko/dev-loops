import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "bun:test";
import { parseBunLock } from "../../scripts/release/assert-core-dependency-version.mjs";

const repoRoot = path.resolve(import.meta.dir, "../..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));

describe("Bun 1.4.1 toolchain authority", () => {
  test("pins Bun exactly while keeping both published Node engines at >=24", async () => {
    const [root, core] = await Promise.all([readJson("package.json"), readJson("packages/core/package.json")]);
    assert.equal(root.packageManager, "bun@1.4.1");
    assert.equal(root.engines.node, ">=24");
    assert.equal(core.engines.node, ">=24");
  });

  test("uses one text Bun lock and no npm lock", async () => {
    const lock = parseBunLock(await readFile(path.join(repoRoot, "bun.lock"), "utf8"));
    assert.equal(lock.lockfileVersion, 2);
    await assert.rejects(access(path.join(repoRoot, "package-lock.json")));
  });

  test("locks workspace linkage, bins, peer/optional metadata, and omits obsolete runners", async () => {
    const [root, core, lock] = await Promise.all([
      readJson("package.json"),
      readJson("packages/core/package.json"),
      readFile(path.join(repoRoot, "bun.lock"), "utf8").then(parseBunLock),
    ]);
    assert.equal(lock.packages["@dev-loops/core"][0], "@dev-loops/core@workspace:packages/core");
    assert.equal(lock.workspaces["packages/core"].name, "@dev-loops/core");
    assert.deepEqual(
      lock.workspaces["packages/core"].bin,
      Object.fromEntries(Object.entries(core.bin).map(([name, target]) => [name, target.replace(/^\.\//u, "")])),
    );
    assert.deepEqual(new Set(lock.workspaces[""].optionalPeers), new Set(["@axe-core/playwright", "@playwright/test"]));
    assert.equal(root.peerDependenciesMeta["@playwright/test"].optional, true);
    assert.equal(root.peerDependenciesMeta["@axe-core/playwright"].optional, true);
    assert.equal(root.devDependencies["npm-run-all2"], undefined);
    assert.equal(root.devDependencies.tsx, undefined);
  });

  test("keeps npm publication provenance while ordinary verification uses Bun", async () => {
    const [root, core] = await Promise.all([readJson("package.json"), readJson("packages/core/package.json")]);
    assert.deepEqual(root.publishConfig, { access: "public", provenance: true });
    assert.deepEqual(core.publishConfig, { access: "public", provenance: true });
    assert.equal(root.scripts.verify, "bun scripts/verify.mjs");
    assert.match(root.scripts["test:pack"], /^bun test /);
    for (const script of Object.values(root.scripts).filter((value) => value.includes("playwright"))) {
      assert.match(script, /node \.\/node_modules\/@playwright\/test\/cli\.js/);
    }
  });
});
