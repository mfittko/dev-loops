import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { validatePrePrReview, writePrePrReviewRecord } from "../../scripts/loop/_pre-pr-review-record.mjs";
import { runCli } from "../../scripts/loop/record-pre-pr-review.mjs";
import { main as createPr } from "../../scripts/github/create-pr.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixtureRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pre-pr-review-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "src/a.mjs", "export const a = 1;\n");
  return dir;
}

function commit(dir, file, content) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `edit ${file}`);
}

const record = (dir) => writePrePrReviewRecord({ cwd: dir, verdict: "clean", disposition: "none" });

test("no record for the branch head is refused with pre_pr_review_missing naming the sanctioned command", () => {
  const dir = fixtureRepo();
  try {
    const result = validatePrePrReview({ cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "pre_pr_review_missing");
    assert.match(result.detail, /cli\/index.mjs loop pre-pr-review --verdict/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record for the current head passes", () => {
  const dir = fixtureRepo();
  try {
    record(dir);
    assert.equal(validatePrePrReview({ cwd: dir }).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record for an older head passes when later commits touch docs and tests only, and fails after a logic change", () => {
  const dir = fixtureRepo();
  try {
    record(dir);
    commit(dir, "docs/note.md", "# note\n");
    commit(dir, "test/a.test.mjs", "export {};\n");
    assert.equal(validatePrePrReview({ cwd: dir }).ok, true);
    commit(dir, "src/a.mjs", "export const a = 2;\n");
    const result = validatePrePrReview({ cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "pre_pr_review_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hand-built or tampered record file fails validation", () => {
  const dir = fixtureRepo();
  try {
    const { record: written, file } = record(dir);
    writeFileSync(file, JSON.stringify({ ...written, integrity: undefined }));
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
    writeFileSync(file, JSON.stringify({ head: written.head, verdict: "clean", disposition: "none", integrity: "0".repeat(64) }));
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
    writeFileSync(file, JSON.stringify({ ...written, disposition: "all_applied" }));
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI writes the record from git HEAD and takes no head argument", async () => {
  const dir = fixtureRepo();
  try {
    let out = "";
    const code = await runCli(["--verdict", "findings_fixed", "--disposition", "all_applied"], { cwd: dir, stdout: { write: (s) => { out += s; } }, stderr: { write() {} } });
    assert.equal(code, 0);
    const result = JSON.parse(out);
    assert.equal(result.head, git(dir, "rev-parse", "HEAD"));
    assert.equal(validatePrePrReview({ cwd: dir }).ok, true);
    assert.ok(readdirSync(path.dirname(result.file)).includes(`${result.head}.json`));
    assert.equal(JSON.parse(readFileSync(result.file, "utf8")).verdict, "findings_fixed");
    let err = "";
    assert.equal(await runCli(["--head", "abc", "--verdict", "clean", "--disposition", "none"], { cwd: dir, stdout: { write() {} }, stderr: { write: (s) => { err += s; } } }), 1);
    assert.equal(await runCli(["--verdict", "bogus", "--disposition", "none"], { cwd: dir, stdout: { write() {} }, stderr: { write() {} } }), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const prArgs = ["--repo", "owner/repo", "--base", "main", "--head", "feature", "--title", "t", "--body", "body"];

test("pr create refuses before gh when no record exists, and a failing validator never reaches gh", async () => {
  const dir = fixtureRepo();
  try {
    git(dir, "branch", "feature");
    await assert.rejects(() => createPr(prArgs, { cwd: dir, env: { PATH: process.env.PATH }, ghCommand: "false" }), /pre_pr_review_missing: .*loop pre-pr-review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr create proceeds past the guard with a valid record, and the --lightweight path needs none", async () => {
  const dir = fixtureRepo();
  try {
    let calls = 0;
    const validatePrePrReview = () => { calls += 1; return { ok: true }; };
    // gh is the no-op `true`, so create succeeds once the guard passes.
    const env = { PATH: process.env.PATH, DEV_LOOPS_GH_STUB: "1" };
    assert.equal(await createPr(prArgs, { cwd: dir, env, ghCommand: "true", validatePrePrReview }), 0);
    assert.equal(calls, 1);
    assert.equal(await createPr([...prArgs, "--lightweight"], { cwd: dir, env, ghCommand: "true", validatePrePrReview: () => { throw new Error("must not run"); } }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record file copied to another head's name fails (the record must name that head)", () => {
  const dir = fixtureRepo();
  try {
    const { file } = record(dir);
    commit(dir, "src/a.mjs", "export const a = 2;\n");
    copyFileSync(file, path.join(path.dirname(file), `${git(dir, "rev-parse", "HEAD")}.json`));
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renaming logic into the test tree after the record does not reuse it", () => {
  const dir = fixtureRepo();
  try {
    record(dir);
    mkdirSync(path.join(dir, "test"));
    git(dir, "mv", "src/a.mjs", "test/a.test.mjs");
    git(dir, "commit", "-q", "-m", "move logic into tests");
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit head is resolved (owner prefix stripped by pr create) instead of the checked-out HEAD", () => {
  const dir = fixtureRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    record(dir);
    git(dir, "checkout", "-q", "main");
    commit(dir, "src/b.mjs", "export const b = 1;\n");
    assert.equal(validatePrePrReview({ cwd: dir }).ok, false);
    assert.equal(validatePrePrReview({ cwd: dir, head: "feature" }).ok, true);
    assert.equal(validatePrePrReview({ cwd: dir, head: "no-such-branch" }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pr create validates the --head branch with a real record, ignoring the checked-out HEAD", async () => {
  const dir = fixtureRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    record(dir);
    git(dir, "checkout", "-q", "main");
    commit(dir, "src/b.mjs", "export const b = 1;\n");
    const env = { PATH: process.env.PATH };
    await assert.rejects(() => createPr(["--repo", "owner/repo", "--base", "main", "--title", "t", "--body", "body"], { cwd: dir, env, ghCommand: "false" }), /pre_pr_review_missing/);
    assert.equal(await createPr(["--repo", "owner/repo", "--base", "main", "--head", "someone:feature", "--title", "t", "--body", "body"], { cwd: dir, env: { ...env, DEV_LOOPS_GH_STUB: "1" }, ghCommand: "true" }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
