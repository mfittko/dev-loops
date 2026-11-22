import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runCli } from "../../scripts/loop/round-causes.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { runGitFixture, withTempDir } from "../_helpers.mjs";
import { buildGateContextPath, buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { writeSealed } from "../../scripts/github/_gate-artifact-seal.mjs";

const sha = (c) => c.repeat(40);
const ZERO = { first: 0, developer_findings: 0, system_rerun: 0, base_refresh: 0, body_only: 0, other_head_move: 0 };

async function ledger(dir, pr, headSha, loggedAt, extra = {}, retainedRound, gate = "draft_gate") {
  const file = path.resolve(dir, buildLogPath({ repo: "o/r", pr, gate, headSha, tmpRoot: dir }));
  await mkdir(path.dirname(file), { recursive: true });
  const target = retainedRound ? file.replace(/\.json$/, `.round-${retainedRound}.json`) : file;
  await writeSealed(target, JSON.stringify({ repo: "o/r", pr, gate, headSha, verdict: "clean", loggedAt, roundIdentity: { completed: true }, findings: [], ...extra }));
}
const raw = async (dir, args) => {
  let out = "";
  const previous = process.exitCode;
  await runCli(["--repo", "o/r", "--tmp-root", dir, ...args], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, repoRoot: dir });
  const code = process.exitCode ?? 0;
  process.exitCode = previous;
  return { out, code };
};
const run = async (dir, args) => JSON.parse((await raw(dir, args)).out);
const json = (dir, name, value) => writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
const git = (dir, ...args) => runGitFixture(dir, args);

async function fixture(dir) {
  await ledger(dir, 10, sha("a"), "2026-11-01T00:00:00.000Z", { roundCause: "first" });
  await ledger(dir, 10, sha("b"), "2026-11-02T00:00:00.000Z", { roundCause: "developer_findings" });
  await ledger(dir, 11, sha("c"), "2026-11-03T00:00:00.000Z", { roundCause: "first" }, 1);
  await ledger(dir, 11, sha("c"), "2026-11-03T01:00:00.000Z", { roundCause: "system_rerun" });
  await ledger(dir, 12, sha("d"), "2026-11-04T00:00:00.000Z");
  await json(dir, "merged.json", [
    { number: 10, mergedAt: "2026-11-05T00:00:00Z" },
    { number: 11, mergedAt: "2026-11-06T00:00:00Z" },
    { number: 12, mergedAt: "2026-11-07T00:00:00Z" },
  ]);
}

test("R1 counts rounds per change and in total, deriving the legacy ledger", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange.map((c) => [c.pr, c.rounds, c.derivedRounds]), [[12, 1, 1], [11, 2, 0], [10, 2, 0]]);
    assert.deepEqual(r.perChange[2].byCause, { ...ZERO, first: 1, developer_findings: 1 });
    assert.deepEqual(r.totals.byCause, { ...ZERO, first: 3, developer_findings: 1, system_rerun: 1 });
    assert.equal(r.totals.rounds, 5);
    assert.equal(r.totals.roundsPerMerge, 1.67);
    assert.equal(r.totals.derivedRounds, 1);
    assert.equal(r.totals.undeterminedRounds, 0);
    assert.equal(r.totals.byCausePerMerge.first, 1);
    assert.equal(r.issues, null);
  });
});

test("R2 --last keeps the newest merges and names the preceding merge as the window bound", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), "--last", "2"]);
    assert.deepEqual(r.window, { merges: 2, from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z", after: "2026-11-05T00:00:00Z" });
    assert.deepEqual(r.perChange.map((c) => c.pr), [12, 11]);
  });
});

test("R3 --issues counts the issues filed inside the window", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    await json(dir, "issues.json", [
      { number: 1, createdAt: "2026-11-04T00:00:00Z" },
      { number: 2, createdAt: "2026-11-05T12:00:00Z" },
      { number: 3, createdAt: "2026-11-06T12:00:00Z" },
      { number: 4, createdAt: "2026-11-08T00:00:00Z" },
    ]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), "--issues", path.join(dir, "issues.json")]);
    assert.deepEqual(r.issues, { filed: 2, perMerge: 0.67 });
  });
});

test("R3b --last 1 counts the issues filed since the preceding merge", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    await json(dir, "issues.json", [
      { number: 1, createdAt: "2026-11-05T12:00:00Z" },
      { number: 2, createdAt: "2026-11-06T00:00:00Z" },
      { number: 3, createdAt: "2026-11-06T12:00:00Z" },
    ]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), "--issues", path.join(dir, "issues.json"), "--last", "1"]);
    assert.deepEqual(r.window, { merges: 1, from: "2026-11-07T00:00:00Z", to: "2026-11-07T00:00:00Z", after: "2026-11-06T00:00:00Z" });
    assert.deepEqual(r.issues, { filed: 1, perMerge: 1 });
  });
});

test("R4 a merged change without a ledger directory below an existing findings root has zero rounds", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "gate-findings", "o-r"), { recursive: true });
    await json(dir, "merged.json", [{ number: 99, mergedAt: "2026-11-05T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange, [{ pr: 99, mergedAt: "2026-11-05T00:00:00Z", rounds: 0, derivedRounds: 0, undeterminedRounds: 0, unreadableLedgers: 0, outOfBandLedgers: 0, byCause: ZERO, round1: null }]);
  });
});

test("R4b a missing findings root exits with the resolved path instead of reporting zero rounds", async () => {
  await withTempDir(async (dir) => {
    await json(dir, "merged.json", [{ number: 99, mergedAt: "2026-11-05T00:00:00Z" }]);
    await assert.rejects(() => raw(dir, ["--merged-prs", path.join(dir, "merged.json")]), (err) => err.message.includes(path.join(dir, "gate-findings", "o-r")));
  });
});

test("R5 argument and export errors name the cause", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "gate-findings", "o-r"), { recursive: true });
    await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-05T00:00:00Z" }]);
    await json(dir, "bad.json", "not json");
    await json(dir, "nodate.json", [{ number: 1 }]);
    const merged = path.join(dir, "merged.json");
    const fails = (args, re) => assert.rejects(() => runCli(args, { stdout: { write() {} }, repoRoot: dir }), re);
    await fails(["--merged-prs", merged, "--bogus"], /bogus/);
    await fails(["--merged-prs", merged], /--repo is required/);
    await fails(["--repo", "o/r"], /--merged-prs is required/);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "bad.json")], /bad\.json/);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "nodate.json")], /mergedAt/);
    await fails(["--repo", "o/r", "--merged-prs", merged, "--gate", "bogus_gate"], /--gate must be one of/);
    await json(dir, "loose.json", [{ number: 1, mergedAt: "yesterday" }]);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "loose.json")], /mergedAt/);
    await fails(["--repo", "o/r", "--merged-prs", merged, "--base", " "], /--base must not be blank/);
    // A blank --tmp-root is rejected, and a relative or absolute one is accepted.
    for (const blank of ["", " "]) await fails(["--repo", "o/r", "--merged-prs", merged, "--tmp-root", blank], /--tmp-root must not be blank/);
    await mkdir(path.join(dir, "tmp", "gate-findings", "o-r"), { recursive: true });
    for (const ok of [path.join(dir, "tmp"), "tmp"]) {
      await runCli(["--repo", "o/r", "--merged-prs", merged, "--tmp-root", ok, "--silent"], { stdout: { write() {} }, stderr: { write() {} }, repoRoot: dir });
    }
    process.exitCode = 0;
  });
});

test("R5b --repo accepts a safe slug and rejects unsafe or malformed ones", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "gate-findings", "mfittko-dev-loops"), { recursive: true });
    await mkdir(path.join(dir, "gate-findings", "o-r"), { recursive: true });
    await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-05T00:00:00Z" }]);
    const merged = path.join(dir, "merged.json");
    const repoRun = (repo) => runCli(["--repo", repo, "--merged-prs", merged, "--tmp-root", dir, "--silent"], { stdout: { write() {} }, stderr: { write() {} }, repoRoot: dir });
    await repoRun("o/r");
    await repoRun("mfittko/dev-loops");
    for (const bad of ["o/..", "o\\x/r", "nope"]) await assert.rejects(() => repoRun(bad), /--repo must be <owner\/name>/);
    process.exitCode = 0;
  });
});

test("R5c --last accepts digits and rejects zero, hex, negative and exponent forms", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const merged = path.join(dir, "merged.json");
    assert.equal((await run(dir, ["--merged-prs", merged, "--last", "1"])).window.merges, 1);
    assert.equal((await run(dir, ["--merged-prs", merged, "--last", "20"])).window.merges, 3);
    for (const bad of ["0", "0x10", "-1", "1e2"]) await assert.rejects(() => raw(dir, ["--merged-prs", merged, "--last", bad]), /--last/);
  });
});

test("R5d an export entry with a zero or negative number is rejected", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "gate-findings", "o-r"), { recursive: true });
    for (const bad of [0, -1]) {
      await json(dir, "bad-number.json", [{ number: bad, mergedAt: "2026-11-05T00:00:00Z" }]);
      await assert.rejects(() => raw(dir, ["--merged-prs", path.join(dir, "bad-number.json")]), /positive integer number/);
    }
  });
});

test("R6 the report makes no gh call", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "gh"), `#!/bin/sh\ntouch "${dir}/gh-called"\nexit 1\n`);
    await chmod(path.join(bin, "gh"), 0o755);
    const pathBefore = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
    try {
      await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    } finally {
      process.env.PATH = pathBefore;
    }
    assert.equal(existsSync(path.join(dir, "gh-called")), false);
  });
});

test("R7 --help prints usage", async () => {
  let out = "";
  await runCli(["--help"], { stdout: { write: (s) => { out += s; } } });
  assert.match(out, /dev-loops loop round-causes/);
  assert.match(out, /other_head_move/);
  assert.match(out, /2 {2}Invalid output filter/);
});

test("R8 duplicate export rows count once", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    await json(dir, "dup.json", [
      { number: 10, mergedAt: "2026-11-05T00:00:00Z" },
      { number: 10, mergedAt: "2026-11-05T00:00:00Z" },
      { number: 11, mergedAt: "2026-11-06T00:00:00Z" },
    ]);
    await json(dir, "issues.json", [{ number: 1, createdAt: "2026-11-05T12:00:00Z" }, { number: 1, createdAt: "2026-11-05T12:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "dup.json"), "--issues", path.join(dir, "issues.json"), "--last", "2"]);
    assert.deepEqual(r.perChange.map((c) => c.pr), [11, 10]);
    assert.equal(r.issues.filed, 1);
  });
});

test("R9 --fields prints the named field and an unknown field exits 2", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const merged = path.join(dir, "merged.json");
    assert.deepEqual(await raw(dir, ["--merged-prs", merged, "--fields", "gate"]), { out: "draft_gate\n", code: 0 });
    assert.equal((await raw(dir, ["--merged-prs", merged, "--fields", "nope"])).code, 2);
  });
});

test("R10 merges with an equal mergedAt tie-break by PR number, whatever the export order", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    for (const rows of [[10, 11], [11, 10]]) {
      await json(dir, "tie.json", rows.map((number) => ({ number, mergedAt: "2026-11-05T00:00:00Z" })));
      assert.deepEqual((await run(dir, ["--merged-prs", path.join(dir, "tie.json"), "--last", "1"])).perChange.map((c) => c.pr), [11]);
    }
  });
});

test("R11 an unreadable ledger is counted per change and in totals", async () => {
  await withTempDir(async (dir) => {
    await ledger(dir, 10, sha("a"), "2026-11-01T00:00:00.000Z", { roundCause: "first" });
    await ledger(dir, 10, sha("b"), "2026-11-02T00:00:00.000Z", { roundCause: "other_head_move" });
    await ledger(dir, 11, sha("c"), "2026-11-03T00:00:00.000Z");
    await writeFile(path.resolve(dir, buildLogPath({ repo: "o/r", pr: 10, gate: "draft_gate", headSha: sha("d"), tmpRoot: dir })), "{truncated");
    await writeFile(path.resolve(dir, buildLogPath({ repo: "o/r", pr: 11, gate: "draft_gate", headSha: sha("e"), tmpRoot: dir })), "{truncated");
    await json(dir, "merged.json", [{ number: 10, mergedAt: "2026-11-05T00:00:00Z" }, { number: 11, mergedAt: "2026-11-06T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange.map((c) => [c.pr, c.rounds, c.unreadableLedgers]), [[11, 1, 1], [10, 2, 1]]);
    assert.equal(r.totals.unreadableLedgers, 2);
    assert.equal(r.perChange[1].byCause.other_head_move, 1);
  });
});

test("R12 the round-1 draft_gate findings split by developer-checklist coverage on both sides of the cutoff", async () => {
  await withTempDir(async (dir) => {
    const finding = (angle) => ({ severity: "low", angle, summary: angle });
    // coverage and correctness carry developer-checklist ids in the shipped defaults, scope does not.
    await ledger(dir, 30, sha("a"), "2026-11-20T00:00:00.000Z", { findings: [finding("coverage"), finding("scope"), finding("scope")], roundCause: "first" });
    await ledger(dir, 30, sha("b"), "2026-11-20T06:00:00.000Z", { findings: [finding("coverage")], roundCause: "developer_findings" });
    await ledger(dir, 31, sha("c"), "2026-11-22T00:00:00.000Z", { findings: [finding("coverage"), finding("correctness")], roundCause: "first" });
    await ledger(dir, 32, sha("d"), "2026-11-22T00:00:00.000Z", { findings: [finding("scope")], roundCause: "first" });
    await json(dir, "merged.json", [
      { number: 30, mergedAt: "2026-11-23T00:00:00Z" }, { number: 31, mergedAt: "2026-11-23T01:00:00Z" }, { number: 32, mergedAt: "2026-11-23T02:00:00Z" }, { number: 33, mergedAt: "2026-11-23T03:00:00Z" },
    ]);
    await mkdir(path.join(dir, "gate-findings", "o-r"), { recursive: true });
    for (const args of [[], ["--gate", "pre_approval_gate"]]) {
      const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), ...args]);
      assert.deepEqual(r.checklist, { cutoff: "2026-11-21T17:03:00Z", before: { changes: 1, covered: 1, uncovered: 2 }, after: { changes: 2, covered: 2, uncovered: 1 } });
      const byPr = Object.fromEntries(r.perChange.map((c) => [c.pr, c.round1]));
      assert.deepEqual(byPr[30], { loggedAt: "2026-11-20T00:00:00.000Z", side: "before", covered: 1, uncovered: 2 });
      assert.deepEqual(byPr[31], { loggedAt: "2026-11-22T00:00:00.000Z", side: "after", covered: 2, uncovered: 0 });
      assert.deepEqual(byPr[32], { loggedAt: "2026-11-22T00:00:00.000Z", side: "after", covered: 0, uncovered: 1 });
      assert.equal(byPr[33], null);
    }
  });
});

test("R13 a ledger written by the writer reaches the report: retained, intermediate and blocked rounds", async () => {
  await withTempDir(async (dir) => {
    const ID = { repo: "o/r", pr: 1, gate: "draft_gate", tmpRoot: dir, contextTmpRoot: dir };
    const act = JSON.stringify([{ severity: "low", angle: "scope", summary: "x", judgeDisposition: "act" }]);
    const ctx = async (headSha, digest) => {
      const file = path.resolve(dir, buildGateContextPath({ repo: "o/r", pr: 1, gate: "draft_gate", headSha, tmpRoot: dir }));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ requiredReads: [{ kind: "pr-body", sha256: digest }] }));
    };
    const write = (headSha, extra) => writeGateFindingsLog({ ...ID, headSha, verdict: "findings_present", findings: act, ...extra }, { repoRoot: dir });
    await ctx(sha("a"), "1".repeat(64));
    await write(sha("a"));
    await ctx(sha("a"), "2".repeat(64));
    await write(sha("a"));
    await write(sha("b"));
    await write(sha("c"), { findings: JSON.stringify([{ severity: "low", angle: "scope", summary: "x" }]) });
    await write(sha("d"), { verdict: "blocked" });
    await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-30T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.equal(r.perChange[0].rounds, 3);
    assert.equal(r.perChange[0].derivedRounds, 0);
    assert.deepEqual(r.perChange[0].byCause, { ...ZERO, first: 1, body_only: 1, developer_findings: 1 });
  });
});

// main advances after the PR branch forks; B is an own commit, C merges main into the PR head.
function legacyRepo(dir, { land = false } = {}) {
  git(dir, "init", "-q", "-b", "main");
  execFileSync("sh", ["-c", "echo 0 > base.txt"], { cwd: dir });
  git(dir, "add", "."); git(dir, "commit", "-qm", "m0");
  git(dir, "checkout", "-qb", "pr");
  execFileSync("sh", ["-c", "echo pr > pr.txt"], { cwd: dir });
  git(dir, "add", "."); git(dir, "commit", "-qm", "pr");
  const a = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  execFileSync("sh", ["-c", "echo 1 > base.txt"], { cwd: dir });
  git(dir, "commit", "-qam", "m1");
  git(dir, "update-ref", "refs/remotes/origin/main", "main");
  git(dir, "checkout", "-q", "pr");
  execFileSync("sh", ["-c", "echo pr2 > pr.txt"], { cwd: dir });
  git(dir, "commit", "-qam", "own");
  const b = git(dir, "rev-parse", "HEAD");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge main", "main");
  const c = git(dir, "rev-parse", "HEAD");
  if (land) {
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "land pr", "pr");
    git(dir, "update-ref", "refs/remotes/origin/main", "main");
  }
  return { a, b, c };
}

test("R14 legacy rounds derive same head, own commit, base-only merge and an unresolved commit", async () => {
  await withTempDir(async (dir) => {
    const { a, b, c } = legacyRepo(dir);
    const act = { findings: [{ severity: "low", angle: "scope", summary: "x", judgeDisposition: "act" }] };
    await ledger(dir, 20, a, "2026-11-01T00:00:00.000Z", act, 1);
    await ledger(dir, 20, a, "2026-11-01T01:00:00.000Z", act);
    await ledger(dir, 20, b, "2026-11-02T00:00:00.000Z", act);
    await ledger(dir, 20, c, "2026-11-03T00:00:00.000Z");
    await ledger(dir, 20, sha("e"), "2026-11-04T00:00:00.000Z");
    await json(dir, "merged.json", [{ number: 20, mergedAt: "2026-11-05T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    const change = r.perChange[0];
    assert.deepEqual([change.rounds, change.derivedRounds, change.undeterminedRounds], [5, 5, 1]);
    assert.deepEqual(change.byCause, { ...ZERO, first: 1, system_rerun: 1, developer_findings: 1, base_refresh: 1 });
    assert.equal(r.totals.undeterminedRounds, 1);
  });
});

test("R14b a legacy same-head round with a changed PR body digest derives body_only", async () => {
  await withTempDir(async (dir) => {
    const { a } = legacyRepo(dir);
    await ledger(dir, 22, a, "2026-11-01T00:00:00.000Z", { prBodySha256: "1".repeat(64) }, 1);
    await ledger(dir, 22, a, "2026-11-01T01:00:00.000Z", { prBodySha256: "2".repeat(64) });
    await json(dir, "merged.json", [{ number: 22, mergedAt: "2026-11-05T00:00:00Z" }]);
    const change = (await run(dir, ["--merged-prs", path.join(dir, "merged.json")])).perChange[0];
    assert.deepEqual([change.rounds, change.derivedRounds], [2, 2]);
    assert.deepEqual(change.byCause, { ...ZERO, first: 1, body_only: 1 });
  });
});

test("R15 a legacy head contained in the current base after a merge-commit landing is undetermined, not base_refresh", async () => {
  await withTempDir(async (dir) => {
    const { a, b } = legacyRepo(dir, { land: true });
    await ledger(dir, 21, a, "2026-11-01T00:00:00.000Z");
    await ledger(dir, 21, b, "2026-11-02T00:00:00.000Z");
    await json(dir, "merged.json", [{ number: 21, mergedAt: "2026-11-05T00:00:00Z" }]);
    const change = (await run(dir, ["--merged-prs", path.join(dir, "merged.json")])).perChange[0];
    assert.deepEqual([change.byCause.first, change.byCause.base_refresh, change.undeterminedRounds], [1, 0, 1]);
  });
});

test("R16 an unresolved origin/<base> exits naming the ref when a legacy probe is needed", async () => {
  await withTempDir(async (dir) => {
    const { a, b } = legacyRepo(dir);
    await ledger(dir, 22, a, "2026-11-01T00:00:00.000Z");
    await ledger(dir, 22, b, "2026-11-02T00:00:00.000Z");
    await json(dir, "merged.json", [{ number: 22, mergedAt: "2026-11-05T00:00:00Z" }]);
    await assert.rejects(() => raw(dir, ["--merged-prs", path.join(dir, "merged.json"), "--base", "mian"]), /origin\/mian/);
  });
});

const tamper = async (file) => writeFile(file, `${await readFile(file, "utf8")} `);
const retiredRecord = async (dir, headSha, name, content) => {
  const round = path.join(dir, "retired-gate-rounds", headSha, name);
  await mkdir(round, { recursive: true });
  await writeFile(path.join(round, "retirement.json"), typeof content === "string" ? content : JSON.stringify({ gate: "draft_gate", ...content }));
};

test("R17 a ledger with a seal mismatch is excluded and counted, and the report of another change stays intact", async () => {
  await withTempDir(async (dir) => {
    await ledger(dir, 10, sha("a"), "2026-11-01T00:00:00.000Z", { roundCause: "first" });
    await ledger(dir, 10, sha("b"), "2026-11-02T00:00:00.000Z", { roundCause: "developer_findings" }, 1);
    await ledger(dir, 11, sha("c"), "2026-11-03T00:00:00.000Z", { roundCause: "first" });
    await tamper(path.resolve(dir, buildLogPath({ repo: "o/r", pr: 10, gate: "draft_gate", headSha: sha("b"), tmpRoot: dir })).replace(/\.json$/, ".round-1.json"));
    await json(dir, "merged.json", [{ number: 10, mergedAt: "2026-11-05T00:00:00Z" }, { number: 11, mergedAt: "2026-11-06T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange.map((c) => [c.pr, c.rounds, c.outOfBandLedgers]), [[11, 1, 0], [10, 1, 1]]);
    assert.equal(r.totals.outOfBandLedgers, 1);
    assert.deepEqual(r.totals.byCause, { ...ZERO, first: 2 });
  });
});

const checklistRepo = async (dir, devloops) => {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, ".devloops"), devloops);
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await ledger(dir, 40, sha("a"), "2026-11-22T00:00:00.000Z", { findings: [{ severity: "low", angle: "scope", summary: "x" }], roundCause: "first" });
  await json(dir, "merged.json", [{ number: 40, mergedAt: "2026-11-23T00:00:00Z" }]);
};
const SCOPE_CHECKLIST = "version: 1\ngates:\n  draft:\n    angles:\n      - name: scope\n        developer-checklist:\n          - \"SC1: check the scope\"\n";
const runFrom = (dir, repoRoot, args) => {
  let out = "";
  return runCli(["--repo", "o/r", "--tmp-root", dir, "--merged-prs", path.join(dir, "merged.json"), ...args], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, repoRoot }).then(() => JSON.parse(out));
};

test("R18 the checklist config loads from the repository root, also for a run from a subdirectory", async () => {
  await withTempDir(async (dir) => {
    await checklistRepo(dir, SCOPE_CHECKLIST);
    for (const from of [dir, path.join(dir, "scripts")]) {
      assert.deepEqual((await runFrom(dir, from, [])).checklist.after, { changes: 1, covered: 1, uncovered: 0 });
    }
  });
});

test("R19 an invalid .devloops exits with config_load_failed instead of a split over the shipped angles", async () => {
  await withTempDir(async (dir) => {
    await checklistRepo(dir, `${SCOPE_CHECKLIST}unknownKey: 1\n`);
    for (const from of [dir, path.join(dir, "scripts")]) {
      await assert.rejects(() => runFrom(dir, from, []), { code: "config_load_failed" });
    }
  });
});

test("R20 round 1 is the earliest round stamped first, whatever a repeated write did to loggedAt", async () => {
  await withTempDir(async (dir) => {
    const finding = (angle) => ({ severity: "low", angle, summary: angle });
    // W16 sequence: A judged, B written, A rewritten, so A's loggedAt is later than B's.
    await ledger(dir, 41, sha("b"), "2026-11-22T01:00:00.000Z", { findings: [finding("scope")], roundCause: "developer_findings" });
    await ledger(dir, 41, sha("a"), "2026-11-22T02:00:00.000Z", { findings: [finding("coverage"), finding("correctness")], roundCause: "first" });
    await ledger(dir, 42, sha("c"), "2026-11-22T03:00:00.000Z", { findings: [finding("scope")], roundCause: "other_head_move" });
    await ledger(dir, 42, sha("d"), "2026-11-22T04:00:00.000Z", { findings: [finding("coverage")], roundCause: "other_head_move" });
    await json(dir, "merged.json", [{ number: 41, mergedAt: "2026-11-23T00:00:00Z" }, { number: 42, mergedAt: "2026-11-23T01:00:00Z" }]);
    const byPr = Object.fromEntries((await run(dir, ["--merged-prs", path.join(dir, "merged.json")])).perChange.map((c) => [c.pr, c.round1]));
    assert.deepEqual(byPr[41], { loggedAt: "2026-11-22T02:00:00.000Z", side: "after", covered: 2, uncovered: 0 });
    // No round stamped first: the earliest by loggedAt.
    assert.deepEqual(byPr[42], { loggedAt: "2026-11-22T03:00:00.000Z", side: "after", covered: 0, uncovered: 1 });
  });
});

test("R21 a legacy round reads the blocked ledger and the retirement records of its head between the previous round and itself", async () => {
  const merged = (dir) => json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-30T00:00:00Z" }]);
  const cause = async (dir) => (await run(dir, ["--merged-prs", path.join(dir, "merged.json")])).perChange[0].byCause;
  // A blocked round at the head of the first round.
  await withTempDir(async (dir) => {
    await ledger(dir, 1, sha("a"), "2026-11-01T00:00:00.000Z", { verdict: "blocked" });
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { verdict: "clean" }, 1);
    await merged(dir);
    assert.deepEqual(await cause(dir), { ...ZERO, system_rerun: 1 });
  });
  // A whole-round retirement, a scoped retirement and a retirement later than the round.
  const retired = { retiredAt: "2026-11-01T00:30:00.000Z" };
  for (const [record, expected] of [[retired, "system_rerun"], [{ ...retired, scopes: ["u1"] }, "body_only"], [{ retiredAt: "2026-11-02T00:00:00.000Z" }, "first"]]) {
    await withTempDir(async (dir) => {
      await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
      await retiredRecord(dir, sha("a"), "r1", record);
      await merged(dir);
      assert.deepEqual(await cause(dir), { ...ZERO, [expected]: 1 });
    });
  }
  // A retirement before the previous round does not count for the later head.
  await withTempDir(async (dir) => {
    const { a, b } = legacyRepo(dir);
    await ledger(dir, 1, a, "2026-11-02T00:00:00.000Z", { findings: [] });
    await ledger(dir, 1, b, "2026-11-03T00:00:00.000Z", { findings: [] });
    await retiredRecord(dir, b, "r1", { retiredAt: "2026-11-01T00:00:00.000Z" });
    await merged(dir);
    assert.deepEqual(await cause(dir), { ...ZERO, first: 1, other_head_move: 1 });
  });
});

test("R22 a truncated retirement record is skipped and named, and a valid sibling still counts in either name order", async () => {
  for (const [bad, good] of [["r1", "r2"], ["r2", "r1"]]) {
    await withTempDir(async (dir) => {
      git(dir, "init", "-q");
      await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
      await retiredRecord(dir, sha("a"), bad, "{truncated");
      await retiredRecord(dir, sha("a"), good, { retiredAt: "2026-11-01T00:30:00.000Z" });
      await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-30T00:00:00Z" }]);
      const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
      assert.deepEqual(r.perChange[0].byCause, { ...ZERO, system_rerun: 1 });
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], new RegExp(`${bad}/retirement\\.json`));
    });
  }
});

test("R24 a retirement record under a linked worktree counts, run from the checkout root or a subdirectory", async () => {
  for (const sub of [false, true]) {
    await withTempDir(async (dir) => {
      legacyRepo(dir);
      const wt = path.join(dir, "wt");
      git(dir, "worktree", "add", "-q", "-b", "wt-branch", wt);
      await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
      await retiredRecord(path.join(wt, "tmp"), sha("a"), "r1", { retiredAt: "2026-11-01T00:30:00.000Z" });
      await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-30T00:00:00Z" }]);
      let out = "";
      const cwd = sub ? path.join(dir, "sub") : dir;
      await mkdir(cwd, { recursive: true });
      await runCli(["--repo", "o/r", "--tmp-root", dir, "--merged-prs", path.join(dir, "merged.json")], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, repoRoot: cwd });
      assert.deepEqual(JSON.parse(out).perChange[0].byCause, { ...ZERO, system_rerun: 1 });
    });
  }
});

test("R23 --help states the derivation limit, the out-of-band count and the round 1 rule", async () => {
  let out = "";
  await runCli(["--help"], { stdout: { write: (s) => { out += s; } } });
  assert.match(out, /is unread and can undercount system_rerun and body_only/);
  assert.match(out, /outOfBandLedgers counts ledgers of the --gate read whose seal does not match/);
  assert.match(out, /the earliest one stamped\s+first/);
});

const mergedOne = (dir) => json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-30T00:00:00Z" }]);

test("R25 an unreadable retirement directory is skipped and named, not dropped silently", async () => {
  await withTempDir(async (dir) => {
    git(dir, "init", "-q");
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
    await mkdir(path.join(dir, "retired-gate-rounds"), { recursive: true });
    await writeFile(path.join(dir, "retired-gate-rounds", sha("a")), "not a directory");
    await mergedOne(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange[0].byCause, { ...ZERO, first: 1 });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /retirement directory .*unreadable/);
  });
});

test("R26 a blocked ledger without a loggedAt does not count inside a bounded window", async () => {
  await withTempDir(async (dir) => {
    const { a, b } = legacyRepo(dir);
    await ledger(dir, 1, a, "2026-11-02T00:00:00.000Z", { findings: [] });
    await ledger(dir, 1, b, "2026-11-03T00:00:00.000Z", { findings: [] });
    await ledger(dir, 1, b, undefined, { verdict: "blocked", loggedAt: undefined }, 1);
    await mergedOne(dir);
    assert.deepEqual((await run(dir, ["--merged-prs", path.join(dir, "merged.json")])).perChange[0].byCause, { ...ZERO, first: 1, other_head_move: 1 });
  });
});

test("R27 a retirement record under a subdirectory tmp does not change the cause with the working directory", async () => {
  for (const sub of [false, true]) {
    await withTempDir(async (dir) => {
      legacyRepo(dir);
      await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
      await retiredRecord(path.join(dir, "sub", "tmp"), sha("a"), "r1", { retiredAt: "2026-11-01T00:30:00.000Z" });
      await mergedOne(dir);
      let out = "";
      const cwd = sub ? path.join(dir, "sub") : dir;
      await runCli(["--repo", "o/r", "--tmp-root", dir, "--merged-prs", path.join(dir, "merged.json")], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, repoRoot: cwd });
      assert.deepEqual(JSON.parse(out).perChange[0].byCause, { ...ZERO, first: 1 });
    });
  }
});

test("R28 a failed worktree listing in a git checkout is named in warnings", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".git"));
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
    await mergedOne(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.ok(r.warnings.some((w) => /worktree listing failed/.test(w)));
  });
});

test("R30 a run from a directory with no Git checkout warns that the config and worktree records can be unread", async () => {
  await withTempDir(async (dir) => {
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
    await mergedOne(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /is no Git checkout/);
  });
});

test("R31 a run from a bare repository root warns although the worktree listing succeeds", async () => {
  await withTempDir(async (dir) => {
    execFileSync("git", ["init", "-q", "--bare", dir]);
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z", { findings: [] });
    await mergedOne(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.ok(r.warnings.some((w) => /is no Git checkout/.test(w)));
  });
});

test("R29 --gate review counts no draft_gate drop and names both dropped checklist ledgers in warnings", async () => {
  await withTempDir(async (dir) => {
    await ledger(dir, 1, sha("a"), "2026-11-01T01:00:00.000Z");
    await ledger(dir, 1, sha("b"), "2026-11-01T02:00:00.000Z");
    await writeFile(path.resolve(dir, buildLogPath({ repo: "o/r", pr: 1, gate: "draft_gate", headSha: sha("c"), tmpRoot: dir })), "{truncated");
    await tamper(path.resolve(dir, buildLogPath({ repo: "o/r", pr: 1, gate: "draft_gate", headSha: sha("b"), tmpRoot: dir })));
    await mergedOne(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), "--gate", "review"]);
    assert.equal(r.gate, "review");
    assert.equal(r.totals.unreadableLedgers, 0);
    assert.equal(r.totals.outOfBandLedgers, 0);
    assert.ok(r.warnings.some((w) => w.includes(`draft_gate-${sha("c")}.json`)));
    assert.ok(r.warnings.some((w) => w.includes(`draft_gate-${sha("b")}.json`)));
  });
});
