import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshDepsIfChanged } from "../../scripts/loop/_worktree-deps.mjs";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "worktree-deps-"));
  mkdirSync(path.join(dir, "packages", "a"), { recursive: true });
  writeFileSync(path.join(dir, "bun.lock"), "lock-1");
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "packages", "a", "package.json"), '{"v":1}');
  return dir;
}

test("refreshDepsIfChanged: editing only a workspace package.json triggers an install", () => {
  const dir = setup();
  try {
    assert.equal(refreshDepsIfChanged(dir, () => ({ ok: true })).ran, true);
    assert.equal(refreshDepsIfChanged(dir, () => assert.fail("unchanged fingerprint must not install")).ran, false);
    writeFileSync(path.join(dir, "packages", "a", "package.json"), '{"v":2}');
    let installs = 0;
    assert.equal(refreshDepsIfChanged(dir, () => { installs += 1; return { ok: true }; }).ran, true);
    assert.equal(installs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshDepsIfChanged: a failed install followed by the original lockfile still reinstalls", () => {
  const dir = setup();
  const realWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    refreshDepsIfChanged(dir, () => ({ ok: true }));
    writeFileSync(path.join(dir, "bun.lock"), "lock-2");
    assert.equal(refreshDepsIfChanged(dir, () => ({ ok: false, reason: "killed" })).ok, false);
    writeFileSync(path.join(dir, "bun.lock"), "lock-1");
    let installs = 0;
    assert.equal(refreshDepsIfChanged(dir, () => { installs += 1; return { ok: true }; }).ran, true);
    assert.equal(installs, 1);
  } finally {
    process.stderr.write = realWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});
