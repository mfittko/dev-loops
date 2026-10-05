import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  defaultFetchOrigin,
  evaluateStandingAuthorizationRecord,
  readStandingAuthorization,
} from "../../scripts/loop/standing-authorization.mjs";

const NOW = new Date("2026-10-04T12:00:00Z");
const noFetch = () => {};
const good ={ grantedBy: "operator", grantedAt: "2026-10-01", expires: "2026-12-01", reason: "contract doc edits named in the issue matrix" };

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
    const r = readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW, fetchOrigin: noFetch });
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
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW, fetchOrigin: noFetch }).inForce, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { dir: dir2, git: git2 } = repoWithDefaultBranch("version: 1\n");
  try {
    git2("checkout", "-q", "-b", "pr-head");
    writeFileSync(join(dir2, ".devloops"), RECORD_YAML);
    git2("commit", "-q", "-am", "add a record on the PR head only");
    assert.equal(readStandingAuthorization({ repoRoot: dir2, defaultBranch: "main", now: NOW, fetchOrigin: noFetch }).state, "missing");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("an unparsable default-branch .devloops is malformed, an absent one is missing", () => {
  const { dir } = repoWithDefaultBranch("version: [unclosed\n");
  try {
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW, fetchOrigin: noFetch }).state, "malformed");
    assert.equal(readStandingAuthorization({ repoRoot: dir, defaultBranch: "nope", now: NOW, fetchOrigin: noFetch }).state, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed fetch refuses with fetch_failed and never reads the local ref", () => {
  const { dir } = repoWithDefaultBranch(RECORD_YAML);
  try {
    const failing = () => { throw new Error("network down"); };
    const r = readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW, fetchOrigin: failing });
    assert.equal(r.inForce, false);
    assert.equal(r.state, "fetch_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default fetch is bounded, prompt-free and separates the branch with --", () => {
  const calls = [];
  defaultFetchOrigin("main", { repoRoot: "/r" }, (cmd, args, opts) => calls.push({ cmd, args, opts }));
  assert.equal(calls[0].cmd, "git");
  assert.deepEqual(calls[0].args, ["fetch", "origin", "--", "main"]);
  assert.equal(calls[0].opts.timeout, 30000);
  assert.equal(calls[0].opts.killSignal, "SIGKILL");
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[0].opts.cwd, "/r");
});

test("a fetch timeout from the default fetch yields fetch_failed", () => {
  const timeout = () => { throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }); };
  const r = readStandingAuthorization({
    repoRoot: ".", defaultBranch: "main", now: NOW,
    fetchOrigin: (branch, ctx) => defaultFetchOrigin(branch, ctx, timeout),
  });
  assert.equal(r.state, "fetch_failed");
});

test("the reader fetches the default branch before reading", () => {
  const { dir } = repoWithDefaultBranch(RECORD_YAML);
  try {
    const calls = [];
    const r = readStandingAuthorization({ repoRoot: dir, defaultBranch: "main", now: NOW, fetchOrigin: (branch) => calls.push(branch) });
    assert.deepEqual(calls, ["main"]);
    assert.equal(r.inForce, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record dates must be exactly YYYY-MM-DD and a real calendar day", () => {
  for (const bad of ["2026-02-30", "2026-10-01T00:00:00Z", "2026-1-01", " 2026-10-01", "2026-13-01"]) {
    assert.equal(evaluateStandingAuthorizationRecord({ ...good, grantedAt: bad }, NOW).state, "malformed", bad);
    assert.equal(evaluateStandingAuthorizationRecord({ ...good, expires: bad }, NOW).state, "malformed", bad);
  }
  assert.equal(evaluateStandingAuthorizationRecord({ ...good, grantedAt: new Date("2026-10-01"), expires: new Date("2026-12-01") }, NOW).inForce, true, "unquoted YAML dates parse to Date");
});

function fakeGit({ files = {}, showFails = [], lsFails = false }) {
  return (args) => {
    if (args[0] === "rev-parse") return "sha\n";
    if (args[0] === "ls-tree") {
      if (lsFails) throw new Error("ls-tree failed");
      const name = args[args.length - 1];
      return name in files ? `${name}\n` : "";
    }
    if (args[0] === "show") {
      const name = args[1].split(":")[1];
      if (showFails.includes(name)) throw new Error("show failed");
      return files[name];
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

test("the first existing .devloops file wins and a later valid file is never consulted", () => {
  const git = fakeGit({ files: { ".devloops": "version: 1\n", ".devloops.yaml": RECORD_YAML } });
  const r = readStandingAuthorization({ repoRoot: ".", defaultBranch: "main", now: NOW, git, fetchOrigin: noFetch });
  assert.equal(r.state, "missing", "bare .devloops has no record; .devloops.yaml is shadowed");
});

test("an existing .devloops that git cannot show is malformed and does not fall through", () => {
  const git = fakeGit({ files: { ".devloops": RECORD_YAML, ".devloops.yaml": RECORD_YAML }, showFails: [".devloops"] });
  const r = readStandingAuthorization({ repoRoot: ".", defaultBranch: "main", now: NOW, git, fetchOrigin: noFetch });
  assert.equal(r.inForce, false);
  assert.equal(r.state, "malformed");
});

test("a path-absent report falls through to the next filename; a listing failure is malformed", () => {
  const git = fakeGit({ files: { ".devloops.yml": RECORD_YAML } });
  assert.equal(readStandingAuthorization({ repoRoot: ".", defaultBranch: "main", now: NOW, git, fetchOrigin: noFetch }).inForce, true);
  const broken = fakeGit({ lsFails: true });
  assert.equal(readStandingAuthorization({ repoRoot: ".", defaultBranch: "main", now: NOW, git: broken, fetchOrigin: noFetch }).state, "malformed");
});

test("a record whose grantedAt is after today refuses (not yet valid)", () => {
  const r = evaluateStandingAuthorizationRecord({ ...good, grantedAt: "2030-01-01", expires: "2030-03-31" }, NOW);
  assert.equal(r.inForce, false);
  assert.equal(r.state, "malformed");
  assert.match(r.detail, /not yet valid/);
});
