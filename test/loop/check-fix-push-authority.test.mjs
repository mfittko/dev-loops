// PRE-PUSH-DELTA-PUSH-AUTHORITY in harness-neutral tooling: the git pre-push hook runs this check, so
// Pi and Claude Code share it; agent type plays no part.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { clearSequenceMarker, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
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

test("the generated pre-push hook falls back to the checkout script and, with neither file, refuses only under an ungranted sequence marker whose branch ref has not advanced", () => {
  const prePush = renderGuardHook("pre-push", ["main"]);
  assert.match(prePush, /authority_cli=""\nif \[ -z "\$authority_cli" \] \|\| \[ ! -f "\$authority_cli" \]; then\n[^\n]*show-toplevel[^\n]*\nfi\nif \[ -f "\$authority_cli" \]; then\n[^\n]*node "\$authority_cli" \|\| exit 1\nelse\n[\s\S]*gate-delta\/\*\.sequence[\s\S]*PRE-PUSH-DELTA-PUSH-AUTHORITY[^\n]*\n    exit 1\n  fi\nfi/);
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

test("only the PR branch's remote ref ends the sequence; a stacked remote ref of another branch does not", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a" });
    git("commit", "-q", "--allow-empty", "-m", "stacked");
    const stacked = git("rev-parse", "HEAD").trim();
    git("update-ref", "refs/remotes/origin/issue-b", stacked);
    assert.equal(checkFixPushAuthority(root, [stacked]).ok, false, "a stacked origin/issue-b does not end the sequence of issue-a");
    git("update-ref", "refs/remotes/origin/issue-a", stacked);
    assert.deepEqual(checkFixPushAuthority(root, [stacked]), { ok: true }, "the PR branch's own remote ref advanced");
  });
});

test("the refusal names the marker file and the delete recovery", async () => {
  await withRepo(async (root, head) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(file), refused.reason);
    assert.match(refused.reason, /delete the marker/);
    clearSequenceMarker(path.join(root, "tmp"), head);
    assert.deepEqual(checkFixPushAuthority(root), { ok: true }, "a cleared marker (a commit_only round without a fix commit) guards nothing");
  });
});

test("a marker that names no branch is not ended by a remote ref (fail closed)", async () => {
  await withRepo(async (root, head, git) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    git("commit", "-q", "--allow-empty", "-m", "next");
    git("update-ref", "refs/remotes/origin/any", git("rev-parse", "HEAD").trim());
    assert.equal(checkFixPushAuthority(root).ok, false);
    writeFileSync(file, "{not json");
    assert.equal(checkFixPushAuthority(root).ok, false, "a malformed marker keeps guarding");
  });
});

test("a merge-base failure other than 'not an ancestor' refuses instead of dropping the marker", async () => {
  await withRepo((root, head) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    const refused = checkFixPushAuthority(root, ["b".repeat(40)]);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(file), refused.reason);
  });
});

test("a force-push of a non-descendant sha to the marked branch is refused; another branch is not", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a" });
    git("checkout", "-q", "--orphan", "rewritten");
    git("commit", "-q", "--allow-empty", "-m", "rewrite");
    const rewritten = git("rev-parse", "HEAD").trim();
    assert.equal(checkFixPushAuthority(root, [{ sha: rewritten, remoteRef: "refs/heads/issue-a" }]).ok, false);
    assert.deepEqual(checkFixPushAuthority(root, [{ sha: rewritten, remoteRef: "refs/heads/issue-b" }]), { ok: true });
  });
});
