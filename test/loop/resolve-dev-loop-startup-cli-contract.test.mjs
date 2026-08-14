import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolverTestEnv, writeGhStub } from "../_helpers.mjs";
import { RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "loop", "resolve-dev-loop-startup.mjs");

const BASE_PLAN = [
  "# my plan",
  "",
  "## Status",
  "",
  "in progress",
  "",
  "## Objective",
  "",
  "Prove the thing works.",
  "",
  "## In scope",
  "",
  "- the bounded slice",
  "",
  "## Explicit non-goals",
  "",
  "- no broad rewrite",
  "",
].join("\n");

const REFINEMENT_SECTIONS = [
  "## Acceptance criteria",
  "",
  "- it works",
  "",
  "## Definition of done",
  "",
  "- merged + green",
  "",
].join("\n");

async function withInputFile(input, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-cli-contract-"));
  const inputPath = path.join(tmpDir, "startup-input.json");
  await writeFile(inputPath, JSON.stringify(input));
  try {
    return await fn(inputPath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("resolve-dev-loop-startup help documents accepted flags and JSON contracts", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage:\n  resolve-dev-loop-startup\.mjs --issue <number>/);
  assert.match(result.stdout, /--issue <n>\s+Target an issue/);
  assert.match(result.stdout, /--pr <n>\s+Target a PR/);
  assert.match(result.stdout, /--input <path>\s+Path to a JSON file/);
  assert.match(result.stdout, /--plan-file <path>\s+Path to a phase-doc-format plan/);
  assert.match(result.stdout, /--spike <path>\s+Path to a spike artifact/);
  assert.match(result.stdout, /Exit codes:\n  0  Success\n  1  Argument error, runtime failure, or async-start contract rejection/);
});

test("resolve-dev-loop-startup success stdout keeps documented JSON shape", async () => {
  // Use a complete retrospective so route resolves (not blocked by enforcement).
  await withInputFile({
    currentState: {
      target: { kind: "issue", issue: 429 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "authorized",
    },
    artifactState: "not_applicable",
    issueLinkageResolution: "resolved_no_open_pr",
    issueReadiness: "ready",
    issueAssignmentState: "unassigned",
    loopState: "active",
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      // An isolated, non-repo cwd (no `.devloops`) rather than repoRoot: this
      // repo's own `.devloops` sets `workflow.requireRetrospective: true`
      // (pinned in resolve-dev-loop-startup.test.mjs), which would make the
      // resolver run a live git ancestry check against this worktree's own
      // history for the retrospective gate — an ambient dependency this test
      // must never have. (The retrospectiveCheckpointState in the input above
      // is not authoritative either way — the resolver always recomputes it —
      // but an isolated cwd keeps that recomputation itself hermetic: no
      // checkpoint file, no config opting into the ancestry check.)
      cwd: tmpDir,
      encoding: "utf8",
      env: { ...process.env, ...resolverTestEnv() },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed), [
      "ok",
      "bundleKind",
      "selectedStrategy",
      "requiredReads",
      "nextAction",
      "canonicalStateSummary",
      "bundle",
    ]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "issue_intake");
    assert.deepEqual(parsed.requiredReads, [
      "skills/docs/public-dev-loop-contract.md",
      "skills/docs/retrospective-checkpoint-contract.md",
      "skills/copilot-pr-followup/SKILL.md",
      "skills/docs/copilot-loop-operations.md",
      "skills/docs/issue-intake-procedure.md",
    ]);
    assert.deepEqual(Object.keys(parsed.canonicalStateSummary), [
      "target",
      "ownership",
      "nextActor",
      "status",
      "authorization",
      "artifactState",
      "issueLinkageResolution",
      "loopState",
      "routeKind",
      "selectedGate",
      "executionMode",
      "waitSemantics",
      "requiresAsyncDispatch",
    ]);
    assert.equal(parsed.canonicalStateSummary.requiresAsyncDispatch, true);
    assert.equal(parsed.bundle.contractTrace.decision.selectedGate, "issue_intake");
  });
});

test("resolve-dev-loop-startup rejects async-required strategy via stderr contract", async () => {
  // This test verifies the CLI-level async-start contract:
  // without DEVLOOPS_RUN_ID or an allowed asyncStartMode setting, an async-required
  // route exits 1 with empty stdout and the rejection object on stderr.
  await withInputFile({
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
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      // Isolated cwd, not repoRoot — see the identical note in the previous
      // test: repoRoot's own `.devloops` opts into the live retrospective
      // query, which this test must not depend on.
      cwd: tmpDir,
      encoding: "utf8",
      // Deliberately omit every async-context signal so both the rejection
      // path AND its exact reason are exercised hermetically — independent of
      // the ambient harness. CLAUDECODE would relax the contract (#830);
      // DEVLOOPS_DETACHED would switch validateAsyncStartContext to a
      // different rejection-reason branch.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            !RUN_ID_MARKERS.includes(k) &&
            k !== "CLAUDECODE" &&
            k !== "DEVLOOPS_DETACHED",
        ),
      ),
    });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.equal(result.stdout, "", `expected empty stdout, got: ${result.stdout}`);

    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.asyncStartContract, "rejected");
    assert.ok(parsed.error.includes("async context"));
  });
});

test("resolve-dev-loop-startup honors maintainer-controlled asyncStartMode=allowed from cwd config", async () => {
  await withInputFile({
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
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    await mkdir(path.join(tmpDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\nworkflow:\n  asyncStartMode: allowed\n",
      "utf8",
    );

    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: tmpDir,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k !== "DEVLOOPS_RUN_ID",
        ),
      ),
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    if (result.stderr !== "") {
      assert.match(result.stderr, /DEV_LOOP_ROUTING_CONFIG_FALLBACK/);
    }
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.selectedStrategy, "copilot_pr_followup");
  });
});

async function withPlanFile(markdown, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-plan-file-"));
  const planPath = path.join(tmpDir, "plan.md");
  await writeFile(planPath, markdown, "utf8");
  try {
    return await fn(planPath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("--plan-file with a valid base plan resolves to a local_phase bundle with no issue/PR", async () => {
  await withPlanFile(BASE_PLAN, async (planPath, tmpDir) => {
    // A gh stub on PATH with logCalls lets us assert the read-only contract:
    // the plan-file path must make ZERO gh calls (no tracker mutation, no reads).
    // repeatLastOnOverflow keeps the stub from exiting before it logs, so any
    // attempted call is recorded — an empty log then proves zero invocations.
    const { env, ghLogPath } = await writeGhStub(tmpDir, [{ stdout: "{}\n" }], {
      logCalls: true,
      repeatLastOnOverflow: true,
    });

    const result = spawnSync(process.execPath, [cliPath, "--plan-file", planPath], {
      // Run from a plain (non-worktree) dir to exercise the worktree-guard exemption.
      cwd: tmpDir,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    // Exempt from the worktree guard: stays local_implementation, never needs_reconcile.
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.planFileIntakeState, "new_plan_needs_refinement");
    const target = parsed.canonicalStateSummary.target;
    assert.equal(target.kind, "local_phase");
    assert.equal(target.issue, null);
    assert.equal(target.pr, null);
    assert.equal(target.phase, planPath);

    // No-tracker-mutation: gh was never invoked on the plan-file path.
    const log = await readFile(ghLogPath, "utf8");
    assert.equal(log.trim(), "", `expected zero gh calls, got: ${log}`);
  });
});

test("--input cannot inject planFileExempt to bypass the worktree-isolation guard", async () => {
  // Untrusted external --input must not be able to set the resolver-only intake
  // fields. A local_implementation route from a non-worktree dir must still hit
  // the worktree guard even though the input file sets planFileExempt: true.
  await withInputFile({
    planFileExempt: true,
    planFileIntakeState: "plan_refined_ready_for_promotion",
    spikeIntakeState: "spike_ready_for_exit",
    currentState: {
      target: { kind: "local_branch", branch: "feature/inject" },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "not_applicable",
    loopState: "active",
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    const parsed = JSON.parse(result.stdout || result.stderr);
    // Exemption was stripped: the worktree-isolation guard fires (not a clean
    // resolved/exempted bundle), and no injected intake state leaks through.
    assert.notEqual(parsed.bundleKind, "resolved");
    assert.match(parsed.nextAction || "", /worktree/i);
    assert.equal(parsed.planFileIntakeState, undefined);
    // The spike intake field is a resolver-only output too: untrusted --input
    // must not be able to inject it.
    assert.equal(parsed.spikeIntakeState, undefined);
  });
});

test("--plan-file carrying AC + DoD resolves to plan_refined_ready_for_promotion", async () => {
  await withPlanFile(`${BASE_PLAN}\n${REFINEMENT_SECTIONS}`, async (planPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--plan-file", planPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.planFileIntakeState, "plan_refined_ready_for_promotion");
  });
});

test("--plan-file with only one refinement section is unsupported intake input", async () => {
  // Base + Acceptance criteria but no Definition of done: the intake state machine
  // fails closed (ambiguous) rather than guessing refine-vs-promote.
  const partial = `${BASE_PLAN}\n## Acceptance criteria\n\n- it works\n`;
  await withPlanFile(partial, async (planPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--plan-file", planPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.planFileIntakeState, "ambiguous_fail_closed");
  });
});

test("--plan-file pointing at a missing file fails closed (exit 1, no bundle)", () => {
  const result = spawnSync(process.execPath, [cliPath, "--plan-file", "/nonexistent/plan.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing or unreadable/i);
});

test("--plan-file failing base validation fails closed (exit 1, no bundle)", async () => {
  await withPlanFile("# incomplete\n\n## Status\n\nopen\n", async (planPath) => {
    const result = spawnSync(process.execPath, [cliPath, "--plan-file", planPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /failed validation/i);
  });
});

const BASE_SPIKE = [
  "# my spike",
  "",
  "## Question",
  "",
  "Can we use approach X to solve Y?",
  "",
  "## Approach",
  "",
  "- prototype the call path",
  "",
  "## Findings",
  "",
  "- X works but is slow",
  "",
  "## Recommendation",
  "",
  "- adopt X with a cache",
  "",
].join("\n");

// A spike carrying the exploration scaffold (Question/Approach/Findings) with no
// Recommendation section yet: a valid artifact that is still in progress.
const SPIKE_IN_PROGRESS = [
  "# my spike",
  "",
  "## Question",
  "",
  "Can we use approach X to solve Y?",
  "",
  "## Approach",
  "",
  "- prototype the call path",
  "",
  "## Findings",
  "",
  "- exploring",
  "",
].join("\n");

async function withSpikeFile(markdown, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-spike-file-"));
  const spikePath = path.join(tmpDir, "spike.md");
  await writeFile(spikePath, markdown, "utf8");
  try {
    return await fn(spikePath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("--spike with a complete spike artifact resolves to a local_phase bundle with no issue/PR", async () => {
  await withSpikeFile(BASE_SPIKE, async (spikePath, tmpDir) => {
    // gh stub on PATH proves the read-only contract: the spike path makes ZERO
    // gh calls (no tracker artifact, no tracker mutation) at entry.
    const { env, ghLogPath } = await writeGhStub(tmpDir, [{ stdout: "{}\n" }], {
      logCalls: true,
      repeatLastOnOverflow: true,
    });

    const result = spawnSync(process.execPath, [cliPath, "--spike", spikePath], {
      // Run from a plain (non-worktree) dir to exercise the worktree-guard exemption.
      cwd: tmpDir,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    // Exempt from the worktree guard: stays local_implementation, never needs_reconcile.
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "local_implementation");
    assert.equal(parsed.spikeIntakeState, "spike_ready_for_exit");
    const target = parsed.canonicalStateSummary.target;
    assert.equal(target.kind, "local_phase");
    assert.equal(target.issue, null);
    assert.equal(target.pr, null);
    assert.equal(target.phase, spikePath);

    // Zero tracker artifacts at entry: gh was never invoked on the spike path.
    const log = await readFile(ghLogPath, "utf8");
    assert.equal(log.trim(), "", `expected zero gh calls, got: ${log}`);
  });
});

test("--spike with an in-progress spike (no recommendation) resolves to spike_in_progress", async () => {
  await withSpikeFile(SPIKE_IN_PROGRESS, async (spikePath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--spike", spikePath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.spikeIntakeState, "spike_in_progress");
  });
});

test("--spike pointing at a missing file fails closed (exit 1, no bundle)", () => {
  const result = spawnSync(process.execPath, [cliPath, "--spike", "/nonexistent/spike.md"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /missing or unreadable/i);
});

test("--spike with a malformed spike artifact fails closed (exit 1, no bundle)", async () => {
  await withSpikeFile("# incomplete\n\n## Question\n\nwhat?\n", async (spikePath) => {
    const result = spawnSync(process.execPath, [cliPath, "--spike", spikePath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /failed validation/i);
  });
});

test("--spike is mutually exclusive with --issue and --plan-file", async () => {
  await withSpikeFile(BASE_SPIKE, async (spikePath) => {
    const withIssue = spawnSync(process.execPath, [cliPath, "--spike", spikePath, "--issue", "511"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(withIssue.status, 1);
    assert.match(withIssue.stderr, /mutually exclusive/i);

    const withPlanFile = spawnSync(process.execPath, [cliPath, "--spike", spikePath, "--plan-file", "p.md"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(withPlanFile.status, 1);
    assert.match(withPlanFile.stderr, /mutually exclusive/i);
  });
});

test("resolve-dev-loop-startup malformed args keep documented stderr JSON shape", () => {
  const result = spawnSync(process.execPath, [cliPath, "--bogus"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const parsed = JSON.parse(result.stderr);
  assert.deepEqual(Object.keys(parsed), ["ok", "error", "hint"]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "Unknown argument: --bogus");
  assert.equal(parsed.hint, "run with --help for usage");
});
