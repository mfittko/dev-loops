import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  loadDevLoopConfig,
  configLoadFailure,
  assertConfigLoaded,
  ConfigLoadFailedError,
} from "../src/config/config.mjs";
import pkg from "../package.json" with { type: "json" };

async function withRepo(devloops, fn, { packageJson } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-fail-"));
  try {
    await writeFile(path.join(dir, ".devloops"), devloops);
    if (packageJson) await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson));
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("unknown key error names the key, the running version and requires a newer dev-loops", async () => {
  await withRepo("version: 1\nfutureKnob: true\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    const failure = configLoadFailure(load);
    assert.equal(failure.reason, "config_load_failed");
    assert.deepEqual(failure.unknownKeys, ["futureKnob"]);
    assert.equal(failure.runningVersion, pkg.version);
    assert.equal(failure.checkoutVersion, null);
    const text = load.errors[0].message;
    assert.match(text, /futureKnob/);
    assert.ok(text.includes(pkg.version));
    assert.match(text, /newer dev-loops/);
    assert.doesNotMatch(text, /checkout/);
  });
});

test("inside a dev-loops checkout the error also names the checkout version", async () => {
  await withRepo("version: 1\nfutureKnob: true\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.match(load.errors[0].message, /checkout is 9\.9\.9/);
    assert.equal(configLoadFailure(load).checkoutVersion, "9.9.9");
  }, { packageJson: { name: "dev-loops", version: "9.9.9" } });
});

test("an Object.prototype key name keeps the generic text", async () => {
  await withRepo("version: 1\nconstructor: 1\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.match(load.errors[0].message, /constructor need a newer dev-loops/);
    assert.doesNotMatch(load.errors[0].message, /undefined|renamed/);
  });
});

test("a renamed key gets a migration hint naming the new key and the renaming release", async () => {
  await withRepo("version: 1\nqueue:\n  board: https://example.test/board\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.match(load.errors[0].message, /queue\.board/);
    assert.match(load.errors[0].message, /tracker\.board/);
    assert.match(load.errors[0].message, /in dev-loops 1\.0\.0;/);
    assert.doesNotMatch(load.errors[0].message, /newer dev-loops/);
  });
});

test("an unknown key without a rename record keeps the generic text", async () => {
  await withRepo("version: 1\nqueue:\n  nothingLikeThis: 1\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.doesNotMatch(load.errors[0].message, /renamed/);
    assert.match(load.errors[0].message, /queue\.nothingLikeThis need a newer dev-loops/);
    assert.deepEqual(configLoadFailure(load).unknownKeys, ["queue.nothingLikeThis"]);
  });
});

test("a removed raw angle key gets the migration hint, not the upgrade advice", async () => {
  await withRepo("version: 1\ngates:\n  draft:\n    mandatoryAngles: [security]\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.doesNotMatch(load.errors[0].message, /newer dev-loops/);
    assert.match(load.errors[0].message, /canonical angle-entry shape/);
  });
});

test("assertConfigLoaded passes a clean load and throws a typed error otherwise", async () => {
  await withRepo("version: 1\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.equal(configLoadFailure(load), null);
    assert.equal(assertConfigLoaded(load), load);
  });
  await withRepo("version: 1\nfutureKnob: true\n", async (dir) => {
    const load = await loadDevLoopConfig({ repoRoot: dir });
    assert.throws(() => assertConfigLoaded(load), (err) => {
      assert.ok(err instanceof ConfigLoadFailedError);
      assert.equal(err.code, "config_load_failed");
      assert.equal(err.configError.reason, "config_load_failed");
      assert.match(err.message, /futureKnob/);
      return true;
    });
  });
});

test("formatCliError carries code and configError for a ConfigLoadFailedError", async () => {
  const { formatCliError } = await import("../src/github/review-threads.mjs");
  const configError = { reason: "config_load_failed", errors: ["x"], unknownKeys: ["k"], runningVersion: "1", checkoutVersion: null };
  const payload = JSON.parse(formatCliError(new ConfigLoadFailedError(configError)));
  assert.equal(payload.code, "config_load_failed");
  assert.deepEqual(payload.configError, configError);
});
