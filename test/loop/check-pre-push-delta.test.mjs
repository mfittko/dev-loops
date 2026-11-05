import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { readSequenceMarker, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";

import { DELTA_EVIDENCE_RULE, deltaPatchPath, gitStaleSurfaceHits, parseCheckPrePushDeltaArgs, runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { A, B, C, M, boundArgs, coverageRepo } from "./_delta-coverage-fixture.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { sealDeltaFixture } from "./_seal-fixture.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { decidePiToolCall } from "../../extension/readonly-role-gate.ts";

const ACT = { ref: "act-1", severity: "low", angle: "correctness", summary: "s", judgeDisposition: "act" };
const FP = fingerprintFinding(ACT);
const ACT_LIST = [{ ...ACT, fingerprint: FP }];
async function runCli(argv, seam) {
  const fixture = await boundArgs(argv, seam);
  return runDeltaCli(fixture.args, fixture.seam);
}

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-log-"));
// A findings log of the reviewed round at `head`, as the gate round writes it.
const logFor = (head) => {
  const p = path.join(LOG_DIR, `${head}.json`);
  fs.writeFileSync(p, JSON.stringify({ headSha: head, provenance: { perAngle: [{ angle: "correctness" }] } }));
  return p;
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const result = path.join(dir, "result.json");
  fs.writeFileSync(result, JSON.stringify({
    reviewBaselineHead: A,
    candidateHead: B,
    actSetId: startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId,
    actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }],
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
  }));
  return { dir, actList, result };
}

const quiet = { stdout: { write: () => {} } };
test("help describes authenticated closure as an alternative successful response", async () => {
  let help = "";
  await runDeltaCli(["--help"], { stdout: { write: (text) => { help += text; } } });
  assert.match(help, /"outcome": "no_commit\|head_moved", "nextStep": "push_to_gate"/);
  assert.match(help, /"reviewBaselineHead": "<baseline sha>", "candidateHead": "<current HEAD sha>"/);
  assert.match(help, /HEAD equal to baseline yields no_commit; otherwise HEAD differing from the authenticated handback yields head_moved/);
  assert.match(help, /Removes the matching active ungranted branch marker instead of producing reviewer input or a patch/);
  assert.match(help, /Exit codes: 0 reviewer input, decision or authenticated no_commit\/head_moved closure printed/);
});

const headAt = (head, tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"))) => ({ ...quiet, tmpRoot, changedPaths: () => [], revParse: (_worktree, rev) => (rev === "HEAD" ? head : rev), isAncestor: () => true, staleSurface: () => ({ hits: [], truncated: false }), diffPatch: () => "patch\n" });

test("result-only changelog seam checks touched changes paths before writing evidence", async () => {
  for (const changedPaths of [["changes/a.md"], ["changes/deleted.md", "docs/moved.md"], ["scripts/fix.mjs"]]) {
    const { actList, result } = fixture();
    let calls = 0;
    const seam = { ...headAt(B), changedPaths: () => changedPaths, validateChangelog: async () => { calls++; return 1; } };
    const args = ["--act-list", actList, "--baseline", A];
    await runCli([...args, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
    assert.equal(calls, 0, "input mode never checks changelog");
    if (changedPaths[0].startsWith("changes/")) {
      await assert.rejects(runCli([...args, "--result", result, "--invocation", "1"], seam), /^Error: LIFECYCLE-CHANGELOG-COMPLETENESS/);
      assert.equal(fs.existsSync(path.join(seam.tmpRoot, "gate-delta", `${A}.json`)), false);
      assert.equal(calls, 1);
    } else {
      assert.equal((await runCli([...args, "--result", result, "--invocation", "1"], seam)).nextStep, "push");
      assert.equal(calls, 0);
    }
  }
});

// Base commit; `optIn` writes the changelog.required opt-in that enables the completeness check.
function commitBase(dir, { optIn, message = "base" }) {
  if (optIn) {
    fs.writeFileSync(path.join(dir, ".devloops"), "version: 1\nchangelog:\n  required: true\n");
    runGitFixture(dir, ["add", ".devloops"]);
  }
  runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

test("real delta CLI refuses committed invalid inputs concealed by uncommitted corrections", async () => {
  for (const { length, correction, crlf } of [{ length: 201 }, { length: 200 }, { length: 200, crlf: true }, { length: 0 },
    { length: 201, correction: "changes/note.md" }, { length: 200, correction: "changes/other.md" }, { length: 200, correction: "CHANGELOG.md" }]) {
  const { dir, threadsFile } = threadsFixture();
  try {
    initGitFixture(dir, { branch: "main", commit: null });
    runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
    commitBase(dir, { optIn: true });
    const baseline = runGitFixture(dir, ["rev-parse", "HEAD"]);
    runGitFixture(dir, ["update-ref", "refs/remotes/origin/main", baseline]);
    if (length) {
      fs.mkdirSync(path.join(dir, "changes"));
      fs.writeFileSync(path.join(dir, "changes/note.md"), `- ${"x".repeat(length - 7)} (#1)\n`);
    } else fs.writeFileSync(path.join(dir, "fix.mjs"), "export const fixed = true;\n");
    if (correction && correction !== "changes/note.md") {
      const body = `- ${"x".repeat(194)} (#1)\n`;
      fs.writeFileSync(path.join(dir, correction), correction === "CHANGELOG.md" ? `# Changelog\n\n## Unreleased\n\n${body}` : body);
    }
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-qm", "fix(local): fragment"]);
    if (crlf) {
      runGitFixture(dir, ["config", "core.autocrlf", "true"]);
      fs.rmSync(path.join(dir, "changes/note.md"));
      runGitFixture(dir, ["checkout", "--", "changes/note.md"]);
      assert.ok(fs.readFileSync(path.join(dir, "changes/note.md"), "utf8").includes("\r\n"));
      assert.equal(runGitFixture(dir, ["status", "--porcelain"]), "");
    }
    if (correction) {
      const body = `- ${"x".repeat(193)} (#1)\n`;
      fs.writeFileSync(path.join(dir, correction), correction === "CHANGELOG.md" ? `# Changelog\n\n## Unreleased\n\n${body}` : body);
    }
    const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir];
    const input = (await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", path.join(dir, "input-result.json")], { ...quiet })).input;
    const resultPath = path.join(dir, "review.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape,
      actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })),
      newFindings: [], widenedReads: [], outcome: "locally_clear",
    }));
    const resultArgs = [...args, "--result", resultPath, "--invocation", "1"];
    sealDeltaFixture(resolveGateArtifactTmpRoot(dir), resultPath);
    const recordDir = path.join(resolveGateArtifactTmpRoot(dir), "gate-delta");
    if (length === 201 || correction) {
      const out = spawnSync(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), ...resultArgs], { cwd: dir, encoding: "utf8" });
      assert.equal(out.status, 2, out.stderr);
      assert.match(JSON.parse(out.stderr).error, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
      if (correction) assert.match(JSON.parse(out.stderr).error, /differs from HEAD/);
      assert.equal(fs.existsSync(path.join(recordDir, `${baseline}.json`)), false);
    } else {
      let calls = 0;
      const seam = length ? quiet : { ...quiet, validateChangelog: async () => { calls++; throw new Error("must not run"); } };
      assert.equal((await runDeltaCli(resultArgs, seam)).nextStep, "push");
      assert.equal(calls, 0);
      assert.equal(fs.existsSync(path.join(recordDir, `${baseline}.json`)), true);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("result-mode changelog ignores inherited Git directory overrides", async () => {
  const { dir, threadsFile } = threadsFixture();
  const target = path.join(dir, "target"), decoy = path.join(dir, "decoy");
  try {
    fs.mkdirSync(target);
    fs.mkdirSync(decoy);
    for (const [root, message] of [[target, "base"], [decoy, "decoy without origin"]]) {
      initGitFixture(root, { branch: "main", commit: null });
      runGitFixture(root, ["config", "commit.gpgsign", "false"]);
      commitBase(root, { optIn: root === target, message });
    }
    const baseline = runGitFixture(target, ["rev-parse", "HEAD"]);
    runGitFixture(target, ["update-ref", "refs/remotes/origin/main", baseline]);
    fs.mkdirSync(path.join(target, "changes"));
    fs.writeFileSync(path.join(target, "changes/note.md"), `- ${"x".repeat(194)} (#1)\n`);
    runGitFixture(target, ["add", "."]);
    runGitFixture(target, ["commit", "-qm", "fix(local): invalid fragment"]);
    const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", target];
    const input = (await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", path.join(target, "input-result.json")], quiet)).input;
    const resultPath = path.join(dir, "review.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape,
      actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })),
      newFindings: [], widenedReads: [], outcome: "locally_clear",
    }));
    sealDeltaFixture(resolveGateArtifactTmpRoot(target), resultPath);
    const recordDir = path.join(resolveGateArtifactTmpRoot(target), "gate-delta");
    assert.equal(fs.existsSync(path.join(recordDir, `${baseline}.json`)), false);
    const out = spawnSync(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), ...args, "--result", resultPath, "--invocation", "1"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GIT_DIR: path.join(decoy, ".git"), GIT_WORK_TREE: decoy },
    });
    assert.equal(out.status, 2, out.stderr);
    assert.match(JSON.parse(out.stderr).error, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
    assert.equal(fs.existsSync(path.join(recordDir, `${baseline}.json`)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("result mode without changelog.required records a changes-touching diff that has no valid note", async () => {
  const { dir, threadsFile } = threadsFixture();
  try {
    initGitFixture(dir, { branch: "main", commit: null });
    runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
    commitBase(dir, { optIn: false });
    const baseline = runGitFixture(dir, ["rev-parse", "HEAD"]);
    runGitFixture(dir, ["update-ref", "refs/remotes/origin/main", baseline]);
    fs.mkdirSync(path.join(dir, "changes"));
    fs.writeFileSync(path.join(dir, "changes/note.md"), `- ${"x".repeat(194)} (#1)\n`);
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-qm", "fix(local): invalid fragment"]);
    const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir];
    const input = (await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", path.join(dir, "input-result.json")], quiet)).input;
    const resultPath = path.join(dir, "review.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape,
      actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })),
      newFindings: [], widenedReads: [], outcome: "locally_clear",
    }));
    sealDeltaFixture(resolveGateArtifactTmpRoot(dir), resultPath);
    const out = spawnSync(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), ...args, "--result", resultPath, "--invocation", "1"], { cwd: dir, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(fs.existsSync(path.join(resolveGateArtifactTmpRoot(dir), "gate-delta", `${baseline}.json`)), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("without --result the CLI prints the cumulative delta input for the worktree head", async () => {
  const { dir, actList } = fixture();
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], headAt(B));
  assert.equal(out.input.diffRange, `${A}..${B}`);
  assert.equal(out.input.specIdentity, "spec@1");
  // Nothing is written next to the inputs (the patch goes under the tmp root).
  assert.deepEqual(fs.readdirSync(dir).sort(), ["act-list.json", "result.json"]);
});

test("without --result only the patch is written under the tmp root, no decision record", async () => {
  const { actList } = fixture();
  const seam = headAt(B);
  await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  assert.deepEqual(fs.readdirSync(path.join(seam.tmpRoot, "gate-delta")), [`${A}-${B}.patch`]);
});

test("input.patchPath is the gate-delta patch holding the diffPatch bytes", async () => {
  const { actList } = fixture();
  const seam = { ...headAt(B), diffPatch: () => "diff --git a/x b/x\n" };
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  assert.equal(out.input.patchPath, deltaPatchPath(seam.tmpRoot, A, B));
  assert.equal(fs.readFileSync(out.input.patchPath, "utf8"), "diff --git a/x b/x\n");
  assert.equal(out.input.evidenceRule, DELTA_EVIDENCE_RULE);
  const resultPath = path.join(seam.tmpRoot, "bound-result.json");
  const bare = (await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--result-path", resultPath], seam)).input.sealCommand;
  assert.match(bare, /^dev-loops-run --repo-root \/\S+ /, "the command pins --repo-root to the absolute worktree");
  assert.ok(bare.endsWith(` scripts/loop/seal-evidence.mjs --kind delta --file ${resultPath} --tmp-root ${path.resolve(seam.tmpRoot)}`), "the command carries the bound path and the absolute tmp root");
  assert.match(bare, /--tmp-root \//);
  assert.equal(decidePiToolCall({ toolName: "bash", input: { command: bare }, agentType: "review" }).block, false, "the review role may run it verbatim");
});

test("input.sealCommand refuses a bound path the read-only gate would block", async () => {
  const { actList } = fixture();
  const seam = headAt(B);
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--result-path", path.join(seam.tmpRoot, "a b.json")], seam), /may use only letters/);
});

test("the real patch file holds the cumulative baseline..candidate git diff", async () => {
  const { dir, threadsFile } = threadsFixture();
  try {
    initGitFixture(dir, { branch: "main", commit: null });
    runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
    runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const baseline = runGitFixture(dir, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(dir, "one.mjs"), "export const one = 1;\n");
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-qm", "fix(local): one"]);
    fs.writeFileSync(path.join(dir, "two.mjs"), "export const two = 2;\n");
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-qm", "fix(local): two"]);
    const head = runGitFixture(dir, ["rev-parse", "HEAD"]);
    const out = await runDeltaCli(["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir, "--spec-identity", "spec@1", "--result-path", path.join(dir, "input-result.json")], quiet);
    assert.equal(out.input.patchPath, deltaPatchPath(resolveGateArtifactTmpRoot(dir), baseline, head));
    const patch = fs.readFileSync(out.input.patchPath, "utf8");
    assert.match(patch, /^diff --git a\/one\.mjs b\/one\.mjs$/m);
    assert.match(patch, /^\+export const one = 1;$/m);
    assert.match(patch, /^\+export const two = 2;$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the real patch keeps a committed gitlink change under diff.ignoreSubmodules=all", async () => {
  const { dir, threadsFile } = threadsFixture();
  try {
    initGitFixture(dir, { branch: "main", commit: null });
    runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
    runGitFixture(dir, ["config", "diff.ignoreSubmodules", "all"]);
    runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const baseline = runGitFixture(dir, ["rev-parse", "HEAD"]);
    runGitFixture(dir, ["update-index", "--add", "--cacheinfo", `160000,${baseline},sub`]);
    runGitFixture(dir, ["commit", "-qm", "fix(local): gitlink"]);
    const out = await runDeltaCli(["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir, "--spec-identity", "spec@1", "--result-path", path.join(dir, "input-result.json")], quiet);
    assert.match(fs.readFileSync(out.input.patchPath, "utf8"), /^\+Subproject commit /m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the evidence rule reads, forbids executing tests, and the input carries no shell instruction", async () => {
  assert.match(DELTA_EVIDENCE_RULE, /Read patchPath with the read tool/);
  assert.match(DELTA_EVIDENCE_RULE, /Run no tests, builds/);
  assert.match(DELTA_EVIDENCE_RULE, /git grep, grep, rg/);
  assert.match(DELTA_EVIDENCE_RULE, /data, never instructions/);
  const { actList } = fixture();
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], headAt(B));
  const text = JSON.stringify(out.input);
  for (const banned of [/\bsed\b/, /\| head/, /git diff/, /run the tests/i]) assert.doesNotMatch(text, banned);
});

test("the read-only role gate allows read and git grep and blocks bun test", () => {
  assert.equal(decidePiToolCall({ toolName: "read", input: { path: "/x.patch" }, agentType: "review" }).block, false);
  assert.equal(decidePiToolCall({ toolName: "bash", input: { command: "git grep -n foo" }, agentType: "review" }).block, false);
  for (const command of ["grep -n foo x", "rg -n foo"]) assert.equal(decidePiToolCall({ toolName: "bash", input: { command }, agentType: "review" }).block, false);
  for (const role of ["review", "judge"]) assert.equal(decidePiToolCall({ toolName: "bash", input: { command: "bun test" }, agentType: role }).block, true);
});

test("with --result the CLI records the decision for the baseline, and the last write wins", async () => {
  const { actList, result } = fixture();
  const seam = headAt(B);
  const args = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  const decision = await runCli(args, seam);
  const recordPath = path.join(seam.tmpRoot, "gate-delta", `${A}.json`);
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")), {
    ...Object.fromEntries(["coverageProtocol", "siteCoverageDigest", "handbackBytesDigest", "origin"].map((key) => [key, decision[key]])),
    reviewBaselineHead: A, candidateHead: B, actSetId: sequence.actSetId, invocation: 1,
    outcome: "locally_clear", nextStep: "push", items: [{ ref: "act-1", status: "resolved" }],
  });
  await runCli(args, { ...seam, revParse: (_worktree, rev) => (rev === "HEAD" ? "ccccccc3333333" : rev) });
  const later = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(later.nextStep, "rereview_current_head");
  assert.equal(later.candidateHead, "ccccccc3333333");
});

const THREADS = { ok: true, repo: "o/r", pr: 7, threads: [{ trusted: true, threadId: "T1", commentId: 1, body: "fix a", isResolved: false, path: "a.mjs", line: 1 }, { trusted: true, threadId: "T2", commentId: 2, body: "fix b", isResolved: false }] };
function threadsFixture(payload = THREADS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-threads-"));
  const threadsFile = path.join(dir, "threads.json");
  fs.writeFileSync(threadsFile, JSON.stringify(payload));
  return { dir, threadsFile };
}
const threadArgs = (threadsFile, ...rest) => ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", A, ...rest];

test("--threads-file builds one act item per unresolved thread, keyed by threadId, with a stable actSetId", async () => {
  const { threadsFile } = threadsFixture();
  const first = (await runCli(threadArgs(threadsFile, "--spec-identity", "spec@1"), headAt(B))).input;
  assert.deepEqual(first.actItems.map((item) => item.ref), ["T1", "T2"]);
  assert.equal((await runCli(threadArgs(threadsFile, "--spec-identity", "spec@1"), headAt(B))).input.actSetId, first.actSetId);
});

test("--threads-file refuses another PR's file, a resolved thread and a missing --repo/--pr", async () => {
  const { threadsFile } = threadsFixture({ ...THREADS, pr: 8 });
  await assert.rejects(runCli(threadArgs(threadsFile, "--spec-identity", "s"), headAt(B)), /not successful list-review-threads/);
  const resolved = threadsFixture({ ...THREADS, threads: [{ ...THREADS.threads[0], isResolved: true }] });
  await assert.rejects(runCli(threadArgs(resolved.threadsFile, "--spec-identity", "s"), headAt(B)), /not successful list-review-threads/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--threads-file", "x", "--baseline", A, "--spec-identity", "s"]), /--repo/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--threads-file", "x", "--act-list", "y", "--repo", "o/r", "--pr", "7", "--baseline", A, "--spec-identity", "s"]), /exactly one/);
});

test("--threads-file with --result records the decision with thread-id item refs", async () => {
  const { dir, threadsFile } = threadsFixture();
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList: [
    { ref: "T1", angle: "review-thread", summary: "fix a", judgeDisposition: "act", file: "a.mjs", line: 1 },
    { ref: "T2", angle: "review-thread", summary: "fix b", judgeDisposition: "act" },
  ] });
  const result = path.join(dir, "result.json");
  fs.writeFileSync(result, JSON.stringify({
    reviewBaselineHead: A, candidateHead: B, actSetId: sequence.actSetId,
    actionableItems: [{ ref: "T1", status: "resolved", evidence: ["e"] }, { ref: "T2", status: "not_resolved", evidence: ["e"] }],
    newFindings: [], widenedReads: [], outcome: "needs_fix",
  }));
  const seam = headAt(B);
  assert.equal((await runCli(threadArgs(threadsFile, "--result", result, "--invocation", "1"), seam)).nextStep, "fix_and_rereview");
  const record = JSON.parse(fs.readFileSync(path.join(seam.tmpRoot, "gate-delta", `${A}.json`), "utf8"));
  assert.deepEqual(record.items, [{ ref: "T1", status: "resolved" }, { ref: "T2", status: "not_resolved" }]);
});

test("with --result the CLI authorizes the push only for the reviewed head", async () => {
  const { actList, result } = fixture();
  const args = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  assert.equal((await runCli(args, headAt(B))).nextStep, "push");
  const stale = await runCli(args, headAt("ccccccc3333333"));
  assert.equal(stale.fresh, false);
  assert.equal(stale.nextStep, "rereview_current_head");
});

test("the baseline resolves to a full SHA, and authenticated HEAD equal to baseline closes as no_commit", async () => {
  const { actList } = fixture();
  const full = A;
  const resolve = (head) => ({ ...quiet, revParse: (_worktree, rev) => (rev === "HEAD" ? head : full), isAncestor: () => true, staleSurface: () => ({ hits: [], truncated: false }) });
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)];
  assert.equal((await runCli(args, resolve(B))).input.reviewBaselineHead, full);
  assert.equal((await runCli(args, resolve(full))).outcome, "no_commit");
});

test("baseline equality refuses invocations that cannot authenticate input-only closure", async () => {
  const { threadsFile } = threadsFixture();
  const { result } = fixture();
  for (const extra of [[], ["--fixer-plan", "missing.json"], ["--fixer-plan", "missing.json", "--site-coverage", "missing.json", "--result", result, "--invocation", "1"]]) {
    const seam = headAt(A);
    const marker = writeSequenceMarker({ tmpRoot: seam.tmpRoot, baselineHead: A, branch: "issue-1" });
    await assert.rejects(runDeltaCli(["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", A, "--spec-identity", "s", ...(extra.includes("--result") ? [] : ["--result-path", path.join(os.tmpdir(), "r.json")]), ...extra], seam), /no delta review applies \(worktree HEAD \w+, baseline \w+, \d+ item\(s\)\)/);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.existsSync(path.join(seam.tmpRoot, "gate-delta", `${A}.json`)), false);
    assert.equal(fs.existsSync(path.join(seam.tmpRoot, "gate-delta", `${A}-${A}.patch`)), false);
  }
});

test("symbolic and abbreviated handback heads cannot close a genuine fixer sequence", async () => {
  for (const headSha of ["HEAD", B.slice(0, 7)]) {
    const { dir, actList } = fixture();
    const coverage = path.join(dir, "coverage.json");
    fs.writeFileSync(coverage, JSON.stringify({ headSha, siteCoverage: [] }));
    const seam = headAt(B);
    const marker = writeSequenceMarker({ tmpRoot: seam.tmpRoot, baselineHead: A, branch: "issue-1" });
    await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", logFor(A), "--site-coverage", coverage], seam), /canonical full commit SHA/);
    assert.equal(fs.existsSync(marker), true);
  }
});

test("an authenticated commit_only round without a fix commit clears its sequence marker", async () => {
  const { actList } = fixture();
  const full = A;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"));
  const seam = { ...quiet, tmpRoot, revParse: (_worktree, rev) => (rev === "HEAD" ? full : full), isAncestor: () => true };
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  // The marker names the pulled plan's execution, as the real emission writes it.
  const marker = writeSequenceMarker({ tmpRoot, baselineHead: full, branch: "issue-1", execution: { executionIdentity: bound.unit.executionIdentity, workOrderRef: bound.unit.workOrderRef, outputRef: bound.output } });
  const result = await runDeltaCli(bound.args, bound.seam);
  assert.equal(result.outcome, "no_commit");
  assert.equal(result.nextStep, "push_to_gate");
  assert.equal(fs.existsSync(marker), false);
});

// The fixCommitted guard in the CLI is defensive: startDeltaSequence rejects an empty list first, so this asserts the marker survives that abort.
test("a zero-item act list with a committed fix aborts early and keeps the sequence marker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, "[]");
  const full = `${A}${"0".repeat(26)}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"));
  const marker = writeSequenceMarker({ tmpRoot, baselineHead: full });
  const seam = { ...quiet, tmpRoot, revParse: (_worktree, rev) => (rev === "HEAD" ? B : full), isAncestor: () => true };
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam), /non-empty judge act list/);
  assert.equal(fs.existsSync(marker), true);
});

test("a baseline that is not an ancestor of HEAD fails", async () => {
  const { actList } = fixture();
  const calls = [];
  const seam = {
    ...headAt(B),
    isAncestor: (_worktree, ancestor, descendant) => {
      calls.push([ancestor, descendant]);
      return false;
    },
  };
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam), /is not an ancestor of worktree HEAD/);
  assert.deepEqual(calls, [[A, B]]);
});

test("real git calls ignore an inherited GIT_DIR/GIT_WORK_TREE pointing at another repo", async () => {
  const { dir, actList } = fixture();
  const repo = (name, commits) => {
    const root = path.join(dir, name);
    const git = (...args) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    }).stdout.trim();
    fs.mkdirSync(root);
    git("init", "-q");
    return commits.map((msg) => (git("commit", "-q", "--allow-empty", "-m", msg), git("rev-parse", "HEAD")));
  };
  const [base, head] = repo("target", ["c1", "c2"]);
  repo("decoy", ["d1"]);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(dir, "decoy", ".git");
  process.env.GIT_WORK_TREE = path.join(dir, "decoy");
  try {
    const out = await runCli(["--act-list", actList, "--baseline", base, "--spec-identity", "spec@1", "--findings-log", logFor(base), "--worktree", path.join(dir, "target")], quiet);
    assert.equal(out.input.diffRange, `${base}..${head}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("--result-path belongs to the reviewer-input run and must be absolute", () => {
  const base = ["--act-list", "x", "--baseline", A, "--spec-identity", "s", "--findings-log", "f", "--fixer-plan", "p", "--site-coverage", "c"];
  assert.equal(parseCheckPrePushDeltaArgs([...base, "--result-path", "/abs/tmp/delta-result.json"]).resultPath, "/abs/tmp/delta-result.json");
  for (const bad of ["r.json", "./tmp/r.json", "", " "]) assert.throws(() => parseCheckPrePushDeltaArgs([...base, "--result-path", bad]), /absolute path/, JSON.stringify(bad));
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r", "--invocation", "1", "--result-path", "/abs/r.json"]), /reviewer-input run only/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--spec-identity", "s", "--handback", "--site-coverage", "c", "--result-path", "/abs/r.json"]), /reviewer-input run only/);
});

test("argument errors fail closed", () => {
  assert.throws(() => parseCheckPrePushDeltaArgs(["--baseline", A]), /--act-list/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r"]), /--invocation/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--bogus"]), /bogus/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", "HEAD~1"]), /hex commit SHA/);
  for (const extra of [[], ["--spec-identity", "  "]]) {
    assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, ...extra]), /--spec-identity/);
  }
  for (const n of ["0", "4", "1.5"]) {
    assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r", "--invocation", n]), /1\.\.3/, n);
  }
});

test("a --handback run writes no patch and prints no patchPath or evidenceRule", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [] }));
  const seam = headAt(B);
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--handback", "--site-coverage", coverage], seam);
  assert.equal(out.input.patchPath, undefined);
  assert.equal(out.input.evidenceRule, undefined);
  assert.equal(out.input.sealCommand, undefined);
  assert.equal(fs.existsSync(path.join(seam.tmpRoot, "gate-delta")), false);
});

test("--site-coverage threads a valid record into the delta input", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  const item = { fingerprint: "fp1", returnedSites: ["s1"], sites: [{ site: "s1", status: "fixed" }] };
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [item] }));
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--site-coverage", coverage], headAt(B));
  assert.equal(out.input.siteCoverage[0].fingerprint, "fp1");
});

test("--site-coverage refuses foreign-head closure without its matching marker and rejects malformed JSON", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--site-coverage", coverage];
  fs.writeFileSync(coverage, JSON.stringify({ headSha: A, siteCoverage: [] }));
  await assert.rejects(runCli(args, headAt(B)), /matching active commit_only branch marker/);
  fs.writeFileSync(coverage, "{not json");
  await assert.rejects(runCli(args, headAt(B)), SyntaxError);
});

test("--site-coverage input mode refuses a record that leaves a siteQuery uncovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify([{ ...ACT_LIST[0], siteQuery: "git grep -n x" }]));
  const coverage = path.join(dir, "coverage.json");
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--site-coverage", coverage];
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [{ fingerprint: FP, returnedSites: ["scripts/loop/consolidate-fanin.mjs:1161-1163"], sites: [] }] }));
  await assert.rejects(runCli(args, headAt(B)), /GATE-EXEC-REMEDIATION-SITE-QUERY/);
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [] }));
  await assert.rejects(runCli(args, headAt(B)), /GATE-EXEC-REMEDIATION-SITE-QUERY: the disposition handoff leaves site coverage incomplete: /);
  const complete = { fingerprint: FP, returnedSites: ["s1"], sites: [{ site: "s1", status: "fixed" }] };
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [complete] }));
  assert.equal((await runCli(args, headAt(B))).input.siteCoverage[0].fingerprint, FP);
});

test("with --result a coverage record for an older head is discarded and the stale result is routed", async () => {
  const { dir, actList, result } = fixture();
  const coverage = path.join(dir, "coverage.json");
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [] }));
  const args = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1", "--site-coverage", coverage];
  assert.equal((await runCli(args, headAt("ccccccc3333333"))).nextStep, "rereview_current_head");
  args[args.indexOf("1")] = "3";
  assert.equal((await runCli(args, headAt("ccccccc3333333"))).outcome, "bounded_out");
});

test("--pr-head fails closed when the PR head differs from the baseline and passes when equal", async () => {
  const { actList } = fixture();
  const base = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)];
  await assert.rejects(runCli([...base, "--pr-head", "ddddddd4444444"], headAt(B)), /PRE-PUSH-DELTA-PUSH-AUTHORITY.*PR head moved/);
  assert.equal((await runCli([...base, "--pr-head", A], headAt(B))).ok, true);
});

test("--pr-head fails closed when a well-formed PR head does not resolve locally", async () => {
  const { actList } = fixture();
  const unfetched = "ddddddd4444444";
  const seam = { ...headAt(B), revParse: (_worktree, rev) => { if (rev === unfetched) throw new Error("unknown revision"); return rev === "HEAD" ? B : rev; } };
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--pr-head", unfetched], seam), /unknown revision/);
});

const STALE = { kind: "sentence", needle: "n", file: "test/contracts/style.test.mjs", line: 23, site: "test/contracts/style.test.mjs:23" };
const withStale = (head) => ({ ...headAt(head), staleSurface: () => [STALE] });

test("input mode lists stale-surface hits and the findings-log round angles", async () => {
  const { dir, actList } = fixture();
  const log = path.join(dir, "log.json");
  fs.writeFileSync(log, JSON.stringify({ headSha: A, provenance: { distinctReviewers: 2, perAngle: [{ angle: "determinism" }, { angle: "correctness" }] } }));
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", log], withStale(B));
  assert.deepEqual(out.input.staleSurfaceHits, [STALE]);
  assert.deepEqual(out.input.surfaceHints, ["correctness", "determinism"]);
});

test("result mode refuses locally_clear for an unaddressed stale-surface hit on both routes", async () => {
  const { dir, actList, result } = fixture();
  const act = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  assert.equal((await runCli(act, withStale(B))).nextStep, "fix_and_rereview");
  assert.match((await runCli(act, withStale(B))).errors.join("\n"), /stale-surface/);
  // Addressed by a new finding naming the file.
  const addressed = path.join(dir, "addressed.json");
  const base = JSON.parse(fs.readFileSync(result, "utf8"));
  fs.writeFileSync(addressed, JSON.stringify({ ...base, newFindings: [{ severity: "low", summary: "stale pin in test/contracts/style.test.mjs", evidence: ["e"] }] }));
  assert.equal((await runCli(["--act-list", actList, "--baseline", A, "--result", addressed, "--invocation", "1"], withStale(B))).nextStep, "push");
  // Addressed by a recorded skip reason in the site coverage record.
  const coverage = path.join(dir, "skip-coverage.json");
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [{ fingerprint: "fp-skip", returnedSites: [STALE.site], sites: [{ site: STALE.site, status: "skipped", reason: "false positive" }] }] }));
  assert.equal((await runCli([...act, "--site-coverage", coverage], withStale(B))).nextStep, "push");
  // Thread route.
  const { threadsFile } = threadsFixture();
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList: [
    { ref: "T1", angle: "review-thread", summary: "fix a", judgeDisposition: "act", file: "a.mjs", line: 1 },
    { ref: "T2", angle: "review-thread", summary: "fix b", judgeDisposition: "act" },
  ] });
  const threadResult = path.join(dir, "thread-result.json");
  fs.writeFileSync(threadResult, JSON.stringify({
    reviewBaselineHead: A, candidateHead: B, actSetId: sequence.actSetId,
    actionableItems: [{ ref: "T1", status: "resolved", evidence: ["e"] }, { ref: "T2", status: "resolved", evidence: ["e"] }],
    newFindings: [], widenedReads: [], outcome: "locally_clear",
  }));
  const threadArgsResult = threadArgs(threadsFile, "--result", threadResult, "--invocation", "1");
  assert.equal((await runCli(threadArgsResult, headAt(B))).nextStep, "push");
  assert.equal((await runCli(threadArgsResult, withStale(B))).nextStep, "fix_and_rereview");
});

test("a truncated stale-surface list is flagged in the input and blocks locally_clear until a finding names the gap", async () => {
  const { dir, actList, result } = fixture();
  const truncated = (head) => ({ ...headAt(head), staleSurface: () => ({ hits: [], truncated: true }) });
  assert.equal((await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", logFor(A)], truncated(B))).input.staleSurfaceTruncated, true);
  assert.equal((await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", logFor(A)], headAt(B))).input.staleSurfaceTruncated, undefined);
  const act = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  assert.equal((await runCli(act, truncated(B))).nextStep, "fix_and_rereview");
  const addressed = path.join(dir, "addressed.json");
  const base = JSON.parse(fs.readFileSync(result, "utf8"));
  fs.writeFileSync(addressed, JSON.stringify({ ...base, newFindings: [{ severity: "low", summary: "stale-surface-hits-truncated: read the remaining hits by hand", evidence: ["e"] }] }));
  assert.equal((await runCli(["--act-list", actList, "--baseline", A, "--result", addressed, "--invocation", "1"], truncated(B))).nextStep, "push");
});

test("the production stale-surface adapter reports the hit file and line, whatever the operator's git config", async () => {
  const { dir, actList } = fixture();
  const root = path.join(dir, "stale-repo");
  const git = (...args) => {
    const out = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  git("init", "-q");
  const sentence = "The delta review reads the changed lines only.";
  const spaced = "The spaced path file keeps this sentence pinned.";
  fs.writeFileSync(path.join(root, "doc.md"), `${sentence}\n`);
  fs.writeFileSync(path.join(root, "docs", "my guide café.md"), `${spaced}\n`);
  fs.writeFileSync(path.join(root, "test", "pin.test.mjs"), `const pinned = "${sentence}";\nconst spaced = "${spaced}";\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "c1");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "doc.md"), "Reworded.\n");
  fs.writeFileSync(path.join(root, "docs", "my guide café.md"), "Reworded too.\n");
  git("commit", "-q", "-a", "-m", "c2");
  const args = ["--act-list", actList, "--baseline", base, "--spec-identity", "s", "--findings-log", logFor(base), "--worktree", root];
  const hitsUnder = async (...config) => {
    for (const [key, value] of config) git("config", key, value);
    return (await runCli(args, quiet)).input.staleSurfaceHits.map((h) => h.site).sort();
  };
  const expected = ["test/pin.test.mjs:1", "test/pin.test.mjs:2"];
  assert.deepEqual(await hitsUnder(), expected);
  assert.deepEqual(await hitsUnder(["diff.noprefix", "true"], ["color.ui", "always"], ["diff.external", "false"], ["diff.algorithm", "histogram"], ["diff.renames", "copies"], ["diff.orderFile", "/dev/null"], ["core.quotePath", "true"]), expected);
});

test("the production adapter runs from the top level and ignores diff.relative and diff.interHunkContext", async () => {
  const { dir, actList } = fixture();
  const root = path.join(dir, "sub-repo");
  const git = (...args) => {
    const out = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
    assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  git("init", "-q");
  const first = "Alpha rule text describing the gate behavior";
  const third = "and the second clause ends here.";
  fs.writeFileSync(path.join(root, "a.md"), `${first}\nkept middle line\n${third}\n`);
  fs.writeFileSync(path.join(root, "test", "pin.test.mjs"), `const a = "${first}";\nconst b = "${third}";\n`);
  fs.writeFileSync(path.join(root, "sub", "x.txt"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "c1");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "a.md"), "kept middle line\n");
  git("commit", "-q", "-a", "-m", "c2");
  const args = ["--act-list", actList, "--baseline", base, "--spec-identity", "s", "--findings-log", logFor(base), "--worktree", path.join(root, "sub")];
  const hits = async () => (await runCli(args, quiet)).input.staleSurfaceHits.map((h) => `${h.file}:${h.line}`).sort();
  const expected = ["test/pin.test.mjs:1", "test/pin.test.mjs:2"];
  assert.deepEqual(await hits(), expected);
  git("config", "diff.relative", "true");
  git("config", "diff.interHunkContext", "1");
  assert.deepEqual(await hits(), expected);
});

test("an act-list input run without --findings-log is refused, the other routes keep their forms", () => {
  const base = ["--act-list", "a.json", "--baseline", A, "--spec-identity", "s"];
  assert.throws(() => parseCheckPrePushDeltaArgs(base), /PRE-PUSH-DELTA-INPUT/);
  assert.equal(parseCheckPrePushDeltaArgs([...base, "--findings-log", "log.json", "--fixer-plan", "p", "--site-coverage", "c"]).findingsLog, "log.json");
  assert.throws(() => parseCheckPrePushDeltaArgs([...base, "--handback"]), /--handback/);
  assert.throws(() => parseCheckPrePushDeltaArgs([...base, "--handback", "--site-coverage", "c.json", "--result", "r.json", "--invocation", "1"]), /--handback/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--threads-file", "t.json", "--repo", "o/r", "--pr", "1", "--baseline", A, "--spec-identity", "s", "--handback", "--site-coverage", "c.json"]), /--handback/);
  assert.equal(parseCheckPrePushDeltaArgs([...base, "--handback", "--site-coverage", "c.json"]).findingsLog, null);
  assert.equal(parseCheckPrePushDeltaArgs(["--act-list", "a.json", "--baseline", A, "--result", "r.json", "--invocation", "1", "--fixer-plan", "p", "--site-coverage", "c"]).findingsLog, null);
});

test("a missing commit object fails the stale-surface check instead of reporting no hits", async () => {
  const { dir, actList } = fixture();
  const root = path.join(dir, "empty-repo");
  fs.mkdirSync(root);
  spawnSync("git", ["-C", root, "init", "-q"]);
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", logFor(A), "--worktree", root], { ...quiet, revParse: (_w, rev) => (rev === "HEAD" ? B : rev), isAncestor: () => true }), /no longer contains|git cat-file/);
});

test("--findings-log is refused on the thread route and validated on the act-list route", async () => {
  const { dir, actList } = fixture();
  const logWith = (body) => {
    const p = path.join(dir, `log-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const base = ["--act-list", actList, "--baseline", A, "--spec-identity", "s"];
  const good = logWith({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } });
  assert.deepEqual((await runCli([...base, "--findings-log", good], headAt(B))).input.surfaceHints, ["correctness"]);
  await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha: A })], headAt(B)), /perAngle/);
  for (const headSha of ["", "a"]) await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha, provenance: { perAngle: [{ angle: "correctness" }] } })], headAt(B)), /not the baseline/);
  await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha: "ccccccc3333333", provenance: { perAngle: [{ angle: "correctness" }] } })], headAt(B)), /not the baseline/);
  const inline = { executionMode: "inline_single_agent", findings: [{ angle: "correctness" }, { angle: "correctness" }] };
  assert.deepEqual((await runCli([...base, "--findings-log", logWith({ headSha: A, ...inline })], headAt(B))).input.surfaceHints, ["correctness"]);
  await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha: "ccccccc3333333", ...inline })], headAt(B)), /not the baseline/);
  await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha: A, executionMode: "fanout_fanin" })], headAt(B)), /perAngle/);
  const sha256 = "d".repeat(64);
  const sha256Args = ["--act-list", actList, "--baseline", sha256, "--spec-identity", "s"];
  const perAngle = { provenance: { perAngle: [{ angle: "correctness" }] } };
  await assert.rejects(runCli([...sha256Args, "--findings-log", logWith({ headSha: sha256, ...perAngle })], headAt(B)), /stale|no longer contains/);
  await assert.rejects(runCli([...sha256Args, "--findings-log", logWith({ headSha: "e".repeat(64), ...perAngle })], headAt(B)), /stale|no longer contains/);
  await assert.rejects(runCli([...base, "--findings-log", logWith({ headSha: "not-a-sha", ...perAngle })], headAt(B)), /not the baseline/);
  const { threadsFile } = threadsFixture();
  assert.throws(() => parseCheckPrePushDeltaArgs([...threadArgs(threadsFile), "--spec-identity", "s", "--result-path", "/abs/r.json", "--findings-log", good]), /refused with --threads-file/);
  assert.equal(parseCheckPrePushDeltaArgs([...threadArgs(threadsFile), "--spec-identity", "s", "--result-path", "/abs/r.json"]).findingsLog, null);
});

test("input mode accepts the cap-round findings log at an earlier head after a base-only merge", async () => {
  const { actList } = fixture();
  const seam = { ...headAt("c".repeat(40)), baseOnlyMerge: async ({ fromHead, head }) => fromHead === A && head === B };
  const out = await runCli(["--act-list", actList, "--baseline", B, "--spec-identity", "s", "--findings-log", logFor(A)], seam);
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("the base-only merge is checked against the configured base, not a hardcoded origin/main", async () => {
  const { actList } = fixture();
  const cfg = path.join(coverageRepo, ".devloops");
  fs.writeFileSync(cfg, "version: 1\nworkflow:\n  baseBranch: develop\n");
  try {
    const seen = [];
    const seam = { ...headAt("c".repeat(40)), baseOnlyMerge: async ({ fromHead, head, mainRef }) => { seen.push(mainRef); return mainRef === "origin/develop" && fromHead === A && head === B; } };
    const out = await runCli(["--act-list", actList, "--baseline", B, "--spec-identity", "s", "--findings-log", logFor(A)], seam);
    assert.deepEqual(out.input.surfaceHints, ["correctness"]);
    assert.deepEqual(seen, ["origin/develop"]);
  } finally { fs.rmSync(cfg, { force: true }); }
});

test("input mode rejects an earlier-head findings log when .devloops fails to load", async () => {
  const { actList } = fixture();
  const cfg = path.join(coverageRepo, ".devloops");
  try {
    const seam = { ...headAt("c".repeat(40)), baseOnlyMerge: async () => true };
    const bound = await boundArgs(["--act-list", actList, "--baseline", B, "--spec-identity", "s", "--findings-log", logFor(A)], seam);
    fs.writeFileSync(cfg, "version: 1\nworkflow:\n  baseBranch: develop\nbogusKey: true\n");
    await assert.rejects(runDeltaCli(bound.args, bound.seam), /not the baseline/);
  } finally { fs.rmSync(cfg, { force: true }); }
});

test("input mode still rejects an earlier-head findings log after a PR-own change or a seam error", async () => {
  const { actList } = fixture();
  for (const baseOnlyMerge of [async () => false, async () => { throw new Error("git failed"); }]) {
    await assert.rejects(runCli(["--act-list", actList, "--baseline", B, "--spec-identity", "s", "--findings-log", logFor(A)], { ...headAt("c".repeat(40)), baseOnlyMerge }), /not the baseline/);
  }
});

// The cap-round chain (PRE-PUSH-DELTA-INPUT-CAP-CHAIN): the log at cap round A, a sealed clearing record A -> B, then a base-only merge M of B.
const chainLog = (head, extra = { repo: "o/r", pr: 7 }) => {
  const text = JSON.stringify({ headSha: head, ...extra, provenance: { perAngle: [{ angle: "correctness" }] } });
  const p = path.join(LOG_DIR, `chain-${head}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`);
  fs.writeFileSync(p, text);
  return p;
};
const sealRecord = (tmpRoot, from, to, { seal = true } = {}) => {
  const dir = path.join(tmpRoot, "gate-delta");
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify({ reviewBaselineHead: from, candidateHead: to, nextStep: "push_to_gate", outcome: "locally_clear", items: [] });
  fs.writeFileSync(path.join(dir, `${from}.json`), text);
  if (seal) fs.writeFileSync(path.join(dir, `${from}.json.seal`), `${createHash("sha256").update(text).digest("hex")}\n`);
};
// `sealed` lists extra sealed records [from, to]; `ledgerAt` is one head or a list of heads that carry a draft_gate findings log.
const chainRun = (baseline, log, { seal = true, mergeFrom = B, to = B, merge = true, calls = [], seedTo, ledgerAt, sealed = [], between = [] } = {}) => {
  const { actList } = fixture();
  const seam = { ...headAt("c".repeat(40)), revList: () => between, baseOnlyMerge: async ({ fromHead, head }) => { calls.push(fromHead); return merge && fromHead === mergeFrom && head === (seedTo ? M : baseline); } };
  if (!seedTo) sealRecord(seam.tmpRoot, A, to, { seal });
  if (seedTo) sealRecord(seam.tmpRoot, M, seedTo);
  for (const [from, next] of sealed) sealRecord(seam.tmpRoot, from, next);
  for (const head of [ledgerAt].flat().filter(Boolean)) {
    const p = path.join(seam.tmpRoot, "gate-findings", "o-r", "pr-7", `draft_gate-${head}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}");
  }
  return runCli(["--act-list", actList, "--baseline", baseline, "--spec-identity", "s", "--findings-log", log], seam);
};

test("input mode accepts the cap-round log across the sealed fixer chain plus a base-only merge", async () => {
  const out = await chainRun(M, chainLog(A));
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("input mode accepts the cap-round log when the baseline is the chain end", async () => {
  const out = await chainRun(B, chainLog(A), { merge: false });
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("input mode accepts a chain seeded by a ledgerless base-only merge of the log head", async () => {
  // M is a ledgerless base-only merge of the log head A and M -> B is sealed: the baseline B is the end of the seeded chain.
  const out = await chainRun(B, chainLog(A), { seedTo: B, mergeFrom: A });
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("input mode accepts a chain seeded by a ledgerless base-only merge of a chain end", async () => {
  // A -> B is sealed, M is a ledgerless base-only merge of the chain end B and M -> C is sealed: the baseline C is the end of the seeded chain.
  const out = await chainRun(C, chainLog(A), { seedTo: C, mergeFrom: B, sealed: [[A, B]] });
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("input mode accepts a chain through an intermediate head that wrote no findings log", async () => {
  const out = await chainRun(C, chainLog(A), { merge: false, sealed: [[B, C]] });
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("input mode refuses the chain log when a later full round ran at an intermediate head or chain end", async () => {
  // log at B, sealed B -> C, baseline C
  await assert.rejects(chainRun(C, chainLog(A), { merge: false, sealed: [[B, C]], ledgerAt: B }), /sealed clearing chain/);
  // log at B, baseline M a base-only merge of B (no log at M)
  await assert.rejects(chainRun(M, chainLog(A), { ledgerAt: B }), /sealed clearing chain/);
});

test("input mode refuses the chain log when a draft_gate round ran at an intermediate merge between the chain end and the baseline", async () => {
  const M1 = "1".repeat(40);
  await assert.rejects(chainRun(M, chainLog(A), { between: [M, M1], ledgerAt: M1 }), /sealed clearing chain/);
  const out = await chainRun(M, chainLog(A), { between: [M, M1] }); // no log at M1: accepted
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
  await assert.rejects(chainRun(M, chainLog(A), { between: null }), /sealed clearing chain/); // rev-list failure fails closed
});

test("input mode refuses a chain log whose repo or pr differs from the authenticated plan target", async () => {
  await chainRun(M, chainLog(A)); // equal to the plan target o/r#7: accepted
  await assert.rejects(chainRun(M, chainLog(A, { repo: "o/r", pr: 999 })), /sealed clearing chain/);
  await assert.rejects(chainRun(M, chainLog(A, { repo: "x/y", pr: 7 })), /sealed clearing chain/);
});

test("input mode refuses the chain log when a later round wrote its own findings log at the baseline", async () => {
  await assert.rejects(chainRun(B, chainLog(A), { merge: false, ledgerAt: B }), /sealed clearing chain/);
  await assert.rejects(chainRun(M, chainLog(A), { ledgerAt: M }), /sealed clearing chain/);
});

test("input mode accepts a base-only merge of the log head even when the ledger already holds the baseline (ADR 0225 item 4)", async () => {
  const out = await chainRun(M, chainLog(A), { mergeFrom: A, ledgerAt: M });
  assert.deepEqual(out.input.surfaceHints, ["correctness"]);
});

test("a --handback run with --repo and --pr but no authenticated plan refuses the chain path", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  const head = "c".repeat(40);
  fs.writeFileSync(coverage, JSON.stringify({ headSha: head, siteCoverage: [] }));
  const seam = { ...headAt(head), baseOnlyMerge: async ({ fromHead, head: to }) => fromHead === B && to === M };
  sealRecord(seam.tmpRoot, A, B);
  await assert.rejects(runCli(["--act-list", actList, "--baseline", M, "--spec-identity", "s", "--handback", "--site-coverage", coverage, "--findings-log", chainLog(A), "--repo", "o/r", "--pr", "7"], seam), /sealed clearing chain/);
});

test("input mode refuses the chain log for each failing chain condition", async () => {
  const run = async (opts, log = chainLog(A)) => {
    const calls = [];
    await assert.rejects(chainRun(M, log, { ...opts, calls }), /sealed clearing chain/);
    return calls;
  };
  assert.deepEqual(await run({ seal: false }), [A]); // unsealed: no chain end, only the log-head merge check ran
  assert.deepEqual(await run({}, chainLog(A, {})), [A]); // no repo/pr on the chain path: no chain walk
  assert.ok((await run({ to: "e".repeat(40) })).includes("e".repeat(40))); // chain ends elsewhere: its end is tried and fails
  assert.ok((await run({ merge: false })).includes(B)); // chain reaches B, the merge of B is not base-only
});

test("issue 2787 C12: the sealed delta record carries findings[] only when a fixer must act on one", async () => {
  const { writeGateDeltaRecord, readSealedGateDeltaRecord } = await import("../../scripts/loop/_gate-delta-record.mjs");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delta-findings-"));
  try {
    const sequence = { reviewBaselineHead: B, actSetId: "set" };
    const write = (newFindings) => writeGateDeltaRecord({ tmpRoot, sequence, candidateHead: C, invocation: 1, decision: { outcome: "needs_fix", nextStep: "fix_and_rereview" },
      result: { actionableItems: [{ ref: "T1", status: "resolved" }], newFindings } });
    write([{ severity: "low", summary: "nit", evidence: ["e"] }]);
    assert.equal("findings" in readSealedGateDeltaRecord(tmpRoot, B), false);
    write([{ severity: "high", summary: "new bug", evidence: ["a", "b"], site: "x.mjs:1" }]);
    assert.deepEqual(readSealedGateDeltaRecord(tmpRoot, B).findings, [{ severity: "high", summary: "new bug", evidence: "a; b", site: "x.mjs:1" }]);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

// Issue 3111 AC1: a locally_clear result refused for a stale-surface hit, a no-commit fixer re-emission, then the corrected result still binds to the original execution.
test("a refused locally_clear result followed by a no-commit re-emission keeps the original coverage binding", async () => {
  const { emitFixerWorkOrder } = await import("../../scripts/loop/emit-fixer-work-order.mjs");
  const { dir, actList, result } = fixture();
  const seam = withStale(B);
  const argv = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  const first = await boundArgs(argv, seam);
  const refused = await runDeltaCli(first.args, first.seam);
  assert.equal(refused.nextStep, "fix_and_rereview");
  assert.match(refused.errors.join("\n"), /PRE-PUSH-DELTA-RESULT/);
  sealDeltaFixture(resolveGateArtifactTmpRoot(coverageRepo), result);
  const planBytes = fs.readFileSync(first.unit.planPath);
  const again = await emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", cwd: coverageRepo, deltaResult: result,
    fetchPr: async () => ({ headRefName: "issue-1", headRefOid: A }), fetchVerdictMarkers: async () => ({ draft_gate: { visible: true, contractComplete: true } }), executionIdentity: `f${Date.now() + 1}-0000beef` });
  assert.notEqual(again.planPath, first.unit.planPath);
  assert.deepEqual(fs.readFileSync(first.unit.planPath), planBytes, "the bound plan is not superseded");
  const base = JSON.parse(fs.readFileSync(result, "utf8"));
  const corrected = path.join(dir, "corrected.json");
  fs.writeFileSync(corrected, JSON.stringify({ ...base, newFindings: [{ severity: "low", summary: "stale pin in test/contracts/style.test.mjs", evidence: ["e"] }] }));
  sealDeltaFixture(seam.tmpRoot, corrected);
  const args = [...first.args];
  args[args.indexOf("--result") + 1] = corrected;
  args[args.indexOf("--invocation") + 1] = "2";
  const done = await runDeltaCli(args, first.seam);
  assert.equal(done.nextStep, "push");
  assert.deepEqual(JSON.parse(fs.readFileSync(corrected, "utf8")).origin, first.binding.origin);
  // The reviewer-input run after the re-emission still authenticates against the original execution.
  const inputArgs = ["--act-list", actList, "--baseline", A, "--spec-identity", "s", "--findings-log", logFor(A), "--worktree", coverageRepo, "--fixer-plan", first.unit.planPath, "--site-coverage", first.output, "--result-path", path.join(dir, "next-result.json")];
  const input = await runDeltaCli(inputArgs, first.seam);
  assert.deepEqual(input.input.origin, first.binding.origin);
});


// ADR 0255: the PR 3087 state. The cap-round head P1, a fix commit P2, then a base refresh merged in; the sequence is closed (no marker, no plan) and the head moved.
function reviewerOnlyRepo({ nonBaseOnlyMerge = false, evilMerge = false, octopus = false, baseChanges = false, ownChanges = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-only-"));
  initGitFixture(dir, { branch: "main", commit: null });
  const git = (...args) => runGitFixture(dir, args);
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "gone.mjs"), "export const goneIdentifierName = 1;\n");
  git("add", "."); git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-qb", "pr");
  fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 1;\n");
  git("add", "."); git("commit", "-qm", "feat: a");
  const baseline = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 2;\n");
  if (ownChanges) { fs.mkdirSync(path.join(dir, "changes")); fs.writeFileSync(path.join(dir, "changes", "own.md"), "own\n"); }
  git("add", "."); git("commit", "-qm", "fix: a");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "refreshed.txt"), "from the base\n");
  if (baseChanges) { fs.mkdirSync(path.join(dir, "changes")); fs.writeFileSync(path.join(dir, "changes", "base.md"), "base\n"); }
  git("rm", "-q", "gone.mjs");
  git("add", "."); git("commit", "-qm", "base moves");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "pr");
  git("merge", "-q", "--no-ff", "-m", "refresh base", "main");
  if (nonBaseOnlyMerge || evilMerge || octopus) {
    // A merge of a branch that holds PR-own work is not a base-only merge.
    for (const name of octopus ? ["side", "side2"] : ["side"]) {
      git("checkout", "-qb", name, baseline);
      fs.writeFileSync(path.join(dir, `${name}.mjs`), `export const ${name} = 1;\n`);
      git("add", "."); git("commit", "-qm", `feat: ${name}`);
    }
    git("checkout", "-q", "pr");
    if (evilMerge) {
      // A merge that carries content of its own (a conflict resolution): the resolution diff names evil.mjs, which no parent holds.
      git("merge", "-q", "--no-ff", "--no-commit", "side");
      fs.writeFileSync(path.join(dir, "evil.mjs"), "export const evil = 1;\n");
      git("add", "."); git("commit", "-qm", "merge side with a resolution");
    } else git("merge", "-q", "--no-ff", "-m", "merge side", ...(octopus ? ["side", "side2"] : ["side"]));
  }
  return { dir, baseline, head: git("rev-parse", "HEAD"), tmpRoot: resolveGateArtifactTmpRoot(dir) };
}
// The cap-round ledger at the baseline; --findings-log is required and the act list is derived from it (ADR 0255).
const CAP_ACT = { severity: "medium", summary: "guard missing", files: ["a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
function capLog(dir, baseline, findings) {
  const file = path.join(dir, `cap-log-${baseline.slice(0, 8)}-${findings.length}.json`);
  fs.writeFileSync(file, JSON.stringify({ headSha: baseline, verdict: findings.length ? "findings_present" : "clean", findings, provenance: { perAngle: [{ angle: "correctness" }] } }));
  return file;
}
const reviewerOnlyArgs = ({ dir, baseline, head }, findings = []) => ["--reviewer-only", "--baseline", baseline, "--pr-head", head, "--findings-log", capLog(dir, baseline, findings), "--worktree", dir];
const seam = { stdout: { write: () => {} }, fetchBase: () => {} };

async function reviewerOnlyRun(repo, result, { invocation = 1, extraSeam = {}, findings = [], status = "resolved" } = {}) {
  const resultPath = path.join(repo.dir, "reviewer-result.json");
  const { input } = await runDeltaCli([...reviewerOnlyArgs(repo, findings), "--spec-identity", "spec@1", "--result-path", resultPath], { ...seam, ...extraSeam });
  const actionableItems = input.actItems.map((item) => ({ ref: item.ref, status, evidence: ["a.mjs:1"] }));
  fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems, newFindings: [], widenedReads: [], outcome: status === "resolved" ? "locally_clear" : "needs_fix", ...result }));
  sealDeltaFixture(repo.tmpRoot, resultPath);
  const decision = await runDeltaCli([...reviewerOnlyArgs(repo, findings), "--result", resultPath, "--invocation", String(invocation)], { ...seam, ...extraSeam });
  return { input, decision, record: JSON.parse(fs.readFileSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`), "utf8")) };
}
const cleanup = (repo) => fs.rmSync(repo.dir, { recursive: true, force: true });
const MEDIUM = [{ severity: "medium", summary: "open", evidence: ["a.mjs:1"] }];

test("AC1: a reviewer-only delta seals locally_clear for baseline..head across a base-refresh merge with no plan, marker or coverage record", async () => {
  const repo = reviewerOnlyRepo();
  try {
    assert.equal(readSequenceMarker(repo.tmpRoot, repo.baseline), null, "closed sequence: no marker");
    assert.equal(fs.existsSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`)), false, "no earlier record");
    const { input, decision, record } = await reviewerOnlyRun(repo, {});
    assert.deepEqual(input.actItems, []);
    assert.deepEqual(input.resultShape.actionableItems, []);
    const patch = fs.readFileSync(input.patchPath, "utf8");
    assert.match(patch, /^\+export const a = 2;$/m);
    assert.doesNotMatch(patch, /refreshed\.txt|gone\.mjs/);
    assert.equal(decision.outcome, "locally_clear");
    assert.equal(decision.nextStep, "push");
    assert.deepEqual({ b: record.reviewBaselineHead, c: record.candidateHead, o: record.outcome, i: record.items }, { b: repo.baseline, c: repo.head, o: "locally_clear", i: [] });
    assert.ok(fs.existsSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json.seal`)));
  } finally { cleanup(repo); }
});

test("a reviewer-only run over a non-clean cap-round ledger derives the act items, seals them resolved, and an unresolved item seals no locally_clear record", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const ok = await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT] });
    assert.deepEqual(ok.input.actItems.map((i) => i.ref), [fingerprintFinding(CAP_ACT)]);
    assert.equal(ok.decision.outcome, "locally_clear");
    assert.deepEqual(ok.record.items.map((i) => [i.ref, i.status]), [[fingerprintFinding(CAP_ACT), "resolved"]]);
    const bad = reviewerOnlyRepo();
    try {
      const run = await reviewerOnlyRun(bad, {}, { findings: [CAP_ACT], status: "not_resolved" });
      assert.equal(run.record.outcome, "needs_fix");
      assert.equal(run.decision.locallyClear, false);
    } finally { cleanup(bad); }
  } finally { cleanup(repo); }
});

test("AC3: a reviewer-only result with a medium or high finding, or a residue claim, does not seal a clearing record", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const first = await reviewerOnlyRun(repo, { newFindings: MEDIUM });
    assert.equal(first.decision.locallyClear, false);
    assert.equal(first.decision.outcome, "needs_fix");
    assert.equal(first.record.outcome, "needs_fix");
    assert.equal(first.record.nextStep, "fix_and_rereview");
    const high = await reviewerOnlyRun(repo, { newFindings: [{ ...MEDIUM[0], severity: "high" }], outcome: "locally_clear" }, { invocation: 2 });
    assert.equal(high.record.outcome, "needs_fix");
    const residue = await reviewerOnlyRun(repo, { newFindings: [{ severity: "low", summary: "still open", evidence: ["a.mjs:1"], residueOf: "x", residueStatus: "open" }], outcome: "locally_clear" }, { invocation: 3 });
    assert.notEqual(residue.record.outcome, "locally_clear");
    assert.ok(!["push", "push_to_gate"].includes(residue.record.nextStep));
  } finally { cleanup(repo); }
});

test("a reviewer-only result at invocation 3 with an open finding writes no clearing nextStep", async () => {
  const repo = reviewerOnlyRepo();
  try {
    await reviewerOnlyRun(repo, { newFindings: MEDIUM });
    await reviewerOnlyRun(repo, { newFindings: MEDIUM }, { invocation: 2 });
    const { record, decision } = await reviewerOnlyRun(repo, { newFindings: MEDIUM }, { invocation: 3 });
    assert.equal(decision.outcome, "bounded_out");
    assert.deepEqual({ o: record.outcome, n: record.nextStep }, { o: "bounded_out", n: "restart_on_replacement_pr" });
    await assert.rejects(reviewerOnlyRun(repo, {}, { invocation: 3 }), /invocation bound of 3 is reached/);
  } finally { cleanup(repo); }
});

test("the invocation bound is real: a rerun at invocation 1 over a needs_fix record refuses, and a needs_fix result never replaces a locally_clear record", async () => {
  const repo = reviewerOnlyRepo();
  try {
    await reviewerOnlyRun(repo, { newFindings: MEDIUM });
    await assert.rejects(reviewerOnlyRun(repo, {}), /--invocation 1 is not the next invocation 2/);
    const clear = await reviewerOnlyRun(repo, {}, { invocation: 2 });
    assert.equal(clear.record.outcome, "locally_clear");
    await assert.rejects(reviewerOnlyRun(repo, { newFindings: MEDIUM }, { invocation: 3 }), /locally_clear record .* never overwritten/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`), "utf8")).outcome, "locally_clear");
  } finally { cleanup(repo); }
});

test("reviewer-only refuses an existing record with another act set, an active marker, a head equal to the baseline and a missing origin base", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const args = [...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    const recordPath = path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ reviewBaselineHead: repo.baseline, candidateHead: repo.head, actSetId: "covering-first-record", invocation: 1, outcome: "locally_clear", nextStep: "push_to_gate", items: [] }));
    await assert.rejects(runDeltaCli(args, seam), /is locally_clear for another act set and is never overwritten/);
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).actSetId, "covering-first-record");
    fs.rmSync(recordPath);
    writeSequenceMarker({ tmpRoot: repo.tmpRoot, baselineHead: repo.baseline, branch: "issue-1" });
    await assert.rejects(runDeltaCli(args, seam), /active sequence marker/);
    fs.rmSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.sequence`));
    await assert.rejects(runDeltaCli(["--reviewer-only", "--baseline", repo.head, "--pr-head", repo.head, "--findings-log", capLog(repo.dir, repo.head, []), "--worktree", repo.dir, "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam), /equals the baseline/);
    runGitFixture(repo.dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    await assert.rejects(runDeltaCli(args, seam), /origin\/main does not exist.*git fetch origin main/);
    await assert.rejects(runDeltaCli(args, { ...seam, fetchBase: () => { throw new Error("offline"); } }), /git fetch origin main failed/);
  } finally { cleanup(repo); }
});

test("a reviewer-only range with no PR-own commit refuses", async () => {
  const repo = reviewerOnlyRepo();
  try {
    // origin/main now holds every commit of the range.
    runGitFixture(repo.dir, ["update-ref", "refs/remotes/origin/main", repo.head]);
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")], seam), /no PR-own commit/);
  } finally { cleanup(repo); }
});

test("the changes/ changelog check follows the PR-own paths only", async () => {
  const own = reviewerOnlyRepo({ ownChanges: true });
  const base = reviewerOnlyRepo({ baseChanges: true });
  try {
    let calls = 0;
    const validateChangelog = async () => { calls += 1; return 1; };
    await assert.rejects(reviewerOnlyRun(own, {}, { extraSeam: { validateChangelog } }), /LIFECYCLE-CHANGELOG-COMPLETENESS/);
    assert.equal(calls, 1);
    const { decision } = await reviewerOnlyRun(base, {}, { extraSeam: { validateChangelog } });
    assert.equal(decision.outcome, "locally_clear");
    assert.equal(calls, 1, "a changes/ file that only the base-only merge brought in does not trigger the check");
  } finally { cleanup(own); cleanup(base); }
});

test("identifiers removed by a base-only merge are excluded from the stale-surface scan", () => {
  const repo = reviewerOnlyRepo();
  try {
    assert.ok(gitStaleSurfaceHits(repo.dir, repo.baseline, repo.head).hits.length > 0, "the plain range sees the base removal");
    assert.deepEqual(gitStaleSurfaceHits(repo.dir, repo.baseline, repo.head, ["a.mjs"]).hits, []);
  } finally { cleanup(repo); }
});

test("a reviewer-only run refuses an octopus merge in the range and names the merge", async () => {
  const repo = reviewerOnlyRepo({ octopus: true });
  try {
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")], seam), new RegExp(`^Error: non_base_only_merge: merge [0-9a-f]{40} in ${repo.baseline}.*Only the replacement-PR restart remains`));
  } finally { cleanup(repo); }
});

test("a reviewer-only run reviews a merge that is not base-only through its own commits and its resolution diff", async () => {
  const clean = reviewerOnlyRepo({ nonBaseOnlyMerge: true });
  const evil = reviewerOnlyRepo({ evilMerge: true });
  try {
    const cleanRun = await reviewerOnlyRun(clean, {});
    assert.match(fs.readFileSync(cleanRun.input.patchPath, "utf8"), /side\.mjs/, "the merged PR-own commit is reviewed");
    assert.equal(cleanRun.decision.outcome, "locally_clear");
    const evilRun = await reviewerOnlyRun(evil, {});
    const patch = fs.readFileSync(evilRun.input.patchPath, "utf8");
    assert.match(patch, /evil\.mjs/, "the resolution diff names the file only the merge holds");
    assert.doesNotMatch(patch, /refreshed\.txt/);
    assert.equal(evilRun.decision.outcome, "locally_clear");
  } finally { cleanup(clean); cleanup(evil); }
});

// ADR 0255: the reviewer-only run takes over the fixer's non-clearing record at the baseline when the refs match.
function seedFixerRecord(repo, patch = {}) {
  const recordPath = path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`);
  const record = { ...JSON.parse(fs.readFileSync(recordPath, "utf8")), actSetId: "fixer-act-set", ...patch };
  writeSealedGateDeltaRecord(repo.tmpRoot, repo.baseline, record);
  return recordPath;
}

test("the reviewer-only run takes over a prior non-clearing record with another actSetId but the same refs and continues its invocation count", async () => {
  for (const unsealed of [false, true]) {
    const repo = reviewerOnlyRepo();
    try {
      await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], status: "not_resolved" });
      const recordPath = seedFixerRecord(repo, { candidateHead: repo.baseline });
      if (unsealed) fs.rmSync(`${recordPath}.seal`);
      await assert.rejects(reviewerOnlyRun(repo, {}, { findings: [CAP_ACT] }), /--invocation 1 is not the next invocation 2/);
      const { record } = await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], invocation: 2 });
      assert.deepEqual({ o: record.outcome, i: record.invocation, same: record.actSetId !== "fixer-act-set" }, { o: "locally_clear", i: 2, same: true });
    } finally { cleanup(repo); }
  }
});

test("the reviewer-only run keeps a locally_clear record, an extension, another ref set and a foreign candidate protected, and an unsealed one names its remedy", async () => {
  const cases = [
    ["is locally_clear for another act set", { outcome: "locally_clear" }, false],
    ["carries an extension", { extension: "delta_covered" }, false],
    ["covers another set of act refs", { items: [{ ref: "other", status: "resolved" }] }, false],
    ["not on the PR head's history", { candidateHead: "ORPHAN" }, false],
    ["unsealed_record: .*is locally_clear for another act set.*rm -f .*\\.seal", { outcome: "locally_clear" }, true],
  ];
  for (const [message, patch, unsealed] of cases) {
    const repo = reviewerOnlyRepo();
    try {
      await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], status: "not_resolved" });
      const orphan = runGitFixture(repo.dir, ["commit-tree", "-m", "orphan", "HEAD^{tree}"]);
      const recordPath = seedFixerRecord(repo, { candidateHead: repo.baseline, ...patch, ...(patch.candidateHead ? { candidateHead: orphan } : {}) });
      if (unsealed) fs.rmSync(`${recordPath}.seal`);
      const before = fs.readFileSync(recordPath, "utf8");
      await assert.rejects(reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], invocation: 2 }), new RegExp(message));
      assert.equal(fs.readFileSync(recordPath, "utf8"), before, "the record is never overwritten");
    } finally { cleanup(repo); }
  }
});

test("--reviewer-only refuses the plan inputs, a missing --pr-head and a worktree HEAD that is not the PR head", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const base = reviewerOnlyArgs(repo);
    for (const extra of [["--fixer-plan", "p"], ["--site-coverage", "s"], ["--handback"], ["--act-list", "a"], ["--threads-file", "t"]]) {
      assert.throws(() => parseCheckPrePushDeltaArgs([...base, ...extra]), /--reviewer-only refuses/);
    }
    assert.throws(() => parseCheckPrePushDeltaArgs(["--reviewer-only", "--baseline", repo.baseline, "--spec-identity", "s", "--findings-log", "l"]), /requires --pr-head/);
    assert.throws(() => parseCheckPrePushDeltaArgs(["--reviewer-only", "--baseline", repo.baseline, "--pr-head", repo.head, "--spec-identity", "s"]), /requires --findings-log/);
    await assert.rejects(runDeltaCli(["--reviewer-only", "--baseline", repo.baseline, "--pr-head", repo.baseline, "--findings-log", capLog(repo.dir, repo.baseline, []), "--worktree", repo.dir, "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam), /is not --pr-head/);
  } finally { cleanup(repo); }
});
