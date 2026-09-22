import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { makeGhMock, runIdFreeEnv, runNode as runNodeHelper } from "../_helpers.mjs";

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

  assert.deepEqual(result, { ok: true, action: "converted", repo: "owner/repo", pr: 17, isDraft: true });
  const ghCalls = calls.filter((c) => c.command === "gh");
  assert.equal(ghCalls.length, 2, `expected resolve + convert mutation calls, got ${JSON.stringify(ghCalls)}`);
});

test("is idempotent when the PR is already draft (no mutation call)", async () => {
  const { runChild, calls } = makeGhMock([readyPrGraphqlStub({ isDraft: true })]);

  const result = await convertToDraft({ repo: "owner/repo", pr: 17 }, { env: {}, ghCommand: "gh", runChild });

  assert.deepEqual(result, { ok: true, action: "already_draft", repo: "owner/repo", pr: 17, isDraft: true });
  const ghCalls = calls.filter((c) => c.command === "gh");
  assert.equal(ghCalls.length, 1, `expected only the resolve call, got ${JSON.stringify(ghCalls)}`);
});
