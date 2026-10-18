import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { validatePrePrReview } from "../../scripts/loop/_pre-pr-review-record.mjs";
import { runCli } from "../../scripts/loop/record-pre-pr-review.mjs";
import { runGitFixture } from "../_helpers.mjs";

const git = (cwd, ...args) => runGitFixture(cwd, args);
const SENTENCE = "The review reads every changed line before the push.";

function write(dir, file, content) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// main holds a Markdown sentence pinned by a test and a helper used elsewhere; feature removes both.
function staleRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pre-pr-stale-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "doc.md", `${SENTENCE}\n`);
  write(dir, "test/pin.test.mjs", `const pinned = "${SENTENCE}";\n`);
  write(dir, "src/helper.mjs", "export function legacyHelperName() { return 1; }\n");
  write(dir, "src/use.mjs", "import { legacyHelperName } from \"./helper.mjs\";\nlegacyHelperName();\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "doc.md", "Reworded.\n");
  write(dir, "src/helper.mjs", "export function currentHelperName() { return 1; }\n");
  git(dir, "commit", "-q", "-a", "-m", "rename");
  return dir;
}

async function run(dir, argv, extra = {}) {
  let out = "";
  let err = "";
  const code = await runCli(argv, { cwd: dir, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...extra });
  return { code, out: out ? JSON.parse(out) : null, err: err ? JSON.parse(err.trim().split("\n").pop()) : null };
}

const record = ["--verdict", "clean", "--disposition", "none", "--base", "main", "--no-linked-issue"];
const withRepo = (fn) => async () => {
  const dir = staleRepo();
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const sitesOf = (scan) => scan.staleSurfaceHits.map((h) => h.site).sort();

test("--scan lists the renamed identifier and the removed sentence still referenced, and writes no record", withRepo(async (dir) => {
  const { code, out } = await run(dir, ["--scan", "--base", "main"]);
  assert.equal(code, 0);
  assert.equal(out.head, git(dir, "rev-parse", "HEAD"));
  assert.deepEqual(sitesOf(out), ["src/use.mjs:1", "src/use.mjs:2", "test/pin.test.mjs:1"]);
  assert.equal(out.staleSurfaceTruncated, false);
  assert.deepEqual(out.truncatedNeedles, []);
  assert.equal((await validatePrePrReview({ cwd: dir })).ok, false);
}));

test("record refuses with pre_pr_stale_surface_unaddressed, then succeeds once the hits are fixed", withRepo(async (dir) => {
  const refused = await run(dir, record);
  assert.equal(refused.code, 1);
  assert.equal(refused.err.code, "pre_pr_stale_surface_unaddressed");
  assert.match(refused.err.error, /test\/pin\.test\.mjs:1/);
  assert.equal((await validatePrePrReview({ cwd: dir })).ok, false);
  write(dir, "test/pin.test.mjs", "const pinned = \"Reworded.\";\n");
  write(dir, "src/use.mjs", "import { currentHelperName } from \"./helper.mjs\";\ncurrentHelperName();\n");
  git(dir, "commit", "-q", "-a", "-m", "fix stale surface");
  assert.equal((await run(dir, record)).code, 0);
  assert.equal((await validatePrePrReview({ cwd: dir })).ok, true);
}));

test("a skips-file entry with a reason addresses a hit; an empty reason does not", withRepo(async (dir) => {
  const skips = path.join(dir, "..", `skips-${path.basename(dir)}.json`);
  const entries = (reason) => [{ site: "test/pin.test.mjs", reason }, { site: "src/use.mjs:1-2", reason }];
  writeFileSync(skips, JSON.stringify(entries("  ")));
  assert.equal((await run(dir, [...record, "--skips-file", skips])).err.code, "pre_pr_stale_surface_unaddressed");
  writeFileSync(skips, JSON.stringify(entries("kept on purpose")));
  assert.equal((await run(dir, [...record, "--skips-file", skips])).code, 0);
  rmSync(skips);
}));

test("a truncated hit list needs a skip naming stale-surface-hits-truncated", withRepo(async (dir) => {
  const { scanPrePrStaleSurface, requireStaleSurfaceAddressed } = await import("../../scripts/loop/_pre-pr-stale-surface.mjs");
  const scan = await scanPrePrStaleSurface({ cwd: dir, base: "main", staleSurface: () => ({ hits: [], truncated: true, truncatedNeedles: [{ needle: "x" }] }) });
  assert.equal(scan.staleSurfaceTruncated, true);
  assert.deepEqual(scan.truncatedNeedles, [{ needle: "x" }]);
  assert.throws(() => requireStaleSurfaceAddressed(scan, []), /stale-surface-hits-truncated/);
  const skip = (reason) => [{ sites: [{ site: "stale-surface-hits-truncated", status: "skipped", reason }] }];
  assert.throws(() => requireStaleSurfaceAddressed(scan, skip("")), /stale-surface-hits-truncated/);
  requireStaleSurfaceAddressed(scan, skip("read the rest by hand"));
}));

test("a missing commit object or an unresolvable base fails the scan", withRepo(async (dir) => {
  const { scanPrePrStaleSurface } = await import("../../scripts/loop/_pre-pr-stale-surface.mjs");
  await assert.rejects(scanPrePrStaleSurface({ cwd: dir, base: "no-such-base" }));
  await assert.rejects(scanPrePrStaleSurface({ cwd: dir, base: "main", staleSurface: (cwd) => { throw new Error(`git grep failed in ${cwd}`); } }), /git grep failed/);
  const empty = mkdtempSync(path.join(os.tmpdir(), "pre-pr-stale-empty-"));
  try {
    git(empty, "init", "-q");
    assert.equal((await run(empty, ["--scan", "--base", "main"])).code, 1);
  } finally { rmSync(empty, { recursive: true, force: true }); }
}));

const MATRIX = "| Criterion outcome | Required completion evidence |\n|---|---|\n| AC1 works | D1 test proves it |\n| AC2 widened case | D2 test pins widened case |\n";
const ISSUE = `## In scope\n\n- Alpha\n- Beta widened\n\n## AC / DoD matrix\n\n${MATRIX}\n## Non-goals\n\n- None\n`;
const PR_OLD = "## In scope\n\n- Alpha\n- Beta\n\n## Acceptance criteria\n\n- [ ] AC1 works\n\n## Definition of done\n\n- [ ] D1 test proves it\n\n## Non-goals\n\n- None\n";
const PR_NEW = "## In scope\n\n- Alpha\n- Beta widened\n\n## Acceptance criteria\n\n- [ ] AC1 works\n- [ ] AC2 widened case\n\n## Definition of done\n\n- [ ] D1 test proves it\n- [ ] D2 test pins widened case\n\n## Non-goals\n\n- None\n";

test("the PR body is compared with the linked issue: a widened issue yields hits, a matching body none", withRepo(async (dir) => {
  const body = path.join(dir, "..", `body-${path.basename(dir)}.md`);
  const readIssueBody = async ({ issue }) => { assert.equal(issue, "7"); return ISSUE; };
  const scan = async () => (await run(dir, ["--scan", "--base", "main", "--body-file", body, "--issue", "7"], { readIssueBody })).out;
  writeFileSync(body, PR_OLD);
  const stale = (await scan()).staleSurfaceHits.filter((h) => h.kind === "pr-body").map((h) => h.site).sort();
  assert.deepEqual(stale, ["issue-body/acceptance-criteria:2", "issue-body/definition-of-done:2", "issue-body/in-scope:2", "pr-body/in-scope:2"]);
  const refused = await run(dir, [...record.slice(0, -1), "--body-file", body, "--issue", "7"], { readIssueBody });
  assert.equal(refused.err.code, "pre_pr_stale_surface_unaddressed");
  assert.match(refused.err.error, /pr-body\/in-scope:2/);
  writeFileSync(body, PR_NEW);
  assert.deepEqual((await scan()).staleSurfaceHits.filter((h) => h.kind === "pr-body"), []);
  rmSync(body);
}));

test("without --issue no comparison runs, and --body-file and --issue come as a pair", withRepo(async (dir) => {
  const readIssueBody = async () => { throw new Error("must not read the issue"); };
  assert.equal((await run(dir, ["--scan", "--base", "main"], { readIssueBody })).code, 0);
  assert.equal((await run(dir, ["--scan", "--base", "main", "--issue", "7"], { readIssueBody })).code, 1);
  assert.equal((await run(dir, ["--scan", "--base", "main", "--body-file", "b.md"], { readIssueBody })).code, 1);
}));

test("record mode needs a linked-issue flag, flags are exclusive, and --scan rejects verdict flags", withRepo(async (dir) => {
  const noSweepFlag = ["--verdict", "clean", "--disposition", "none", "--base", "main"];
  assert.equal((await run(dir, noSweepFlag)).code, 1);
  assert.equal((await run(dir, [...noSweepFlag, "--no-linked-issue", "--issue", "7", "--body-file", "b.md"])).code, 1);
  assert.equal((await run(dir, ["--scan", "--base", "main", "--verdict", "clean"])).code, 1);
  assert.equal((await run(dir, ["--scan", "--base", "main", "--disposition", "none"])).code, 1);
  assert.equal((await validatePrePrReview({ cwd: dir })).ok, false);
}));

test("an empty scan range fails closed in scan and record mode", withRepo(async (dir) => {
  assert.equal((await run(dir, ["--scan", "--base", "HEAD"])).code, 1);
  assert.equal((await run(dir, [...record.slice(0, -3), "--base", "HEAD", "--no-linked-issue"])).code, 1);
  assert.equal((await validatePrePrReview({ cwd: dir })).ok, false);
}));

test("scan and refusal behave identically for the claude and pi harness environments", withRepo(async (dir) => {
  const results = [];
  for (const env of [{ DEVLOOPS_RUN_ID: "run-claude" }, { PI_SUBAGENT_RUN_ID: "run-pi" }]) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const scan = (await run(dir, ["--scan", "--base", "main"])).out;
      const refusal = await run(dir, record);
      results.push({ sites: sitesOf(scan), code: refusal.code, errCode: refusal.err.code });
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].errCode, "pre_pr_stale_surface_unaddressed");
}));
