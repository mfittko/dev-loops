import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";

const cliPath = path.resolve("scripts/refine/promote-plan.mjs");

const BASE_PLAN = [
  "# Plan",
  "",
  "## Status",
  "Draft.",
  "",
  "## Objective",
  "Do the thing.",
  "",
  "## In scope",
  "- the bounded slice",
  "",
  "## Explicit non-goals",
  "- no broad rewrite",
  "",
].join("\n");

const READY_PLAN = [
  BASE_PLAN.trimEnd(),
  "",
  "## Acceptance criteria",
  "",
  "- The thing works end to end.",
  "- A second criterion holds.",
  "",
  "## Definition of done",
  "",
  "- Tests pass; CHANGELOG updated.",
  "- A second done check holds.",
  "",
].join("\n");

// gh stub entry for `gh pr create`: print a PR URL on stdout (create-pr inherits
// stdio, so this URL flows back up to the promote CLI's captured child stdout).
const PR_CREATE_ENTRY = {
  assertArgs: ["pr", "create", "--draft"],
  stdout: "https://github.com/owner/repo/pull/321\n",
};

async function gitInit(repoDir, env) {
  const sh = async (args) => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("git", args, { cwd: repoDir, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  await sh(["init", "-q", "-b", "main"]);
  await sh(["config", "user.email", "test@example.com"]);
  await sh(["config", "user.name", "Test"]);
  // Disable commit signing so the test is deterministic regardless of a
  // developer's global commit.gpgsign setting.
  await sh(["config", "commit.gpgsign", "false"]);
  await sh(["commit", "-q", "--allow-empty", "-m", "root"]);
}

async function setup(plan = READY_PLAN, ghEntries = [PR_CREATE_ENTRY]) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "promote-plan-"));
  // A real git repo so the promote path's git add/commit/branch run for real.
  const repoDir = path.join(tempDir, "repo");
  const stubDir = path.join(tempDir, "stub");
  await writeFile(path.join(tempDir, ".keep"), "", "utf8");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  const ghStub = await writeGhStub(stubDir, ghEntries, { logCalls: true });
  await gitInit(repoDir, ghStub.env);
  const planPath = path.join(repoDir, "docs", "phases", "phase-x.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, plan, "utf8");
  return { tempDir, repoDir, planPath, ghStub };
}

describe("promote-plan CLI", () => {
  test("ready plan: commits plan doc, opens exactly one draft PR, links bidirectionally", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "promote");
      assert.equal(parsed.prNumber, 321);
      assert.equal(parsed.planDocPath, "docs/phases/phase-x.md");

      // Plan->PR link written into front-matter.
      const written = await readFile(planPath, "utf8");
      assert.match(written, /^---\nprNumber: 321\n---\n/u);

      // Exactly one gh call, and it was `pr create --draft`.
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(ghLog.length, 1, `expected one gh call, got: ${ghLog.join(" | ")}`);
      const call = JSON.parse(ghLog[0]);
      assert.deepEqual(call.slice(0, 2), ["pr", "create"]);
      assert.ok(call.includes("--draft"), "PR must be a draft");

      // PR body (passed via --body) carries the full AC + DoD and links the doc;
      // never an issue close keyword.
      const bodyIdx = call.indexOf("--body");
      assert.notEqual(bodyIdx, -1);
      const body = call[bodyIdx + 1];
      assert.match(body, /docs\/phases\/phase-x\.md/u);
      assert.match(body, /The thing works end to end\./u);
      assert.match(body, /A second criterion holds\./u);
      assert.match(body, /Tests pass; CHANGELOG updated\./u);
      assert.doesNotMatch(body, /Closes #\d+/u);
      assert.doesNotMatch(body, /Fixes #\d+/u);

      // The plan doc was committed (the spec-of-record), with a head branch.
      const { spawnSync } = await import("node:child_process");
      const log = spawnSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" }).stdout;
      assert.match(log, /promote docs\/phases\/phase-x\.md/u);
      assert.match(log, /link docs\/phases\/phase-x\.md to PR #321/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: a not-ready plan makes ZERO gh calls and exits 1", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup(BASE_PLAN, []);
    try {
      const before = await readFile(planPath, "utf8");
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "not_ready_for_promotion");
      assert.equal(parsed.planFileIntakeState, "new_plan_needs_refinement");

      // Zero tracker mutation: plan untouched, gh log empty.
      const after = await readFile(planPath, "utf8");
      assert.equal(after, before, "plan file must be untouched on fail-closed");
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("idempotent: a plan already linked to a PR opens nothing and reports it", async () => {
    const linked = `---\nprNumber: 99\n---\n${READY_PLAN}`;
    const { tempDir, repoDir, planPath, ghStub } = await setup(linked, []);
    try {
      const before = await readFile(planPath, "utf8");
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "already_promoted");
      assert.equal(parsed.prNumber, 99);

      // Opened nothing: plan untouched, gh log empty.
      const after = await readFile(planPath, "utf8");
      assert.equal(after, before, "plan must be untouched on the idempotent no-op");
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("partial state: link write-back commit failure reports the open PR for recovery, exits 1", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      // Install a commit-msg hook that rejects only the link commit (its message
      // carries "to PR #"), so the PR opens and the first commit lands but the
      // link write-back commit fails — exactly the partial-state hazard.
      const { mkdir, chmod } = await import("node:fs/promises");
      const hookDir = path.join(repoDir, ".git", "hooks");
      await mkdir(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, "commit-msg");
      await writeFile(hookPath, "#!/bin/sh\ngrep -q 'to PR #' \"$1\" && exit 1\nexit 0\n", "utf8");
      await chmod(hookPath, 0o755);

      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "git_link_commit_failed");
      // The PR opened: its number is surfaced so the operator can recover.
      assert.equal(parsed.prNumber, 321);
      assert.match(parsed.recovery, /PR #321 is open/u);

      // Exactly one PR was opened (no duplicate); the on-disk plan carries the link.
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(ghLog.length, 1, `expected one gh call, got: ${ghLog.join(" | ")}`);
      const written = await readFile(planPath, "utf8");
      assert.match(written, /^---\nprNumber: 321\n---\n/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects missing --plan-file", async () => {
    const result = await runNode(cliPath, [], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --plan-file/u);
  });
});
