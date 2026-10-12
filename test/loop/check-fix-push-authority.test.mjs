// PRE-PUSH-DELTA-PUSH-AUTHORITY in harness-neutral tooling: the git pre-push hook runs this check, so
// Pi and Claude Code share it; agent type plays no part.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { renderGuardHook } from "@dev-loops/core/loop/default-branch-guard";
import { checkFixPushAuthority, parsePushedShas } from "../../scripts/loop/check-fix-push-authority.mjs";
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
  const prePush = renderGuardHook("pre-push", ["main"], null, "/x/check-fix-push-authority.mjs");
  assert.ok(prePush.indexOf("check-fix-push-authority.mjs") !== -1);
  assert.ok(prePush.indexOf("check-fix-push-authority.mjs") < prePush.indexOf("DEVLOOPS_ALLOW_MAIN"));
  assert.ok(!renderGuardHook("pre-commit", ["main"], null, "/x/check-fix-push-authority.mjs").includes("check-fix-push-authority"));
});

test("the generated pre-push hook bakes the path its owner supplies, even from outside core", () => {
  const owner = "/opt/consumer/node_modules/dev-loops/scripts/loop/check-fix-push-authority.mjs";
  const baked = /authority_cli="([^"]*)"\n/.exec(renderGuardHook("pre-push", ["main"], null, owner))?.[1];
  assert.equal(baked, owner);
});

test("the generated pre-push hook refuses every push when no authority script is supplied (fail closed)", () => {
  const prePush = renderGuardHook("pre-push", ["main"]);
  assert.match(prePush, /authority_cli=""\nif \[ -z "\$authority_cli" \] \|\| \[ ! -f "\$authority_cli" \]; then\n[^\n]*show-toplevel[^\n]*\nfi\nif \[ ! -f "\$authority_cli" \]; then\n[^\n]*PRE-PUSH-DELTA-PUSH-AUTHORITY[^\n]*\n  exit 1\nfi/);
  assert.ok(!prePush.includes("/../"), "no package-layout-relative path");
  assert.throws(() => renderGuardHook("pre-push", ["main"], null, "relative/check.mjs"), /absolute path/);
  assert.throws(() => renderGuardHook("pre-push", ["main"], null, "/x/$(evil)/check.mjs"), /absolute path/);
});

test("pushed shas come from git's stdin lines; deletions are skipped and a malformed line throws", () => {
  const a = "a".repeat(40);
  assert.deepEqual(parsePushedShas(`refs/heads/b ${a} refs/heads/b ${"0".repeat(40)}\nrefs/heads/c ${"0".repeat(40)} refs/heads/c ${a}\n`), [a]);
  assert.deepEqual(parsePushedShas(""), []);
  assert.throws(() => parsePushedShas("not a push line"), /malformed pre-push line/);
  assert.throws(() => parsePushedShas(`refs/heads/b zzz refs/heads/b ${a}`), /malformed pre-push line/);
});

test("the guarded sha is refused when pushed from a checkout whose HEAD is elsewhere", async () => {
  await withRepo(async (root, head, git) => {
    git("branch", "fix");
    git("checkout", "-q", "--orphan", "other");
    git("commit", "-q", "--allow-empty", "-m", "elsewhere");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true }, "HEAD is not under the baseline");
    assert.equal(checkFixPushAuthority(root, [head]).ok, false);
    const lines = `refs/heads/fix ${head} refs/heads/fix ${"0".repeat(40)}\n`;
    const run = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8", input: lines });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
    const malformed = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8", input: "garbage\n" });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /fail closed/);
  });
});
