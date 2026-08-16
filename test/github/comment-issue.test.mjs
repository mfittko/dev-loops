import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseCommentIssueCliArgs,
  commentIssue,
  runCli,
} from "../../scripts/github/comment-issue.mjs";

const COMMENT_URL = "https://github.com/o/n/issues/7#issuecomment-123";

function stubGh(responses) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    const resp = responses.shift();
    if (!resp) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return { code: resp.code ?? 0, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

test("parseCommentIssueCliArgs: parses repo/issue/body", () => {
  const out = parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "hi"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.issue, 7);
  assert.equal(out.body, "hi");
});

test("parseCommentIssueCliArgs: requires repo + issue", () => {
  assert.throws(() => parseCommentIssueCliArgs(["--repo", "o/n"]), /requires both/);
});

test("parseCommentIssueCliArgs: requires a body source", () => {
  assert.throws(() => parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7"]), /--body <text> or --body-file/);
});

test("parseCommentIssueCliArgs: parses --allowed-refs csv", () => {
  const out = parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "hi", "--allowed-refs", "1670, 9000"]);
  assert.deepEqual(out.allowedRefs, ["1670", "9000"]);
});

test("parseCommentIssueCliArgs: rejects a non-numeric --allowed-refs entry", () => {
  assert.throws(
    () => parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "hi", "--allowed-refs", "1670,abc"]),
    /positive integers/,
  );
  assert.throws(
    () => parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "hi", "--allowed-refs", "0"]),
    /positive integers/,
  );
});

test("commentIssue: an --allowed-refs deliberate cross-ref posts", async () => {
  const { run, calls } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
  const result = await commentIssue(
    { repo: "o/n", issue: 7, body: "deliberate cross-ref to issue #1670", allowedRefs: ["1670"] },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["issue", "comment", "7", "--repo", "o/n", "--body", "deliberate cross-ref to issue #1670"]);
});

test("commentIssue: a raw unallowlisted id still refuses (guard, #1731)", async () => {
  const { run } = stubGh([]);
  await assert.rejects(
    () => commentIssue({ repo: "o/n", issue: 7, body: "see #1670 but also #999", allowedRefs: ["1670"] }, { run }),
    /#999/,
  );
});

test("parseCommentIssueCliArgs: --body and --body-file are mutually exclusive", () => {
  assert.throws(
    () => parseCommentIssueCliArgs(["--repo", "o/n", "--issue", "7", "--body", "x", "--body-file", "f"]),
    /mutually exclusive/,
  );
});

test("commentIssue: posts via gh issue comment and returns the URL", async () => {
  const { run, calls } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
  const result = await commentIssue(
    { repo: "o/n", issue: 7, body: "hello" },
    { run },
  );
  assert.deepEqual(result, { ok: true, repo: "o/n", issue: 7, commentUrl: COMMENT_URL });
  assert.deepEqual(calls[0], ["issue", "comment", "7", "--repo", "o/n", "--body", "hello"]);
});

test("commentIssue: reads the body from --body-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comment-issue-"));
  try {
    const file = join(dir, "body.md");
    await writeFile(file, "from a file\n");
    const { run, calls } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
    const result = await commentIssue({ repo: "o/n", issue: 7, bodyFile: file }, { run });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["issue", "comment", "7", "--repo", "o/n", "--body", "from a file\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commentIssue: rejects an empty --body-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comment-issue-"));
  try {
    const file = join(dir, "empty.md");
    await writeFile(file, "   \n");
    const { run } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
    await assert.rejects(() => commentIssue({ repo: "o/n", issue: 7, bodyFile: file }, { run }), /is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commentIssue: rejects an empty --body", async () => {
  const { run } = stubGh([]);
  await assert.rejects(() => commentIssue({ repo: "o/n", issue: 7, body: "   " }, { run }), /--body must not be empty/);
});

test("commentIssue: throws when gh fails", async () => {
  const { run } = stubGh([{ code: 1, stderr: "no such issue" }]);
  await assert.rejects(() => commentIssue({ repo: "o/n", issue: 7, body: "x" }, { run }), /gh issue comment failed: no such issue/);
});

test("commentIssue: throws when gh returns no URL", async () => {
  const { run } = stubGh([{ stdout: "not a url\n" }]);
  await assert.rejects(() => commentIssue({ repo: "o/n", issue: 7, body: "x" }, { run }), /did not return a comment URL/);
});

test("runCli: --jq extracts the comment URL", async () => {
  const { run } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "7", "--body", "x", "--jq", ".commentUrl"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), COMMENT_URL);
});

test("runCli: invalid --jq filter fails closed with exit 2", async () => {
  const { run } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "7", "--body", "x", "--jq", "not!valid"], { run, stderr: stderr, stdout: captureStream() });
  assert.equal(code, 2);
});

test("runCli: --silent maps success to exit 0 with no stdout", async () => {
  const { run } = stubGh([{ stdout: `${COMMENT_URL}\n` }]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "7", "--body", "x", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});

test("runCli: gh failure returns exit 1", async () => {
  const { run } = stubGh([{ code: 1, stderr: "boom" }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "7", "--body", "x"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /boom/);
});
