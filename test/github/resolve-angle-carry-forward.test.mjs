import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCarryForwardPlan,
  main,
  parseResolveAngleCarryForwardCliArgs,
} from "../../scripts/github/resolve-angle-carry-forward.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// Run the CLI main() against a repoRoot and return the parsed JSON result it
// writes to stdout (default emitResult mode).
async function runMain(argv, { repoRoot }) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await main(argv, { repoRoot });
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join(""));
}

// Run main() capturing stdout+stderr and the exit code, WITHOUT parsing — for the
// fail-closed paths where main writes an error and sets process.exitCode = 1.
async function runMainRaw(argv, { repoRoot }) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exitCode;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  process.exitCode = 0;
  try {
    await main(argv, { repoRoot });
    return { stdout: out.join(""), stderr: err.join(""), exitCode: process.exitCode };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
  }
}

async function makeCarryForwardRepo({ mandatoryAngles = [], perAngle, mutate }) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "carry-forward-cli-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  await writeFile(
    path.join(repoRoot, ".devloops.yaml"),
    `version: 1\ngates:\n  draft:\n    mandatoryAngles: ${JSON.stringify(mandatoryAngles)}\n`,
    "utf8",
  );
  const base = {
    "src/foo.mjs": "export function foo() { return 1; }\n",
    "docs/guide.md": "# Guide\n",
  };
  for (const [rel, content] of Object.entries(base)) {
    const abs = path.join(repoRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const prevHead = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();

  await mutate(repoRoot);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "delta"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();

  // Prior CLEAN findings-log recorded at prevHead.
  const logPath = path.join(repoRoot, buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: prevHead, tmpRoot: "tmp" }));
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    headSha: prevHead,
    verdict: "clean",
    provenance: { distinctReviewers: perAngle.length, perAngle },
  }), "utf8");

  return { repoRoot, prevHead, headSha };
}

const cleanLog = {
  headSha: "aaaaaaa",
  verdict: "clean",
  provenance: {
    distinctReviewers: 3,
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "coverage", reviewer: "review-b" },
      { angle: "docs", reviewer: "review-c" },
    ],
  },
};

test("buildCarryForwardPlan carries code angles on a doc-only delta, marks provenance honestly", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["docs/guide.md"] });
  assert.equal(plan.prevHead, "aaaaaaa");
  const carriedAngles = plan.carried.map((c) => c.angle).sort();
  assert.deepEqual(carriedAngles, ["correctness", "coverage"]);
  // Carried verdict records the prior head + the prior reviewer (not fabricated).
  const correctness = plan.carried.find((c) => c.angle === "correctness");
  assert.equal(correctness.carriedFromHead, "aaaaaaa");
  assert.equal(correctness.reviewer, "review-a");
  // docs angle's surface changed -> must re-run.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle), ["docs"]);
});

test("buildCarryForwardPlan carries the FULL reviewer identity (dispatchId/model), not just reviewer", () => {
  // Prior entry recorded its identity under dispatchId (no `reviewer`) — the
  // provenance contract counts dispatchId as a reviewer identity, so the carried
  // entry must preserve it or distinctReviewers breaks at the new head.
  const log = {
    headSha: "aaaaaaa",
    verdict: "clean",
    provenance: {
      distinctReviewers: 2,
      perAngle: [
        { angle: "correctness", dispatchId: "dispatch-42", model: "opus" },
        { angle: "docs", reviewer: "review-c" },
      ],
    },
  };
  const plan = buildCarryForwardPlan({ log, changedFiles: ["docs/guide.md"] });
  const correctness = plan.carried.find((c) => c.angle === "correctness");
  assert.equal(correctness.carriedFromHead, "aaaaaaa");
  assert.equal(correctness.dispatchId, "dispatch-42");
  assert.equal(correctness.model, "opus");
  assert.ok(!("reviewer" in correctness), "no fabricated reviewer when the prior entry had none");
});

test("buildCarryForwardPlan re-runs code angles but carries the docs angle on a code delta", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["src/foo.mjs"] });
  // Code delta touches correctness + coverage surfaces; docs surface untouched.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle).sort(), ["correctness", "coverage"]);
  assert.deepEqual(plan.carried.map((c) => c.angle), ["docs"]);
});

test("buildCarryForwardPlan fails closed on a non-clean or missing prior log", () => {
  assert.throws(() => buildCarryForwardPlan({ log: null, changedFiles: ["docs/x.md"] }), /not found or unreadable/);
  assert.throws(
    () => buildCarryForwardPlan({ log: { ...cleanLog, verdict: "findings_present" }, changedFiles: ["docs/x.md"] }),
    /not "clean"/,
  );
  assert.throws(
    () => buildCarryForwardPlan({ log: { headSha: "aaaaaaa", verdict: "clean", provenance: { distinctReviewers: 0, perAngle: [] } }, changedFiles: ["docs/x.md"] }),
    /no provenance\.perAngle reviewers/,
  );
});

test("buildCarryForwardPlan never carries an alwaysRerun angle even when the delta is outside its surface", () => {
  // `docs` surface is `docs`; a code-only delta does not touch it, so it would
  // carry — but passing it in alwaysRerun (a configured mandatory angle) forces
  // it to re-run.
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["src/foo.mjs"], alwaysRerun: ["docs"] });
  assert.ok(!plan.carried.some((c) => c.angle === "docs"), "docs must not be carried");
  assert.ok(plan.mustRerun.some((m) => m.angle === "docs"), "docs must re-run (mandatory)");
});

test("CLI loads the gate's configured mandatoryAngles and never carries them (fail-closed hole)", async () => {
  // `docs` is configured mandatory; the delta is code-only (outside docs' surface),
  // so without loading mandatoryAngles docs would be CARRIED. It must re-run.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: ["docs"],
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "docs", reviewer: "review-c" },
    ],
    mutate: async (root) => {
      await writeFile(path.join(root, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    },
  });
  try {
    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    const carried = result.carried.map((c) => c.angle);
    const rerun = result.mustRerun.map((m) => m.angle);
    assert.ok(!carried.includes("docs"), "configured mandatory docs must NOT be carried");
    assert.ok(rerun.includes("docs"), "configured mandatory docs must re-run");
    assert.ok(rerun.includes("correctness"), "code delta touches correctness surface");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI forces the RENAME_ONLY angles to re-run when the delta contains a rename", async () => {
  // Pure rename of a doc file: classifying the destination path alone would only
  // implicate docs; the rename must force scope/correctness/contract-surface/link-check too.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [
      { angle: "scope", reviewer: "review-a" },
      { angle: "correctness", reviewer: "review-b" },
      { angle: "coverage", reviewer: "review-c" },
    ],
    mutate: async (root) => {
      git(root, ["mv", "docs/guide.md", "docs/handbook.md"]);
    },
  });
  try {
    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    const rerun = result.mustRerun.map((m) => m.angle);
    const carried = result.carried.map((c) => c.angle);
    // RENAME_ONLY-mapped angles present in the prior log must re-run.
    assert.ok(rerun.includes("scope"), "rename forces scope");
    assert.ok(rerun.includes("correctness"), "rename forces correctness");
    // coverage is not RENAME_ONLY-mapped and its surface (test/code) is untouched → carries.
    assert.ok(carried.includes("coverage"), "coverage carries (not a rename angle, surface untouched)");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI fails closed when --head-sha does not match the worktree HEAD (wrong worktree)", async () => {
  const { repoRoot, prevHead } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [{ angle: "correctness", reviewer: "review-a" }],
    mutate: async (root) => {
      await writeFile(path.join(root, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    },
  });
  try {
    // A syntactically valid SHA that is NOT the worktree HEAD → delta would resolve
    // against the wrong head while the plan claims to be for this --head-sha.
    const bogusHead = "0".repeat(40);
    const { stdout, stderr, exitCode } = await runMainRaw([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", bogusHead,
    ], { repoRoot });
    assert.equal(exitCode, 1, "must fail closed");
    assert.equal(stdout, "", "no carry-forward plan is emitted on mismatch");
    // stderr may also carry ambient git warnings under the test env's GIT_CONFIG,
    // so match the fail-closed error substring rather than JSON-parsing the stream.
    assert.match(stderr, /"ok":false/);
    assert.match(stderr, /does not match --head-sha/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("parseResolveAngleCarryForwardCliArgs requires the core args", () => {
  assert.throws(() => parseResolveAngleCarryForwardCliArgs(["--repo", "o/n"]), /Missing required arguments/);
  const opts = parseResolveAngleCarryForwardCliArgs([
    "--repo", "o/n", "--pr", "5", "--gate", "draft_gate", "--prev-head", "aaaaaaa", "--head-sha", "bbbbbbb",
  ]);
  assert.equal(opts.gate, "draft_gate");
  assert.equal(opts.prevHead, "aaaaaaa");
  assert.equal(opts.headSha, "bbbbbbb");
});
