import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEditCommentCliArgs,
  editComment,
  runCli,
} from "../../scripts/github/edit-comment.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

const COMMENT_URL = "https://github.com/o/n/issues/7#issuecomment-123";

const stubGh = (responses) => makeGhStub(responses);

test("parseEditCommentCliArgs: parses repo/comment-id/body", () => {
  const out = parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "123", "--body", "hi"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.commentId, 123);
  assert.equal(out.body, "hi");
});

test("parseEditCommentCliArgs: parses --allowed-refs csv", () => {
  const out = parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "123", "--body", "hi", "--allowed-refs", "1670,9000"]);
  assert.deepEqual(out.allowedRefs, ["1670", "9000"]);
});

test("parseEditCommentCliArgs: rejects a non-numeric --allowed-refs entry", () => {
  assert.throws(
    () => parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "123", "--body", "hi", "--allowed-refs", "abc"]),
    /positive integers/,
  );
});

test("editComment: an --allowed-refs deliberate cross-ref posts", async () => {
  const { run, calls } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  const result = await editComment({ repo: "o/n", commentId: 123, body: "deliberate cross-ref to issue #1670", allowedRefs: ["1670"] }, { run });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["api", "-X", "PATCH", "repos/o/n/issues/comments/123", "-f", "body=deliberate cross-ref to issue #1670"]);
});

test("editComment: a raw unallowlisted id still refuses even when another is allowed (guard, #1731)", async () => {
  const { run } = stubGh([]);
  await assert.rejects(
    () => editComment({ repo: "o/n", commentId: 7, body: "see #1670 but also #999", allowedRefs: ["1670"] }, { run }),
    /#999/,
  );
});

test("parseEditCommentCliArgs: requires repo + comment-id", () => {
  assert.throws(() => parseEditCommentCliArgs(["--repo", "o/n"]), /requires both/);
});

test("parseEditCommentCliArgs: rejects a missing/invalid --comment-id", () => {
  assert.throws(() => parseEditCommentCliArgs(["--repo", "o/n", "--body", "x"]), /requires both/);
  assert.throws(() => parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "abc", "--body", "x"]), /--comment-id/);
  assert.throws(() => parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "0", "--body", "x"]), /--comment-id/);
});

test("parseEditCommentCliArgs: requires a body source", () => {
  assert.throws(() => parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "7"]), /--body <text> or --body-file/);
});

test("parseEditCommentCliArgs: --body and --body-file are mutually exclusive", () => {
  assert.throws(
    () => parseEditCommentCliArgs(["--repo", "o/n", "--comment-id", "7", "--body", "x", "--body-file", "f"]),
    /mutually exclusive/,
  );
});

test("editComment: PATCHes via gh api and returns the comment URL", async () => {
  const { run, calls } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  const result = await editComment({ repo: "o/n", commentId: 123, body: "hello" }, { run });
  assert.deepEqual(result, { ok: true, repo: "o/n", commentId: 123, commentUrl: COMMENT_URL });
  assert.deepEqual(calls[0], [
    "api", "-X", "PATCH", "repos/o/n/issues/comments/123", "-f", "body=hello",
  ]);
});

test("editComment: a body starting with @ is passed raw via -f (NOT the @-file magic of -F)", async () => {
  // `-f/--raw-field` is a static string; only `-F/--field` interprets a leading
  // `@` as read-from-file. A comment body like "@user please review" must stay
  // literal — this pins the raw-field choice against a regression to -F.
  const { run, calls } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  await editComment({ repo: "o/n", commentId: 9, body: "@user please review" }, { run });
  assert.deepEqual(calls[0], [
    "api", "-X", "PATCH", "repos/o/n/issues/comments/9", "-f", "body=@user please review",
  ]);
});

test("editComment: reads the body from --body-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edit-comment-"));
  try {
    const file = join(dir, "body.md");
    await writeFile(file, "from a file\n");
    const { run, calls } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
    const result = await editComment({ repo: "o/n", commentId: 7, bodyFile: file }, { run });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["api", "-X", "PATCH", "repos/o/n/issues/comments/7", "-f", "body=from a file\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editComment: rejects an empty --body-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "edit-comment-"));
  try {
    const file = join(dir, "empty.md");
    await writeFile(file, "   \n");
    const { run } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
    await assert.rejects(() => editComment({ repo: "o/n", commentId: 7, bodyFile: file }, { run }), /is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editComment: rejects an empty --body", async () => {
  const { run } = stubGh([]);
  await assert.rejects(() => editComment({ repo: "o/n", commentId: 7, body: "   " }, { run }), /--body must not be empty/);
});

test("editComment: refuses a body containing a raw issue/PR id (guard, #1731)", async () => {
  const { run } = stubGh([]);
  await assert.rejects(
    () => editComment({ repo: "o/n", commentId: 7, body: "see issue #1670" }, { run }),
    /#1670/,
  );
  // a clean body still PATCHes
  const { run: run2, calls: calls2 } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  await editComment({ repo: "o/n", commentId: 7, body: "clean edit" }, { run: run2 });
  assert.deepEqual(calls2[0], ["api", "-X", "PATCH", "repos/o/n/issues/comments/7", "-f", "body=clean edit"]);
});

test("editComment: throws when gh fails", async () => {
  const { run } = stubGh([{ code: 1, stderr: "not found" }]);
  await assert.rejects(() => editComment({ repo: "o/n", commentId: 7, body: "x" }, { run }), /gh api PATCH issues\/comments failed: not found/);
});

test("editComment: throws when gh returns no html_url", async () => {
  const { run } = stubGh([{ stdout: JSON.stringify({ id: 7 }) }]);
  await assert.rejects(() => editComment({ repo: "o/n", commentId: 7, body: "x" }, { run }), /did not return a comment html_url/);
});

test("runCli: --jq extracts the comment URL", async () => {
  const { run } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--comment-id", "7", "--body", "x", "--jq", ".commentUrl"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), COMMENT_URL);
});

test("runCli: invalid --jq filter fails closed with exit 2", async () => {
  const { run } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--comment-id", "7", "--body", "x", "--jq", "not!valid"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 2);
});

test("runCli: --silent maps success to exit 0 with no stdout", async () => {
  const { run } = stubGh([{ stdout: JSON.stringify({ html_url: COMMENT_URL }) }]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--comment-id", "7", "--body", "x", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});

test("runCli: gh failure returns exit 1", async () => {
  const { run } = stubGh([{ code: 1, stderr: "boom" }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--comment-id", "7", "--body", "x"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /boom/);
});

test("runCli: missing --comment-id fails closed with an actionable error", async () => {
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--body", "x"], { stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /requires both/);
});
