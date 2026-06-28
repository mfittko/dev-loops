import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  buildResolveDevLoopStartupResult,
  buildAutoResolvedInput,
  parseResolveDevLoopStartupCliArgs,
  summarizeCanonicalState,
} from "../../scripts/loop/resolve-dev-loop-startup.mjs";

const scriptPath = path.resolve("scripts/loop/resolve-dev-loop-startup.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

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
  });
  assert.deepEqual(parseResolveDevLoopStartupCliArgs(["--help"]), {
    help: true,
    inputPath: undefined,
    issue: undefined,
    pr: undefined,
    planFile: undefined,
    spike: undefined,
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
    result = buildResolveDevLoopStartupResult(null, { env: { DEVLOOPS_WORKTREE_BYPASS: "1" } });
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
  }, { env: { DEVLOOPS_WORKTREE_BYPASS: "1" } });

  assert.equal(result.bundleKind, "resolved");
  assert.equal(result.selectedStrategy, "local_implementation");
  assert.deepEqual(result.requiredReads, [
    "skills/docs/public-dev-loop-contract.md",
    "skills/local-implementation/SKILL.md",
  ]);
  assert.equal(result.canonicalStateSummary.target.kind, "local_branch");
  assert.equal(result.canonicalStateSummary.routeKind, "route");
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
  }, { env: { DEVLOOPS_RUN_ID: "test-run-123" }, cwd: os.tmpdir() });

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
      { env: { DEVLOOPS_RUN_ID: "test-run-123" }, cwd: tempDir },
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
      { env: { DEVLOOPS_RUN_ID: "test-run-123" }, cwd: tempDir },
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
      { env: { DEVLOOPS_RUN_ID: "test-run-123" }, cwd: tempDir },
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
      { env: { DEVLOOPS_RUN_ID: "test-run-123" }, cwd: tempDir },
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
    { env: {} },
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
    { env: { DEVLOOPS_RUN_ID: "test-run-123" } },
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
    { env: {}, asyncStartMode: "allowed" },
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
    { env: { DEVLOOPS_WORKTREE_BYPASS: "1" } },
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
      DEVLOOPS_WORKTREE_BYPASS: "1",
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
      DEVLOOPS_RUN_ID: "test-run-123",
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

test("buildAutoResolvedInput returns warnings array for failed detection", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
    const result = buildAutoResolvedInput({ issue: 999999, cwd: tmp });
    assert.equal(result.intent, "start_issue_locally");
    assert.equal(result.artifactState, "not_applicable");
    assert.equal(result.issueLinkageResolution, "resolved_no_open_pr");
    assert.equal(result.issueReadiness, "needs_clarification");
    assert.equal(result.issueAssignmentState, "unassigned");
    assert.equal(result.loopState, "issue_intake_start");
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.length >= 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput sets linkedPr null when detection fails", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
    const result = buildAutoResolvedInput({ issue: 999999, cwd: tmp });
    assert.equal(result.currentState.target.linkedPr, null);
    assert.equal(result.issueLinkageResolution, "resolved_no_open_pr");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput for PR returns pr_followup_start", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
    const result = buildAutoResolvedInput({ pr: 999999, cwd: tmp });
    assert.equal(result.intent, "continue_on_pr");
    assert.equal(result.loopState, "pr_followup_start");
    assert.equal(result.artifactState, "open");
    assert.equal(result.currentState.target.kind, "pr");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput returns valid targetPreference", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
    const result = buildAutoResolvedInput({ issue: 999999, cwd: tmp });
    assert.ok(
      result.targetPreference === "prefer_local" || result.targetPreference === "prefer_github_first",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput with local-first tracker source keeps issue-backed startup state", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
    const result = buildAutoResolvedInput({
      issue: 999999,
      cwd: tmp,
      targetPreference: "prefer_local",
      inputSource: "tracker",
    });
    assert.equal(result.currentState.target.kind, "issue");
    assert.equal(result.loopState, "issue_intake_start");
    assert.equal(result.issueLinkageResolution, "resolved_no_open_pr");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildAutoResolvedInput with local-first phase-doc source uses local_phase startup state", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dev-loop-511-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: tmp, stdio: "ignore" });
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
      "version: 1\nstrategy:\n  default: local-first\ninputSource:\n  default: phase-docs\n",
      "utf8",
    );

    const ghStub = await writeGhStubHelper(tempDir, []);
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: {
        ...ghStub.env,
        DEVLOOPS_WORKTREE_BYPASS: "1",
      },
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
      "version: 1\ninputSource:\n  default: phase-docs\n",
      "utf8",
    );

    // Logging stub: any gh invocation appends to the log.
    const ghStub = await writeGhStubHelper(tempDir, [], { logCalls: true });
    const result = await runNode(["--issue", "511"], {
      cwd: tempDir,
      env: { ...ghStub.env, DEVLOOPS_WORKTREE_BYPASS: "1" },
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
    // Stub gh pr view to return Copilot author
    const ghStub = await writeGhStubHelper(tempDir, [
      { assertArgs: ["pr", "view", "740"], stdout: JSON.stringify({ author: { login: "copilot-swe-agent" }, state: "OPEN" }) },
    ]);
    const result = await runNode(["--issue", "735"], {
      cwd: tempDir,
      env: {
        ...ghStub.env,
        DEVLOOPS_WORKTREE_BYPASS: "1",
        DEVLOOPS_RUN_ID: "test-run-copilot-author",
      },
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
    ]);
    const result = await runNode(["--issue", "735"], {
      cwd: tempDir,
      env: {
        ...ghStub.env,
        DEVLOOPS_WORKTREE_BYPASS: "1",
        DEVLOOPS_RUN_ID: "test-run-external-author",
      },
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
