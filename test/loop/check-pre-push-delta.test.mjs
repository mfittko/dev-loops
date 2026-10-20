import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";

import { parseCheckPrePushDeltaArgs, runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { A, B, boundArgs } from "./_delta-coverage-fixture.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";

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
const headAt = (head, tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"))) => ({ ...quiet, tmpRoot, changedPaths: () => [], revParse: (_worktree, rev) => (rev === "HEAD" ? head : rev), isAncestor: () => true, staleSurface: () => ({ hits: [], truncated: false }) });

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
      assert.equal(fs.existsSync(path.join(seam.tmpRoot, "gate-delta")), false);
      assert.equal(calls, 1);
    } else {
      assert.equal((await runCli([...args, "--result", result, "--invocation", "1"], seam)).nextStep, "push");
      assert.equal(calls, 0);
    }
  }
});

test("real delta CLI refuses committed invalid inputs concealed by uncommitted corrections", async () => {
  for (const { length, correction } of [{ length: 201 }, { length: 200 }, { length: 0 },
    { length: 201, correction: "changes/note.md" }, { length: 200, correction: "changes/other.md" }, { length: 200, correction: "CHANGELOG.md" }]) {
  const { dir, threadsFile } = threadsFixture();
  try {
    initGitFixture(dir, { branch: "main", commit: null });
    runGitFixture(dir, ["config", "commit.gpgsign", "false"]);
    runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
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
    if (correction) {
      const body = `- ${"x".repeat(193)} (#1)\n`;
      fs.writeFileSync(path.join(dir, correction), correction === "CHANGELOG.md" ? `# Changelog\n\n## Unreleased\n\n${body}` : body);
    }
    const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", dir];
    const input = (await runDeltaCli([...args, "--spec-identity", "spec@1"], { ...quiet })).input;
    const resultPath = path.join(dir, "review.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape,
      actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })),
      newFindings: [], widenedReads: [], outcome: "locally_clear",
    }));
    const resultArgs = [...args, "--result", resultPath, "--invocation", "1"];
    const recordDir = path.join(resolveGateArtifactTmpRoot(dir), "gate-delta");
    if (length === 201 || correction) {
      const out = spawnSync(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), ...resultArgs], { cwd: dir, encoding: "utf8" });
      assert.equal(out.status, 2, out.stderr);
      assert.match(JSON.parse(out.stderr).error, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
      if (correction) assert.match(JSON.parse(out.stderr).error, /differs from HEAD/);
      assert.equal(fs.existsSync(recordDir), false);
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
      runGitFixture(root, ["commit", "-q", "--allow-empty", "-m", message]);
    }
    const baseline = runGitFixture(target, ["rev-parse", "HEAD"]);
    runGitFixture(target, ["update-ref", "refs/remotes/origin/main", baseline]);
    fs.mkdirSync(path.join(target, "changes"));
    fs.writeFileSync(path.join(target, "changes/note.md"), `- ${"x".repeat(194)} (#1)\n`);
    runGitFixture(target, ["add", "."]);
    runGitFixture(target, ["commit", "-qm", "fix(local): invalid fragment"]);
    const args = ["--threads-file", threadsFile, "--repo", "o/r", "--pr", "7", "--baseline", baseline, "--worktree", target];
    const input = (await runDeltaCli([...args, "--spec-identity", "spec@1"], quiet)).input;
    const resultPath = path.join(dir, "review.json");
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape,
      actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["checked"] })),
      newFindings: [], widenedReads: [], outcome: "locally_clear",
    }));
    const recordDir = path.join(resolveGateArtifactTmpRoot(target), "gate-delta");
    assert.equal(fs.existsSync(recordDir), false);
    const out = spawnSync(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), ...args, "--result", resultPath, "--invocation", "1"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GIT_DIR: path.join(decoy, ".git"), GIT_WORK_TREE: decoy },
    });
    assert.equal(out.status, 2, out.stderr);
    assert.match(JSON.parse(out.stderr).error, /^LIFECYCLE-CHANGELOG-COMPLETENESS/);
    assert.equal(fs.existsSync(recordDir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("without --result the CLI prints the cumulative delta input for the worktree head", async () => {
  const { dir, actList } = fixture();
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], headAt(B));
  assert.equal(out.input.diffRange, `${A}..${B}`);
  assert.equal(out.input.specIdentity, "spec@1");
  // Write-free: nothing is written next to the inputs.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["act-list.json", "result.json"]);
});

test("without --result no decision record is written under the tmp root", async () => {
  const { actList } = fixture();
  const seam = headAt(B);
  await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam);
  assert.deepEqual(fs.readdirSync(seam.tmpRoot), []);
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

const THREADS = { ok: true, repo: "o/r", pr: 7, threads: [{ threadId: "T1", commentId: 1, body: "fix a", isResolved: false, path: "a.mjs", line: 1 }, { threadId: "T2", commentId: 2, body: "fix b", isResolved: false }] };
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

test("the baseline resolves to a full SHA, and HEAD equal to the baseline fails", async () => {
  const { actList } = fixture();
  const full = A;
  const resolve = (head) => ({ ...quiet, revParse: (_worktree, rev) => (rev === "HEAD" ? head : full), isAncestor: () => true, staleSurface: () => ({ hits: [], truncated: false }) });
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)];
  assert.equal((await runCli(args, resolve(B))).input.reviewBaselineHead, full);
  await assert.rejects(runCli(args, resolve(full)), /equals the baseline/);
});

test("a commit_only round without a fix commit clears its sequence marker", async () => {
  const { actList } = fixture();
  const full = `${A}${"0".repeat(26)}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-tmp-"));
  const marker = writeSequenceMarker({ tmpRoot, baselineHead: full });
  const seam = { ...quiet, tmpRoot, revParse: (_worktree, rev) => (rev === "HEAD" ? full : full), isAncestor: () => true };
  await assert.rejects(runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A)], seam), /equals the baseline/);
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

test("--site-coverage threads a valid record into the delta input", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  const item = { fingerprint: "fp1", returnedSites: ["s1"], sites: [{ site: "s1", status: "fixed" }] };
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage: [item] }));
  const out = await runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--site-coverage", coverage], headAt(B));
  assert.equal(out.input.siteCoverage[0].fingerprint, "fp1");
});

test("--site-coverage fails on a headSha mismatch or malformed JSON", async () => {
  const { dir, actList } = fixture();
  const coverage = path.join(dir, "coverage.json");
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", logFor(A), "--site-coverage", coverage];
  fs.writeFileSync(coverage, JSON.stringify({ headSha: A, siteCoverage: [] }));
  await assert.rejects(runCli(args, headAt(B)), /site coverage record names head/);
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
  assert.throws(() => parseCheckPrePushDeltaArgs([...threadArgs(threadsFile), "--spec-identity", "s", "--findings-log", good]), /refused with --threads-file/);
  assert.equal(parseCheckPrePushDeltaArgs([...threadArgs(threadsFile), "--spec-identity", "s"]).findingsLog, null);
});
