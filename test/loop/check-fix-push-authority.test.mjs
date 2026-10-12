// PRE-PUSH-DELTA-PUSH-AUTHORITY in harness-neutral tooling: the git pre-push hook runs this check, so
// Pi and Claude Code share it; agent type plays no part.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { renderGuardHook } from "@dev-loops/core/loop/default-branch-guard";
import { checkFixPushAuthority } from "../../scripts/loop/check-fix-push-authority.mjs";
import { withTempDir } from "../_helpers.mjs";

const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };

async function withRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, env, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    await fn(root, git("rev-parse", "HEAD").trim(), git);
  }, { prefix: "dev-loops-fix-push-authority-" });
}

test("no marker allows the push", async () => {
  await withRepo((root) => assert.deepEqual(checkFixPushAuthority(root), { ok: true }));
});

test("an active ungranted marker refuses, a granted marker allows, a descendant head stays covered", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    assert.equal(checkFixPushAuthority(root).ok, false);
    git("commit", "-q", "--allow-empty", "-m", "fix");
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, fullGranted: true });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
  });
});

test("the CLI exits 1 while a sequence is ungranted", async () => {
  await withRepo((root, head) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    const run = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
  });
});

test("only the generated pre-push hook runs the check, ahead of the override env", () => {
  const prePush = renderGuardHook("pre-push", ["main"]);
  assert.ok(prePush.indexOf("check-fix-push-authority.mjs") !== -1);
  assert.ok(prePush.indexOf("check-fix-push-authority.mjs") < prePush.indexOf("DEVLOOPS_ALLOW_MAIN"));
  assert.ok(!renderGuardHook("pre-commit", ["main"]).includes("check-fix-push-authority"));
});
