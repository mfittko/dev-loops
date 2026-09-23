import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { makeGhMock, runIdFreeEnv, runNode as runNodeHelper, writeGhStub } from "../_helpers.mjs";

import { convertToDraft, parseConvertToDraftCliArgs } from "../../scripts/github/convert-to-draft.mjs";

const scriptPath = path.resolve("scripts/github/convert-to-draft.mjs");

function readyPrGraphqlStub({ id = "PR_kwDOScHU78000017", isDraft = false } = {}) {
  return {
    assertArgContains: ["pullRequest(number: $number)"],
    stdout: JSON.stringify({ data: { repository: { pullRequest: { id, isDraft } } } }),
  };
}

// --- CLI argument parsing ---

test("parseConvertToDraftCliArgs rejects missing --repo and --pr", () => {
  assert.throws(() => parseConvertToDraftCliArgs([]), /requires --repo and --pr/);
  assert.throws(() => parseConvertToDraftCliArgs(["--pr", "17"]), /requires --repo and --pr/);
  assert.throws(() => parseConvertToDraftCliArgs(["--repo", "owner/repo"]), /requires --repo and --pr/);
});

test("parseConvertToDraftCliArgs rejects an invalid repo slug", () => {
  assert.throws(() => parseConvertToDraftCliArgs(["--repo", "bad", "--pr", "17"]));
});

test("parseConvertToDraftCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseConvertToDraftCliArgs(["--repo", "owner/repo", "--pr", "17", "--bogus"]), /Unknown argument/);
});

test("parseConvertToDraftCliArgs parses a valid repo and pr", () => {
  const options = parseConvertToDraftCliArgs(["--repo", "owner/repo", "--pr", "17"]);
  assert.equal(options.repo, "owner/repo");
  assert.equal(options.pr, 17);
});

test("parseConvertToDraftCliArgs rejects a non-numeric --pr value", () => {
  assert.throws(() => parseConvertToDraftCliArgs(["--repo", "owner/repo", "--pr", "not-a-number"]), /--pr/);
});

test("--help prints usage to stdout", async () => {
  const result = await runNodeHelper(scriptPath, ["--help"], { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }) });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /convert-to-draft\.mjs/);
  assert.match(result.stdout, /idempotent/i);
});

// --- convertToDraft() integration ---

test("converts a ready PR to draft", async () => {
  const { runChild, calls } = makeGhMock([
    readyPrGraphqlStub({ isDraft: false }),
    {
      assertArgContains: ["convertPullRequestToDraft"],
      stdout: JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { id: "PR_kwDOScHU78000017", isDraft: true } } } }),
    },
  ]);

  const result = await convertToDraft({ repo: "owner/repo", pr: 17 }, { env: {}, ghCommand: "gh", runChild });

  assert.deepEqual(result, { ok: true, action: "converted", alreadyDraft: false, repo: "owner/repo", pr: 17, isDraft: true });
  const ghCalls = calls.filter((c) => c.command === "gh");
  assert.equal(ghCalls.length, 2, `expected resolve + convert mutation calls, got ${JSON.stringify(ghCalls)}`);
});

test("is idempotent when the PR is already draft (no mutation call)", async () => {
  const { runChild, calls } = makeGhMock([readyPrGraphqlStub({ isDraft: true })]);

  const result = await convertToDraft({ repo: "owner/repo", pr: 17 }, { env: {}, ghCommand: "gh", runChild });

  assert.deepEqual(result, { ok: true, action: "already_draft", alreadyDraft: true, repo: "owner/repo", pr: 17, isDraft: true });
  const ghCalls = calls.filter((c) => c.command === "gh");
  assert.equal(ghCalls.length, 1, `expected only the resolve call, got ${JSON.stringify(ghCalls)}`);
});

// --- Real-CLI-subprocess failure modes (stderr JSON, exit 1) ---

test("gh non-zero exit surfaces as a stderr JSON error, exit 1", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-convert-to-draft-gh-fail-"));
  try {
    const { env } = await writeGhStub(tempDir, [
      { exitCode: 1, stderr: "gh: some transient API failure\n" },
    ]);

    const result = await runNodeHelper(scriptPath, ["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Failed to resolve PR node ID for #17/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses (stderr JSON, exit 1) when the mutation reports isDraft:false", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-convert-to-draft-not-draft-"));
  try {
    const { env } = await writeGhStub(tempDir, [
      readyPrGraphqlStub({ isDraft: false }),
      {
        stdout: JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { id: "PR_kwDOScHU78000017", isDraft: false } } } }),
      },
    ]);

    const result = await runNodeHelper(scriptPath, ["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /PR #17 was not set to draft state after mutation/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
