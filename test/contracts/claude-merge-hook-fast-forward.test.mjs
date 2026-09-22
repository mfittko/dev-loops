import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hookScript = path.join(repoRoot, ".claude", "hooks", "post-tool-use-merge.mjs");

// Scrub inherited git config so host-side signing/hooks/aliases (e.g. tag.gpgSign,
// core.warnAmbiguousRefs) cannot steer these fixtures (same convention as the other
// CLI git-fixture tests, e.g. test/lib/git-delta.test.mjs).
const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: GIT_FIXTURE_ENV });
}

function revParse(cwd, ref) {
  return execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8", env: GIT_FIXTURE_ENV }).trim();
}

test("post-tool-use-merge hook fast-forwards the main checkout's local main to origin/main (#1596)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    // Normal origin repo with commit A, then commit B (B at HEAD).
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    const commitASha = revParse(originDir, "HEAD");
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    const originSha = revParse(originDir, "HEAD");
    assert.notEqual(commitASha, originSha, "origin must have two distinct commits");

    // Clone origin so mainDir local main = B and refs/remotes/origin/main = B.
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // Put local main behind origin/main: reset to A (remote-tracking stays at B).
    git(mainDir, ["reset", "--hard", commitASha]);
    const beforeSha = revParse(mainDir, "main");
    assert.notEqual(beforeSha, originSha, "local main must start behind origin/main");

    // Run the hook as a PostToolUse Bash event for a merge-capable command.
    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);

    const afterSha = revParse(mainDir, "main");
    assert.equal(afterSha, originSha, "local main advanced to origin/main");
    assert.notEqual(afterSha, beforeSha, "local main actually moved");

    assert.match(res.stderr, /fast-forwarded/, "hook must emit a fast-forwarded stderr note");
    assert.equal(res.stdout.trim(), "", "an on-main fast-forward must not emit a systemMessage");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook fast-forwards a main checkout even when a tag named `main` also exists", async () => {
  // `git rev-parse --abbrev-ref HEAD` prints the ambiguous `heads/main` (core.warnAmbiguousRefs)
  // when a tag named `main` also exists, which used to misclassify an on-main checkout as
  // `other_branch` and wrongly emit a `main_checkout_not_on_main` systemMessage.
  // `--symbolic-full-name` is immune: it always resolves to `refs/heads/main`.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-ambiguous-ref-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    const commitASha = revParse(originDir, "HEAD");
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    const originSha = revParse(originDir, "HEAD");

    git(tmp, ["clone", "-q", originDir, mainDir]);
    git(mainDir, ["reset", "--hard", commitASha]);
    // Force the ambiguity this test exercises rather than relying on git's compiled
    // default (which a host/distro could override even with global/system config
    // scrubbed) — without this, a host with core.warnAmbiguousRefs=false would make
    // `--abbrev-ref HEAD` print an unambiguous `main` too, and the regression this
    // test guards against would pass vacuously.
    git(mainDir, ["config", "core.warnAmbiguousRefs", "true"]);
    // A tag literally named `main` makes `--abbrev-ref HEAD` ambiguous (prints `heads/main`).
    git(mainDir, ["tag", "main"]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    // "main" alone is ambiguous once the tag exists; resolve the branch tip explicitly.
    assert.equal(revParse(mainDir, "refs/heads/main"), originSha, "local main advanced to origin/main despite the ambiguous tag");
    assert.match(res.stderr, /fast-forwarded/, "hook must emit a fast-forwarded stderr note, not a skip");
    assert.equal(
      res.stdout.trim(),
      "",
      "a checkout on main must never emit a main_checkout_not_on_main systemMessage, even with an ambiguous `main` tag",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook skips with a note when the main checkout cannot be resolved (#1596)", async () => {
  // A NON-git temp directory: `git worktree list` fails → mainCheckout stays null.
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-nogit-"));

  try {
    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: nonGit,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: nonGit,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.match(res.stderr, /could not resolve main checkout/, "hook must note it could not resolve the main checkout");
    assert.equal(res.stdout.trim(), "", "an unresolved main checkout must not emit a systemMessage");
  } finally {
    await rm(nonGit, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook warns and exits 0 when fast-forward is non-fast-forwardable (diverged main) (#1596)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-diverged-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    // Origin: A then B (B at HEAD).
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    const commitASha = revParse(originDir, "HEAD");
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);

    // Clone so mainDir local main = B and refs/remotes/origin/main = B.
    git(tmp, ["clone", "-q", originDir, mainDir]);
    // Local main = A (behind), then add commit C so local main = A+C (diverged from origin B).
    git(mainDir, ["reset", "--hard", commitASha]);
    git(mainDir, ["config", "user.email", "test@example.com"]);
    git(mainDir, ["config", "user.name", "Test"]);
    git(mainDir, ["config", "commit.gpgsign", "false"]);
    git(mainDir, ["commit", "--allow-empty", "-q", "-m", "C"]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.match(res.stderr, /skipped \(best-effort\)/, "hook must warn and skip on a diverged main");
    assert.equal(res.stdout.trim(), "", "a diverged main (on main) must not emit a systemMessage");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook runs post-merge worktree cleanup for the merged PR (#1627)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cleanup-hook-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // The dev-loops cleanup script exists in this main checkout; the hook must invoke
    // it for the merged PR, running from the main checkout.
    const scriptPath = path.join(mainDir, "scripts", "loop", "cleanup-worktree.mjs");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    const runLog = path.join(tmp, "cleanup.log");
    await writeFile(
      scriptPath,
      `import fs from "node:fs";const a=process.argv.slice(2);` +
        `const i=a.indexOf("--pr");fs.writeFileSync(${JSON.stringify(runLog)}, "ran "+a[i+1]);\n`,
      { mode: 0o755 },
    );

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    // Mutation anchor: if the cleanup block in post-tool-use-merge.mjs is reverted, the
    // cleanup script is never run and this assertion fails.
    const log = execFileSync("cat", [runLog], { encoding: "utf8" }).trim();
    assert.equal(log, "ran 42", `expected cleanup to run for PR 42, got: ${log}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook invokes the postMerge.actions runner for the merged PR when it exists (#1457)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-post-merge-actions-hook-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // The runner script exists in this main checkout; the hook must invoke it, running
    // from the main checkout, and print its stdout as its own stderr note.
    const scriptPath = path.join(mainDir, "scripts", "loop", "run-post-merge-actions.mjs");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    const runLog = path.join(tmp, "actions.log");
    await writeFile(
      scriptPath,
      `import fs from "node:fs";const a=process.argv.slice(2);` +
        `fs.writeFileSync(${JSON.stringify(runLog)}, a.join(" "));` +
        `process.stdout.write(JSON.stringify({ok:true,results:[{name:"sync",status:"ok",detail:null}]}));\n`,
      { mode: 0o755 },
    );

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    // Mutation anchor: if the postMerge.actions block in post-tool-use-merge.mjs is
    // reverted, the runner is never invoked and this assertion fails.
    const argv = execFileSync("cat", [runLog], { encoding: "utf8" }).trim();
    assert.ok(argv.includes("--repo-root"), `expected --repo-root, got: ${argv}`);
    assert.ok(argv.includes(mainDir), `expected the main checkout path (${mainDir}), got: ${argv}`);
    assert.ok(argv.includes("--pr 42"), `expected --pr 42, got: ${argv}`);
    assert.match(res.stderr, /post-merge actions: /, "hook must relay the runner's stdout");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook is a silent no-op for postMerge.actions when the runner script is absent (#1457)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-post-merge-actions-noop-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);
    // No scripts/loop/run-post-merge-actions.mjs in this checkout.

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.doesNotMatch(res.stderr, /post-merge actions/, "a checkout without the runner script must produce zero new log lines");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- main_checkout_not_on_main: detached/other-branch action-required signal ---

function symbolicRefIsDetached(cwd) {
  const res = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd, encoding: "utf8" });
  return res.status !== 0;
}

test("post-tool-use-merge hook emits a main_checkout_not_on_main systemMessage for a detached, behind/divergent checkout", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-detached-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);

    git(tmp, ["clone", "-q", originDir, mainDir]);
    git(mainDir, ["config", "user.email", "test@example.com"]);
    git(mainDir, ["config", "user.name", "Test"]);
    git(mainDir, ["config", "commit.gpgsign", "false"]);

    // Detach mainDir HEAD and add one local-only commit (never pushed).
    git(mainDir, ["checkout", "-q", "--detach", "HEAD"]);
    git(mainDir, ["commit", "--allow-empty", "-q", "-m", "local-only"]);
    const beforeSha = revParse(mainDir, "HEAD");
    const beforeShortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: mainDir, encoding: "utf8" }).trim();
    assert.equal(symbolicRefIsDetached(mainDir), true, "test setup must start detached");

    // Origin advances by three commits the local checkout never saw.
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "B"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "C"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "D"]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.doesNotMatch(res.stderr, /skipped \(best-effort\)/, "the detached case must not also emit the generic warning");

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(res.stdout.trim());
    }, `stdout must be valid JSON, got: ${res.stdout}`);
    assert.equal(typeof parsed.systemMessage, "string");
    assert.ok(parsed.systemMessage.length > 0);
    assert.ok(parsed.systemMessage.includes("main_checkout_not_on_main"), parsed.systemMessage);
    assert.ok(parsed.systemMessage.includes(mainDir), parsed.systemMessage);
    assert.ok(parsed.systemMessage.includes(`detached@${beforeShortSha}`), parsed.systemMessage);
    assert.ok(parsed.systemMessage.includes("3 commit(s) behind"), parsed.systemMessage);

    const afterSha = revParse(mainDir, "HEAD");
    assert.equal(afterSha, beforeSha, "HEAD sha must be unchanged");
    assert.equal(symbolicRefIsDetached(mainDir), true, "checkout must remain detached (never switched/checked out)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook emits a main_checkout_not_on_main systemMessage for another branch at a zero behind count", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-other-branch-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);

    git(tmp, ["clone", "-q", originDir, mainDir]);
    git(mainDir, ["checkout", "-q", "-b", "feature-x"]);
    const beforeSha = revParse(mainDir, "HEAD");
    const beforeBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: mainDir, encoding: "utf8" }).trim();
    assert.equal(beforeBranch, "feature-x");

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.doesNotMatch(res.stderr, /skipped \(best-effort\)/, "the other-branch case must not also emit the generic warning");

    const parsed = JSON.parse(res.stdout.trim());
    assert.ok(parsed.systemMessage.includes("feature-x"), parsed.systemMessage);
    assert.ok(parsed.systemMessage.includes("0 commit(s) behind"), parsed.systemMessage);

    const afterSha = revParse(mainDir, "HEAD");
    const afterBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: mainDir, encoding: "utf8" }).trim();
    assert.equal(afterSha, beforeSha, "HEAD sha must be unchanged");
    assert.equal(afterBranch, "feature-x", "checked-out branch must be unchanged");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook stays silent (no systemMessage) for a non-merge command", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-nonmerge-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);
    git(mainDir, ["checkout", "-q", "--detach", "HEAD"]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.equal(res.stdout.trim(), "", "a non-merge command must never trigger the sync flow or a systemMessage");
    assert.equal(res.stderr.trim(), "", "a non-merge command must never emit a post-merge stderr note");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post-tool-use-merge hook keeps the generic warning (no systemMessage) when fetch fails", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ff-hook-fetch-fail-"));
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");

  try {
    git(tmp, ["init", "-q", originDir]);
    git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(originDir, ["config", "user.email", "test@example.com"]);
    git(originDir, ["config", "user.name", "Test"]);
    git(originDir, ["config", "commit.gpgsign", "false"]);
    git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
    git(tmp, ["clone", "-q", originDir, mainDir]);

    // Point origin at a path that no longer exists so `fetch origin main` fails.
    git(mainDir, ["remote", "set-url", "origin", path.join(tmp, "does-not-exist")]);

    const res = spawnSync("node", [hookScript], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 42 --squash --delete-branch" },
        cwd: mainDir,
      }),
      encoding: "utf8",
      env: GIT_FIXTURE_ENV,
      cwd: mainDir,
    });

    assert.equal(res.status, 0, `hook must exit 0 (got ${res.status}, stderr: ${res.stderr})`);
    assert.match(res.stderr, /skipped \(best-effort\)/, "a fetch failure must keep the generic warning path");
    assert.equal(res.stdout.trim(), "", "a fetch failure must never emit a systemMessage");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
