import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDefaultTimeout, test } from "bun:test";

import { readSequenceMarker, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";

import { DELTA_EVIDENCE_RULE, deltaPatchPath, gitStaleSurfaceHits, parseCheckPrePushDeltaArgs, runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { A, B, C, M, boundArgs, coverageRepo } from "./_delta-coverage-fixture.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { sealDeltaFixture } from "./_seal-fixture.mjs";
import { runDocsValidators } from "../../scripts/docs/docs-validators.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { gateDeltaRecordPath, isLifecycleFinding, readGateDeltaRecord, readSealedGateDeltaRecord, writeGateDeltaRecord, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { decidePiToolCall } from "../../extension/readonly-role-gate.ts";

setDefaultTimeout(30000); // most cases seed a real git repo and run the CLI; the 5 s default fails under load

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
      // Issue 2447: the refusal is a medium finding in the sealed record, exit 0, never a throw with no record.
      const decision = await runCli([...args, "--result", result, "--invocation", "1"], seam);
      assert.deepEqual([decision.outcome, decision.nextStep, decision.locallyClear], ["needs_fix", "fix_and_rereview", false]);
      const record = readSealedGateDeltaRecord(seam.tmpRoot, A);
      assert.equal(record.nextStep, "fix_and_rereview");
      assert.deepEqual(record.findings.map((f) => [f.severity, /^LIFECYCLE-CHANGELOG-COMPLETENESS/.test(f.summary)]), [["medium", true]]);
      assert.equal(calls, 1);
      const bounded = await runCli([...args, "--result", result, "--invocation", "3"], seam);
      assert.deepEqual([bounded.outcome, bounded.nextStep], ["bounded_out", "push_to_gate"]);
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
      if (correction) {
        // An uncommitted input is no refusal of the reviewed commit: the check throws (exit 2) and no record is written.
        assert.equal(out.status, 2, out.stderr);
        assert.match(JSON.parse(out.stderr).error, /differs from HEAD/);
        assert.equal(fs.existsSync(path.join(recordDir, `${baseline}.json`)), false);
      } else {
        assert.equal(out.status, 0, out.stderr);
        assert.equal(JSON.parse(out.stdout).nextStep, "fix_and_rereview");
        const [finding] = readGateDeltaRecord(resolveGateArtifactTmpRoot(dir), baseline).findings;
        assert.match(finding.summary, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
      }
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
    assert.equal(out.status, 0, out.stderr);
    assert.match(readGateDeltaRecord(resolveGateArtifactTmpRoot(target), baseline).findings[0].summary, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
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
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  assert.deepEqual(fs.readdirSync(path.join(seam.tmpRoot, "gate-delta")), [`${A}-${B}-${out.input.runId}.patch`]);
});

test("input.patchPath is the gate-delta patch holding the diffPatch bytes", async () => {
  const { actList } = fixture();
  const seam = { ...headAt(B), diffPatch: () => "diff --git a/x b/x\n" };
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  assert.equal(out.input.patchPath, deltaPatchPath(seam.tmpRoot, A, B, out.input.runId));
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
    assert.equal(out.input.patchPath, deltaPatchPath(resolveGateArtifactTmpRoot(dir), baseline, head, out.input.runId));
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
    const deltaDir = path.join(seam.tmpRoot, "gate-delta");
    assert.deepEqual((fs.existsSync(deltaDir) ? fs.readdirSync(deltaDir) : []).filter((f) => f.endsWith(".patch")), []);
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
function reviewerOnlyRepo({ conflictOnly = false, nonBaseOnlyMerge = false, evilMerge = false, octopus = false, baseChanges = false, ownChanges = false, commitAfterMerge = false, netRevert = false, resolutionGitlink = false } = {}) {
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
  if (netRevert) { fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 1;\n"); git("add", "."); git("commit", "-qm", "revert: a"); }
  const fix = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "refreshed.txt"), "from the base\n");
  if (baseChanges) { fs.mkdirSync(path.join(dir, "changes")); fs.writeFileSync(path.join(dir, "changes", "base.md"), "base\n"); }
  if (conflictOnly) fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = \"main\";\n");
  git("rm", "-q", "gone.mjs");
  git("add", "."); git("commit", "-qm", "base moves");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "pr");
  if (conflictOnly) {
    assert.throws(() => git("merge", "-q", "--no-ff", "--no-commit", "main")); // add/add conflict on a.mjs
    fs.writeFileSync(path.join(dir, "a.mjs"), "export const a = 3;\n");
    git("add", ".");
    if (resolutionGitlink) git("update-index", "--add", "--cacheinfo", `160000,${"b".repeat(40)},vendor/sub`);
    git("commit", "-qm", "refresh base with a resolution");
  } else git("merge", "-q", "--no-ff", "-m", "refresh base", "main");
  const mergeHead = git("rev-parse", "HEAD");
  if (commitAfterMerge) { fs.writeFileSync(path.join(dir, "a.mjs"), "// uses goneIdentifierName\nexport const a = 3;\n"); git("add", "."); git("commit", "-qm", "fix: a again"); }
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
  return { dir, baseline: conflictOnly ? fix : baseline, fix, mergeHead, head: git("rev-parse", "HEAD"), tmpRoot: resolveGateArtifactTmpRoot(dir) };
}
// The cap-round ledger at the baseline; --findings-log is required and the act list is derived from it (ADR 0255).
const CAP_ACT = { severity: "medium", summary: "guard missing", files: ["a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
function capLog(dir, baseline, findings) {
  const file = buildLogPath({ repo: "owner/repo", pr: 70, gate: "draft_gate", headSha: baseline, tmpRoot: resolveGateArtifactTmpRoot(dir) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ repo: "owner/repo", pr: 70, gate: "draft_gate", headSha: baseline, verdict: findings.length ? "findings_present" : "clean", findings, provenance: { perAngle: [{ angle: "correctness" }] } }));
  return file;
}
const reviewerOnlyArgs = ({ dir, baseline, head }, findings = []) => ["--reviewer-only", "--repo", "owner/repo", "--pr", "70", "--baseline", baseline, "--pr-head", head, "--findings-log", capLog(dir, baseline, findings), "--worktree", dir];
const seam = { stdout: { write: () => {} }, fetchBase: () => {}, fetchPr: async () => ({ baseRefName: "main" }) };

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

test("a reviewer-only baseline that is a base-only merge of a non-clean cap-round head derives the cap-round act items", async () => {
  const repo = reviewerOnlyRepo({ commitAfterMerge: true });
  try {
    const args = ["--reviewer-only", "--repo", "owner/repo", "--pr", "70", "--baseline", repo.mergeHead, "--pr-head", repo.head, "--findings-log", capLog(repo.dir, repo.fix, [CAP_ACT]), "--worktree", repo.dir, "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    const { input } = await runDeltaCli(args, seam);
    assert.deepEqual(input.actItems.map((i) => i.ref), [fingerprintFinding(CAP_ACT)]);
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

test("a locally_clear record at invocation 3 names the chain-end route, not the replacement-PR restart", async () => {
  const repo = reviewerOnlyRepo();
  try {
    await reviewerOnlyRun(repo, { newFindings: MEDIUM });
    await reviewerOnlyRun(repo, { newFindings: MEDIUM }, { invocation: 2 });
    assert.equal((await reviewerOnlyRun(repo, {}, { invocation: 3 })).record.outcome, "locally_clear");
    await assert.rejects(reviewerOnlyRun(repo, {}, { invocation: 4 }), (error) => {
      assert.match(error.message, /locally_clear.*gate extend-cap-round-chain/);
      assert.doesNotMatch(error.message, /bounded_out|restart_on_replacement_pr/);
      return true;
    });
  } finally { cleanup(repo); }
});

// The owner token file of <baseline>.sequence-lock, read at the call: null when no lock directory exists.
const lockOwner = (repo) => { try { return fs.readFileSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.sequence-lock`, "owner"), "utf8"); } catch { return null; } };

test("the reviewer-only run reads and seal-checks the prior record while it owns the sequence lock (one owner token)", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const record = { reviewBaselineHead: repo.baseline, candidateHead: repo.head, actSetId: "other", invocation: 1, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "delta_covered" };
    writeSealedGateDeltaRecord(repo.tmpRoot, repo.baseline, record);
    const seen = [];
    const readRecord = (...a) => { seen.push(["read", lockOwner(repo)]); return readGateDeltaRecord(...a); };
    const readSealedRecord = (...a) => { const sealed = readSealedGateDeltaRecord(...a); seen.push(["seal", lockOwner(repo), sealed !== null]); return sealed; };
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")], { ...seam, readRecord, readSealedRecord }), /carries an extension/);
    assert.deepEqual(seen.map(([kind]) => kind), ["read", "seal"]);
    assert.ok(seen[0][1], "the record is read while a lock owner token exists");
    assert.equal(seen[1][1], seen[0][1], "the seal check runs under the same owner token as the read");
    assert.equal(seen[1][2], true, "the record is sealed, so the refusal is no unsealed leftover");
  } finally { cleanup(repo); }
});

test("the reviewer-only result run compares the record under a sequence lock owner token", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const owners = [];
    const readRecord = (...a) => { owners.push(lockOwner(repo)); return readGateDeltaRecord(...a); };
    await reviewerOnlyRun(repo, {}, { extraSeam: { readRecord } });
    // The input run reads once and the result run reads at the start and at the compare: every read holds a lock.
    assert.equal(owners.length, 3);
    assert.deepEqual(owners.filter((owner) => !owner), [], "no record read runs outside the sequence lock");
  } finally { cleanup(repo); }
});

test("AC1: the reviewer-only route reads the PR baseRefName for the fetch and the origin ref, and an unreadable PR base refuses", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const args = [...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    const fetched = [];
    const release = { ...seam, fetchPr: async () => ({ baseRefName: "release" }), fetchBase: (base) => fetched.push(base) };
    await assert.rejects(runDeltaCli(args, release), /origin\/release does not exist/);
    assert.deepEqual(fetched, ["release"], "the fetch names the PR's base, not the configured one");
    runGitFixture(repo.dir, ["update-ref", "refs/remotes/origin/release", runGitFixture(repo.dir, ["rev-parse", "refs/remotes/origin/main"])]);
    assert.ok((await runDeltaCli(args, release)).input);
    for (const fetchPr of [async () => { throw new Error("gh offline"); }, async () => ({}), async () => ({ baseRefName: "" })]) {
      fetched.length = 0;
      await assert.rejects(runDeltaCli(args, { ...release, fetchPr }), /cannot read the base branch of owner\/repo#70.*no fallback/);
      assert.deepEqual(fetched, [], "an unreadable PR base fetches nothing");
    }
  } finally { cleanup(repo); }
});

test("AC1: roundAnglesOf measures an earlier-head log against the PR's base on the input run", async () => {
  const repo = reviewerOnlyRepo();
  try {
    runGitFixture(repo.dir, ["update-ref", "refs/remotes/origin/release", runGitFixture(repo.dir, ["rev-parse", "refs/remotes/origin/main"])]);
    const logHead = "a".repeat(40);
    const mainRefs = new Set();
    const order = [];
    const release = { ...seam, fetchPr: async () => ({ baseRefName: "release" }), fetchBase: () => order.push("fetch"), baseOnlyMerge: async ({ fromHead, mainRef }) => { order.push("merge"); mainRefs.add(mainRef); return fromHead === logHead; } };
    const args = [...reviewerOnlyArgs(repo).map((arg, i, all) => (all[i - 1] === "--findings-log" ? capLog(repo.dir, logHead, []) : arg)), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    assert.ok((await runDeltaCli(args, release)).input);
    assert.deepEqual([...mainRefs], ["origin/release"], "no call measures against the configured branch");
    assert.ok(order.includes("merge") && order.indexOf("fetch") === 0, "the fetch precedes the first base-only-merge call");
  } finally { cleanup(repo); }
});

test("AC2: a record that turns malformed between the first read and the write-time compare refuses and stays unchanged", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const resultPath = path.join(repo.dir, "reviewer-result.json");
    const { input } = await runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", resultPath], seam);
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: [], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    sealDeltaFixture(repo.tmpRoot, resultPath);
    const recordPath = gateDeltaRecordPath(repo.tmpRoot, repo.baseline);
    // No record at the first read; a malformed file appears before the compare.
    const corrupt = () => { fs.writeFileSync(recordPath, "{ not json"); return []; };
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--result", resultPath, "--invocation", "1"], { ...seam, staleSurface: corrupt }), /changed on disk between/);
    assert.equal(fs.readFileSync(recordPath, "utf8"), "{ not json");
  } finally { cleanup(repo); }
});

test("AC3: under diff.ignoreSubmodules=all a gitlink change stays in the path set and the reviewer patch, and a patch that omits it refuses", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const git = (...args) => runGitFixture(repo.dir, args);
    git("config", "diff.ignoreSubmodules", "all"); git("config", "diff.submodule", "log");
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub`);
    fs.writeFileSync(path.join(repo.dir, "docs.md"), "docs\n");
    git("add", "docs.md"); git("commit", "-qm", "docs and a gitlink");
    const moved = { ...repo, head: git("rev-parse", "HEAD") };
    const args = [...reviewerOnlyArgs(moved), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    const { input } = await runDeltaCli(args, seam);
    const patch = fs.readFileSync(input.patchPath, "utf8");
    assert.match(patch, /^diff --git a\/vendor\/sub b\/vendor\/sub$/m);
    assert.match(patch, /Subproject commit a{40}/);
    assert.match(patch, /docs\.md/);
    await assert.rejects(runDeltaCli(args, { ...seam, diffPatch: () => "diff --git a/docs.md b/docs.md\n+docs\n" }), /gitlink_not_in_patch.*vendor\/sub/);
  } finally { cleanup(repo); }
});

test("AC3: a path named like a gitlink raw header is not read as a gitlink", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const git = (...args) => runGitFixture(repo.dir, args);
    fs.writeFileSync(path.join(repo.dir, ":160000 notes"), "n\n");
    fs.writeFileSync(path.join(repo.dir, "docs.md"), "docs\n");
    git("add", "--", "./:160000 notes", "docs.md"); git("commit", "-qm", "colon-named file and docs");
    const moved = { ...repo, head: git("rev-parse", "HEAD") };
    const args = [...reviewerOnlyArgs(moved), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    assert.ok((await runDeltaCli(args, seam)).input.patchPath);
  } finally { cleanup(repo); }
});

test("AC3: the stale-surface diff keeps a removed gitlink line under diff.ignoreSubmodules=all", () => {
  const repo = reviewerOnlyRepo();
  try {
    const git = (...args) => runGitFixture(repo.dir, args);
    git("config", "diff.ignoreSubmodules", "all"); git("config", "diff.submodule", "log");
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub.md`);
    fs.writeFileSync(path.join(repo.dir, "notes.txt"), `Subproject commit ${"a".repeat(40)}\n`);
    git("add", "notes.txt"); git("commit", "-qm", "add a gitlink");
    const added = git("rev-parse", "HEAD");
    git("update-index", "--force-remove", "vendor/sub.md");
    git("commit", "-qm", "drop the gitlink");
    const { hits } = gitStaleSurfaceHits(repo.dir, added, git("rev-parse", "HEAD"), ["vendor/sub.md"]);
    assert.deepEqual(hits.map((h) => h.site), ["notes.txt:1"], "the removed gitlink line reaches the scan");
  } finally { cleanup(repo); }
});

test("AC3: under diff.ignoreSubmodules=all a gitlink changed by a conflict resolution reaches the PR-own paths and the reviewer patch", async () => {
  const repo = reviewerOnlyRepo({ conflictOnly: true, resolutionGitlink: true });
  try {
    runGitFixture(repo.dir, ["config", "diff.ignoreSubmodules", "all"]);
    const { input } = await reviewerOnlyRun(repo, {});
    assert.match(fs.readFileSync(input.patchPath, "utf8"), /^diff --git a\/vendor\/sub b\/vendor\/sub$/m);
  } finally { cleanup(repo); }
});

test("a deleted gitlink under diff.ignoreSubmodules=all is refused when the patch does not name it, and a header only counts at a line start", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const git = (...args) => runGitFixture(repo.dir, args);
    git("config", "diff.ignoreSubmodules", "all");
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub`);
    git("commit", "-qm", "add gitlink");
    const baseline = git("rev-parse", "HEAD");
    git("update-index", "--force-remove", "vendor/sub");
    fs.writeFileSync(path.join(repo.dir, "docs.md"), "docs\n");
    git("add", "docs.md"); git("commit", "-qm", "drop the gitlink");
    const moved = { ...repo, baseline, head: git("rev-parse", "HEAD") };
    const args = [...reviewerOnlyArgs(moved), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    await assert.rejects(runDeltaCli(args, { ...seam, diffPatch: () => "diff --git a/docs.md b/docs.md\n+docs\n" }), /gitlink_not_in_patch.*vendor\/sub/);
    await assert.rejects(runDeltaCli(args, { ...seam, diffPatch: () => "diff --git a/docs.md b/docs.md\n+ diff --git a/vendor/sub b/vendor/sub\n" }), /gitlink_not_in_patch.*vendor\/sub/);
    const { input } = await runDeltaCli(args, { ...seam, diffPatch: () => 'diff --git a/docs.md b/docs.md\n+docs\ndiff --git "a/vendor/sub" "b/vendor/sub"\n' });
    assert.ok(input.patchPath);
    // A name with a tab and a quote is C-quoted the way git writes it.
    git("update-index", "--add", "--cacheinfo", `160000,${"b".repeat(40)},v/t\tq"x`);
    git("commit", "-qm", "odd gitlink");
    const odd = { ...repo, baseline: moved.head, head: git("rev-parse", "HEAD") };
    const oddArgs = [...reviewerOnlyArgs(odd), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r2.json")];
    await assert.rejects(runDeltaCli(oddArgs, { ...seam, staleSurface: () => [], diffPatch: () => "diff --git a/docs.md b/docs.md\n" }), /gitlink_not_in_patch/);
    assert.ok((await runDeltaCli(oddArgs, { ...seam, staleSurface: () => [], diffPatch: () => 'diff --git "a/v/t\\tq\\"x" "b/v/t\\tq\\"x"\n' })).input.patchPath);
  } finally { cleanup(repo); }
});

test("AC4: every input run writes its own run-bound patch and the result run reads only the patch of its own run", async () => {
  const repo = reviewerOnlyRepo({ nonBaseOnlyMerge: true });
  try {
    const run = (name) => runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, name)], seam);
    const first = await run("r1.json");
    const firstBytes = fs.readFileSync(first.input.patchPath);
    assert.match(firstBytes.toString("utf8"), /side\.mjs/);
    assert.ok(first.input.patchPath.endsWith(`-${first.input.runId}.patch`));
    // The side branch lands on the base after the first input run; the second input run recomputes another range.
    runGitFixture(repo.dir, ["update-ref", "refs/remotes/origin/main", runGitFixture(repo.dir, ["rev-parse", "side"])]);
    const second = await run("r2.json");
    assert.notEqual(second.input.patchPath, first.input.patchPath);
    assert.deepEqual(fs.readFileSync(first.input.patchPath), firstBytes, "the second input run leaves the first run's patch alone");
    assert.doesNotMatch(fs.readFileSync(second.input.patchPath, "utf8"), /side\.mjs/);
    const resultPath = path.join(repo.dir, "r2.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...second.input.resultShape, actionableItems: [], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    sealDeltaFixture(repo.tmpRoot, resultPath);
    const secondBytes = fs.readFileSync(second.input.patchPath);
    fs.rmSync(second.input.patchPath);
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--result", resultPath, "--invocation", "1"], { ...seam, staleSurface: () => [] }), /differs from the patch the reviewer read/);
    fs.writeFileSync(second.input.patchPath, secondBytes);
    const done = await runDeltaCli([...reviewerOnlyArgs(repo), "--result", resultPath, "--invocation", "1"], { ...seam, staleSurface: () => [] }); assert.equal(done.outcome, "locally_clear");
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
    await assert.rejects(runDeltaCli(["--reviewer-only", "--repo", "owner/repo", "--pr", "70", "--baseline", repo.head, "--pr-head", repo.head, "--findings-log", capLog(repo.dir, repo.head, []), "--worktree", repo.dir, "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam), /equals the baseline.*bodyOnly: true/s);
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
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")], seam), /no PR-own commit.*bodyOnly: true/s);
  } finally { cleanup(repo); }
});

test("the changes/ changelog check follows the PR-own paths only", async () => {
  const own = reviewerOnlyRepo({ ownChanges: true });
  const base = reviewerOnlyRepo({ baseChanges: true });
  try {
    let calls = 0;
    const validateChangelog = async () => { calls += 1; return 1; };
    const refused = await reviewerOnlyRun(own, {}, { extraSeam: { validateChangelog } });
    assert.equal(refused.decision.nextStep, "fix_and_rereview");
    assert.match(refused.record.findings[0].summary, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
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
function seedFixerRecord(repo, { sameActSet, ...patch } = {}) {
  const recordPath = path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`);
  const record = { ...JSON.parse(fs.readFileSync(recordPath, "utf8")), ...(sameActSet ? {} : { actSetId: "fixer-act-set" }), ...patch };
  writeSealedGateDeltaRecord(repo.tmpRoot, repo.baseline, record);
  return recordPath;
}

test("the reviewer-only run takes over a sealed or unsealed non-clearing record over the same refs with another actSetId and continues its invocation count", async () => {
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

// Issue 3139 AC3 (ADR 0255 decision 6 amended): a sealed non-clearing record is taken over whatever its ref set or candidate; the count continues, so the bound of 3 holds.
test("the reviewer-only run takes over a sealed needs_fix record with another ref set or an off-history candidate, continuing its invocation count", async () => {
  for (const patch of [{ items: [{ ref: "other", status: "not_resolved" }] }, { candidateHead: "ORPHAN" }]) {
    const repo = reviewerOnlyRepo();
    try {
      await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], status: "not_resolved" });
      const orphan = runGitFixture(repo.dir, ["commit-tree", "-m", "orphan", "HEAD^{tree}"]);
      seedFixerRecord(repo, { candidateHead: repo.baseline, invocation: 1, ...patch, ...(patch.candidateHead === "ORPHAN" ? { candidateHead: orphan } : {}) });
      const { record } = await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], invocation: 2 });
      assert.deepEqual({ o: record.outcome, i: record.invocation }, { o: "locally_clear", i: 2 });
    } finally { cleanup(repo); }
  }
}, 30000);

test("the reviewer-only run refuses a sealed needs_fix record at invocation 3 with bounded_out and no record deletion", async () => {
  const repo = reviewerOnlyRepo();
  try {
    await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], status: "not_resolved" });
    seedFixerRecord(repo, { candidateHead: repo.baseline, invocation: 3, items: [{ ref: "other", status: "not_resolved" }] });
    await assert.rejects(reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], invocation: 4 }), (error) => {
      assert.match(error.message, /bounded_out, restart_on_replacement_pr/);
      assert.doesNotMatch(error.message, /\brm\b/);
      return true;
    });
  } finally { cleanup(repo); }
});

test("the reviewer-only run keeps a locally_clear record, an extension, another ref set and a foreign candidate protected, and an unsealed one names its remedy", async () => {
  const cases = [
    ["is locally_clear for another act set", { outcome: "locally_clear" }, false, /gate extend-cap-round-chain/],
    ["carries an extension", { outcome: "locally_clear", extension: "delta_covered", sameActSet: true }, false, /gate extend-cap-round-chain/],
    ["is locally_clear for another act set", { outcome: "locally_clear", candidateHead: "ORPHAN" }, false, /pr create .*--allow-replacement-pr/],
    ["carries an extension", { outcome: "locally_clear", extension: "delta_covered", sameActSet: true, candidateHead: "ORPHAN" }, false, /pr create .*--allow-replacement-pr/],
    // Issue 3139 AC3: a locally_clear record of another act set and ref set stays protected and names the replacement-PR restart, on or off the PR head's history.
    ["is locally_clear for another act set and covers another set of act refs", { outcome: "locally_clear", items: [{ ref: "other", status: "resolved" }] }, false, /pr create .*--allow-replacement-pr/],
    ["is locally_clear for another act set and covers another set of act refs", { outcome: "locally_clear", items: [{ ref: "other", status: "resolved" }], candidateHead: "ORPHAN" }, false, /pr create .*--allow-replacement-pr/],
    ["bounded_out", { sameActSet: true, outcome: "locally_clear", invocation: 3, candidateHead: "ORPHAN" }, false, /pr create .*--allow-replacement-pr/],
    ["bounded_out", { sameActSet: true, outcome: "locally_clear", invocation: 3, candidateHead: "HEAD" }, false, /pr create .*--allow-replacement-pr/], // a symbolic candidate at the bound
    ["unsealed_record: .*is locally_clear for another act set.*rm -f \\S+\\.json \\S+\\.seal", { outcome: "locally_clear" }, true],
    // ADR 0255 decision 7: an unsealed non-clearing record over another ref set is not taken over.
    ["unsealed_record: .*covers another set of act refs.*rm -f \\S+\\.json \\S+\\.seal", { outcome: "needs_fix", items: [{ ref: "other", status: "not_resolved" }] }, true],
  ];
  for (const [message, patch, unsealed, remedy] of cases) {
    const repo = reviewerOnlyRepo();
    try {
      await reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], status: "not_resolved" });
      const orphan = runGitFixture(repo.dir, ["commit-tree", "-m", "orphan", "HEAD^{tree}"]);
      const recordPath = seedFixerRecord(repo, { candidateHead: repo.baseline, ...patch, ...(patch.candidateHead === "ORPHAN" ? { candidateHead: orphan } : {}) });
      if (unsealed) fs.rmSync(`${recordPath}.seal`);
      const before = fs.readFileSync(recordPath, "utf8");
      await assert.rejects(reviewerOnlyRun(repo, {}, { findings: [CAP_ACT], invocation: (patch.invocation ?? 1) + 1 }), (error) => {
        assert.match(error.message, new RegExp(message));
        if (!unsealed) assert.match(error.message, remedy, "a sealed refusal names the runnable remedy");
        if (!unsealed) assert.doesNotMatch(error.message, /\brm\b/, "no sealed refusal names a record deletion (issue 3139 AC3)");
        assert.doesNotMatch(error.message, /loop gate-coordination/, "no remedy routes back to the coordinator");
        if (!/extend-cap-round-chain/.test(String(remedy))) assert.doesNotMatch(error.message, /extend-cap-round-chain/, "a record that does not cover the derived refs never routes to the extension");
        assert.doesNotMatch(error.message, /\$\{/, "no uninterpolated placeholder");
        return true;
      });
      assert.equal(fs.readFileSync(recordPath, "utf8"), before, "the record is never overwritten");
    } finally { cleanup(repo); }
  }
}, 30000); // measured over 5 s: eight cases, each seeds a repo and runs two reviewer-only invocations

test("--reviewer-only refuses the plan inputs, a missing --pr-head and a worktree HEAD that is not the PR head", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const base = reviewerOnlyArgs(repo);
    for (const extra of [["--fixer-plan", "p"], ["--site-coverage", "s"], ["--handback"], ["--act-list", "a"], ["--threads-file", "t"]]) {
      assert.throws(() => parseCheckPrePushDeltaArgs([...base, ...extra]), /--reviewer-only refuses/);
    }
    assert.throws(() => parseCheckPrePushDeltaArgs(["--reviewer-only", "--baseline", repo.baseline, "--spec-identity", "s", "--findings-log", "l"]), /requires --pr-head/);
    assert.throws(() => parseCheckPrePushDeltaArgs(["--reviewer-only", "--baseline", repo.baseline, "--pr-head", repo.head, "--spec-identity", "s"]), /requires --findings-log/);
    await assert.rejects(runDeltaCli(["--reviewer-only", "--repo", "owner/repo", "--pr", "70", "--baseline", repo.baseline, "--pr-head", repo.baseline, "--findings-log", capLog(repo.dir, repo.baseline, []), "--worktree", repo.dir, "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam), /is not --pr-head/);
  } finally { cleanup(repo); }
});

test("the reviewer-only result run refuses when the delta record changed between its read and its write", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const resultPath = path.join(repo.dir, "reviewer-result.json");
    const { input } = await runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", resultPath], seam);
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: [], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    sealDeltaFixture(repo.tmpRoot, resultPath);
    // A concurrent run seals a record after this run read an absent one and before it writes.
    const concurrent = () => { writeSealedGateDeltaRecord(repo.tmpRoot, repo.baseline, { reviewBaselineHead: repo.baseline, candidateHead: repo.head, actSetId: "concurrent", invocation: 1, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "delta_covered" }); return []; };
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--result", resultPath, "--invocation", "1"], { ...seam, staleSurface: concurrent }), /changed on disk between/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`), "utf8")).extension, "delta_covered");
  } finally { cleanup(repo); }
});

test("the reviewer-only result run refuses when origin/<base> moved the PR-own path set after the input run", async () => {
  const repo = reviewerOnlyRepo({ nonBaseOnlyMerge: true });
  try {
    const resultPath = path.join(repo.dir, "reviewer-result.json");
    const { input } = await runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", resultPath], seam);
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: [], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    sealDeltaFixture(repo.tmpRoot, resultPath);
    // The side branch lands on the base: side.mjs is no longer PR-own, so the result run would judge another range than the reviewer read.
    runGitFixture(repo.dir, ["update-ref", "refs/remotes/origin/main", runGitFixture(repo.dir, ["rev-parse", "side"])]);
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--result", resultPath, "--invocation", "1"], seam), /differs from the patch the reviewer read/);
  } finally { cleanup(repo); }
});

test("a prior record that is not JSON refuses unsealed_record, and a sealed non-clearing one whose candidate is missing from the clone is taken over", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const recordPath = path.join(repo.tmpRoot, "gate-delta", `${repo.baseline}.json`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, "{ not json");
    const args = [...reviewerOnlyArgs(repo), "--spec-identity", "spec@1", "--result-path", path.join(repo.dir, "r.json")];
    await assert.rejects(runDeltaCli(args, seam), /unsealed_record: .*unreadable.*rm -f .*\.seal/);
    writeSealedGateDeltaRecord(repo.tmpRoot, repo.baseline, { reviewBaselineHead: repo.baseline, candidateHead: "f".repeat(40), actSetId: "fixer-act-set", invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview", items: [] });
    const input = await runDeltaCli(args, seam);
    assert.equal(input.input.actItems.length, 0, "the takeover proceeds to the reviewer input");
  } finally { cleanup(repo); }
});

test("--reviewer-only requires --repo and --pr, and refuses a findings log for another PR", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const bare = ["--reviewer-only", "--baseline", repo.baseline, "--pr-head", repo.head, "--spec-identity", "s", "--findings-log", "l"];
    assert.throws(() => parseCheckPrePushDeltaArgs(bare), /requires --repo <owner\/name> and --pr <n>/);
    const other = [...reviewerOnlyArgs(repo).map((arg) => (arg === "70" ? "71" : arg)), "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")];
    await assert.rejects(runDeltaCli(other, seam), /findings log .* is for owner\/repo#70, not owner\/repo#71/);
  } finally { cleanup(repo); }
});

test("--pr-head accepts a commit SHA and rejects a symbolic ref", () => {
  const base = ["--reviewer-only", "--repo", "owner/repo", "--pr", "70", "--baseline", "abc1234", "--spec-identity", "s", "--findings-log", "l"];
  assert.equal(parseCheckPrePushDeltaArgs([...base, "--pr-head", "fba27b5"]).prHead, "fba27b5");
  for (const bad of ["HEAD", "issue-3122", "origin/main"]) assert.throws(() => parseCheckPrePushDeltaArgs([...base, "--pr-head", bad]), /--pr-head must be a hex commit SHA/);
});

test("a reviewer-only run whose only PR-own change is a conflict-resolution merge reviews its resolution diff", async () => {
  const repo = reviewerOnlyRepo({ conflictOnly: true });
  try {
    const { input, decision } = await reviewerOnlyRun(repo, {});
    assert.match(fs.readFileSync(input.patchPath, "utf8"), /a\.mjs/, "the resolution diff names the resolved path");
    assert.equal(decision.outcome, "locally_clear");
  } finally { cleanup(repo); }
});

test("AC6: the reviewer patch of a conflict-resolution merge that drops a base change holds the remerge diff, and the result run recomputes the same bytes", async () => {
  const repo = reviewerOnlyRepo({ conflictOnly: true });
  try {
    const { input, decision } = await reviewerOnlyRun(repo, {});
    const patch = fs.readFileSync(input.patchPath, "utf8");
    const mergeSha = runGitFixture(repo.dir, ["rev-parse", repo.head]);
    assert.match(patch, new RegExp(`^# Resolution diff of merge ${mergeSha} \\(git show --remerge-diff\\)$`, "m"));
    const section = patch.slice(patch.indexOf("# Resolution diff of merge"));
    assert.match(section, /^-export const a = "main";$/m, "the base-side line the resolution dropped is shown");
    assert.match(section, /^\+export const a = 3;$/m);
    assert.equal(decision.outcome, "locally_clear", "the result run recomputed the same bytes");
  } finally { cleanup(repo); }
});

test("a conflict-resolution merge whose patch is empty fails closed with the replacement-PR remedy", async () => {
  const repo = reviewerOnlyRepo({ conflictOnly: true });
  try {
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], { ...seam, diffPatch: () => "" }), /empty_resolution_patch[\s\S]*--allow-replacement-pr/);
  } finally { cleanup(repo); }
});

test("PR-own commits that net-revert a file leave an empty patch and fail closed with the replacement-PR remedy", async () => {
  const repo = reviewerOnlyRepo({ netRevert: true });
  try {
    await assert.rejects(runDeltaCli([...reviewerOnlyArgs(repo), "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam), /empty_resolution_patch[\s\S]*--allow-replacement-pr/);
  } finally { cleanup(repo); }
});

test("the reviewer-only route accepts only the canonical draft_gate cap-round ledger as --findings-log", async () => {
  const repo = reviewerOnlyRepo();
  try {
    const canonical = capLog(repo.dir, repo.baseline, []);
    const log = JSON.parse(fs.readFileSync(canonical, "utf8"));
    const copy = path.join(repo.dir, "copy.json");
    const otherGate = path.join(repo.dir, "other-gate.json");
    fs.writeFileSync(copy, JSON.stringify(log));
    fs.writeFileSync(otherGate, JSON.stringify({ ...log, gate: "pre_approval_gate" }));
    const run = (file) => runDeltaCli([...reviewerOnlyArgs(repo).slice(0, -4), "--findings-log", file, "--worktree", repo.dir, "--spec-identity", "s", "--result-path", path.join(repo.dir, "r.json")], seam);
    assert.ok((await run(canonical)).input, "the canonical ledger is accepted");
    for (const file of [copy, otherGate]) await assert.rejects(run(file), /is not the draft_gate cap-round ledger/);
  } finally { cleanup(repo); }
});

// Issue 2447 slice 1: no handback at the reviewed candidate while must-fix work is open.
function openRecordFixture(findings, actSetId = startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId) {
  const { dir, actList } = fixture();
  const seam = headAt(B);
  writeSealedGateDeltaRecord(seam.tmpRoot, A, { reviewBaselineHead: A, candidateHead: B, actSetId, invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview", items: [], findings });
  const handback = (headSha, siteCoverage = []) => {
    const coverage = path.join(dir, `coverage-${headSha}-${Math.random()}.json`);
    fs.writeFileSync(coverage, JSON.stringify({ headSha, siteCoverage }));
    return coverage;
  };
  const run = (coverage, extra = [], over = headAt(B)) => runDeltaCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--site-coverage", coverage, ...extra], { ...over, tmpRoot: seam.tmpRoot });
  return { run, handback, tmpRoot: seam.tmpRoot, headAt: (head) => headAt(head, seam.tmpRoot) };
}
const RESIDUE_FINDING = { severity: "low", summary: "same-class site left", evidence: "a.mjs:1", residueOf: "act-1", site: "s1" };
const LIFECYCLE_FINDING = { lifecycle: true, severity: "medium", summary: "LIFECYCLE-CHANGELOG-COMPLETENESS: too long", evidence: "changes/x.md" };

test("issue 2447: a handback at the reviewed candidate is refused in both runs while a residue finding has no skip reason, accepted at a new commit or with a skip reason", async () => {
  const fx = openRecordFixture([RESIDUE_FINDING]);
  const atC = fx.handback(B);
  await assert.rejects(fx.run(atC, ["--handback"]), /open task[^]*new commit/);
  await assert.rejects(fx.run(atC, ["--fixer-plan", "plan.json", "--findings-log", logFor(A)]), /open task[^]*new commit/);
  const D = "d".repeat(40);
  assert.ok((await fx.run(fx.handback(D), ["--handback"], fx.headAt(D))).ok);
  const skipped = fx.handback(B, [{ fingerprint: ACT.fingerprint ?? FP, returnedSites: ["s1"], sites: [{ site: "s1", status: "skipped", reason: "intentional" }] }]);
  assert.ok((await fx.run(skipped, ["--handback"])).ok);
});

test("issue 2447: a reviewer finding worded like a lifecycle summary is no lifecycle task at the reviewed candidate", async () => {
  const { lifecycle, ...reviewerWorded } = LIFECYCLE_FINDING;
  const fx = openRecordFixture([reviewerWorded]);
  assert.ok((await fx.run(fx.handback(B), ["--handback"])).ok);
});

test("issue 2447: a handback at the reviewed candidate is refused while the record holds a lifecycle finding, whatever skip reasons it records", async () => {
  const fx = openRecordFixture([LIFECYCLE_FINDING, RESIDUE_FINDING]);
  const skipped = fx.handback(B, [{ fingerprint: FP, returnedSites: ["s1"], sites: [{ site: "s1", status: "skipped", reason: "intentional" }] }]);
  await assert.rejects(fx.run(skipped, ["--handback"]), /LIFECYCLE-CHANGELOG-COMPLETENESS[^]*new commit/);
});

// Issue 2447 slice 1: one docs validator list, run in the --result run only when the repo's test:docs calls it.
test("issue 2447: package.json test:docs calls the one docs validator module, which lists the four validators", async () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["test:docs"], /scripts\/docs\/docs-validators\.mjs/);
  assert.doesNotMatch(pkg.scripts["test:docs"], /validate-links/);
  const { DOCS_VALIDATORS } = await import("../../scripts/docs/docs-validators.mjs");
  assert.deepEqual(DOCS_VALIDATORS.map((v) => v.id), ["links", "rule-ownership", "decision-records", "changelog"]);
});

// A git fixture whose test:docs calls the docs validator module (or not), a threads-route input run and a clearing reviewer result.
// `adr`: the baseline commits an accepted ADR, origin/main names it, and the fix commit edits its Decision line (the real ADR-SUPERSEDE-NOT-REWRITE input).
async function docsFixture(optIn, { adr = false, dropOptIn = false } = {}) {
  const { dir, threadsFile } = threadsFixture();
  initGitFixture(dir, { branch: "main", commit: null });
  runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
  // The gate artifacts (tmp/) and the fixture's own result files are ignored, as in a real worktree; an ignored file never refuses.
  fs.writeFileSync(path.join(dir, ".gitignore"), "tmp/\nreview.json\ninput-result.json\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "test:docs": optIn ? "bun scripts/docs/docs-validators.mjs" : "bun scripts/docs/validate-links.mjs" } }));
  const adrFile = path.join(dir, "docs", "decisions", "0001-x.md");
  if (adr) {
    fs.mkdirSync(path.dirname(adrFile), { recursive: true });
    fs.writeFileSync(adrFile, "# 0001. X\n\n## Status\n\nAccepted, 2026-11-09.\n\n## Decision\n\nUse A.\n");
  }
  runGitFixture(dir, ["add", "."]);
  runGitFixture(dir, ["commit", "-qm", "base"]);
  const baseline = runGitFixture(dir, ["rev-parse", "HEAD"]);
  if (adr) {
    runGitFixture(dir, ["update-ref", "refs/remotes/origin/main", baseline]);
    fs.writeFileSync(adrFile, fs.readFileSync(adrFile, "utf8").replace("Use A.", "Use B."));
    // The candidate may also drop the opt-in from test:docs; the baseline's opt-in still holds.
    if (dropOptIn) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "test:docs": "bun scripts/docs/validate-links.mjs" } }));
    runGitFixture(dir, ["commit", "-qam", "fix: edit adr"]);
  } else runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", "fix: edit adr"]);
  const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir];
  const input = (await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", path.join(dir, "input-result.json")], quiet)).input;
  const resultPath = path.join(dir, "review.json");
  fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })), newFindings: [], widenedReads: [], outcome: "locally_clear" }));
  sealDeltaFixture(resolveGateArtifactTmpRoot(dir), resultPath);
  const run = (seam) => runDeltaCli([...args, "--result", resultPath, "--invocation", "1"], { ...quiet, ...seam });
  return { dir, baseline, run, recordOf: () => readGateDeltaRecord(resolveGateArtifactTmpRoot(dir), baseline) };
}
const REFUSING_VALIDATOR = async () => [{ id: "decision-records", code: 1, output: "ADR-SUPERSEDE-NOT-REWRITE: docs/decisions/0001-x.md edits an accepted Decision", crashed: false }];

test("issue 2447: a docs validator refusal in the --result run is one medium finding per refusing validator; a repo whose test:docs does not call the module runs none", async () => {
  for (const optIn of [true, false]) {
    const fx = await docsFixture(optIn);
    try {
      const calls = [];
      const decision = await fx.run({ docsValidators: async (opts) => { calls.push(opts.ids); return REFUSING_VALIDATOR(); } });
      if (!optIn) {
        assert.equal(calls.length, 0);
        assert.equal(decision.nextStep, "push");
        continue;
      }
      assert.deepEqual(calls, [["links", "rule-ownership", "decision-records"]]);
      assert.equal(decision.nextStep, "fix_and_rereview");
      const [finding] = fx.recordOf().findings;
      assert.equal(finding.severity, "medium");
      assert.equal(finding.lifecycle, true);
      assert.match(finding.summary, /ADR-SUPERSEDE-NOT-REWRITE/);
      assert.match(finding.evidence, /edits an accepted Decision/);
    } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
  }
});

test("issue 2447: a candidate that drops the test:docs opt-in and edits an accepted ADR Decision still gets the validators and needs_fix", async () => {
  const fx = await docsFixture(true, { adr: true, dropOptIn: true });
  try {
    const calls = [];
    const decision = await fx.run({ docsValidators: async (opts) => { calls.push(opts.ids); return REFUSING_VALIDATOR(); } });
    assert.equal(calls.length, 1);
    assert.equal(decision.nextStep, "fix_and_rereview");
    assert.match(fx.recordOf().findings[0].summary, /ADR-SUPERSEDE-NOT-REWRITE/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("issue 2447: the docs validators refuse (exit 2, no record) while a tracked file differs from the reviewed commit, so an uncommitted edit cannot hide a committed refusal", async () => {
  const fx = await docsFixture(true);
  try {
    const pkg = path.join(fx.dir, "package.json");
    fs.appendFileSync(pkg, "\n");
    let called = false;
    await assert.rejects(fx.run({ docsValidators: async () => { called = true; return []; } }), /docs_validators_dirty_worktree[^]*package\.json/);
    assert.equal(called, false);
    assert.equal(fx.recordOf(), null);
    runGitFixture(fx.dir, ["checkout", "--", "package.json"]);
    // An untracked non-ignored file feeds the validators too: it refuses for every form (a link target, a markdown file with a broken link, a file under docs/); an ignored tmp/ file does not.
    runGitFixture(fx.dir, ["config", "status.showUntrackedFiles", "no"]); // the guard must pass --untracked-files=all over a disabled config
    for (const rel of ["docs/new.md", "notes.md"]) {
      const file = path.join(fx.dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rel === "notes.md" ? "[broken](./missing.md)\n" : "target\n");
      await assert.rejects(fx.run({ docsValidators: async () => { called = true; return []; } }), /docs_validators_dirty_worktree[^]*(docs\/|notes\.md)/);
      assert.equal(called, false);
      assert.equal(fx.recordOf(), null);
      fs.rmSync(file);
    }
    fs.rmSync(path.join(fx.dir, "docs"), { recursive: true, force: true });
    assert.equal((await fx.run({ docsValidators: REFUSING_VALIDATOR })).nextStep, "fix_and_rereview");
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("issue 2447: a thrown infrastructure error (a validator crash, a changelog check that throws) keeps the throw and writes no record; only a refusal is a finding", async () => {
  const fx = await docsFixture(true);
  try {
    await assert.rejects(fx.run({ docsValidators: async () => [{ id: "links", code: 1, output: "ENOENT boom", crashed: true }] }), /docs validator links crashed: ENOENT boom/);
    assert.equal(fx.recordOf(), null);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
  const own = await docsFixture(true);
  try {
    fs.mkdirSync(path.join(own.dir, "changes"), { recursive: true });
    fs.writeFileSync(path.join(own.dir, "changes", "x.md"), "x\n");
    runGitFixture(own.dir, ["add", "."]);
    runGitFixture(own.dir, ["commit", "-qm", "add change"]);
    await assert.rejects(own.run({ validateChangelog: async () => { throw new Error("no base ref"); }, docsValidators: async () => [] }), /no base ref/);
    assert.equal(own.recordOf(), null);
  } finally { fs.rmSync(own.dir, { recursive: true, force: true }); }
});

test("issue 2447: the writer caps findings at 20 whatever the open act refs, and only a writer-set flag marks a lifecycle finding", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delta-cap-"));
  try {
    const sequence = { reviewBaselineHead: A, actSetId: "x" };
    const newFindings = Array.from({ length: 25 }, (_, i) => ({ severity: "medium", summary: `finding ${i}`, evidence: "e", file: "a.mjs", line: i + 1 }));
    const result = { actionableItems: [{ ref: "r1", status: "not_resolved", evidence: ["e"] }, { ref: "r2", status: "cannot_verify", evidence: ["e"] }], newFindings };
    writeGateDeltaRecord({ tmpRoot, sequence, candidateHead: B, invocation: 1, decision: { outcome: "needs_fix", nextStep: "fix_and_rereview", locallyClear: false }, result, lifecycleFindings: [{ lifecycle: true, severity: "medium", summary: "docs validator links refused this delta range", evidence: "e" }] });
    const { findings } = readGateDeltaRecord(tmpRoot, A);
    assert.equal(findings.length, 20);
    assert.equal(isLifecycleFinding(findings[0]), true);
    assert.equal(findings.filter(isLifecycleFinding).length, 1);
    assert.equal(isLifecycleFinding({ severity: "medium", summary: "LIFECYCLE-CHANGELOG-COMPLETENESS: reviewer wording", evidence: "e" }), false);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test("issue 2447: the contract docs state the finding route and the fixer contract states the re-dispatch rules", () => {
  const read = (file) => fs.readFileSync(file, "utf8");
  const lifecycle = read("skills/docs/pr-lifecycle-contract.md");
  assert.doesNotMatch(lifecycle, /writes no record/);
  assert.match(lifecycle, /medium finding[^\n]*fix_and_rereview/);
  assert.match(read("skills/docs/pre-pr-review-contract.md"), /lifecycle refusal[^\n]*medium finding[^\n]*fix_and_rereview/);
  for (const file of ["agents/fixer.agent.md", ".claude/agents/fixer.md"]) {
    const text = read(file);
    assert.match(text, /earlier candidate is at HEAD[^\n]*new commit on top of HEAD/);
    assert.match(text, /fix every lifecycle task/);
    assert.match(text, /run `handbackCheck`/);
    assert.match(text, /skip does not apply when the order lists `deltaFindings`/);
  }
  for (const file of ["skills/docs/pr-lifecycle-contract.md", "skills/docs/pre-pr-review-contract.md"]) assert.match(read(file), /0259-delta-lifecycle-refusal-is-a-finding\.md/);
});

test("issue 2447: a handback is refused with delta_record_unsealed when a record exists at the baseline with no matching seal", async () => {
  const fx = openRecordFixture([LIFECYCLE_FINDING]);
  fs.rmSync(`${gateDeltaRecordPath(fx.tmpRoot, A)}.seal`);
  await assert.rejects(fx.run(fx.handback(B), ["--handback"]), /delta_record_unsealed[^]*re-run the --result/);
});

test("issue 2447: the writer caps the record at 20 findings, lifecycle first, and refuses by name only when lifecycle findings alone exceed 20", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delta-budget-"));
  try {
    const sequence = { reviewBaselineHead: A, actSetId: "x" };
    const decision = { outcome: "needs_fix", nextStep: "fix_and_rereview", locallyClear: false };
    const items = (n) => Array.from({ length: n }, (_, i) => ({ ref: `r${i}`, status: "not_resolved", evidence: ["e"] }));
    const residue = (n) => Array.from({ length: n }, (_, i) => ({ severity: "medium", summary: `residue ${i}`, evidence: "e", residueOf: `r${i}`, site: `s${i}` }));
    const lifecycle = (n) => Array.from({ length: n }, (_, i) => ({ ...LIFECYCLE_FINDING, summary: `lifecycle ${i}` }));
    const write = (over) => writeGateDeltaRecord({ tmpRoot, sequence, candidateHead: B, invocation: 1, decision, ...over });
    // 21 open items and two residue findings: both findings are sealed.
    write({ result: { actionableItems: items(21), newFindings: residue(2) } });
    assert.deepEqual(readGateDeltaRecord(tmpRoot, A).findings.map((f) => f.summary), ["residue 0", "residue 1"]);
    // One lifecycle finding with 20 open items: no throw, the act-ref tasks are not counted.
    write({ result: { actionableItems: items(20), newFindings: [] }, lifecycleFindings: [LIFECYCLE_FINDING] });
    assert.equal(readGateDeltaRecord(tmpRoot, A).findings.filter(isLifecycleFinding).length, 1);
    // Lifecycle findings lead the cap.
    write({ result: { actionableItems: [], newFindings: residue(25) }, lifecycleFindings: lifecycle(2) });
    const capped = readGateDeltaRecord(tmpRoot, A).findings;
    assert.equal(capped.length, 20);
    assert.equal(capped.filter(isLifecycleFinding).length, 2);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test("issue 2447: a baseline handback with HEAD at the reviewed candidate is refused on the closure path while the record holds a lifecycle finding", async () => {
  const fx = openRecordFixture([LIFECYCLE_FINDING]);
  await assert.rejects(fx.run(fx.handback(A), ["--fixer-plan", "plan.json", "--findings-log", logFor(A)]), /open task[^]*new commit/);
  const unsealed = openRecordFixture([LIFECYCLE_FINDING]);
  fs.rmSync(`${gateDeltaRecordPath(unsealed.tmpRoot, A)}.seal`);
  await assert.rejects(unsealed.run(unsealed.handback(A), ["--fixer-plan", "plan.json", "--findings-log", logFor(A)]), /delta_record_unsealed/);
});

test("issue 2447: the handback guard reads the sealed record once, so a concurrent rewrite cannot fail it open", async () => {
  const fx = openRecordFixture([LIFECYCLE_FINDING]);
  let reads = 0;
  const real = readSealedGateDeltaRecord;
  const over = { ...fx.headAt(B), readSealedRecord: (...args) => (reads++ === 0 ? real(...args) : null) };
  await assert.rejects(fx.run(fx.handback(B), ["--handback"], over), /open task/);
  assert.equal(reads, 1);
});

test("issue 2447: the closure guard reads the sealed record once for both the handback head and HEAD", async () => {
  const fx = openRecordFixture([LIFECYCLE_FINDING]);
  let reads = 0;
  const real = readSealedGateDeltaRecord;
  const over = { ...fx.headAt(B), readSealedRecord: (...args) => (reads++ === 0 ? real(...args) : null) };
  await assert.rejects(fx.run(fx.handback(A), ["--fixer-plan", "plan.json", "--findings-log", logFor(A)], over), /open task/);
  assert.equal(reads, 1);
});

test("issue 2447: a fix_and_rereview record of another act set at the handback candidate does not refuse the handback, sealed or not", async () => {
  const sealed = openRecordFixture([RESIDUE_FINDING], "other-act-set");
  assert.ok((await sealed.run(sealed.handback(B), ["--handback"])).ok);
  const unsealed = openRecordFixture([LIFECYCLE_FINDING], "other-act-set");
  fs.rmSync(`${gateDeltaRecordPath(unsealed.tmpRoot, A)}.seal`);
  assert.ok((await unsealed.run(unsealed.handback(B), ["--handback"])).ok);
});

test("issue 2447: the --result run judges the recorded candidate and refuses when HEAD moved during the run", async () => {
  const fx = await docsFixture(true);
  try {
    let heads = 0;
    const revParse = (_worktree, rev) => (rev === "HEAD" && heads++ > 0 ? "f".repeat(40) : runGitFixture(fx.dir, ["rev-parse", rev]));
    await assert.rejects(fx.run({ revParse, docsValidators: async () => [] }), /head_moved_during_run/);
    assert.equal(fx.recordOf(), null);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("issue 2447: an edit of an accepted ADR's Decision line runs through the real decision-records validator into one medium lifecycle finding", async () => {
  const fx = await docsFixture(true, { adr: true });
  try {
    // Only the validator list is narrowed (the fixture repo holds no rule registry); the validator, the git client and the message format are real.
    const decision = await fx.run({ docsValidators: (opts) => runDocsValidators({ ...opts, ids: ["decision-records"] }) });
    assert.equal(decision.nextStep, "fix_and_rereview");
    const { findings } = fx.recordOf();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "medium");
    assert.equal(findings[0].lifecycle, true);
    assert.match(findings[0].summary, /decision-records[^]*\(ADR-SUPERSEDE-NOT-REWRITE\)/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("issue 2447: a docs validator that moves HEAD or edits the working tree during its run refuses before the record is written", async () => {
  const fx = await docsFixture(true);
  try {
    let moved = false;
    const revParse = (_worktree, rev) => (rev === "HEAD" && moved ? "f".repeat(40) : runGitFixture(fx.dir, ["rev-parse", rev]));
    await assert.rejects(fx.run({ revParse, docsValidators: async () => { moved = true; return []; } }), /head_moved_during_run/);
    assert.equal(fx.recordOf(), null);
    await assert.rejects(fx.run({ docsValidators: async () => { fs.writeFileSync(path.join(fx.dir, "notes.md"), "late edit\n"); return []; } }), /docs_validators_dirty_worktree[^]*notes\.md/);
    assert.equal(fx.recordOf(), null);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test("issue 2447: a locally_clear result that validation refuses seals no finding, so the issue 3111 keyed-plan route stays open", async () => {
  const { actList, result } = fixture();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"));
  const out = await runCli(["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"], { ...withStale(B), tmpRoot });
  assert.equal(out.nextStep, "fix_and_rereview");
  const record = readGateDeltaRecord(tmpRoot, A);
  assert.equal(record.findings, undefined);
});
