import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { judgePassCli, parseJudgePassCliArgs } from "../../scripts/loop/judge-pass.mjs";
import { buildGateFaninLedgerPath, buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { copilotBodyJudgePath } from "../../scripts/github/_copilot-body-disposition.mjs";
import { judgeSkipRefusal } from "../../scripts/loop/judge-skip.mjs";

const HEAD = "0123456789abcdef".padEnd(40, "0");
const SPEC = { acceptanceCriteria: ["a"], definitionOfDone: ["d"], nonGoals: ["n"] };

async function setup(findings, overallVerdict = "clean") {
  const root = await mkdtemp(path.join(os.tmpdir(), "judge-skip-"));
  const body = JSON.stringify({ overallVerdict, findings });
  await writeFile(path.join(root, "findings.json"), body);
  const keyed = path.join(root, buildGateFaninLedgerPath({ repo: "o/r", pr: 1, gate: "draft_gate", headSha: HEAD, tmpRoot: "tmp" }));
  await mkdir(path.dirname(keyed), { recursive: true });
  await writeFile(keyed, body);
  await writeFile(path.join(root, "spec.json"), JSON.stringify(SPEC));
  const options = parseJudgePassCliArgs([
    "--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD, "--judge-skip",
    "--findings-file", "findings.json", "--ledger-out", "ledger.json", "--out", "act.json",
    "--spec-file", "spec.json", "--content-digest", `sha256:${"a".repeat(64)}`, "--tmp-root", "tmp",
  ]);
  return { root, options };
}

test("GATE-EXEC-JUDGE-SKIP-EMPTY: a zero-finding round skips the judge and records the skip, scope drift and notice", async () => {
  const { root, options } = await setup([]);
  const result = await judgePassCli(options, { repoRoot: root });
  assert.equal(result.ok, true);
  assert.match(result.judgeSkipped.reason, /nothing for the judge/);
  assert.equal(result.scopeDrift.verdict, "within_scope");
  assert.match(result.scopeDrift.rationale, /spec identity sha256:/);
  assert.match(result.findingsSummary, /Judge skipped: .*no consolidated findings/);
  const ledger = JSON.parse(await readFile(path.join(root, "ledger.json"), "utf8"));
  assert.equal(ledger.overallVerdict, "clean");
  assert.deepEqual(ledger.findings, []);
  assert.ok(ledger.judgeSkipped.reason);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "act.json"), "utf8")), []);
});

test("a round with a finding still requires the judge", async () => {
  const { root, options } = await setup([{ severity: "low", angle: "x", summary: "s", disposition: "unjudged" }]);
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /judge-skip refused.*1 consolidated finding/);
});

test("a findings file that is not the head's fan-in ledger refuses", async () => {
  const { root, options } = await setup([]);
  await writeFile(path.join(root, "findings.json"), JSON.stringify({ overallVerdict: "clean", findings: [], stale: true }));
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /not the fan-in ledger/);
});

test("a round with no head-keyed fan-in ledger refuses", async () => {
  const { root, options } = await setup([]);
  await rm(path.join(root, "tmp"), { recursive: true });
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /no fan-in ledger exists/);
});

test("a round retired after its fan-in ledger was written refuses", async () => {
  const { root, options } = await setup([]);
  const dir = path.join(root, "tmp", "retired-gate-rounds", HEAD, "r1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: new Date(Date.now() + 60_000).toISOString() }));
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /retired as r1/);
});

test("a pr_scope spec on a lifecycle gate refuses", async () => {
  const { root, options } = await setup([]);
  await writeFile(path.join(root, "spec.json"), JSON.stringify({ ...SPEC, specKind: "pr_scope" }));
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /only the review gate accepts/);
});

test("a carried act item still requires the judge", () => {
  assert.match(judgeSkipRefusal({ findings: [], priorActItems: [{ fingerprint: "f" }] }), /carried act item/);
  assert.equal(judgeSkipRefusal({ findings: [], priorActItems: [] }), null);
});

const PRIOR = "f".repeat(40);

async function seedPriorLog(root, body) {
  const file = path.join(root, buildLogPath({ repo: "o/r", pr: 1, gate: "draft_gate", headSha: PRIOR, tmpRoot: "tmp" }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

test("a closed prior round with an open act item still requires the judge through judgePassCli", async () => {
  const { root, options } = await setup([]);
  const finding = { severity: "low", angle: "x", summary: "s", judgeDisposition: "act", judgeTitle: "t", file: "a.mjs", line: 1 };
  await seedPriorLog(root, JSON.stringify({ headSha: PRIOR, repo: "o/r", gate: "draft_gate", pr: 1, verdict: "findings_present", findings: [finding] }));
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /carried act item/);
});

test("an unreadable prior findings log fails the skip closed", async () => {
  const { root, options } = await setup([]);
  await seedPriorLog(root, '{"headSha": "truncated');
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /prior findings log\(s\) unreadable/);
});

test("an uppercase --head-sha with surrounding whitespace is normalized to lowercase", async () => {
  const { root, options } = await setup([]);
  const opts = parseJudgePassCliArgs(["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", ` ${HEAD.toUpperCase()} `, "--judge-skip", "--findings-file", "findings.json", "--spec-file", "spec.json", "--content-digest", `sha256:${"a".repeat(64)}`, "--tmp-root", "tmp"]);
  assert.equal(opts.headSha, HEAD);
  const result = await judgePassCli(opts, { repoRoot: root });
  assert.equal(result.headSha, HEAD);
});

test("a non-hex or empty --head-sha is rejected", () => {
  for (const sha of ["not-a-sha!", ""]) {
    assert.throws(() => parseJudgePassCliArgs(["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", sha, "--judge-skip", "--findings-file", "f.json", "--spec-file", "s.json", "--content-digest", `sha256:${"a".repeat(64)}`]), /--head-sha/);
  }
});

test("--judge-skip refuses judge artifact flags", () => {
  assert.throws(() => parseJudgePassCliArgs(["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD, "--judge-skip", "--findings-file", "f.json", "--spec-file", "s.json", "--content-digest", `sha256:${"a".repeat(64)}`, "--judge-verdict", "v.json"]), /judge-skip takes no --judge-verdict/);
});

const BASE = ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD, "--judge-skip", "--findings-file", "f.json"];

test("--judge-skip requires --spec-file and --content-digest", () => {
  assert.throws(() => parseJudgePassCliArgs(BASE), /--spec-file is required with --judge-skip/);
  assert.throws(() => parseJudgePassCliArgs([...BASE, "--spec-file", "s.json"]), /--content-digest is required/);
});

test("--judge-skip refuses the silently ignored flags", () => {
  const spec = ["--spec-file", "s.json", "--content-digest", `sha256:${"a".repeat(64)}`];
  for (const flag of ["--approvals-out", "--prior-approvals", "--changed-paths", "--coverage-map", "--carry-forward-proof"]) {
    assert.throws(() => parseJudgePassCliArgs([...BASE, ...spec, flag, "x.json"]), new RegExp(`judge-skip ignores ${flag}`));
  }
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const hermeticGit = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe", env: GIT_ENV });

test("a blocked zero-finding round still requires the judge through judgePassCli", async () => {
  const { root, options } = await setup([], "blocked");
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /blocked/);
});

test("pending Copilot body feedback for the head still requires the judge", async () => {
  const { root, options } = await setup([]);
  const file = path.join(root, copilotBodyJudgePath({ tmpRoot: "tmp", repo: "o/r", pr: 1, headSha: HEAD }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}");
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /pending Copilot body feedback/);
});

test("a blocked zero-finding round still requires the judge", () => {
  assert.match(judgeSkipRefusal({ findings: [], priorActItems: [], overallVerdict: "blocked" }), /blocked/);
});

test("without --tmp-root a worktree finds the ledger consolidate-fanin wrote under its own tmp/", async () => {
  const { root, options } = await setup([]);
  const git = hermeticGit;
  const main = path.join(root, "main");
  const worktree = path.join(root, "wt");
  await mkdir(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "i");
  git(main, "worktree", "add", "-q", worktree, "-b", "wt");
  for (const file of ["findings.json", "spec.json", "tmp"]) await cp(path.join(root, file), path.join(worktree, file), { recursive: true });
  const { tmpRoot, ...rest } = options;
  const result = await judgePassCli(rest, { repoRoot: worktree });
  assert.equal(result.ok, true);
});

test("a retirement recorded under a different checkout's tmp than the fan-in ledger refuses", async () => {
  const { root, options } = await setup([]);
  const git = hermeticGit;
  const main = path.join(root, "main");
  const worktree = path.join(root, "wt");
  await mkdir(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "i");
  git(main, "worktree", "add", "-q", worktree, "-b", "wt");
  for (const file of ["findings.json", "spec.json", "tmp"]) await cp(path.join(root, file), path.join(worktree, file), { recursive: true });
  const dir = path.join(main, "tmp", "retired-gate-rounds", HEAD, "r1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: new Date(Date.now() + 60_000).toISOString() }));
  const { tmpRoot, ...rest } = options;
  await assert.rejects(judgePassCli(rest, { repoRoot: worktree }), /retired as r1/);
});
