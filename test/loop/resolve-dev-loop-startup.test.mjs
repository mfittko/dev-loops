import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { resolverTestEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  buildResolveDevLoopStartupResult,
  buildAutoResolvedInput,
  parseResolveDevLoopStartupCliArgs,
  summarizeCanonicalState,
  resolveIssuelessLightweightEligibility,
} from "../../scripts/loop/resolve-dev-loop-startup.mjs";

const scriptPath = path.resolve("scripts/loop/resolve-dev-loop-startup.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// Build a throwaway git repo carrying the standard origin remote ONCE, then
// stamp per-test copies by cloning the .git dir on disk (no git subprocess per
// test). buildAutoResolvedInput still shells out to git to read the remote, so
// the git-remote-detection boundary stays exercised — only the identical repo
// setup is amortized.
let originRepoTemplate = null;
function stampRepoWithOrigin() {
  if (originRepoTemplate === null) {
    const template = mkdtempSync(path.join(os.tmpdir(), "dev-loop-origin-template-"));
    execFileSync("git", ["init"], { cwd: template, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: template, stdio: "ignore" });
    originRepoTemplate = template;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  cpSync(path.join(originRepoTemplate, ".git"), path.join(tmp, ".git"), { recursive: true });
  return tmp;
}
after(() => {
  if (originRepoTemplate) rmSync(originRepoTemplate, { recursive: true, force: true });
});

async function writeTempJson(tempDir, name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
}

test("parseResolveDevLoopStartupCliArgs rejects missing --input", () => {
  assert.throws(() => parseResolveDevLoopStartupCliArgs([]), /--input .* is required/i);
});

test("parseResolveDevLoopStartupCliArgs parses --input and --help", () => {
  assert.deepEqual(parseResolveDevLoopStartupCliArgs(["--input", "state.json"]), {
    help: false,
    inputPath: "state.json",
    issue: undefined,
    pr: undefined,
    planFile: undefined,
    spike: undefined,
    lightweight: false,
    uiReview: false,
  });
  assert.deepEqual(parseResolveDevLoopStartupCliArgs(["--help"]), {
    help: true,
    inputPath: undefined,
    issue: undefined,
    pr: undefined,
    planFile: undefined,
    spike: undefined,
    lightweight: false,
    uiReview: false,
  });
});

test("parseResolveDevLoopStartupCliArgs parses --issue", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--issue", "511"]);
  assert.equal(opts.help, false);
  assert.equal(opts.inputPath, undefined);
  assert.equal(opts.issue, 511);
  assert.equal(opts.pr, undefined);
});

test("parseResolveDevLoopStartupCliArgs parses --pr", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--pr", "507"]);
  assert.equal(opts.help, false);
  assert.equal(opts.inputPath, undefined);
  assert.equal(opts.issue, undefined);
  assert.equal(opts.pr, 507);
});

test("parseResolveDevLoopStartupCliArgs parses --pr --ui-review", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--pr", "507", "--ui-review"]);
  assert.equal(opts.help, false);
  assert.equal(opts.pr, 507);
  assert.equal(opts.uiReview, true);
});

test("parseResolveDevLoopStartupCliArgs rejects --ui-review without --pr", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--ui-review"]),
    /--ui-review is only valid with --pr/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --ui-review combined with --issue/--input/--plan-file/--spike", () => {
  for (const args of [
    ["--issue", "511", "--ui-review"],
    ["--input", "state.json", "--ui-review"],
    ["--plan-file", "p.md", "--ui-review"],
    ["--spike", "s.md", "--ui-review"],
  ]) {
    assert.throws(
      () => parseResolveDevLoopStartupCliArgs(args),
      /--ui-review is only valid with --pr/i,
      `expected rejection for ${JSON.stringify(args)}`,
    );
  }
});

test("parseResolveDevLoopStartupCliArgs rejects --issue combined with --pr", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--issue", "511", "--pr", "507"]),
    /mutually exclusive/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --issue combined with --input", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--issue", "511", "--input", "state.json"]),
    /mutually exclusive/i,
  );
});

test("parseResolveDevLoopStartupCliArgs parses --plan-file", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--plan-file", "docs/phases/foo.md"]);
  assert.equal(opts.help, false);
  assert.equal(opts.planFile, "docs/phases/foo.md");
  assert.equal(opts.issue, undefined);
  assert.equal(opts.pr, undefined);
  assert.equal(opts.inputPath, undefined);
});

test("parseResolveDevLoopStartupCliArgs rejects --plan-file combined with --issue", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--plan-file", "p.md", "--issue", "511"]),
    /mutually exclusive/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --plan-file combined with --pr and --input", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--plan-file", "p.md", "--pr", "7"]),
    /mutually exclusive/i,
  );
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--plan-file", "p.md", "--input", "s.json"]),
    /mutually exclusive/i,
  );
});

test("parseResolveDevLoopStartupCliArgs parses --spike", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--spike", "docs/spikes/foo.md"]);
  assert.equal(opts.help, false);
  assert.equal(opts.spike, "docs/spikes/foo.md");
  assert.equal(opts.issue, undefined);
  assert.equal(opts.pr, undefined);
  assert.equal(opts.inputPath, undefined);
  assert.equal(opts.planFile, undefined);
});

test("parseResolveDevLoopStartupCliArgs rejects --spike combined with --issue or --plan-file", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--spike", "s.md", "--issue", "511"]),
    /mutually exclusive/i,
  );
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--spike", "s.md", "--plan-file", "p.md"]),
    /mutually exclusive/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --issue with non-integer value", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--issue", "abc"]),
    /must be a positive integer/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --issue missing value", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--issue"]),
    /Missing value for --issue/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects no input mode", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs([]),
    /--input.*--issue.*--pr|required/i,
  );
});

test("buildResolveDevLoopStartupResult normalizes a null input instead of throwing", () => {
  // `--input null` is legal JSON; the resolver-only field destructure must not
  // throw a TypeError before routing can fail closed.
  let result;
  assert.doesNotThrow(() => {
    result = buildResolveDevLoopStartupResult(null, { env: resolverTestEnv() });
  });
  assert.ok(result && typeof result === "object");
  assert.ok(typeof result.bundleKind === "string");
});

test("buildResolveDevLoopStartupResult maps local implementation to the local route pack", () => {
  const result = buildResolveDevLoopStartupResult({
    currentState: {
      target: { kind: "local_branch", branch: "feature/local-route" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "not_applicable",
    loopState: "active",
  }, { env: resolverTestEnv() });

  assert.equal(result.bundleKind, "resolved");
  assert.equal(result.selectedStrategy, "local_implementation");
  assert.deepEqual(result.requiredReads, [
    "skills/docs/public-dev-loop-contract.md",
    "skills/local-implementation/SKILL.md",
  ]);
  assert.equal(result.canonicalStateSummary.target.kind, "local_branch");
  assert.equal(result.canonicalStateSummary.routeKind, "route");
});

test("buildResolveDevLoopStartupResult maps the ui-review intent to the ui-review route pack without throwing on the new key", () => {
  const result = buildResolveDevLoopStartupResult({
    intent: "review_pr_ui",
    currentState: {
      target: { kind: "pr", pr: 1234 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "authorized",
    },
    artifactState: "open",
    loopState: "pr_ui_review_start",
  }, { env: resolverTestEnv(), cwd: os.tmpdir() });

  assert.equal(result.bundleKind, "resolved");
  assert.equal(result.selectedStrategy, "ui_review");
  assert.deepEqual(result.requiredReads, [
    "skills/docs/public-dev-loop-contract.md",
    "skills/ui-review/SKILL.md",
  ]);
  assert.equal(result.canonicalStateSummary.target.kind, "pr");
  assert.equal(result.canonicalStateSummary.requiresAsyncDispatch, false);
});

test("buildResolveDevLoopStartupResult maps linked Copilot follow-up to the PR follow-up route pack", () => {
  const result = buildResolveDevLoopStartupResult({
    currentState: {
      target: { kind: "issue", issue: 89, linkedPr: 92 },
      ownership: "copilot",
      nextActor: "copilot",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "open",
    issueLinkageResolution: "resolved_linked_pr",
    loopState: "unresolved_feedback_present",
  }, { env: resolverTestEnv(), cwd: os.tmpdir() });

  assert.equal(result.bundleKind, "resolved");
  assert.equal(result.selectedStrategy, "copilot_pr_followup");
  assert.deepEqual(result.requiredReads, [
    "skills/docs/public-dev-loop-contract.md",
    "skills/docs/retrospective-checkpoint-contract.md",
    "skills/copilot-pr-followup/SKILL.md",
    "skills/docs/copilot-loop-operations.md",
  ]);
  assert.equal(result.canonicalStateSummary.target.kind, "pr");
  assert.equal(result.canonicalStateSummary.target.pr, 92);
});

test("buildResolveDevLoopStartupResult returns reconcile reads when authoritative issue linkage is missing", () => {
  const result = buildResolveDevLoopStartupResult({
    currentState: {
      target: { kind: "issue", issue: 93 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "not_applicable",
    loopState: "active",
  });

  assert.equal(result.bundleKind, "needs_reconcile");
  assert.equal(result.selectedStrategy, "none");
  assert.deepEqual(result.requiredReads, ["skills/docs/public-dev-loop-contract.md"]);
  assert.match(result.nextAction, /reconcile/i);
  assert.equal(result.canonicalStateSummary.loopState, "unknown");
});

test("summarizeCanonicalState keeps the public status summary fields stable", () => {
  const summary = summarizeCanonicalState({
    canonicalState: {
      target: { kind: "pr", issue: 12, pr: 34 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "open",
    issueLinkageResolution: "not_applicable",
    loopState: "waiting_for_human_pr_approval",
    routeKind: "route",
    selectedGate: "final_approval",
    executionMode: "bounded_handoff",
    waitSemantics: "default",
  });

  assert.deepEqual(summary, {
    target: { kind: "pr", issue: 12, pr: 34 },
    ownership: "copilot",
    nextActor: "user",
    status: "active",
    authorization: "needs_confirmation",
    artifactState: "open",
    issueLinkageResolution: "not_applicable",
    loopState: "waiting_for_human_pr_approval",
    routeKind: "route",
    selectedGate: "final_approval",
    executionMode: "bounded_handoff",
    waitSemantics: "default",
    requiresAsyncDispatch: false,
  });
});

test("resolve-dev-loop-startup CLI emits stable JSON for a final-approval route", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const inputPath = await writeTempJson(tempDir, "startup.json", {
      currentState: {
        target: { kind: "pr", issue: 89, pr: 92 },
        ownership: "copilot",
        nextActor: "user",
        status: "approval_ready",
        authorization: "needs_confirmation",
      },
      artifactState: "open",
      issueLinkageResolution: "not_applicable",
      gateReviewEvidence: {
        currentHeadSha: "abc1234",
        preApprovalGate: {
          visible: true,
          headSha: "abc1234",
          verdict: "clean",
        },
      },
      loopState: "waiting_for_human_pr_approval",
    });

    const result = await runNode(["--input", inputPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "final_approval");
    assert.deepEqual(parsed.requiredReads, [
      "skills/docs/public-dev-loop-contract.md",
      "skills/docs/retrospective-checkpoint-contract.md",
      "skills/copilot-pr-followup/SKILL.md",
      "skills/docs/copilot-loop-operations.md",
      "skills/final-approval/SKILL.md",
    ]);
    assert.equal(parsed.canonicalStateSummary.target.kind, "pr");
    assert.equal(parsed.canonicalStateSummary.selectedGate, "final_approval");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildResolveDevLoopStartupResult auto-injects retrospectiveCheckpointState from file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    // Create a .pi/dev-loop-retrospective-checkpoint.json in temp dir
    // with state "required" — the durable artifact for pending retrospective.
    const piDir = path.join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required" }),
      "utf8",
    );

    // Run via CLI with CWD set to temp dir
    const inputPath = await writeTempJson(tempDir, "startup.json", {
      currentState: {
        target: { kind: "local_branch", branch: "feature/local-route" },
        ownership: "local",
        nextActor: "local",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "not_applicable",
      loopState: "active",
    });

    const result = await runNode(["--input", inputPath], { cwd: tempDir });

    // The resolver auto-reads the checkpoint file, maps "required" → "missing",
    // and returns needs_reconcile because the retrospective is pending.
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundleKind, "needs_reconcile");
    assert.equal(parsed.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildResolveDevLoopStartupResult fails closed when no checkpoint file exists and cwd is not a worktree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const inputPath = await writeTempJson(tempDir, "startup.json", {
      currentState: {
        target: { kind: "local_branch", branch: "feature/local-route" },
        ownership: "local",
        nextActor: "local",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "not_applicable",
      loopState: "active",
    });

    const result = await runNode(["--input", inputPath], { cwd: tempDir });

    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundleKind, "needs_reconcile");
    assert.equal(parsed.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});



test("buildResolveDevLoopStartupResult maps durable-artifact 'required' to checkpoint state 'missing'", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const piDir = path.join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required" }),
      "utf8",
    );

    // Use the programmatic API with a valid Pi-managed run id to test the state mapping
    // without triggering async-start rejection.
    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_branch", branch: "feature/local-route" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "needs_confirmation",
        },
        artifactState: "not_applicable",
        loopState: "active",
      },
      { env: resolverTestEnv(), cwd: tempDir },
    );

    // The resolver auto-reads the checkpoint file and maps "required" → "missing".
    // A missing retrospective checkpoint causes the resolver to return needs_reconcile
    // regardless of the route type — the retrospective must be completed first.
    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "needs_reconcile");
    assert.equal(result.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildResolveDevLoopStartupResult overrides caller-provided state with on-disk 'required'", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const piDir = path.join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required" }),
      "utf8",
    );

    // Caller tries to provide "complete" — should be overridden by on-disk "required".
    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_branch", branch: "feature/local-route" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "needs_confirmation",
        },
        artifactState: "not_applicable",
        loopState: "active",
        retrospectiveCheckpointState: "complete",
      },
      { env: resolverTestEnv(), cwd: tempDir },
    );

    // On-disk "required" overrides caller-provided "complete". The resolver
    // returns needs_reconcile because the retrospective is still pending.
    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "needs_reconcile");
    assert.equal(result.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("buildResolveDevLoopStartupResult fails closed when checkpoint file is malformed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const piDir = path.join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    // Write malformed JSON (not valid JSON at all)
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      "this is not valid json {{{{{",
      "utf8",
    );

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_branch", branch: "feature/local-route" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "needs_confirmation",
        },
        artifactState: "not_applicable",
        loopState: "active",
      },
      { env: resolverTestEnv(), cwd: tempDir },
    );

    // Malformed file -> fail closed with missing checkpoint state -> needs_reconcile.
    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "needs_reconcile");
    assert.equal(result.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildResolveDevLoopStartupResult fails closed when checkpoint file has unrecognized state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-startup-"));
  try {
    const piDir = path.join(tempDir, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "bogus_unknown_state" }),
      "utf8",
    );

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_branch", branch: "feature/local-route" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "needs_confirmation",
        },
        artifactState: "not_applicable",
        loopState: "active",
      },
      { env: resolverTestEnv(), cwd: tempDir },
    );

    // Unrecognized state -> fail closed with missing -> needs_reconcile.
    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "needs_reconcile");
    assert.equal(result.selectedStrategy, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildResolveDevLoopStartupResult rejects async-required strategy without DEVLOOPS_RUN_ID", () => {
  const result = buildResolveDevLoopStartupResult(
    {
      currentState: {
        target: { kind: "issue", issue: 89, linkedPr: 92 },
        ownership: "copilot",
        nextActor: "copilot",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "open",
      issueLinkageResolution: "resolved_linked_pr",
      loopState: "unresolved_feedback_present",
    },
    { env: resolverTestEnv({ DEVLOOPS_RUN_ID: undefined }) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.asyncStartContract, "rejected");
  assert.ok(result.error.includes("async context"));
});

test("buildResolveDevLoopStartupResult allows async-required strategy with DEVLOOPS_RUN_ID", () => {
  const result = buildResolveDevLoopStartupResult(
    {
      currentState: {
        target: { kind: "issue", issue: 89, linkedPr: 92 },
        ownership: "copilot",
        nextActor: "copilot",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "open",
      issueLinkageResolution: "resolved_linked_pr",
      loopState: "unresolved_feedback_present",
    },
    { env: resolverTestEnv() },
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedStrategy, "copilot_pr_followup");
});

test("buildResolveDevLoopStartupResult allows async-required strategy when asyncStartMode=allowed", () => {
  const result = buildResolveDevLoopStartupResult(
    {
      currentState: {
        target: { kind: "issue", issue: 89, linkedPr: 92 },
        ownership: "copilot",
        nextActor: "copilot",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "open",
      issueLinkageResolution: "resolved_linked_pr",
      loopState: "unresolved_feedback_present",
    },
    { env: resolverTestEnv({ DEVLOOPS_RUN_ID: undefined }), asyncStartMode: "allowed" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedStrategy, "copilot_pr_followup");
});

test("buildResolveDevLoopStartupResult does not enforce async-start on local_implementation", () => {
  const result = buildResolveDevLoopStartupResult(
    {
      currentState: {
        target: { kind: "local_branch", branch: "feature/local-route" },
        ownership: "local",
        nextActor: "local",
        status: "active",
        authorization: "needs_confirmation",
      },
      artifactState: "not_applicable",
      loopState: "active",
    },
    { env: resolverTestEnv() },
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedStrategy, "local_implementation");
});

// ---------------------------------------------------------------------------
// #497: Worktree isolation enforcement for local_implementation
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory structure that simulates a git repo with
 * a worktree under tmp/worktrees/. Also creates a fake git script that
 * returns the expected `git worktree list` output.
 */
function writeWorktreeEnv(tempDir) {
  const worktreeDir = path.join(tempDir, "tmp", "worktrees", "issue-test");
  mkdirSync(worktreeDir, { recursive: true });

  const actualTemp = realpathSync(tempDir);
  const actualWorktree = realpathSync(worktreeDir);

  const gitPath = path.join(tempDir, "git");
  const worktreeListOut = `${actualTemp}  535a18a [main]\n${actualWorktree}  535a18a [issue-test]`;
  const lines = [
    "#!/usr/bin/env sh",
    'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
    `  cat <<'WTEOF'`,
    worktreeListOut,
    "WTEOF",
    "fi",
    "exit 0",
  ];
  writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });

  return { tempDir, worktreeDir, gitPath };
}

test("resolver returns needs_reconcile for local_implementation from main checkout", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-main-"));
  try {
    writeWorktreeEnv(tempDir);
    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
    };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_phase", issue: 497, phase: "issue-497" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
        loopState: "implementation_pending",
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
      },
      { env, cwd: tempDir },
    );

    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "needs_reconcile");
    assert.equal(result.selectedStrategy, "none");
    assert.ok(
      result.nextAction.includes("worktree isolation"),
      `nextAction should mention worktree isolation, got: ${result.nextAction}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── nextAction worktree hint: workflow.baseBranch (#1368) ─────────────────

test("resolver's worktree nextAction hint omits --base when workflow.baseBranch is unset (no-regression)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-base-unset-"));
  try {
    writeWorktreeEnv(tempDir);
    const env = { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}` };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_phase", issue: 497, phase: "issue-497" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
        loopState: "implementation_pending",
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
      },
      { env, cwd: tempDir, config: { version: 1 } },
    );

    assert.equal(result.ok, true);
    assert.match(result.nextAction, /ensure-worktree\.mjs --repo-root \S+ --issue <n>`/);
    assert.doesNotMatch(result.nextAction, /--base/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver's worktree nextAction hint includes --base origin/<baseBranch> when configured", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-base-set-"));
  try {
    writeWorktreeEnv(tempDir);
    const env = { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}` };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_phase", issue: 497, phase: "issue-497" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
        loopState: "implementation_pending",
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
      },
      { env, cwd: tempDir, config: { version: 1, workflow: { baseBranch: "spike/shakapacker-to-vite" } } },
    );

    assert.equal(result.ok, true);
    assert.match(
      result.nextAction,
      /ensure-worktree\.mjs --repo-root \S+ --issue <n> --base origin\/spike\/shakapacker-to-vite`/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver resolves normally for local_implementation from worktree", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-wt-"));
  try {
    const { worktreeDir } = writeWorktreeEnv(tempDir);
    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
    };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_phase", issue: 497, phase: "issue-497" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
        loopState: "implementation_pending",
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
      },
      { env, cwd: worktreeDir },
    );

    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "resolved");
    assert.equal(result.selectedStrategy, "local_implementation");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver bypasses worktree check with DEVLOOPS_WORKTREE_BYPASS=1 from main checkout", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-bypass-"));
  try {
    writeWorktreeEnv(tempDir);
    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
      ...resolverTestEnv(),
    };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "local_phase", issue: 497, phase: "issue-497" },
          ownership: "local",
          nextActor: "local",
          status: "active",
          authorization: "authorized",
        },
        loopState: "implementation_pending",
        artifactState: "not_applicable",
        issueLinkageResolution: "not_applicable",
      },
      { env, cwd: tempDir },
    );

    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "resolved");
    assert.equal(result.selectedStrategy, "local_implementation");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver does not block non-local_implementation strategies from main checkout", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "resolver-nonlocal-"));
  try {
    writeWorktreeEnv(tempDir);
    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH || ""}`,
      ...resolverTestEnv(),
    };

    const result = buildResolveDevLoopStartupResult(
      {
        currentState: {
          target: { kind: "issue", issue: 89, linkedPr: 92 },
          ownership: "copilot",
          nextActor: "copilot",
          status: "active",
          authorization: "needs_confirmation",
        },
        artifactState: "open",
        issueLinkageResolution: "resolved_linked_pr",
        loopState: "unresolved_feedback_present",
      },
      { env, cwd: tempDir },
    );

    assert.equal(result.ok, true);
    assert.equal(result.bundleKind, "resolved");
    assert.equal(result.selectedStrategy, "copilot_pr_followup");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The next few tests deliberately target a nonexistent issue/PR (999999) with
// NO gh stub: the real `gh` binary fails every read against it, so the
// ownership gate's assignees read defaults to an empty list (today's
// warn+default posture for that READ) and the gate — which applies uniformly
// regardless of why the artifact looks unassigned — then fails closed with
// the not-claimed error (#1377). These pin that fail-closed shape; the
// warnings-array and linkage-default assertions these tests used to make on a
// successful return now live on the copilot/external-author tests below,
// which stub the assignment read to reach a normal return.
test("buildAutoResolvedInput fails closed (not-claimed) when the issue read fails and defaults to unassigned", () => {
  const tmp = stampRepoWithOrigin();
  try {
    assert.throws(
      () => buildAutoResolvedInput({ issue: 999999, cwd: tmp }),
      /Issue #999999 is not claimed by any contributor.*edit-issue\.mjs.*--issue 999999 --add-assignee @me/s,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput for a PR fails closed (not-claimed) when the PR read fails and defaults to unassigned", () => {
  const tmp = stampRepoWithOrigin();
  try {
    assert.throws(
      () => buildAutoResolvedInput({ pr: 999999, cwd: tmp }),
      /PR #999999 is not claimed by any contributor.*edit-pr\.mjs.*--pr 999999 --add-assignee @me/s,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput with local-first tracker source still hits the ownership gate (fails closed, not a phase-doc bypass)", () => {
  const tmp = stampRepoWithOrigin();
  try {
    // inputSource "tracker" (vs "phase-docs") keeps this on the issue-backed
    // path where the ownership gate applies — proving the tracker source
    // itself doesn't bypass the gate.
    assert.throws(
      () => buildAutoResolvedInput({
        issue: 999999,
        cwd: tmp,
        targetPreference: "prefer_local",
        inputSource: "tracker",
      }),
      /Issue #999999 is not claimed by any contributor/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput with local-first phase-doc source uses local_phase startup state", () => {
  const tmp = stampRepoWithOrigin();
  try {
    const result = buildAutoResolvedInput({
      issue: 999999,
      cwd: tmp,
      targetPreference: "prefer_local",
      inputSource: "phase-docs",
    });
    assert.equal(result.currentState.target.kind, "local_phase");
    assert.equal(result.currentState.target.phase, "issue-999999");
    assert.equal(result.loopState, "implementation_pending");
    assert.equal(result.issueLinkageResolution, "not_applicable");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCli --issue uses config inputSource=phase-docs to choose phase-doc local startup path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-phase-doc-input-source-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\nstrategy: local-first\ninputSource: phase-docs\n",
      "utf8",
    );

    const ghStub = await writeGhStubHelper(tempDir, []);
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.bundle.issueLinkageResolution, "not_applicable");
    assert.match(parsed.bundle.nextAction, /current branch or phase slice/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// resolveTargetPreference (the raw .devloops/.pi scraper) must recognize both
// the canonical "tracker-first" value (#1408 rename) and the deprecated
// "github-first" alias as the tracker-first posture. Proven the same way as
// the local-first/phase-docs test above, but INVERTED: with strategy set to
// either value, targetPreference resolves to prefer_github_first (not
// prefer_local), so the phase-docs local-startup SHORT-CIRCUIT above must NOT
// fire — the tracker-read path runs instead (gh IS called, and
// issueLinkageResolution advances past "not_applicable").
for (const strategyValue of ["tracker-first", "github-first"]) {
  test(`runCli --issue recognizes strategy: ${strategyValue} as the tracker-first posture (#1408)`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-tracker-first-strategy-"));
    try {
      execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
      await mkdir(path.join(tempDir, "scripts", "github"), { recursive: true });
      await writeFile(
        path.join(tempDir, "scripts/github/detect-linked-issue-pr.mjs"),
        'process.stdout.write(JSON.stringify({ ok: true, repo: "mfittko/dev-loops", issue: 511, hasOpenLinkedPr: false, prNumber: null }));',
        "utf8",
      );
      await writeFile(
        path.join(tempDir, ".devloops"),
        `version: 1\nstrategy: ${strategyValue}\ninputSource: phase-docs\n`,
        "utf8",
      );

      const ghStub = await writeGhStubHelper(tempDir, [], { repeatLastOnOverflow: true, logCalls: true });
      const result = await runNode(["--issue", "511"], {
        cwd: tempDir,
        // resolverTestEnv() satisfies the async-start contract explicitly (CI
        // has no ambient run-id marker; without it the CLI fails closed and
        // the tracker-read path is never reached).
        env: { ...ghStub.env, ...resolverTestEnv() },
      });

      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      // Reached the tracker-read path, not the local-phase short-circuit
      // (which would leave this "not_applicable" and make zero gh calls).
      assert.equal(parsed.bundle.issueLinkageResolution, "resolved_no_open_pr");
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.notEqual(ghLog.trim(), "", "expected the tracker-read path to call gh, not short-circuit to local_phase");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("local-first phase-doc intake fires no tracker artifact / Copilot call before promotion (#953 AC3)", async () => {
  // local-first comes from the shipped extension defaults (settings only sets
  // inputSource), proving the low-noise intake holds with the shipped posture.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-953-ac3-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\ninputSource: phase-docs\n",
      "utf8",
    );

    // Logging stub: any gh invocation appends to the log.
    const ghStub = await writeGhStubHelper(tempDir, [], { logCalls: true });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.bundle.issueLinkageResolution, "not_applicable");

    // Zero tracker side effects during intake. The stub is scripted with an
    // empty sequence and exits non-zero on ANY gh invocation, so `result.code
    // === 0` above already proves intake made no gh call at all — and therefore
    // no `gh issue/pr create` and no Copilot dispatch. The empty call log is the
    // direct evidence of that property (mirrors the P3/P4 refine/promote tests).
    const ghLog = await readFile(ghStub.ghLogPath, "utf8");
    assert.equal(ghLog.trim(), "", `local-first intake made no gh call; got: ${ghLog}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput detects Copilot authorship from linked PR author", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-copilot-author-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
    // Create the detect-linked-issue-pr script path so the subprocess can resolve
    await mkdir(path.join(tempDir, "scripts", "github"), { recursive: true });
    await writeFile(
      path.join(tempDir, "scripts/github/detect-linked-issue-pr.mjs"),
      'process.stdout.write(JSON.stringify({ ok: true, repo: "mfittko/dev-loops", issue: 735, hasOpenLinkedPr: true, prNumber: 740 }));',
      "utf8",
    );
    // Stub gh pr view to return Copilot author. The ownership gate also reads
    // the issue's own assignees + viewer login (order-independent "claims"
    // matching): stub it as assigned to the viewer so the gate passes and the
    // linked-PR authorship path below is reached.
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["pr", "view", "740"], stdout: JSON.stringify({ author: { login: "copilot-swe-agent" }, state: "OPEN" }) },
      { assertArgs: ["issue", "view", "735", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "test-viewer" }] }) },
      { assertArgs: ["issue", "view", "735", "body"], stdout: JSON.stringify({ body: "" }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "735"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_RUN_ID: "test-run-copilot-author" }) },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    // Ownership should be copilot since the PR author is copilot-swe-agent
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "copilot_pr_followup");
    assert.equal(parsed.canonicalStateSummary.ownership, "copilot");
    assert.equal(parsed.canonicalStateSummary.nextActor, "copilot");
    // PR target should be the linked PR number (transformed from issue+linkedPr)
    assert.equal(parsed.canonicalStateSummary.target.pr, 740);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput detects external_human authorship from linked PR author", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-external-author-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
    await mkdir(path.join(tempDir, "scripts", "github"), { recursive: true });
    await writeFile(
      path.join(tempDir, "scripts/github/detect-linked-issue-pr.mjs"),
      'process.stdout.write(JSON.stringify({ ok: true, repo: "mfittko/dev-loops", issue: 735, hasOpenLinkedPr: true, prNumber: 740 }));',
      "utf8",
    );
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["pr", "view", "740"], stdout: JSON.stringify({ author: { login: "some-human-dev" }, state: "OPEN" }) },
      { assertArgs: ["issue", "view", "735", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "test-viewer" }] }) },
      { assertArgs: ["issue", "view", "735", "body"], stdout: JSON.stringify({ body: "" }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "735"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_RUN_ID: "test-run-external-author" }) },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "external_pr_followup");
    assert.equal(parsed.canonicalStateSummary.ownership, "external_human");
    assert.equal(parsed.canonicalStateSummary.nextActor, "external_human");
    assert.equal(parsed.canonicalStateSummary.target.pr, 740);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Single-contributor ownership gate (issue #1377): unassigned work is
// impossible by construction — the resolver requires assigned_to_me and
// fails closed on anything else (assigned_to_other, unassigned), naming a
// distinct remedy in each case. assigned_to_copilot keeps its existing flow.
// ---------------------------------------------------------------------------

async function initRepoWithOrigin(tempDir) {
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
}

// Shadow detect-linked-issue-pr.mjs with a canned "no linked PR" result so the
// ownership-gate tests don't also need to stub that helper's own gh calls.
async function stubNoLinkedPr(tempDir, issue) {
  await mkdir(path.join(tempDir, "scripts", "github"), { recursive: true });
  await writeFile(
    path.join(tempDir, "scripts/github/detect-linked-issue-pr.mjs"),
    `process.stdout.write(JSON.stringify({ ok: true, repo: "mfittko/dev-loops", issue: ${issue}, hasOpenLinkedPr: false, prNumber: null }));`,
    "utf8",
  );
}

test("--issue assigned_to_other fails closed naming the foreign assignee (no readiness bundle)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-other-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "foreign-dev" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Issue #511 is assigned to foreign-dev, not the current viewer/);
    assert.match(result.stderr, /Have the owner unassign it, or pick a different item/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--issue: a claim-contested race's raced-past loser sees only the tiebreak winner and fails closed foreign (convergence backstop)", async () => {
  // Shape of the interleaving this pins: the pickup tiebreak winner removed
  // the loser's login (resolve-active-board-item.mjs), so by the time the
  // raced-past loser reaches its own startup gate, gh reports only the
  // winner as assignee — never both, never the loser itself.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-raced-past-loser-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "tiebreak-winner" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "raced-past-loser" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Issue #511 is assigned to tiebreak-winner, not the current viewer/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--issue unassigned fails closed naming the exact claim command (no readiness bundle)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-unassigned-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [] }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /Issue #511 is not claimed by any contributor.*Claim it first: node scripts\/github\/edit-issue\.mjs --repo mfittko\/dev-loops --issue 511 --add-assignee @me/s,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--issue assigned to the viewer (assigned_to_me) proceeds", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-me-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "test-viewer" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.selectedStrategy, "local_implementation");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("DEVLOOPS_OWNERSHIP_BYPASS=1 skips the ownership gate for read-only inspection (e.g. info.mjs)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-bypass-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    // Foreign-owned and unclaimed would normally fail closed; the bypass lets a
    // read-only preview through without ever calling gh api user.
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "foreign-dev" }] }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--issue assigned_to_copilot is unchanged: proceeds and never resolves a viewer login", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-copilot-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    // No "api user" entry at all: if the copilot short-circuit regressed and
    // the gate tried to resolve a viewer login anyway, the unmatched claims-mode
    // call would fail closed and this test would catch that regression.
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "copilot-swe-agent" }] }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--issue fails closed with a distinct reason when the viewer login cannot be resolved", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-viewer-fail-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "someone" }] }) },
      { assertArgs: ["api", "user"], exitCode: 1, stderr: "gh: not authenticated\n" },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unable to resolve the current GitHub viewer login/);
    assert.match(result.stderr, /cannot verify or claim single-contributor ownership/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr assigned_to_other fails closed naming the foreign assignee", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-other-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: "foreign-dev" }], closingIssuesReferences: [], body: "" }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /PR #740 is assigned to foreign-dev, not the current viewer/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr unassigned fails closed naming the exact claim command", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-unassigned-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [], closingIssuesReferences: [], body: "" }),
      },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /PR #740 is not claimed by any contributor.*Claim it first: node scripts\/github\/edit-pr\.mjs --repo mfittko\/dev-loops --pr 740 --add-assignee @me/s,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr assigned to the viewer proceeds", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-me-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: "test-viewer" }], closingIssuesReferences: [], body: "" }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    // Byte-unchanged plain --pr path (issue #1362): --ui-review must never
    // change the default routing outcome when the flag is absent.
    assert.equal(parsed.selectedStrategy, "copilot_pr_followup");
    assert.equal(parsed.canonicalStateSummary.loopState, "pr_followup_start");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr --ui-review routes to the ui_review strategy end-to-end (issue #1362)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ui-review-pr-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: "test-viewer" }], closingIssuesReferences: [], body: "" }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740", "--ui-review"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.selectedStrategy, "ui_review");
    assert.equal(parsed.canonicalStateSummary.loopState, "pr_ui_review_start");
    assert.equal(parsed.canonicalStateSummary.requiresAsyncDispatch, false);
    assert.deepEqual(parsed.requiredReads, [
      "skills/docs/public-dev-loop-contract.md",
      "skills/ui-review/SKILL.md",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr --ui-review still fails closed on foreign PR ownership (no bypass, issue #1362)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ui-review-pr-foreign-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: "foreign-dev" }], closingIssuesReferences: [], body: "" }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740", "--ui-review"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /PR #740 is assigned to foreign-dev, not the current viewer/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr assigned to copilot-swe-agent takes the unchanged copilot path, not the ownership error", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-copilot-"));
  try {
    await initRepoWithOrigin(tempDir);
    // No "api user" entry: a copilot assignee must never need the viewer login.
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: "copilot-swe-agent" }], closingIssuesReferences: [], body: "" }),
      },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("PR assigned to copilot skips the linked-issue ownership check entirely", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-copilot-linked-issue-"));
  try {
    await initRepoWithOrigin(tempDir);
    // Linked issue #511 is foreign-owned, but NO stub entry for its assignee
    // read and NO "api user" entry: a copilot-assigned PR must short-circuit
    // BEFORE the linked-issue loop, so neither gh call is ever made. If that
    // short-circuit regressed, the unstubbed claims-mode call would fail
    // closed and this test would catch it.
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          assignees: [{ login: "copilot-swe-agent" }],
          closingIssuesReferences: [{ number: 511 }],
          body: "",
        }),
      },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("viewer-login memo is reset per buildAutoResolvedInput invocation (no stale-viewer reuse across calls)", async () => {
  // In-process (not runNode/subprocess) on purpose: a subprocess pair resets
  // module state for free and would never exercise the memo bug this pins.
  // ghJson reads the AMBIENT process.env (not a passed env), so the two
  // in-process calls below swap process.env between them and restore it in
  // finally.
  const tempDirAlice = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-viewer-memo-alice-"));
  const tempDirBob = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-viewer-memo-bob-"));
  const savedEnv = { ...process.env };
  try {
    await initRepoWithOrigin(tempDirAlice);
    await initRepoWithOrigin(tempDirBob);
    await stubNoLinkedPr(tempDirAlice, 12);
    await stubNoLinkedPr(tempDirBob, 12);
    // Same issue #12, same assignee (alice) in both stubs — only the VIEWER
    // (gh api user) differs between the two calls.
    const ghStubAlice = await writeGhStubHelper(tempDirAlice, [
      { assertArgs: ["issue", "view", "12", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "alice" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "alice" }) },
    ], { matchMode: "claims" });
    const ghStubBob = await writeGhStubHelper(tempDirBob, [
      { assertArgs: ["issue", "view", "12", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "alice" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "bob" }) },
    ], { matchMode: "claims" });

    // Call 1: viewer is alice, issue #12 is assigned to alice -> sole owner,
    // proceeds. This memoizes "alice" as the viewer login (pre-fix behavior).
    Object.assign(process.env, ghStubAlice.env);
    const resultAlice = buildAutoResolvedInput({ issue: 12, cwd: tempDirAlice });
    assert.equal(resultAlice.currentState.target.issue, 12);
    assert.equal(resultAlice.issueAssignmentState, "unassigned"); // assigned_to_me maps to "unassigned" for the pure evaluator

    // Call 2: viewer is now bob, but the SAME issue #12 is still (only)
    // assigned to alice. Without resetting the memo, this call would reuse
    // the cached "alice" login (never calling `gh api user` at all, so
    // ghStubBob's "bob" answer would never even be consulted), classify
    // alice === alice as assigned_to_me, and wrongly proceed. With the reset,
    // it must resolve "bob" fresh and fail closed as foreign.
    Object.assign(process.env, ghStubBob.env);
    assert.throws(
      () => buildAutoResolvedInput({ issue: 12, cwd: tempDirBob }),
      /Issue #12 is assigned to alice, not the current viewer/,
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    await rm(tempDirAlice, { recursive: true, force: true });
    await rm(tempDirBob, { recursive: true, force: true });
  }
});

test("--issue co-assigned to the viewer AND another human is contested (assigned_to_other), not assigned_to_me", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-issue-contested-"));
  try {
    await initRepoWithOrigin(tempDir);
    await stubNoLinkedPr(tempDir, 511);
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "test-viewer" }, { login: "someone-else" }] }) },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    // foreignLogins excludes the viewer: only the other human is named.
    assert.match(result.stderr, /Issue #511 is assigned to someone-else, not the current viewer/);
    assert.doesNotMatch(result.stderr, /test-viewer/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr continuation fails closed when the PR's linked issue is assigned to another human", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-linked-issue-other-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          assignees: [{ login: "test-viewer" }],
          closingIssuesReferences: [{ number: 511 }],
          body: "",
        }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [{ login: "foreign-dev" }] }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /PR #740's linked issue #511 is assigned to foreign-dev, not the current viewer/);
    assert.match(result.stderr, /the issue owner owns the whole loop/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--pr continuation proceeds when the linked issue is merely unassigned (only foreign ownership blocks)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-ownership-pr-linked-issue-unassigned-"));
  try {
    await initRepoWithOrigin(tempDir);
    const ghStub = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "740"],
        stdout: JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          assignees: [{ login: "test-viewer" }],
          closingIssuesReferences: [{ number: 511 }],
          body: "",
        }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
      { assertArgs: ["issue", "view", "511", "assignees"], stdout: JSON.stringify({ assignees: [] }) },
    ], { matchMode: "claims" });
    const result = await runNode(["--pr", "740"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lightweight PR-body-as-spec modifier (issue #1025)
// ---------------------------------------------------------------------------

test("parseResolveDevLoopStartupCliArgs parses --lightweight as a modifier on --issue", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--issue", "1025", "--lightweight"]);
  assert.equal(opts.lightweight, true);
  assert.equal(opts.issue, 1025);
});

test("parseResolveDevLoopStartupCliArgs defaults lightweight to false", () => {
  assert.equal(parseResolveDevLoopStartupCliArgs(["--issue", "1025"]).lightweight, false);
});

test("parseResolveDevLoopStartupCliArgs rejects --lightweight combined with --plan-file (opposites)", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--plan-file", "p.md", "--lightweight"]),
    /opposites/i,
  );
});

test("parseResolveDevLoopStartupCliArgs rejects --lightweight without --issue", () => {
  assert.throws(
    () => parseResolveDevLoopStartupCliArgs(["--pr", "7", "--lightweight"]),
    /modifier for the --issue/i,
  );
});

test("parseResolveDevLoopStartupCliArgs accepts --lightweight ALONE (issue-less PR-first, #1210)", () => {
  const opts = parseResolveDevLoopStartupCliArgs(["--lightweight"]);
  assert.equal(opts.lightweight, true);
  assert.equal(opts.issue, undefined);
  assert.equal(opts.pr, undefined);
  assert.equal(opts.inputPath, undefined);
  assert.equal(opts.planFile, undefined);
  assert.equal(opts.spike, undefined);
});

test("buildResolveDevLoopStartupResult threads canonicalSpecSource:pr_body onto the result", () => {
  const input = {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    canonicalSpecSource: "pr_body",
    currentState: {
      target: { kind: "local_phase", issue: 1025, pr: null, linkedPr: null, branch: null, phase: "issue-1025" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
  const result = buildResolveDevLoopStartupResult(input, { env: resolverTestEnv() });
  assert.equal(result.selectedStrategy, "local_implementation");
  assert.equal(result.canonicalSpecSource, "pr_body");
});

test("buildResolveDevLoopStartupResult omits canonicalSpecSource on the default (non-lightweight) path", () => {
  const input = {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    currentState: {
      target: { kind: "local_phase", issue: 1025, pr: null, linkedPr: null, branch: null, phase: "issue-1025" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
  const result = buildResolveDevLoopStartupResult(input, { env: resolverTestEnv() });
  assert.equal("canonicalSpecSource" in result, false);
});

test("ADDITIVE: --lightweight only adds canonicalSpecSource; the rest of the resolver output is unchanged", () => {
  const baseInput = {
    intent: "start_issue_locally",
    mode: "bounded_handoff",
    targetPreference: "prefer_local",
    artifactState: "not_applicable",
    issueLinkageResolution: "not_applicable",
    issueReadiness: "not_applicable",
    issueAssignmentState: "not_applicable",
    loopState: "implementation_pending",
    currentState: {
      target: { kind: "local_phase", issue: 1025, pr: null, linkedPr: null, branch: null, phase: "issue-1025" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
    },
  };
  const opts = { env: resolverTestEnv() };
  const def = buildResolveDevLoopStartupResult(structuredClone(baseInput), opts);
  const lite = buildResolveDevLoopStartupResult({ ...structuredClone(baseInput), canonicalSpecSource: "pr_body" }, opts);
  assert.equal(lite.canonicalSpecSource, "pr_body");
  const liteNormalized = { ...lite };
  delete liteNormalized.canonicalSpecSource;
  assert.deepEqual(liteNormalized, def);
});

test("runCli --issue --lightweight threads canonicalSpecSource:pr_body onto the emitted result (end-to-end)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-lightweight-e2e-"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tempDir, stdio: "ignore" });
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    // phase-docs inputSource short-circuits buildAutoResolvedInput before any gh
    // call, so the empty gh stub (exits non-zero on any call) proves zero side effects.
    await writeFile(
      path.join(tempDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\nstrategy: local-first\ninputSource: phase-docs\n",
      "utf8",
    );
    const ghStub = await writeGhStubHelper(tempDir, []);
    const result = await runNode(["--issue", "1025", "--lightweight"], {
      cwd: tempDir,
      env: { ...ghStub.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.canonicalSpecSource, "pr_body");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function initTempGitRepo(tempDir) {
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir, stdio: "ignore" });
}

// Issue-less scope is measured merge-base(default branch)...working tree, so
// these fixtures put the change on a feature branch off main (matching the
// real PR-first shape): initial commit on main, then a feature branch.
async function initFeatureBranchRepo(tempDir) {
  initTempGitRepo(tempDir);
  await writeFile(path.join(tempDir, "a.txt"), "line1\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: tempDir, stdio: "ignore" });
}

test("runCli --lightweight ALONE (no --issue): light mode disabled fails closed with a distinct reason (AC2)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    initTempGitRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: false\n    maxFiles: 3\n    maxLines: 200\n",
      "utf8",
    );
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lightMode\.enabled/);
    assert.match(result.stderr, /localImplementation\.issueless/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE (no --issue): undetectable scope (no commits) fails closed with a distinct reason (AC2)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    initTempGitRepo(tempDir);
    // No commits at all: no default-branch merge-base is resolvable — undetectable scope.
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /measurable change scope/);
    assert.match(result.stderr, /localImplementation\.issueless/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE (no --issue): MULTI-COMMIT above-threshold branch fails closed even though the LAST commit is tiny (AC2, merge-base scoping)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 3\n",
      "utf8",
    );
    // Commit 1 on the branch is already over the 3-line threshold.
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\n", "utf8");
    execFileSync("git", ["commit", "-am", "big change"], { cwd: tempDir, stdio: "ignore" });
    // Commit 2 (the HEAD~1..HEAD diff) is a single line — a HEAD~1-only scope
    // measure would fail OPEN here; the merge-base measure must not.
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n", "utf8");
    execFileSync("git", ["commit", "-am", "tiny follow-up"], { cwd: tempDir, stdio: "ignore" });
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stay within the light-mode threshold/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE (no --issue): DIRTY-TREE above-threshold changes fail closed even with clean under-threshold commits (AC2, merge-base scoping)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 3\n",
      "utf8",
    );
    // One tiny committed change (under threshold on its own)...
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\n", "utf8");
    execFileSync("git", ["commit", "-am", "small committed change"], { cwd: tempDir, stdio: "ignore" });
    // ...plus a large UNCOMMITTED change: the working tree is part of the scope.
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\n", "utf8");
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stay within the light-mode threshold/);
    assert.match(result.stderr, /localImplementation\.issueless/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE (no --issue): invalid config fails closed naming the config failure, not light_mode_disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\nnot_a_real_key: true\n", "utf8");
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /config loading failed/);
    assert.doesNotMatch(result.stderr, /lightMode\.enabled/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE (no --issue): under-threshold change resolves issue-less PR-first (AC-adjacent success path)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 200\n",
      "utf8",
    );
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\n", "utf8");
    execFileSync("git", ["commit", "-am", "small change"], { cwd: tempDir, stdio: "ignore" });
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.canonicalSpecSource, "pr_body");
    assert.equal(parsed.canonicalStateSummary.target.issue, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE: issueless.enabled allows an OVER-threshold change (#1349 AC)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-optin-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 3\n  issueless: true\n",
      "utf8",
    );
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n", "utf8");
    execFileSync("git", ["commit", "-am", "big change"], { cwd: tempDir, stdio: "ignore" });
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.canonicalSpecSource, "pr_body");
    assert.equal(parsed.canonicalStateSummary.target.issue, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE: issueless.enabled allows startup even with lightMode disabled (#1349 full decoupling)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-optin-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: false\n    maxFiles: 3\n    maxLines: 200\n  issueless: true\n",
      "utf8",
    );
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\n", "utf8");
    execFileSync("git", ["commit", "-am", "small change"], { cwd: tempDir, stdio: "ignore" });
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.canonicalSpecSource, "pr_body");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --lightweight ALONE: issueless.enabled=false keeps the over-threshold fail-closed behavior (#1349 default unchanged)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-issueless-optin-"));
  try {
    await initFeatureBranchRepo(tempDir);
    await writeFile(
      path.join(tempDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 3\n  issueless: false\n",
      "utf8",
    );
    await writeFile(path.join(tempDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n", "utf8");
    execFileSync("git", ["commit", "-am", "big change"], { cwd: tempDir, stdio: "ignore" });
    const result = await runNode(["--lightweight"], { cwd: tempDir });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stay within the light-mode threshold/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveIssuelessLightweightEligibility scopes git merge-base/diff to the given cwd, not process.cwd() (review: bind cwd like other git calls in this file)", async () => {
  // Outer dir: a plain non-repo directory. If the merge-base/detectScope git
  // calls fell back to inheriting process.cwd() instead of the explicit cwd
  // param, running them from here would fail to find any default-branch ref.
  const outerDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-cwd-outer-"));
  // Inner dir: the actual small under-threshold repo the caller intends to target.
  const innerRepoDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-cwd-inner-"));
  const originalCwd = process.cwd();
  try {
    await initFeatureBranchRepo(innerRepoDir);
    await writeFile(path.join(innerRepoDir, "a.txt"), "line1\nline2\n", "utf8");
    execFileSync("git", ["commit", "-am", "small change"], { cwd: innerRepoDir, stdio: "ignore" });
    const config = {
      version: 1,
      localImplementation: { lightMode: { enabled: true, maxFiles: 3, maxLines: 200 } },
    };
    process.chdir(outerDir);
    const result = resolveIssuelessLightweightEligibility(config, innerRepoDir);
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(result.scope.filesChanged, 1);
  } finally {
    process.chdir(originalCwd);
    await rm(outerDir, { recursive: true, force: true });
    await rm(innerRepoDir, { recursive: true, force: true });
  }
});

// ── resolveIssuelessLightweightEligibility: workflow.baseBranch (#1368) ───

/**
 * A repo where "main" and a configured integration branch diverge enough that
 * measuring scope against one vs. the other flips eligibility:
 *   initial -> integration (BIG change, many lines) -> feature (small change)
 * "main" never advances past initial, so merge-base(main, feature) = initial
 * (diff includes the big integration change + the small one = over threshold).
 * merge-base(integration, feature) = the integration commit itself (diff is
 * only the small change = under threshold).
 */
async function initDivergedBaseBranchRepo(tempDir) {
  initTempGitRepo(tempDir);
  await writeFile(path.join(tempDir, "base.txt"), "line1\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "integration"], { cwd: tempDir, stdio: "ignore" });
  const bigLines = Array.from({ length: 10 }, (_, i) => `big-line-${i}\n`).join("");
  await writeFile(path.join(tempDir, "big.txt"), bigLines, "utf8");
  execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "big integration change"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: tempDir, stdio: "ignore" });
}

test("resolveIssuelessLightweightEligibility: unset workflow.baseBranch measures scope against the default-branch candidates (main) — over threshold", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-basebranch-unset-"));
  try {
    await initDivergedBaseBranchRepo(tempDir);
    await writeFile(path.join(tempDir, "small.txt"), "line1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "small feature change"], { cwd: tempDir, stdio: "ignore" });
    const config = {
      version: 1,
      localImplementation: { lightMode: { enabled: true, maxFiles: 3, maxLines: 5 } },
    };
    const result = resolveIssuelessLightweightEligibility(config, tempDir);
    // main never advanced past "initial": diff includes the big integration
    // change too, well over the 5-line threshold.
    assert.equal(result.eligible, false, JSON.stringify(result));
    assert.equal(result.reason, "over_threshold");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveIssuelessLightweightEligibility: configured workflow.baseBranch overrides the candidate list, flipping eligibility", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-basebranch-set-"));
  try {
    await initDivergedBaseBranchRepo(tempDir);
    await writeFile(path.join(tempDir, "small.txt"), "line1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "small feature change"], { cwd: tempDir, stdio: "ignore" });
    const config = {
      version: 1,
      workflow: { baseBranch: "integration" },
      localImplementation: { lightMode: { enabled: true, maxFiles: 3, maxLines: 5 } },
    };
    const result = resolveIssuelessLightweightEligibility(config, tempDir);
    // Measured against "integration" (the configured base), the diff is only
    // the small feature change — under the 5-line threshold.
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(result.scope.linesChanged, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli --input STRIPS an injected canonicalSpecSource (injection guard, end-to-end)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-injection-e2e-"));
  try {
    const inputPath = await writeTempJson(tempDir, "startup.json", {
      currentState: {
        target: { kind: "local_branch", branch: "feature/local-route" },
        ownership: "local",
        nextActor: "local",
        status: "active",
        authorization: "authorized",
      },
      artifactState: "not_applicable",
      loopState: "active",
      // Malicious untrusted field: must be stripped, never re-attached to output.
      canonicalSpecSource: "pr_body",
    });
    const result = await runNode(["--input", inputPath], {
      cwd: tempDir,
      env: { ...process.env, ...resolverTestEnv() },
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal("canonicalSpecSource" in parsed, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
