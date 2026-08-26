import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRunPostMergeActionsCliArgs } from "../../scripts/loop/run-post-merge-actions.mjs";

const scriptPath = path.resolve(fileURLToPath(new URL("../../scripts/loop/run-post-merge-actions.mjs", import.meta.url)));

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function makeMainCheckout(tmp) {
  const originDir = path.join(tmp, "origin");
  const mainDir = path.join(tmp, "main");
  git(tmp, ["init", "-q", originDir]);
  git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  git(originDir, ["config", "commit.gpgsign", "false"]);
  git(originDir, ["commit", "--allow-empty", "-q", "-m", "A"]);
  git(tmp, ["clone", "-q", originDir, mainDir]);
  return mainDir;
}

async function writeDevloops(repoRoot, yaml) {
  await writeFile(path.join(repoRoot, ".devloops"), yaml);
}

test("parseRunPostMergeActionsCliArgs: requires --repo-root", () => {
  assert.throws(() => parseRunPostMergeActionsCliArgs([]), /repo-root/);
});

test("parseRunPostMergeActionsCliArgs: parses --repo-root and --pr", () => {
  const options = parseRunPostMergeActionsCliArgs(["--repo-root", "/r", "--pr", "42"]);
  assert.equal(options.repoRoot, "/r");
  assert.equal(options.pr, 42);
});

test("run-post-merge-actions CLI: a repo with no postMerge.actions is a silent no-op (exit 0, no stdout)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pma-cli-"));
  try {
    const mainDir = await makeMainCheckout(tmp);
    await writeDevloops(mainDir, "version: 1\n");

    const res = execFileSync("node", [scriptPath, "--repo-root", mainDir], { cwd: mainDir, encoding: "utf8" });
    assert.equal(res, "", "no postMerge.actions declared must produce zero stdout");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("run-post-merge-actions CLI: runs a declared action and exits 0 on success", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pma-cli-"));
  try {
    const mainDir = await makeMainCheckout(tmp);
    const marker = path.join(tmp, "ran.marker");
    const touchScript = path.join(tmp, "touch.mjs");
    await writeFile(touchScript, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    await writeDevloops(
      mainDir,
      ["version: 1", "postMerge:", "  actions:", "    - name: touch-marker", `      run: node ${touchScript}`].join("\n"),
    );

    const res = execFileSync("node", [scriptPath, "--repo-root", mainDir], { cwd: mainDir, encoding: "utf8" });
    const parsed = JSON.parse(res);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.results, [{ name: "touch-marker", status: "ok", detail: null }]);
    assert.equal(execFileSync("cat", [marker], { encoding: "utf8" }), "ran");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("run-post-merge-actions CLI: exits non-zero when an action fails", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pma-cli-"));
  try {
    const mainDir = await makeMainCheckout(tmp);
    const boomScript = path.join(tmp, "boom.mjs");
    await writeFile(boomScript, "process.exit(1);\n");
    await writeDevloops(
      mainDir,
      ["version: 1", "postMerge:", "  actions:", "    - name: boom", `      run: node ${boomScript}`].join("\n"),
    );

    let stdout = "";
    try {
      execFileSync("node", [scriptPath, "--repo-root", mainDir], { cwd: mainDir, encoding: "utf8" });
      assert.fail("expected the CLI to exit non-zero");
    } catch (error) {
      stdout = error.stdout;
      assert.equal(error.status, 1);
    }
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.results[0].status, "failed");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("run-post-merge-actions CLI: re-derives the main checkout from a worktree path (never trusts --repo-root blindly)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pma-cli-"));
  try {
    const mainDir = await makeMainCheckout(tmp);
    const wtDir = path.join(tmp, "wt");
    git(mainDir, ["worktree", "add", "--detach", wtDir]);

    const marker = path.join(tmp, "cwd.marker");
    const recordCwdScript = path.join(tmp, "record-cwd.mjs");
    await writeFile(recordCwdScript, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, process.cwd());\n`);
    // postMerge.actions is only declared in the MAIN checkout's .devloops (loaded from
    // the resolved main checkout, not the worktree passed as --repo-root).
    await writeDevloops(
      mainDir,
      ["version: 1", "postMerge:", "  actions:", "    - name: record-cwd", `      run: node ${recordCwdScript}`].join("\n"),
    );

    execFileSync("node", [scriptPath, "--repo-root", wtDir], { cwd: wtDir, encoding: "utf8" });
    const recordedCwd = execFileSync("cat", [marker], { encoding: "utf8" });
    assert.equal(recordedCwd, await realpath(mainDir), "the action must run with cwd set to the resolved main checkout, not the worktree");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("run-post-merge-actions CLI: onlyIfChanged scoping via gh pr diff --name-only", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pma-cli-"));
  try {
    const mainDir = await makeMainCheckout(tmp);
    const marker = path.join(tmp, "scoped.marker");
    await writeDevloops(
      mainDir,
      [
        "version: 1",
        "postMerge:",
        "  actions:",
        "    - name: scoped",
        `      run: node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
        "      onlyIfChanged:",
        "        - src/",
      ].join("\n"),
    );

    // A `gh` stub on PATH answering `pr diff <n> --name-only` with a changed-file list
    // that does NOT match the onlyIfChanged pattern.
    const binDir = path.join(tmp, "bin");
    await mkdir(binDir, { recursive: true });
    const ghStub = path.join(binDir, "gh");
    await writeFile(ghStub, "#!/usr/bin/env sh\necho README.md\necho docs/guide.md\n");
    await chmod(ghStub, 0o755);

    const res = execFileSync("node", [scriptPath, "--repo-root", mainDir, "--pr", "7"], {
      cwd: mainDir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    const parsed = JSON.parse(res);
    assert.equal(parsed.results[0].status, "skipped");
    await assert.rejects(async () => {
      await import("node:fs/promises").then((fs) => fs.access(marker));
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
