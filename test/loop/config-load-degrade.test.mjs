import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { afterAll, beforeAll, describe, test } from "bun:test";

// Scripts that keep a listed default on a config load error because the default
// cannot relax a gate. provision-worktree, post-gate-findings, refine-plan-file,
// close-gate-findings pin theirs next to their own suites.
let fixture;
beforeAll(() => {
  fixture = mkdtempSync(path.join(os.tmpdir(), "config-degrade-"));
  writeFileSync(path.join(fixture, ".devloops"), "version: 1\nfutureKnob: true\nautonomy:\n  humanMergeOnly: false\n");
  initGitFixture(fixture, { commit: "a" });
  runGitFixture(fixture, ["commit", "-q", "--allow-empty", "-m", "b"]);
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const run = (script, args = []) =>
  spawnSync("node", [path.resolve(script), ...args], { cwd: fixture, encoding: "utf8" });

describe("a config load error keeps the listed default", () => {
  test("resolve-human-merge-only prints true", () => {
    const r = run("scripts/loop/resolve-human-merge-only.mjs");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "true");
  });

  test("detect-change-scope reports eligibleForLightMode false", () => {
    const r = run("scripts/loop/detect-change-scope.mjs");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.eligibleForLightMode, false);
    assert.deepEqual(out.threshold, { maxFiles: 3, maxLines: 200 });
  });
});
