import assert from "node:assert/strict";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEditIssueCliArgs, editIssue, runCli } from "../../scripts/github/edit-issue.mjs";

function stubGh({ code = 0, stderr = "" } = {}) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return { code, stdout: code === 0 ? "https://github.com/o/n/issues/17\n" : "", stderr };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

test("parseEditIssueCliArgs: requires --repo, --issue and at least one edit", () => {
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n"]), /requires both --repo/);
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1"]), /at least one of/);
});

test("parseEditIssueCliArgs: --body and --body-file are mutually exclusive", () => {
  assert.throws(
    () => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--body", "x", "--body-file", "f"]),
    /mutually exclusive/,
  );
});

test("parseEditIssueCliArgs: --milestone '' parses (empty clears; not rejected as missing)", () => {
  const out = parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--milestone", ""]);
  assert.equal(out.milestone, "");
});

test("parseEditIssueCliArgs: --milestone rejects whitespace-only but allows a real name and empty clear", () => {
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--milestone", "   "]), /whitespace-only is not allowed/);
  assert.equal(parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--milestone", "v1.0"]).milestone, "v1.0");
  assert.equal(parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--milestone", ""]).milestone, "");
});

test("parseEditIssueCliArgs: --milestone with no value is rejected", () => {
  // A bare --milestone (no following token) is a real omission, not an empty clear.
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--milestone"]), /--milestone requires a value/);
});

test("parseEditIssueCliArgs: rejects whitespace-only --title / --body", () => {
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--title", "   "]), /--title must not be empty or whitespace/);
  assert.throws(() => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--body", "\t\n"]), /--body must not be empty or whitespace/);
});

test("parseEditIssueCliArgs: collects repeated assignees", () => {
  const out = parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--add-assignee", "a", "--add-assignee", "b"]);
  assert.deepEqual(out.addAssignees, ["a", "b"]);
});

test("editIssue: builds gh issue edit args and reports edited fields", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue(
    { repo: "o/n", issue: 17, title: "New", body: "Body", addAssignees: ["me"], removeAssignees: [], milestone: undefined },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.edited, ["title", "body", "add-assignee"]);
  assert.deepEqual(calls[0], [
    "issue", "edit", "17", "--repo", "o/n", "--title", "New", "--body", "Body", "--add-assignee", "me",
  ]);
});

test("editIssue: empty --milestone clears (passes empty string through)", async () => {
  const { run, calls } = stubGh();
  await editIssue({ repo: "o/n", issue: 1, addAssignees: [], removeAssignees: [], milestone: "" }, { run });
  assert.deepEqual(calls[0], ["issue", "edit", "1", "--repo", "o/n", "--milestone", ""]);
});

test("editIssue: throws when gh fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "forbidden" });
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 1, title: "x", addAssignees: [], removeAssignees: [] }, { run }),
    /gh issue edit failed: forbidden/,
  );
});

test("runCli: --jq extracts an edited field; --silent maps to exit code", async () => {
  const { run } = stubGh();
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "1", "--title", "T", "--jq", ".edited[0]"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "title");

  const { run: run2 } = stubGh();
  const code2 = await runCli(["--repo", "o/n", "--issue", "1", "--title", "T", "--silent"], { run: run2, stdout: captureStream() });
  assert.equal(code2, 0);
});

test("editIssue: --body-file fails closed on an empty/whitespace-only file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-issue-"));
  const emptyPath = join(dir, "empty.md");
  writeFileSync(emptyPath, "   \n  ");
  const { run } = stubGh();
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 5, bodyFile: emptyPath, addAssignees: [], removeAssignees: [] }, { run }),
    /is empty/,
  );
});

test("editIssue: --body-file reads the body from a real file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-issue-"));
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, "Body from file\nsecond line");
  const { run, calls } = stubGh();
  const result = await editIssue(
    { repo: "o/n", issue: 5, bodyFile: bodyPath, addAssignees: [], removeAssignees: [] },
    { run },
  );
  assert.deepEqual(result.edited, ["body"]);
  assert.deepEqual(calls[0], ["issue", "edit", "5", "--repo", "o/n", "--body-file", bodyPath]);
});

test("editIssue: --body-file - reads stdin and passes it inline as --body (never re-emits exhausted fd 0)", () => {
  // resolveBody consumes fd 0 to validate the body; re-emitting `--body-file -`
  // would make gh re-read an already-drained stdin and clear the issue body. So the
  // resolved stdin content must be passed inline via --body. Exercised in a child
  // process because resolveBody reads the real fd 0 (stdin).
  const modUrl = new URL("../../scripts/github/edit-issue.mjs", import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), "edit-issue-stdin-"));
  const driver = join(dir, "driver.mjs");
  writeFileSync(
    driver,
    `import { editIssue } from ${JSON.stringify(modUrl)};\n` +
      "const calls = [];\n" +
      "await editIssue(\n" +
      "  { repo: \"o/n\", issue: 17, bodyFile: \"-\", addAssignees: [], removeAssignees: [] },\n" +
      "  { run: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: \"\", stderr: \"\" }; } },\n" +
      ");\n" +
      "process.stdout.write(JSON.stringify(calls[0]));\n",
  );
  const res = spawnSync(process.execPath, [driver], { input: "Body from stdin\n", encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const args = JSON.parse(res.stdout);
  assert.deepEqual(args, ["issue", "edit", "17", "--repo", "o/n", "--body", "Body from stdin\n"]);
  assert.ok(!args.includes("--body-file"), "must not re-emit --body-file - for an exhausted stdin");
});

test("editIssue: --remove-assignee builds gh args and reports the edited field", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue(
    { repo: "o/n", issue: 5, addAssignees: ["a"], removeAssignees: ["b", "c"] },
    { run },
  );
  assert.deepEqual(result.edited, ["add-assignee", "remove-assignee"]);
  assert.deepEqual(calls[0], [
    "issue", "edit", "5", "--repo", "o/n",
    "--add-assignee", "a", "--remove-assignee", "b", "--remove-assignee", "c",
  ]);
});
