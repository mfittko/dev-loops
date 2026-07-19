import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCreateIssueCliArgs, createIssue, runCli } from "../../scripts/github/create-issue.mjs";

function stubGh({ code = 0, stdout, stderr = "" } = {}) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return {
      code,
      stdout: code === 0 ? (stdout ?? "https://github.com/o/n/issues/42\n") : "",
      stderr,
    };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

test("parseCreateIssueCliArgs: requires --repo and --title", () => {
  assert.throws(() => parseCreateIssueCliArgs(["--repo", "o/n", "--body", "b"]), /requires both --repo/);
  assert.throws(() => parseCreateIssueCliArgs(["--title", "t", "--body", "b"]), /requires both --repo/);
});

test("parseCreateIssueCliArgs: --body XOR --body-file (both / neither fail)", () => {
  assert.throws(
    () => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "t", "--body", "b", "--body-file", "f"]),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "t"]),
    /exactly one of --body/,
  );
});

test("parseCreateIssueCliArgs: rejects whitespace-only --title / --body", () => {
  assert.throws(() => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "  ", "--body", "b"]), /--title must not be empty/);
  assert.throws(() => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "t", "--body", "\t\n"]), /--body must not be empty/);
});

test("parseCreateIssueCliArgs: rejects --body-file - (stdin) fail-closed", () => {
  assert.throws(
    () => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "t", "--body-file", "-"]),
    /--body-file '-' \(stdin\) is not supported/,
  );
});

test("parseCreateIssueCliArgs: rejects stdin-device --body-file paths (/dev/stdin, /dev/fd/N, /proc/self/fd/N)", () => {
  for (const rawPath of ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]) {
    assert.throws(
      () => parseCreateIssueCliArgs(["--repo", "o/n", "--title", "t", "--body-file", rawPath]),
      new RegExp(`--body-file '${rawPath.replace(/\//g, "\\/")}' \\(stdin\\) is not supported`),
    );
  }
});

test("parseCreateIssueCliArgs: collects repeated --label / --assignee", () => {
  const out = parseCreateIssueCliArgs([
    "--repo", "o/n", "--title", "t", "--body", "b",
    "--label", "bug", "--label", "p1", "--assignee", "a", "--assignee", "b",
  ]);
  assert.deepEqual(out.labels, ["bug", "p1"]);
  assert.deepEqual(out.assignees, ["a", "b"]);
});

test("createIssue: builds gh issue create args and parses issueNumber + url", async () => {
  const { run, calls } = stubGh();
  const result = await createIssue(
    { repo: "o/n", title: "New", body: "Body", milestone: "v1", labels: ["bug"], assignees: ["me"] },
    { run },
  );
  assert.deepEqual(result, { ok: true, issueNumber: 42, url: "https://github.com/o/n/issues/42" });
  assert.deepEqual(calls[0], [
    "issue", "create", "--repo", "o/n", "--title", "New", "--body", "Body",
    "--milestone", "v1", "--label", "bug", "--assignee", "me",
  ]);
});

test("createIssue: --body-file forwards the path to gh (after validating it reads non-empty)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "create-issue-"));
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, "Body from file\nsecond line");
  const { run, calls } = stubGh();
  await createIssue({ repo: "o/n", title: "T", bodyFile: bodyPath, labels: [], assignees: [] }, { run });
  assert.deepEqual(calls[0], ["issue", "create", "--repo", "o/n", "--title", "T", "--body-file", bodyPath]);
});

test("createIssue: fails closed on an empty/whitespace-only --body-file (the real guard behind the stdin trap)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "create-issue-"));
  const emptyPath = join(dir, "empty.md");
  writeFileSync(emptyPath, "   \n  ");
  const { run } = stubGh();
  await assert.rejects(
    () => createIssue({ repo: "o/n", title: "T", bodyFile: emptyPath, labels: [], assignees: [] }, { run }),
    /issue body resolved empty/,
  );
});

test("createIssue: fails closed on an empty/whitespace-only --body", async () => {
  const { run } = stubGh();
  await assert.rejects(
    () => createIssue({ repo: "o/n", title: "T", body: "   \n", labels: [], assignees: [] }, { run }),
    /issue body resolved empty/,
  );
});

test("createIssue: rejects a --body-file that resolves to a non-regular file (a symlink to /dev/null)", async () => {
  // A symlink to a device dodges the CLI layer's literal stdin-path regex (it
  // isn't spelled "-"/"/dev/stdin"/etc.) but still isn't a regular file once
  // resolved — the core guard must catch it by resolving the symlink, not the
  // literal path string.
  const dir = mkdtempSync(join(tmpdir(), "create-issue-"));
  const linkPath = join(dir, "not-a-file");
  symlinkSync("/dev/null", linkPath);
  const { run } = stubGh();
  await assert.rejects(
    () => createIssue({ repo: "o/n", title: "T", bodyFile: linkPath, labels: [], assignees: [] }, { run }),
    /--body-file must be a regular file/,
  );
});

test("createIssue: accepts a --body-file that is a symlink to a real regular file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "create-issue-"));
  const realPath = join(dir, "real.md");
  writeFileSync(realPath, "Body from a symlinked file");
  const linkPath = join(dir, "link.md");
  symlinkSync(realPath, linkPath);
  const { run, calls } = stubGh();
  await createIssue({ repo: "o/n", title: "T", bodyFile: linkPath, labels: [], assignees: [] }, { run });
  assert.deepEqual(calls[0], ["issue", "create", "--repo", "o/n", "--title", "T", "--body-file", linkPath]);
});

test("createIssue: throws when gh fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "forbidden" });
  await assert.rejects(
    () => createIssue({ repo: "o/n", title: "T", body: "b", labels: [], assignees: [] }, { run }),
    /gh issue create failed: forbidden/,
  );
});

test("createIssue: throws on unparseable URL output", async () => {
  const { run } = stubGh({ stdout: "not-a-url\n" });
  await assert.rejects(
    () => createIssue({ repo: "o/n", title: "T", body: "b", labels: [], assignees: [] }, { run }),
    /no parseable issue URL/,
  );
});

test("runCli: --jq extracts issueNumber; --silent maps to exit code", async () => {
  const { run } = stubGh();
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--title", "T", "--body", "b", "--jq", ".issueNumber"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "42");

  const { run: run2 } = stubGh();
  const code2 = await runCli(["--repo", "o/n", "--title", "T", "--body", "b", "--silent"], { run: run2, stdout: captureStream() });
  assert.equal(code2, 0);
});

test("runCli: fails closed (exit 1) with {ok:false,error} JSON on gh failure", async () => {
  const { run } = stubGh({ code: 1, stderr: "forbidden" });
  const stderr = captureStream();
  const code = await runCli(
    ["--repo", "o/n", "--title", "T", "--body", "b"],
    { run, stdout: captureStream(), stderr },
  );
  assert.equal(code, 1);
  const parsed = JSON.parse(stderr.get().trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /gh issue create failed: forbidden/);
});

test("runCli: fails closed (exit 1) on missing required args", async () => {
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n"], { run: stubGh().run, stdout: captureStream(), stderr });
  assert.equal(code, 1);
});
