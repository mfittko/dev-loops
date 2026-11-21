import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";
import { runChild } from "@dev-loops/core/cli/primitives";
import { classifyGhCall, ghAsync, ghSync, GH_CALL_LOG_ENV, recordGhCall, resolveGhCallLogPath, summarizeGhCallLog, summarizeGhCalls } from "@dev-loops/core/github/gh-call-log";
import { runCli } from "../../scripts/loop/gh-calls.mjs";
import { readdirSync, statSync } from "node:fs";
import { withTempDir } from "../_helpers.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MODULE_URL = new URL("../../packages/core/src/github/gh-call-log.mjs", import.meta.url).href;

const SAVED_LOG = process.env[GH_CALL_LOG_ENV];
afterEach(() => { if (SAVED_LOG === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = SAVED_LOG; });

const readLog = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Fake `gh` on PATH that exits with `code` and prints `stderr`. */
function fakeGhEnv(dir, { code = 0, stderr = "" } = {}) {
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\necho '[]'\necho '${stderr}' >&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
}

test("recordGhCall writes one JSONL record with script, pr, kind, subcommand and json fields", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "nested", "gh-calls.jsonl");
    recordGhCall(["pr", "view", "42", "--repo", "o/r", "--json", "title,state"], { durationMs: 7, status: 0, script: "/x/info.mjs", logPath });
    assert.deepEqual(readLog(logPath).map(({ timestamp, ...rest }) => rest), [
      { script: "info.mjs", pr: 42, kind: "graphql", subcommand: "pr view --json title,state", durationMs: 7, status: 0, rateLimited: false },
    ]);
  });
});

test("recordGhCall flags a rate-limit refusal only on a failed call", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    recordGhCall(["api", "graphql"], { durationMs: 1, status: 1, stderr: "API rate limit already exceeded", logPath });
    recordGhCall(["api", "graphql"], { durationMs: 1, status: 0, stderr: "rate limit mentioned", logPath });
    assert.deepEqual(readLog(logPath).map((r) => r.rateLimited), [true, false]);
  });
});

test("classifyGhCall separates graphql, rest and pr diff", () => {
  assert.equal(classifyGhCall(["api", "graphql"]), "graphql");
  assert.equal(classifyGhCall(["api", "repos/o/r/pulls/1"]), "rest");
  assert.equal(classifyGhCall(["pr", "view", "1"]), "graphql");
  assert.equal(classifyGhCall(["pr", "diff", "1"]), "rest");
});

test("two concurrent writers leave every line whole", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const writer = path.join(dir, "writer.mjs");
    writeFileSync(writer, `import { recordGhCall } from ${JSON.stringify(MODULE_URL)};\nfor (let i = 0; i < 100; i += 1) recordGhCall(["pr", "view", String(i), "--json", "a".repeat(2000)], { durationMs: 1, status: 0, logPath: process.argv[2] });\n`);
    await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [writer, logPath], { stdio: "ignore", timeout: 60_000 });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))));
    })));
    assert.equal(readLog(logPath).length, 200);
  });
});

test("an unwritable log path never fails or alters the gh call", async () => {
  await withTempDir(async (dir) => {
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    assert.doesNotThrow(() => recordGhCall(["pr", "view", "1"], { durationMs: 1, status: 0, logPath: path.join(blocker, "sub", "log.jsonl") }));
    process.env[GH_CALL_LOG_ENV] = path.join(blocker, "sub", "log.jsonl");
    const env = fakeGhEnv(dir);
    const result = await runChild("gh", ["pr", "list"], env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "[]");
  });
});

test("runChild logs a gh call and skips a non-gh command", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    process.env[GH_CALL_LOG_ENV] = logPath;
    const env = fakeGhEnv(dir, { code: 1, stderr: "secondary rate limit" });
    const result = await runChild("gh", ["api", "graphql"], env);
    assert.equal(result.code, 1);
    await runChild("true", [], env);
    const records = readLog(logPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "graphql");
    assert.equal(records[0].rateLimited, true);
  });
});

test("ghSync records a success, and records then rethrows a failure", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = { PATH: process.env.PATH, log: process.env[GH_CALL_LOG_ENV] };
    process.env[GH_CALL_LOG_ENV] = logPath;
    try {
      process.env.PATH = fakeGhEnv(dir).PATH;
      assert.equal(ghSync(["pr", "list"], { encoding: "utf8", timeout: 10_000 }).trim(), "[]");
      process.env.PATH = fakeGhEnv(dir, { code: 3, stderr: "boom" }).PATH;
      assert.throws(() => ghSync(["pr", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }));
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.log === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved.log;
    }
    assert.deepEqual(readLog(logPath).map((r) => r.status), [0, 3]);
  });
});

const DIRECT_GH_SPAWN = /(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*(?:"gh"|ghCommand)\b|ghCommand[^\n]*\b(?:exec|runChild)\s*=\s*execFileSync\b/u;
// verify-release-approval runs under bare node before any install, so it cannot import core and stays unrecorded.
const ALLOWED_SPAWNERS = new Set(["packages/core/src/github/gh-call-log.mjs", "packages/core/src/cli/primitives.mjs", "scripts/release/verify-release-approval.mjs"]);

function sourceFiles(dir) {
  return readdirSync(path.join(REPO_ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === "test" || name === "tests") return [];
    if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return rel.endsWith(".mjs") && !/\.test\.mjs$/u.test(name) ? [rel] : [];
  });
}

test("no non-test source spawns gh outside the recording helpers", () => {
  const offenders = ["scripts", "packages", "cli"]
    .flatMap((dir) => (dir === "cli" ? ["cli/index.mjs"] : sourceFiles(dir)))
    .filter((file) => !ALLOWED_SPAWNERS.has(file) && DIRECT_GH_SPAWN.test(readFileSync(path.join(REPO_ROOT, file), "utf8")));
  assert.deepEqual(offenders, []);
});

test("recordGhCall extracts the PR number per command kind", () => {
  const prOf = (args) => {
    const logPath = path.join(REPO_ROOT, "tmp", "issue-3338-pr-probe.jsonl");
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, "");
    recordGhCall(args, { durationMs: 1, status: 0, logPath });
    return readLog(logPath)[0].pr;
  };
  assert.equal(prOf(["api", "repos/o/r/pulls/12/reviews", "--paginate"]), 12);
  assert.equal(prOf(["api", "repos/o/r/issues/13/comments"]), 13);
  assert.equal(prOf(["api", "repos/o/r/pulls"]), null);
  assert.equal(prOf(["api", "graphql", "-F", "pr=14", "-f", "query=q"]), 14);
  assert.equal(prOf(["api", "graphql", "--raw-field", "number=15", "-f", "query=q"]), 15);
  assert.equal(prOf(["api", "graphql", "-f", "query=q", "-F", "first=50"]), null);
  assert.equal(prOf(["pr", "view", "--repo", "o/r", "16"]), 16);
  assert.equal(prOf(["pr", "list", "--limit", "50"]), null);
});

test("the log path env override resolves against the main checkout when relative", () => {
  assert.equal(resolveGhCallLogPath(REPO_ROOT, { [GH_CALL_LOG_ENV]: "/abs/x.jsonl" }), "/abs/x.jsonl");
  assert.ok(path.isAbsolute(resolveGhCallLogPath(REPO_ROOT, { [GH_CALL_LOG_ENV]: "rel/x.jsonl" })));
});

test("recordGhCall flags the secondary submission refusal as rate limited", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    recordGhCall(["pr", "comment"], { durationMs: 1, status: 1, stderr: "was submitted too quickly", logPath });
    assert.equal(readLog(logPath)[0].rateLimited, true);
  });
});

test("search is classified as rest", () => {
  assert.equal(classifyGhCall(["search", "issues"]), "rest");
});

test("ghSync with an unwritable log path still returns the gh output", async () => {
  await withTempDir(async (dir) => {
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    process.env[GH_CALL_LOG_ENV] = path.join(blocker, "sub", "log.jsonl");
    const saved = process.env.PATH;
    try {
      process.env.PATH = fakeGhEnv(dir).PATH;
      assert.equal(ghSync(["pr", "list"], { encoding: "utf8", timeout: 10_000 }).trim(), "[]");
    } finally { process.env.PATH = saved; }
  });
});

test("ghAsync records a failure and rethrows it", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    process.env[GH_CALL_LOG_ENV] = logPath;
    const saved = process.env.PATH;
    try {
      process.env.PATH = fakeGhEnv(dir, { code: 4, stderr: "boom" }).PATH;
      await assert.rejects(ghAsync(["api", "graphql"], { timeout: 10_000 }));
    } finally { process.env.PATH = saved; }
    assert.deepEqual(readLog(logPath).map((r) => [r.status, r.kind]), [[4, "graphql"]]);
  });
});

test("recordGhCall on a directory log path never throws (write-side EISDIR)", async () => {
  await withTempDir(async (dir) => {
    assert.doesNotThrow(() => recordGhCall(["pr", "list"], { durationMs: 1, status: 0, logPath: dir }));
  });
});

test("summarizeGhCallLog rethrows a read error other than ENOENT (EISDIR)", async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => summarizeGhCallLog(dir), { code: "EISDIR" });
  });
});

test("gh-calls CLI prints help and rejects an unknown flag", async () => {
  let out = "";
  await runCli(["--help"], { stdout: { write: (s) => { out += s; } } });
  assert.match(out, /Usage:/u);
  await assert.rejects(runCli(["--bogus"], { stdout: { write() {} } }));
});

test("summarizeGhCalls counts per script, pr and minute, graphql share and refusals, skipping bad lines", () => {
  const lines = [
    { timestamp: "2026-11-20T10:00:05Z", script: "a.mjs", pr: 1, kind: "graphql", rateLimited: true },
    { timestamp: "2026-11-20T10:00:50Z", script: "a.mjs", pr: 1, kind: "rest", rateLimited: false },
    { timestamp: "2026-11-20T10:01:00Z", script: "b.mjs", pr: null, kind: "graphql", rateLimited: false },
  ].map((r) => JSON.stringify(r));
  assert.deepEqual(summarizeGhCalls([...lines, "not json", ""].join("\n")), {
    total: 3, graphql: 2, graphqlShare: 0.667, rateLimited: 1,
    perScript: { "a.mjs": 2, "b.mjs": 1 }, perPr: { 1: 2 },
    perMinute: { "2026-11-20T10:00": 2, "2026-11-20T10:01": 1 },
  });
  assert.equal(summarizeGhCalls("[1,2]").total, 0);
});

test("gh-calls CLI summarizes a fixture log and treats a missing log as empty", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    recordGhCall(["api", "graphql"], { durationMs: 1, status: 1, stderr: "rate limit", script: "s.mjs", logPath });
    let out = "";
    await runCli(["--log", logPath], { stdout: { write: (s) => { out += s; } } });
    assert.deepEqual([JSON.parse(out).total, JSON.parse(out).rateLimited, JSON.parse(out).graphqlShare], [1, 1, 1]);
    out = "";
    await runCli(["--log", path.join(dir, "missing.jsonl")], { stdout: { write: (s) => { out += s; } } });
    assert.equal(JSON.parse(out).total, 0);
  });
});
