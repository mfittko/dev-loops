import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  evaluateStandingAuthorizationRecord,
  readStandingAuthorization,
} from "../../scripts/loop/standing-authorization.mjs";

const NOW = new Date("2026-10-04T12:00:00Z");
const good = { grantedBy: "operator", grantedAt: "2026-10-01", expires: "2026-12-01", reason: "contract doc edits named in the issue matrix" };

test("a complete in-window record is in force", () => {
  const r = evaluateStandingAuthorizationRecord(good, NOW);
  assert.equal(r.inForce, true);
  assert.equal(r.record.grantedBy, "operator");
});

test("the record is valid through the whole expires day and expired the day after", () => {
  assert.equal(evaluateStandingAuthorizationRecord({ ...good, expires: "2026-10-04" }, NOW).inForce, true);
  const r = evaluateStandingAuthorizationRecord({ ...good, expires: "2026-10-03" }, NOW);
  assert.equal(r.state, "expired");
});

test("a missing record, a malformed record and an over-90-day record each refuse", () => {
  assert.equal(evaluateStandingAuthorizationRecord(undefined, NOW).state, "missing");
  for (const bad of [
    "text",
    { ...good, grantedBy: "not a login!" },
    { ...good, reason: "  " },
    { ...good, grantedAt: "yesterday" },
    { ...good, expires: "2026-09-01" },
    { grantedBy: good.grantedBy, grantedAt: good.grantedAt, expires: good.expires },
    { ...good, scope: "everything" },
  ]) {
    assert.equal(evaluateStandingAuthorizationRecord(bad, NOW).state, "malformed", JSON.stringify(bad));
  }
  const long = evaluateStandingAuthorizationRecord({ ...good, grantedAt: "2026-10-01", expires: "2027-01-01" }, NOW);
  assert.equal(long.state, "over_long");
  assert.equal(evaluateStandingAuthorizationRecord({ ...good, grantedAt: "2026-10-01", expires: "2026-12-30" }, NOW).inForce, true, "exactly 90 days is allowed");
});

const RECORD_YAML = [
  "version: 1",
  "standingAuthorizations:",
  "  adrTripwireWaiver:",
  "    grantedBy: operator",
  "    grantedAt: '2026-10-01'",
  "    expires: '2026-12-01'",
  "    reason: contract doc edits named in the issue matrix",
  "",
].join("\n");

function repoWithDefaultBranch(devloops) {
  const dir = mkdtempSync(join(tmpdir(), "standing-auth-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".devloops"), devloops);
  git("add", ".devloops");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir, git };
}

test("the record is read from origin/<defaultBranch> and a worktree-only record is ignored", () => {
  const { dir } = repoWithDefaultBranch("version: 1\n");
  try {
    writeFileSync(join(dir, ".devloops"), RECORD_YAML);
    const r = readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW });
    assert.equal(r.inForce, false);
    assert.equal(r.state, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PR-head-only record is ignored; the default-branch record is honored", () => {
  const { dir, git } = repoWithDefaultBranch(RECORD_YAML);
  try {
    git("checkout", "-q", "-b", "pr-head");
    writeFileSync(join(dir, ".devloops"), "version: 1\n");
    git("commit", "-q", "-am", "drop the record on the PR head");
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW }).inForce, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { dir: dir2, git: git2 } = repoWithDefaultBranch("version: 1\n");
  try {
    git2("checkout", "-q", "-b", "pr-head");
    writeFileSync(join(dir2, ".devloops"), RECORD_YAML);
    git2("commit", "-q", "-am", "add a record on the PR head only");
    assert.equal(readStandingAuthorization({ repoRoot: dir2, defaultBranch: "main", now: NOW }).state, "missing");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("an unparsable default-branch .devloops is malformed, an absent one is missing", () => {
  const { dir } = repoWithDefaultBranch("version: [unclosed\n");
  try {
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW }).state, "malformed");
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "nope", now: NOW }).state, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
