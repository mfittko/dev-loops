import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runCli } from "../../scripts/loop/round-causes.mjs";
import { withTempDir } from "../_helpers.mjs";
import { buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { writeSealed } from "../../scripts/github/_gate-artifact-seal.mjs";

const sha = (c) => c.repeat(40);
const ZERO = { first: 0, developer_findings: 0, system_rerun: 0, base_refresh: 0, body_only: 0 };

async function ledger(dir, pr, headSha, loggedAt, extra = {}, retainedRound) {
  const file = path.resolve(dir, buildLogPath({ repo: "o/r", pr, gate: "draft_gate", headSha, tmpRoot: dir }));
  await mkdir(path.dirname(file), { recursive: true });
  const target = retainedRound ? file.replace(/\.json$/, `.round-${retainedRound}.json`) : file;
  await writeSealed(target, JSON.stringify({ repo: "o/r", pr, gate: "draft_gate", headSha, verdict: "clean", loggedAt, roundIdentity: { completed: true }, findings: [], ...extra }));
}
const run = async (dir, args) => {
  let out = "";
  await runCli(["--repo", "o/r", "--tmp-root", dir, ...args], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, repoRoot: dir });
  return JSON.parse(out);
};
const json = (dir, name, value) => writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

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
    assert.equal(r.totals.byCausePerMerge.first, 1);
    assert.equal(r.issues, null);
  });
});

test("R2 --last keeps the newest merges", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json"), "--last", "2"]);
    assert.deepEqual(r.window, { merges: 2, from: "2026-11-06T00:00:00Z", to: "2026-11-07T00:00:00Z" });
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

test("R4 a merged change without a ledger directory has zero rounds", async () => {
  await withTempDir(async (dir) => {
    await json(dir, "merged.json", [{ number: 99, mergedAt: "2026-11-05T00:00:00Z" }]);
    const r = await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.deepEqual(r.perChange, [{ pr: 99, mergedAt: "2026-11-05T00:00:00Z", rounds: 0, derivedRounds: 0, byCause: ZERO }]);
  });
});

test("R5 argument and export errors name the cause", async () => {
  await withTempDir(async (dir) => {
    await json(dir, "merged.json", [{ number: 1, mergedAt: "2026-11-05T00:00:00Z" }]);
    await json(dir, "bad.json", "not json");
    await json(dir, "nodate.json", [{ number: 1 }]);
    const merged = path.join(dir, "merged.json");
    const fails = (args, re) => assert.rejects(() => runCli(args, { stdout: { write() {} }, repoRoot: dir }), re);
    await fails(["--merged-prs", merged, "--bogus"], /bogus/);
    await fails(["--merged-prs", merged], /--repo is required/);
    await fails(["--repo", "o/r"], /--merged-prs is required/);
    await fails(["--repo", "o/r", "--merged-prs", merged, "--last", "0"], /--last/);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "bad.json")], /bad\.json/);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "nodate.json")], /mergedAt/);
    await fails(["--repo", "o/r", "--merged-prs", merged, "--gate", "bogus_gate"], /--gate must be one of/);
    await fails(["--repo", "nope", "--merged-prs", merged], /--repo must be/);
    await json(dir, "loose.json", [{ number: 1, mergedAt: "yesterday" }]);
    await fails(["--repo", "o/r", "--merged-prs", path.join(dir, "loose.json")], /mergedAt/);
  });
});

test("R6 the report makes no gh call", async () => {
  await withTempDir(async (dir) => {
    await fixture(dir);
    const log = process.env.DEVLOOPS_GH_CALL_LOG;
    const before = existsSync(log) ? readFileSync(log, "utf8") : "";
    await run(dir, ["--merged-prs", path.join(dir, "merged.json")]);
    assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", before);
  });
});

test("R7 --help prints usage", async () => {
  let out = "";
  await runCli(["--help"], { stdout: { write: (s) => { out += s; } } });
  assert.match(out, /dev-loops loop round-causes/);
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
