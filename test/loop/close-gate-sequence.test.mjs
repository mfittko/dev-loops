// close-gate-sequence: a sanctioned close of an abandoned fix sequence; a live sequence is never closable.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "bun:test";
import { readSequenceMarker, recoveryHint, sequenceClosurePath, sequenceMarkerPath, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";
import { SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import { FIXER_GRACE_MS, closeGateSequence, defaultActor } from "../../scripts/loop/close-gate-sequence.mjs";
import { SANCTIONED_COMMANDS } from "../../scripts/loop/sanctioned-commands.mjs";
import { withTempDir } from "../_helpers.mjs";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const T0 = Date.parse("2026-11-01T10:00:00Z");
const execution = (dir) => ({ executionIdentity: "f1-abcd1234", workOrderRef: "fixer:o/r#7:head:f1-abcd1234", outputRef: path.join(dir, "out.json") });
const pr = (oid, name = "feat") => async () => ({ pr: { headRefOid: oid, headRefName: name } });
const base = (tmpRoot, extra = {}) => ({ tmpRoot, head: HEAD, repo: "o/r", pr: 7, actor: "tester", now: () => T0, fetchPr: pr(MOVED), ...extra });
const pull = (tmpRoot, ex, pulledAt) => {
  const file = pullReceiptPath(tmpRoot, ex.workOrderRef);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ executionIdentity: ex.executionIdentity, pulledAt }));
};

test("a moved PR head closes: the record is written, then the marker is removed", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const result = await closeGateSequence(base(tmpRoot));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(sequenceClosurePath(tmpRoot, HEAD, ex.executionIdentity), "utf8")), { baselineHead: HEAD, executionIdentity: ex.executionIdentity, condition: "HEAD_MOVED", actor: "tester", closedAt: "2026-11-01T10:00:00.000Z" });
    assert.equal(existsSync(sequenceMarkerPath(tmpRoot, HEAD)), false);
  });
});

test("an old marker without an execution still closes on a moved head", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    assert.equal((await closeGateSequence(base(tmpRoot))).condition, "HEAD_MOVED");
  });
});

test("a live sequence (head unchanged, fixer dispatched recently) is refused and keeps its marker", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const mtime = statSync(sequenceMarkerPath(tmpRoot, HEAD)).mtimeMs;
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => mtime + 60_000 }));
    assert.equal(result.refusal, "sequence_live");
    assert.ok(result.remedy);
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a running fixer is refused even when the head moved", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    pull(tmpRoot, ex, new Date(T0 - 60_000).toISOString());
    const result = await closeGateSequence(base(tmpRoot));
    assert.equal(result.refusal, "fixer_running");
    assert.ok(result.remedy);
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("FIXER_NEVER_PULLED boundary: grace minus 1s is sequence_live, grace plus 1s closes", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const mtime = statSync(sequenceMarkerPath(tmpRoot, HEAD)).mtimeMs;
    const young = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => mtime + FIXER_GRACE_MS - 1000 }));
    assert.equal(young.refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => mtime + FIXER_GRACE_MS + 1000 }))).condition, "FIXER_NEVER_PULLED");
  });
});

test("a pull receipt older than the grace blocks FIXER_NEVER_PULLED: sequence_live, marker kept", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const mtime = statSync(sequenceMarkerPath(tmpRoot, HEAD)).mtimeMs;
    pull(tmpRoot, ex, new Date(mtime - FIXER_GRACE_MS - 1000).toISOString());
    writeFileSync(ex.outputRef, "{}");
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => mtime + FIXER_GRACE_MS + 1000 }));
    assert.equal(result.refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a receipt file that parses to null reads as a running fixer, never FIXER_NEVER_PULLED", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const file = pullReceiptPath(tmpRoot, ex.workOrderRef);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "null");
    const mtime = statSync(sequenceMarkerPath(tmpRoot, HEAD)).mtimeMs;
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => mtime + FIXER_GRACE_MS + 1000 }));
    assert.equal(result.refusal, "fixer_running");
    assert.ok(result.remedy);
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a failed closure record write keeps the marker (record first, marker second)", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    mkdirSync(sequenceClosurePath(tmpRoot, HEAD, ex.executionIdentity), { recursive: true }); // renameSync onto a directory throws
    await assert.rejects(closeGateSequence(base(tmpRoot)));
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("defaultActor prefers DEVLOOPS_RUN_ID and falls back to unknown when userInfo throws", () => {
  const throwing = () => { throw new Error("no passwd entry"); };
  assert.equal(defaultActor({ DEVLOOPS_RUN_ID: "run-1" }, throwing), "run-1");
  assert.equal(defaultActor({}, throwing), "unknown");
  assert.equal(defaultActor({}, () => ({ username: "me" })), "me");
});

test("readSequenceMarker accepts a well-formed execution and rejects malformed ones", async () => {
  await withTempDir(async (tmpRoot) => {
    const good = { executionIdentity: "f1793537149889-09e1d637", workOrderRef: "fixer:o/r#7:draft_gate:abc:f1793537149889-09e1d637", outputRef: "/abs/tmp/out.json" };
    const bad = [
      { executionIdentity: "x/../../../evil", workOrderRef: "w", outputRef: "o" },
      { executionIdentity: "f1793537149889-09e1d637" },
      { executionIdentity: 42, workOrderRef: "w", outputRef: "o" },
      { executionIdentity: "f1793537149889-09e1d637", workOrderRef: "", outputRef: "o" },
    ];
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: good });
    assert.deepEqual(readSequenceMarker(tmpRoot, HEAD).execution, good);
    for (const execution of bad) {
      writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution });
      assert.equal(readSequenceMarker(tmpRoot, HEAD).execution, undefined);
    }
  });
});

test("a work order never pulled past the dispatch grace closes as FIXER_NEVER_PULLED", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => Date.now() + FIXER_GRACE_MS + 1000 }));
    assert.equal(result.condition, "FIXER_NEVER_PULLED");
  });
});

test("a fixer that pulls while the PR is read is sequence_live: marker kept, no closure record", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const pullsDuringFetch = async () => { pull(tmpRoot, ex, new Date().toISOString()); return pr(HEAD)(); };
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pullsDuringFetch, now: () => Date.now() + FIXER_GRACE_MS + 1000 }));
    assert.equal(result.refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
    assert.equal(existsSync(sequenceClosurePath(tmpRoot, HEAD, ex.executionIdentity)), false);
  });
});

test("unproven abandonment is refused: no execution, no branch, no PR, wrong branch, absent marker", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    const refusals = [
      [await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) })), "abandonment_unproven"],
      [await closeGateSequence(base(tmpRoot, { pr: undefined })), "abandonment_unproven"],
      [await closeGateSequence(base(tmpRoot, { fetchPr: pr(MOVED, "other") })), "abandonment_unproven"],
      [await closeGateSequence(base(tmpRoot, { head: MOVED })), "sequence_absent"],
    ];
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD });
    refusals.push([await closeGateSequence(base(tmpRoot)), "abandonment_unproven"]);
    for (const [result, code] of refusals) {
      assert.equal(result.refusal, code);
      assert.ok(typeof result.remedy === "string" && result.remedy !== "");
    }
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("recoveryHint names the close command", () => {
  assert.match(recoveryHint("/x/gate-delta/h.sequence"), /close-gate-sequence\.mjs/);
});

test("pulled and handed back with the head unchanged stays sequence_live", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeFileSync(ex.outputRef, "{}");
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    pull(tmpRoot, ex, new Date(T0 - 60_000).toISOString());
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) }))).refusal, "sequence_live");
  });
});

test("a pull older than the grace with the head moved closes as HEAD_MOVED", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    pull(tmpRoot, ex, new Date(T0 - FIXER_GRACE_MS - 1000).toISOString());
    assert.equal((await closeGateSequence(base(tmpRoot))).condition, "HEAD_MOVED");
  });
});

test("an unparseable pulledAt or a garbage receipt reads as a running fixer", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    pull(tmpRoot, ex, "not a date");
    assert.equal((await closeGateSequence(base(tmpRoot))).refusal, "fixer_running");
    writeFileSync(pullReceiptPath(tmpRoot, ex.workOrderRef), "{garbage");
    assert.equal((await closeGateSequence(base(tmpRoot))).refusal, "fixer_running");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a malformed marker or an invalid PR head sha is abandonment_unproven", async () => {
  await withTempDir(async (tmpRoot) => {
    mkdirSync(path.dirname(sequenceMarkerPath(tmpRoot, HEAD)), { recursive: true });
    writeFileSync(sequenceMarkerPath(tmpRoot, HEAD), "{not json");
    assert.equal((await closeGateSequence(base(tmpRoot))).refusal, "abandonment_unproven");
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pr("HEAD~1") }))).refusal, "abandonment_unproven");
  });
});

test("a marker re-emitted while the PR is read is sequence_live and survives", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const reemit = async () => { writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: { ...execution(tmpRoot), executionIdentity: "f1-ffff0000" } }); return pr(MOVED)(); };
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: reemit }))).refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a second close on the same head keeps the first closure record", async () => {
  await withTempDir(async (tmpRoot) => {
    for (const id of ["f1-abcd1234", "f1-bbbb2222"]) {
      writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: { ...execution(tmpRoot), executionIdentity: id } });
      assert.equal((await closeGateSequence(base(tmpRoot))).ok, true);
    }
    assert.equal(existsSync(sequenceClosurePath(tmpRoot, HEAD, "f1-abcd1234")), true);
    assert.equal(existsSync(sequenceClosurePath(tmpRoot, HEAD, "f1-bbbb2222")), true);
  });
});

const cli = path.join(import.meta.dir, "../../scripts/loop/close-gate-sequence.mjs");

test("the CLI refuses a non-numeric --pr", () => {
  const run = spawnSync("node", [cli, "--head", HEAD, "--repo", "o/r", "--pr", "12abc"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage/);
});

test("the CLI refuses a malformed --repo with the usage error", () => {
  for (const repo of ["o", "", "o/r/x", "/r"]) {
    const run = spawnSync("node", [cli, "--head", HEAD, "--repo", repo, "--pr", "7"], { encoding: "utf8" });
    assert.equal(run.status, 1, `--repo ${JSON.stringify(repo)}`);
    assert.match(run.stderr, /usage/);
  }
});

test("the CLI accepts a padded --repo: it passes the usage check and reaches the sequence lookup", () => {
  const run = spawnSync("node", [cli, "--head", HEAD, "--repo", " o/r ", "--pr", "7"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /usage/);
  assert.match(run.stdout + run.stderr, /sequence_absent/);
});

test("a padded --repo reaches fetchPr trimmed: gh is called with the normalized slug", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, ".git"));
    writeSequenceMarker({ tmpRoot: path.join(dir, "tmp"), baselineHead: HEAD, branch: "feat" });
    const log = path.join(dir, "gh-args.txt");
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\nprintf '%s\\n' '{"headRefOid":"${MOVED}","headRefName":"feat"}'\n`, { mode: 0o755 });
    const run = spawnSync("node", [cli, "--head", HEAD, "--repo", " o/r ", "--pr", "7"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(readFileSync(log, "utf8").trim(), "pr view 7 --repo o/r --json headRefOid,headRefName");
  });
});

test("the CLI --help exits 0 and prints usage with the --jq and --silent options", () => {
  const run = spawnSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: close-gate-sequence/);
  assert.match(run.stdout, /--jq/);
  assert.match(run.stdout, /--silent/);
});

test("the close command is registered as a sanctioned command and a gate route", () => {
  assert.equal(SANCTIONED_COMMANDS.lifecycle["close-gate-sequence"], "scripts/loop/close-gate-sequence.mjs");
  assert.equal(SUBCOMMAND_ROUTES.gate["close-sequence"], "scripts/loop/close-gate-sequence.mjs");
});

test("a marker of another repo or PR is refused even when the branch name matches", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    assert.equal((await closeGateSequence(base(tmpRoot, { repo: "x/y" }))).refusal, "abandonment_unproven");
    assert.equal((await closeGateSequence(base(tmpRoot, { pr: 8 }))).refusal, "abandonment_unproven");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a fixer that pulls during the PR read blocks a HEAD_MOVED close", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const pullDuring = async () => { pull(tmpRoot, ex, new Date(T0).toISOString()); return pr(MOVED)(); };
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pullDuring }))).refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a fixer that pulls just before the marker removal blocks the close", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    let calls = 0;
    // With HEAD_MOVED the only clock read is the record timestamp, taken after the post-read check.
    const now = () => { calls += 1; if (calls === 1) pull(tmpRoot, ex, new Date(T0).toISOString()); return T0; };
    assert.equal((await closeGateSequence(base(tmpRoot, { now }))).refusal, "sequence_live");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("the CLI rejects an invalid --jq or --fields before the marker is touched", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, ".git"));
    const tmpRoot = path.join(dir, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    for (const flags of [["--jq", "select("], ["--fields", "a,,b"]]) {
      const run = spawnSync("node", [cli, "--head", HEAD, "--repo", "o/r", "--pr", "7", ...flags], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 2, run.stderr);
      assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
    }
  });
});

test("the CLI forwards --fields and --silent on a successful close", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, ".git"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '{"headRefOid":"${MOVED}","headRefName":"feat"}'\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const args = [cli, "--head", HEAD, "--repo", "o/r", "--pr", "7"];
    writeSequenceMarker({ tmpRoot: path.join(dir, "tmp"), baselineHead: HEAD, branch: "feat" });
    const fields = spawnSync("node", [...args, "--fields", "condition"], { cwd: dir, encoding: "utf8", env });
    assert.equal(fields.status, 0, fields.stderr);
    assert.equal(fields.stdout, "HEAD_MOVED\n");
    writeSequenceMarker({ tmpRoot: path.join(dir, "tmp"), baselineHead: HEAD, branch: "feat" });
    const silent = spawnSync("node", [...args, "--silent"], { cwd: dir, encoding: "utf8", env });
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout, "");
    writeSequenceMarker({ tmpRoot: path.join(dir, "tmp"), baselineHead: HEAD, branch: "feat" });
    const falsy = spawnSync("node", [...args, "--silent", "--jq", ".condition == \"X\""], { cwd: dir, encoding: "utf8", env });
    assert.equal(falsy.status, 1);
  });
});
