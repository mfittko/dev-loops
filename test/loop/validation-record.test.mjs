import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { parseValidationRecord } from "@dev-loops/core/loop/validation-record";
import { runGitFixture, runNode } from "../_helpers.mjs";

const CLI = fileURLToPath(new URL("../../cli/index.mjs", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../scripts/loop/validation-record.mjs", import.meta.url));
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const TITLE = "feat: record title";
const DEVLOOPS = "version: 1\nvalidation:\n  mode: local\n  paths:\n    - match: \"docs/**\"\n      surface: docs\n      commands: [\"bun run test:docs\"]\n";
// Both suites fail unless they see the injected PR title.
const TITLE_CHECK = `process.exit(process.env.DEVLOOPS_PR_TITLE === ${JSON.stringify(TITLE)} ? 0 : 3);\n`;

// runGitFixture scrubs GIT_DIR/GIT_WORK_TREE and sets the identity; signing is off for host independence.
const git = (cwd, ...args) => runGitFixture(cwd, ["-c", "commit.gpgsign=false", ...args]);

// A fixture repo whose HEAD is published as origin/main (the trusted base).
async function fixture({ pinned = bunVersion, files = {} } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "validation-record-"));
  const tree = {
    "package.json": JSON.stringify({ name: "fixture", packageManager: `bun@${pinned}`, scripts: { verify: "bun scripts/verify.mjs", "test:docs": "bun scripts/docs/validate-decision-records.mjs" } }),
    ".gitignore": "tmp/\n",
    ".devloops": DEVLOOPS,
    "scripts/verify.mjs": TITLE_CHECK,
    "scripts/docs/validate-decision-records.mjs": TITLE_CHECK,
    ...files,
  };
  for (const [name, body] of Object.entries(tree)) {
    if (body === null) continue;
    await mkdir(path.dirname(path.join(repoRoot, name)), { recursive: true });
    await writeFile(path.join(repoRoot, name), body);
  }
  git(repoRoot, "init", "-q");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-qm", "fixture");
  const remote = `${repoRoot}-origin.git`;
  git(repoRoot, "init", "-q", "--bare", remote);
  git(repoRoot, "remote", "add", "origin", remote);
  git(repoRoot, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(repoRoot, "fetch", "-q", "origin");
  git(repoRoot, "remote", "set-head", "origin", "main");
  return repoRoot;
}

async function commit(repoRoot, files) {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoRoot, name)), { recursive: true });
    await writeFile(path.join(repoRoot, name), body);
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-qm", "branch change");
  return git(repoRoot, "rev-parse", "HEAD");
}

const run = (repoRoot, headSha, extra = []) =>
  runNode(CLI, ["loop", "validation-record", "--repo", "owner/repo", "--head-sha", headSha, "--title", TITLE, ...extra], { cwd: repoRoot });
const recordFile = (repoRoot, headSha) => path.join(repoRoot, "tmp", "validation-records", "owner", "repo", `${headSha}.json`);

async function withFixture(options, fn) {
  const repoRoot = await fixture(options);
  try { await fn(repoRoot); } finally { await rm(repoRoot, { recursive: true, force: true }); await rm(`${repoRoot}-origin.git`, { recursive: true, force: true }); }
}

test("targeted profile when every changed path maps to gateSuites", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  const out = await run(repoRoot, headSha);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const record = JSON.parse(out.stdout);
  assert.deepEqual(JSON.parse(await readFile(recordFile(repoRoot, headSha), "utf8")), record);
  assert.equal(parseValidationRecord(record, { repo: "owner/repo", headSha }).ok, true);
  assert.equal(record.profile, "targeted");
  assert.deepEqual(record.requestedSuites, ["test:docs"]);
  assert.equal(record.producer, "local");
  assert.equal(record.toolchain, `bun@${bunVersion}`);
  assert.equal(record.prTitle, TITLE);
  assert.equal(record.allPassed, true);
  assert.equal(record.suites[0].exitCode, 0);
  assert.match(record.suites[0].outputPath, new RegExp(`${headSha}\\.logs/test-docs\\.log$`));
  assert.ok(existsSync(path.join(repoRoot, record.suites[0].outputPath)));
}));

test("full profile (verify) when a changed path is unmapped", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n", "src/x.txt": "x\n" });
  const out = await run(repoRoot, headSha);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const record = JSON.parse(out.stdout);
  assert.equal(record.profile, "full-repository");
  assert.deepEqual(record.requestedSuites, ["verify"]);
}));

test("a failing suite writes a failed record and exits non-zero", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "scripts/verify.mjs": "console.error('boom'); process.exit(2);\n" });
  const out = await run(repoRoot, headSha);
  assert.equal(out.code, 1);
  const record = JSON.parse(await readFile(recordFile(repoRoot, headSha), "utf8"));
  assert.equal(record.allPassed, false);
  assert.equal(record.suites[0].exitCode, 2);
  assert.equal(parseValidationRecord(record, { repo: "owner/repo", headSha }).ok, true);
}));

async function assertIncomplete(repoRoot, headSha, reason, extra) {
  // A record left by an earlier run must be gone after every incomplete outcome.
  await mkdir(path.dirname(recordFile(repoRoot, headSha)), { recursive: true });
  await writeFile(recordFile(repoRoot, headSha), "{}\n");
  const out = await run(repoRoot, headSha, extra);
  assert.notEqual(out.code, 0);
  const result = JSON.parse(out.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.status, "incomplete");
  assert.match(result.reason, reason);
  assert.equal(existsSync(recordFile(repoRoot, headSha)), false);
}

test("a dirty worktree is incomplete", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  await writeFile(path.join(repoRoot, "junk.txt"), "dirty\n");
  await assertIncomplete(repoRoot, headSha, /clean worktree/);
}));

test("a suite that modifies a tracked file is incomplete", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n", "scripts/verify.mjs": `import { appendFileSync } from "node:fs";\nappendFileSync("docs/a.md", "changed\\n");\n${TITLE_CHECK}` });
  await assertIncomplete(repoRoot, headSha, /validation changed the worktree/);
}));

test("--jq filters the JSON output", () => withFixture({}, async (repoRoot) => {
  await commit(repoRoot, { "docs/a.md": "# a\n" });
  const out = await run(repoRoot, "b".repeat(40), ["--jq", ".status"]);
  assert.equal(out.code, 1);
  assert.equal(out.stdout.trim(), "incomplete");
}));

test("a head mismatch is incomplete",() => withFixture({}, async (repoRoot) => {
  await commit(repoRoot, { "docs/a.md": "# a\n" });
  await assertIncomplete(repoRoot, "b".repeat(40), /differs from requested head/);
}));

test("a checkout validation block that differs from the base is incomplete", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { ".devloops": DEVLOOPS.replace("bun run test:docs", "echo changed") });
  await assertIncomplete(repoRoot, headSha, /differs from the base branch/);
}));

test("a base validation block in ci-only mode, absent or with no config file is incomplete and writes no record", async () => {
  for (const files of [{ ".devloops": DEVLOOPS.replace("mode: local", "mode: ci-only") }, { ".devloops": "version: 1\n" }, { ".devloops": null }]) {
    await withFixture({ files }, async (repoRoot) => {
      const headSha = await commit(repoRoot, { "src/x.txt": "x\n" });
      await assertIncomplete(repoRoot, headSha, /ci-only selects the ci producer/);
      assert.equal(existsSync(recordFile(repoRoot, headSha)), false);
    });
  }
});

test("an unresolvable origin/HEAD is incomplete", () => withFixture({}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  git(repoRoot, "remote", "set-head", "origin", "-d");
  await assertIncomplete(repoRoot, headSha, /origin\/HEAD does not resolve; run git fetch origin and git remote set-head origin -a/);
}));

test("a toolchain mismatch is incomplete", () => withFixture({ pinned: "0.0.1" }, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  await assertIncomplete(repoRoot, headSha, /differs from bun@0\.0\.1/);
}));

test("a base fullCommand on the full-repository path is incomplete", () => withFixture({
  files: { ".devloops": DEVLOOPS.replace("mode: local\n", "mode: local\n  fullCommand: \"make check\"\n") },
}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "src/x.txt": "x\n" });
  await assertIncomplete(repoRoot, headSha, /fullCommand "make check"/);
}));

// The suite starts a `sleep` grandchild and records its PID under tmp/ as a readiness signal.
const GRANDCHILD_SUITE = "import { spawn } from 'node:child_process';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nconst child = spawn('sleep', ['60'], { stdio: 'ignore' });\nmkdirSync('tmp', { recursive: true });\nwriteFileSync('tmp/grandchild.pid', String(child.pid));\nsetTimeout(() => {}, 60000);\n";
const pidFile = (repoRoot) => path.join(repoRoot, "tmp", "grandchild.pid");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function until(predicate, ms) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("a timeout writes no record, reports it and leaves no orphan process", () => withFixture({
  files: { "scripts/docs/validate-decision-records.mjs": GRANDCHILD_SUITE },
}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  await assertIncomplete(repoRoot, headSha, /timed out after 8 s/, ["--timeout", "8"]);
  assert.ok(existsSync(pidFile(repoRoot)), "the grandchild started before the deadline");
  const pid = Number(await readFile(pidFile(repoRoot), "utf8"));
  assert.ok(await until(() => !alive(pid), 2000), "the grandchild is gone");
}), 30000);

test("interrupting the producer kills the suite process group", () => withFixture({
  files: { "scripts/docs/validate-decision-records.mjs": GRANDCHILD_SUITE },
}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n" });
  const producer = spawn("node", [SCRIPT, "--repo", "owner/repo", "--head-sha", headSha, "--title", TITLE, "--timeout", "60"], { cwd: repoRoot, stdio: "ignore" });
  const exited = new Promise((resolve) => producer.on("close", resolve));
  assert.ok(await until(() => existsSync(pidFile(repoRoot)) && readFileSync(pidFile(repoRoot), "utf8") !== "", 30000), "the grandchild started");
  const pid = Number(readFileSync(pidFile(repoRoot), "utf8"));
  assert.ok(alive(pid));
  producer.kill("SIGINT");
  await exited;
  assert.ok(await until(() => !alive(pid), 2000), "the grandchild is gone");
}), 60000);

test("usage offers no background option and rejects out-of-range or unknown arguments", async () => {
  const help = await runNode(CLI, ["loop", "validation-record", "--help"]);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /background|detach|completion/i);
  const sha = "a".repeat(40);
  const base = ["loop", "validation-record", "--repo", "owner/repo", "--head-sha", sha, "--title", TITLE];
  for (const extra of [["--background"], ["--detach"], ["--completion-file", "x"], ["--timeout", "0"], ["--timeout", "571"], ["--timeout", "abc"], ["--timeout", "-5"], ["--timeout", "0x10"], ["--timeout", "1e2"], ["--tmp-root", "/abs"], ["--tmp-root", "a/../b"], ["--tmp-root", ".."], ["stray"]]) {
    const out = await runNode(CLI, [...base, ...extra]);
    assert.equal(out.code, 2, extra.join(" "));
  }
  for (const bad of [["--head-sha", "abc1234"], ["--repo", "owner"], ["--title", " "]]) {
    const out = await runNode(CLI, [...base.slice(0, 2), ...base.slice(2).reduce((a, v, i, all) => (v === bad[0] ? a.concat(v, bad[1]) : all[i - 1] === bad[0] ? a : a.concat(v)), [])]);
    assert.equal(out.code, 2, bad.join(" "));
  }
});

test("full profile when one changed path has a rule without gateSuites", () => withFixture({
  files: { ".devloops": `${DEVLOOPS}    - match: "src/**"\n      surface: src\n      commands: ["node --test {path}"]\n` },
}, async (repoRoot) => {
  const headSha = await commit(repoRoot, { "docs/a.md": "# a\n", "src/x.test.mjs": "\n" });
  const out = await run(repoRoot, headSha);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).requestedSuites, ["verify"]);
}));
