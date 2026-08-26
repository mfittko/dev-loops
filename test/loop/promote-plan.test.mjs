import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";
import { runCli } from "../../scripts/refine/promote-plan.mjs";

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

const READY_PLAN_WITH_OVERSIZE_ESTIMATE = [
  READY_PLAN.trimEnd(),
  "",
  "## Size estimate",
  "",
  "- Estimated logic LOC: 900",
  "- Tier: default",
  "- Oversize: justified — one cohesive migration; no clean seam to split on",
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

async function setup(plan = READY_PLAN, ghEntries = [PR_CREATE_ENTRY], { withRemote = true } = {}) {
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
  if (withRemote) {
    // A real bare remote so the promote path's `git push -u origin <branch>`
    // (the pre-PR push) succeeds against an actual ref store.
    const remoteDir = path.join(tempDir, "remote.git");
    const { spawnSync } = await import("node:child_process");
    const init = spawnSync("git", ["init", "-q", "--bare", remoteDir], { env: ghStub.env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const add = spawnSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, env: ghStub.env, encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);
  }
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

      // The head branch was pushed to the remote BEFORE the PR was opened, so a
      // fresh branch needs no manual push — the remote now has the branch ref.
      assert.match(parsed.branch, /promote-plan\/phase-x/u);
      const remoteRefs = spawnSync("git", ["ls-remote", "--heads", "origin"], { cwd: repoDir, env: ghStub.env, encoding: "utf8" }).stdout;
      // String-based check (no RegExp built from the branch slug, which can carry
      // a `.` from defaultBranchName and would otherwise act as a regex metachar).
      assert.ok(
        remoteRefs.split("\n").some((line) => line.endsWith(`refs/heads/${parsed.branch}`)),
        `remote missing refs/heads/${parsed.branch}: ${remoteRefs}`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("carries a plan's oversize-justified Size estimate note into the PR body (phase 4 of #1480)", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup(READY_PLAN_WITH_OVERSIZE_ESTIMATE);
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      const call = JSON.parse(ghLog[0]);
      const bodyIdx = call.indexOf("--body");
      const body = call[bodyIdx + 1];
      assert.match(body, /## Size estimate/u);
      assert.match(body, /Oversize: justified — one cohesive migration; no clean seam to split on/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a plan without a Size estimate section still promotes (optional; omitted from the PR body)", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup(READY_PLAN);
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      const call = JSON.parse(ghLog[0]);
      const bodyIdx = call.indexOf("--body");
      const body = call[bodyIdx + 1];
      assert.doesNotMatch(body, /## Size estimate/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("partial-state re-run: plan already committed at HEAD with no PR recovers (no git_commit_failed)", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      const branch = "promote-plan/phase-x";
      const { spawnSync } = await import("node:child_process");
      const sh = (args) => {
        const r = spawnSync("git", args, { cwd: repoDir, env: ghStub.env, encoding: "utf8" });
        assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      };
      // Simulate a prior partial run: the plan doc is committed on the head
      // branch, but no PR was opened and no prNumber was written back. This is
      // exactly the dead-end state the bug produced (re-run would have hit
      // git_commit_failed on an empty index).
      // Leave the repo on the head branch (where a mid-promote failure strands
      // it) with the plan committed and the prNumber unwritten.
      sh(["checkout", "-q", "-b", branch]);
      sh(["add", "--", planPath]);
      sh(["commit", "-q", "-m", "docs(plan): promote docs/phases/phase-x.md"]);

      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "promote");
      assert.equal(parsed.prNumber, 321);

      // It recovered: pushed the branch, opened the PR, wrote the link.
      const remoteRefs = spawnSync("git", ["ls-remote", "--heads", "origin"], { cwd: repoDir, env: ghStub.env, encoding: "utf8" }).stdout;
      // String-based check (no RegExp built from the interpolated branch name).
      assert.ok(
        remoteRefs.split("\n").some((line) => line.endsWith(`refs/heads/${branch}`)),
        `remote missing refs/heads/${branch}: ${remoteRefs}`,
      );
      const written = await readFile(planPath, "utf8");
      assert.match(written, /^---\nprNumber: 321\n---\n/u);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(ghLog.length, 1, `expected one gh call, got: ${ghLog.join(" | ")}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: a push failure surfaces git_push_failed and opens no PR", async () => {
    // No remote configured, so `git push -u origin <branch>` fails — the
    // pre-PR push must fail-closed before any gh mutation.
    const { tempDir, repoDir, planPath, ghStub } = await setup(READY_PLAN, [PR_CREATE_ENTRY], { withRemote: false });
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "git_push_failed");
      assert.ok(parsed.detail && parsed.detail.length > 0, "git_push_failed must carry a detail");

      // Zero gh mutation: the PR is never opened when the push fails.
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("partial state: push succeeds but gh pr create fails surfaces pr_create_failed with a recovery hint, then a re-run recovers", async () => {
    // First run: real remote present (push succeeds), but gh exits non-zero on
    // `pr create` — the now-primary residual partial state (plan committed +
    // branch pushed, no PR). It must fail-closed (exit 1, pr_create_failed) yet
    // carry the recoverable hint, and a plain re-run with a working gh must
    // recover to ok and open exactly one PR.
    const { tempDir, repoDir, planPath, ghStub } = await setup(READY_PLAN, [
      { assertArgs: ["pr", "create", "--draft"], exitCode: 1, stderr: "gh: pr create boom\n" },
    ]);
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "pr_create_failed");
      assert.equal(parsed.branch, "promote-plan/phase-x");
      // The recovery hint says a re-run recovers (idempotent commit-skip + push).
      assert.match(parsed.recovery, /Re-run promote-plan to recover/u);
      assert.match(parsed.recovery, /idempotent/u);

      const { spawnSync } = await import("node:child_process");
      // The branch WAS pushed before the PR-create failure.
      const remoteRefs = spawnSync("git", ["ls-remote", "--heads", "origin"], { cwd: repoDir, env: ghStub.env, encoding: "utf8" }).stdout;
      assert.match(remoteRefs, /refs\/heads\/promote-plan\/phase-x$/mu);
      // No link written: the PR never opened.
      const afterFail = await readFile(planPath, "utf8");
      assert.doesNotMatch(afterFail, /prNumber:/u);

      // Re-run with a gh stub that now succeeds on `pr create`, against the same
      // repo (partial state on disk). It must recover to ok and open one PR.
      const { mkdir } = await import("node:fs/promises");
      const stub2Dir = path.join(tempDir, "stub2");
      await mkdir(stub2Dir, { recursive: true });
      const recoverStub = await writeGhStub(stub2Dir, [PR_CREATE_ENTRY], { logCalls: true });
      const rerun = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: recoverStub.env,
      });
      assert.equal(rerun.code, 0, rerun.stderr);
      const reparsed = JSON.parse(rerun.stdout);
      assert.equal(reparsed.ok, true);
      assert.ok(reparsed.action === "promote" || reparsed.action === "already_promoted", `unexpected action ${reparsed.action}`);
      assert.equal(reparsed.prNumber, 321);
      // Exactly one PR opened on the recovering run.
      const ghLog = (await readFile(recoverStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      assert.equal(ghLog.length, 1, `expected one gh call on recovery, got: ${ghLog.join(" | ")}`);
      const written = await readFile(planPath, "utf8");
      assert.match(written, /^---\nprNumber: 321\n---\n/u);
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

  test("fail closed: a git diff error (exit >1) surfaces git_diff_failed and opens no PR", async () => {
    const { tempDir, repoDir, planPath } = await setup();
    try {
      // Inject a runChildFn that returns success for every git step EXCEPT
      // `git diff --cached --quiet`, which exits 128 (a real git error, not the
      // 0/1 nothing-staged/staged signal). The explicit-code handling must
      // fail-closed with git_diff_failed rather than misread 128 as "staged"
      // and attempt a misleading commit.
      let chunks = [];
      const stdout = { write: (s) => chunks.push(s) };
      const fakeRunChild = async (cmd, args) => {
        if (cmd === "git" && args[0] === "diff" && args.includes("--cached") && args.includes("--quiet")) {
          return { code: 128, stdout: "", stderr: "fatal: not a git repository (diff boom)" };
        }
        if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { code: 0, stdout: `${repoDir}\n`, stderr: "" };
        }
        // checkout, branch verify, add, etc. all succeed up to the diff step.
        return { code: 0, stdout: "", stderr: "" };
      };
      const summary = await runCli(["--plan-file", planPath, "--json"], {
        stdout,
        runChildFn: fakeRunChild,
        env: process.env,
      });
      assert.equal(summary.ok, false);
      assert.equal(summary.reason, "git_diff_failed");
      assert.match(summary.detail, /exited 128/u);
      assert.match(summary.detail, /diff boom/u);
      // No PR-create child ran: the JSON summary carries no prNumber.
      assert.equal(summary.prNumber, undefined);
      // runCli sets process.exitCode on fail-closed; reset it so the in-process
      // test does not mark the whole test process as failed.
      process.exitCode = 0;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects missing --plan-file", async () => {
    const result = await runNode(cliPath, [], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --plan-file/u);
  });

  // ── --base resolution (#1368) ─────────────────────────────────────────────

  test("no --base and no .devloops: resolves via resolveBaseBranch to the repo's auto-detected default branch (unset-no-regression)", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      // gitInit() creates the repo on "main" — auto-detect must land on "main",
      // the same value the prior hardcoded default always used.
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      const call = JSON.parse(ghLog[0]);
      const baseIdx = call.indexOf("--base");
      assert.notEqual(baseIdx, -1, `expected --base in gh call: ${call.join(" ")}`);
      assert.equal(call[baseIdx + 1], "main");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("configured workflow.baseBranch (.devloops) flows through to the create-pr --base when --base is omitted", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      await writeFile(
        path.join(repoDir, ".devloops"),
        "version: 1\nworkflow:\n  baseBranch: integration/develop\n",
        "utf8",
      );
      const result = await runNode(cliPath, ["--plan-file", planPath, "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      const call = JSON.parse(ghLog[0]);
      const baseIdx = call.indexOf("--base");
      assert.notEqual(baseIdx, -1, `expected --base in gh call: ${call.join(" ")}`);
      // gh/PR base is the bare configured name — no origin/ prefix (that
      // prefix is worktree-creation-only; see ensure-worktree.mjs).
      assert.equal(call[baseIdx + 1], "integration/develop");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("an explicit --base still wins over both config and auto-detect", async () => {
    const { tempDir, repoDir, planPath, ghStub } = await setup();
    try {
      await writeFile(
        path.join(repoDir, ".devloops"),
        "version: 1\nworkflow:\n  baseBranch: integration/develop\n",
        "utf8",
      );
      const result = await runNode(cliPath, ["--plan-file", planPath, "--base", "explicit-override", "--json"], {
        cwd: repoDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const ghLog = (await readFile(ghStub.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
      const call = JSON.parse(ghLog[0]);
      const baseIdx = call.indexOf("--base");
      assert.equal(call[baseIdx + 1], "explicit-override");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
