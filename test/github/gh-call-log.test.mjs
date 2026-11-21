import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";
import { runChild } from "@dev-loops/core/cli/primitives";
import { classifyGhCall, execFileSyncRecorded, ghAsync, ghSync, GH_CALL_LOG_ENV, recordGhCall, resolveGhCallLogPath, spawnRecorded, summarizeGhCallLog, summarizeGhCalls } from "@dev-loops/core/github/gh-call-log";
import { EventEmitter } from "node:events";
import { runCli } from "../../scripts/loop/gh-calls.mjs";
import { verifyReleaseApproval } from "../../scripts/release/verify-release-approval.mjs";
import { postGateVerdictViaGh } from "../../skills/dev-loop/scripts/post-gate-verdict-fallback.mjs";
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

const RAW_SPAWNERS = /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\(/u;
const GH_CALL = /(?<![.\w])(\w+)\(\s*(?:"gh"|ghCommand)\s*,/gu;
const RECORDING_CALLS = new Set(["spawnRecorded", "execFileSyncRecorded"]);
const GH_COMMAND_SEAM_DEFAULT = /ghCommand[^\n]*\b(?:exec|runChild)\s*=\s*execFileSync\b/u;

/**
 * True when `source` passes the literal "gh" or `ghCommand` as the command to a raw child_process
 * function or to a file-local wrapper that spawns raw. A `recordGhCall` call exempts only the top-level
 * block (up to the next line that starts in column 0) that contains it, never the whole file.
 * shortcut: a block is the coarse unit, so a raw spawn beside a record inside one block passes; upgrade with a parser.
 */
export function hasUnrecordedGhCall(source) {
  if (GH_COMMAND_SEAM_DEFAULT.test(source)) return true;
  let offset = 0;
  const blocks = source.split(/\n(?=\S)/u).map((text) => { const block = { text, start: offset }; offset += text.length + 1; return block; });
  const blockAt = (index) => blocks.findLast((b) => b.start <= index).text;
  return [...source.matchAll(GH_CALL)].some((match) => {
    const name = match[1];
    if (RECORDING_CALLS.has(name)) return false;
    if (blockAt(match.index).includes("recordGhCall(")) return false;
    if (RAW_SPAWNERS.test(`${name}(`)) return true;
    const def = new RegExp(`(?:function|const)\\s+${name}\\b`, "u").exec(source);
    if (def === null) return false;
    const body = blockAt(def.index);
    return RAW_SPAWNERS.test(body) && !body.includes("recordGhCall(");
  });
}
const ALLOWED_SPAWNERS = new Set(["packages/core/src/github/gh-call-log.mjs", "packages/core/src/cli/primitives.mjs"]);

function sourceFiles(dir) {
  return readdirSync(path.join(REPO_ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === "test" || name === "tests") return [];
    if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return rel.endsWith(".mjs") && !/\.test\.mjs$/u.test(name) ? [rel] : [];
  });
}

test("no non-test source spawns gh outside the recording helpers", () => {
  const offenders = ["scripts", "packages", "skills", "cli"]
    .flatMap((dir) => (dir === "cli" ? ["cli/index.mjs"] : sourceFiles(dir)))
    .filter((file) => !ALLOWED_SPAWNERS.has(file) && hasUnrecordedGhCall(readFileSync(path.join(REPO_ROOT, file), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the call-site guard flags gh passed to raw spawners and local wrappers, and accepts recorded forms", () => {
  const wrapper = "function run(c, a) { return spawn(c, a); }\n";
  assert.equal(hasUnrecordedGhCall('spawn("gh", args)'), true);
  assert.equal(hasUnrecordedGhCall('execFileSync("gh", args)'), true);
  assert.equal(hasUnrecordedGhCall(`${wrapper}run("gh", ["pr", "view"])`), true);
  assert.equal(hasUnrecordedGhCall(`function spawnResult(c, a) { return spawnSync(c, a); }\nspawnResult("gh", ["auth", "status"])`), true);
  assert.equal(hasUnrecordedGhCall(`${wrapper}run(ghCommand, args)`), true);
  assert.equal(hasUnrecordedGhCall(`function spawnResult(c, a) { return spawnSync(c, a); }\nrecordGhCall(x);\nspawnResult("gh", ["auth", "status"])`), true, "a recordGhCall elsewhere in the file does not exempt a raw wrapper");
  assert.equal(hasUnrecordedGhCall(`function runGh(a) { const r = spawnSync("gh", a); recordGhCall(a, {}); return r; }\nrunGh(["pr", "view"])`), false, "a wrapper whose body records is accepted");
  assert.equal(hasUnrecordedGhCall('spawnRecorded("gh", args)'), false);
  assert.equal(hasUnrecordedGhCall("ghSync(args)"), false);
  assert.equal(hasUnrecordedGhCall('spawn("git", args)'), false);
  assert.equal(hasUnrecordedGhCall('runChild(ghCommand, args)'), false, "an imported shared runChild records");
});

test("spawnRecorded records one gh call with piped-stderr rate-limit detection, and skips non-gh commands", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = { PATH: process.env.PATH, log: process.env[GH_CALL_LOG_ENV] };
    process.env[GH_CALL_LOG_ENV] = logPath;
    const closed = (child) => new Promise((resolve) => { child.on("close", resolve); });
    try {
      process.env.PATH = fakeGhEnv(dir, { code: 1, stderr: "was submitted too quickly" }).PATH;
      await closed(spawnRecorded("gh", ["pr", "create"], { stdio: ["ignore", "pipe", "pipe"] }));
      await closed(spawnRecorded("gh", ["pr", "create"], { stdio: ["ignore", "pipe", "inherit"] }));
      await closed(spawnRecorded("true", [], { stdio: "ignore" }));
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.log === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved.log;
    }
    assert.deepEqual(readLog(logPath).map((r) => [r.status, r.rateLimited]), [[1, true], [1, null]]);
  });
});

test("execFileSyncRecorded records gh and skips other commands", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = { PATH: process.env.PATH, log: process.env[GH_CALL_LOG_ENV] };
    process.env[GH_CALL_LOG_ENV] = logPath;
    try {
      process.env.PATH = fakeGhEnv(dir).PATH;
      execFileSyncRecorded("gh", ["pr", "list"], { encoding: "utf8" });
      execFileSyncRecorded("true", [], { encoding: "utf8" });
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.log === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved.log;
    }
    assert.equal(readLog(logPath).length, 1);
  });
});

test("resolveGhCallLogPath resolves no log outside a checkout, and recordGhCall then creates nothing", async () => {
  await withTempDir(async (a) => {
    await withTempDir(async (b) => {
      assert.equal(resolveGhCallLogPath(a, {}), null);
      assert.equal(resolveGhCallLogPath(b, {}), null);
    });
    const saved = process.env[GH_CALL_LOG_ENV];
    delete process.env[GH_CALL_LOG_ENV];
    const cwd = process.cwd();
    try {
      process.chdir(a);
      recordGhCall(["pr", "list"], { durationMs: 1, status: 0 });
    } finally {
      process.chdir(cwd);
      if (saved !== undefined) process.env[GH_CALL_LOG_ENV] = saved;
    }
    assert.deepEqual(readdirSync(a), []);
  });
});

test("a blank DEVLOOPS_GH_CALL_LOG is unset and a padded one is trimmed", () => {
  const main = resolveGhCallLogPath(REPO_ROOT, {});
  assert.ok(main.endsWith(path.join("tmp", "gh-calls.jsonl")));
  assert.equal(resolveGhCallLogPath(REPO_ROOT, { [GH_CALL_LOG_ENV]: "  " }), main);
  assert.equal(resolveGhCallLogPath(REPO_ROOT, { [GH_CALL_LOG_ENV]: " /abs/x.jsonl " }), "/abs/x.jsonl");
});

test("ghSync with stderr ignored records rateLimited null, not false", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = { PATH: process.env.PATH, log: process.env[GH_CALL_LOG_ENV] };
    process.env[GH_CALL_LOG_ENV] = logPath;
    try {
      process.env.PATH = fakeGhEnv(dir, { code: 1, stderr: "API rate limit already exceeded" }).PATH;
      assert.throws(() => ghSync(["pr", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.log === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved.log;
    }
    assert.deepEqual(readLog(logPath).map((r) => r.rateLimited), [null]);
  });
});

test("recordGhCall extracts the PR number per command kind", async () => {
  await withTempDir(async (dir) => {
  const logPath = path.join(dir, "probe.jsonl");
  const prOf = (args) => {
    writeFileSync(logPath, "");
    recordGhCall(args, { durationMs: 1, status: 0, logPath });
    return readLog(logPath)[0].pr;
  };
  assert.equal(prOf(["api", "repos/o/r/pulls", "-f", "body=see /issues/77/"]), null);
  assert.equal(prOf(["api", "repos/o/r/pulls", "--jq", '.[]|select(.url|test("/pulls/5/"))']), null);
  assert.equal(prOf(["api", "repos/o/r/pulls/12/reviews", "--paginate"]), 12);
  assert.equal(prOf(["api", "repos/o/r/issues/13/comments"]), 13);
  assert.equal(prOf(["api", "repos/o/r/pulls"]), null);
  assert.equal(prOf(["api", "graphql", "-F", "pr=14", "-f", "query=q"]), 14);
  assert.equal(prOf(["api", "graphql", "--raw-field", "number=15", "-f", "query=q"]), 15);
  assert.equal(prOf(["api", "graphql", "-f", "query=q", "-F", "first=50"]), null);
  assert.equal(prOf(["pr", "view", "--repo", "o/r", "16"]), 16);
  assert.equal(prOf(["pr", "list", "--limit", "50"]), null);
  });
});

test("a relative log path env override is ignored", () => {
  assert.equal(resolveGhCallLogPath(REPO_ROOT, { [GH_CALL_LOG_ENV]: "rel/x.jsonl" }), resolveGhCallLogPath(REPO_ROOT, {}));
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

test("gh-calls CLI rejects an empty --log", async () => {
  for (const bad of ["", "  "]) await assert.rejects(runCli(["--log", bad], { stdout: { write() {} } }));
});

test("gh-calls CLI resolves a relative --log against cwd", async () => {
  await withTempDir(async (dir) => {
    const repo = realpathSync(dir);
    recordGhCall(["pr", "list"], { durationMs: 1, status: 0, script: "s.mjs", logPath: path.join(repo, "x.jsonl") });
    const prev = process.cwd();
    process.chdir(repo);
    try {
      let out = "";
      await runCli(["--log", "x.jsonl"], { stdout: { write: (s) => { out += s; } } });
      assert.equal(JSON.parse(out).total, 1);
    } finally { process.chdir(prev); }
  });
});

test("gh-calls CLI trims a padded --log before resolving it", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    recordGhCall(["pr", "list"], { durationMs: 1, status: 0, script: "s.mjs", logPath });
    let out = "";
    await runCli(["--log", ` ${logPath} `], { stdout: { write: (s) => { out += s; } } });
    assert.equal(JSON.parse(out).total, 1);
  });
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

test("verify-release-approval appends one record per gh call", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = { PATH: process.env.PATH, log: process.env[GH_CALL_LOG_ENV] };
    process.env[GH_CALL_LOG_ENV] = logPath;
    process.env.PATH = fakeGhEnv(dir).PATH;
    try {
      try { verifyReleaseApproval({ version: "1.2.3", repo: "o/r", operator: "op", releaseCommitDate: "2026-01-01T00:00:00Z" }); } catch { /* the fake gh output is not a real search result */ }
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.log === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved.log;
    }
    const records = readLog(logPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 0);
    const coreLog = path.join(dir, "core.jsonl");
    recordGhCall(["api", "-X", "GET", "search/issues", "-f", "q=x"], { durationMs: 0, status: 0, stderr: null, script: records[0].script, logPath: coreLog });
    const pick = ({ script, pr, kind, subcommand, status, rateLimited }) => ({ script, pr, kind, subcommand, status, rateLimited });
    assert.deepEqual(pick(records[0]), pick(readLog(coreLog)[0]));
  });
});

test("post-gate-verdict-fallback appends one record for its gh api call", async () => {
  await withTempDir(async (dir) => {
    const logPath = path.join(dir, "log.jsonl");
    const saved = process.env[GH_CALL_LOG_ENV];
    process.env[GH_CALL_LOG_ENV] = logPath;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() { child.stdout.emit("data", '{"id":1,"html_url":"https://x"}'); child.emit("close", 0); } };
      return child;
    };
    try {
      await postGateVerdictViaGh({ repo: "o/r", pr: 1, body: "ok", spawnImpl });
    } finally {
      if (saved === undefined) delete process.env[GH_CALL_LOG_ENV]; else process.env[GH_CALL_LOG_ENV] = saved;
    }
    const records = readLog(logPath);
    assert.equal(records.length, 1);
    const coreLog = path.join(dir, "core.jsonl");
    recordGhCall(["api", "--method", "POST", "-H", "Content-Type: application/json", "--input", "-", "repos/o/r/issues/1/comments"], { durationMs: 0, status: 0, stderr: "", script: records[0].script, logPath: coreLog });
    const pick = ({ script, pr, kind, subcommand, status, rateLimited }) => ({ script, pr, kind, subcommand, status, rateLimited });
    assert.deepEqual(pick(records[0]), pick(readLog(coreLog)[0]));
    assert.deepEqual([records[0].subcommand, records[0].pr], ["api", 1]);
  });
});
