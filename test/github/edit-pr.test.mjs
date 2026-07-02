import assert from "node:assert/strict";
import test from "node:test";

import { parseEditPrCliArgs, editPr, runCli } from "../../scripts/github/edit-pr.mjs";

function stubGh({ code = 0, stderr = "" } = {}) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return { code, stdout: code === 0 ? "https://github.com/o/n/pull/17\n" : "", stderr };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

test("parseEditPrCliArgs: requires --repo, --pr and at least one edit", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n"]), /requires both --repo/);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1"]), /at least one of/);
});

test("parseEditPrCliArgs: --body and --body-file are mutually exclusive", () => {
  assert.throws(
    () => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--body", "x", "--body-file", "f"]),
    /mutually exclusive/,
  );
});

test("parseEditPrCliArgs: collects repeated assignees", () => {
  const out = parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--add-assignee", "a", "--add-assignee", "b"]);
  assert.deepEqual(out.addAssignees, ["a", "b"]);
});

test("editPr: builds gh pr edit args and reports edited fields", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 17, title: "New", body: "Body", addAssignees: ["me"], removeAssignees: [], milestone: undefined },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.edited, ["title", "body", "add-assignee"]);
  assert.deepEqual(calls[0], [
    "pr", "edit", "17", "--repo", "o/n", "--title", "New", "--body", "Body", "--add-assignee", "me",
  ]);
});

test("editPr: empty --milestone clears (passes empty string through)", async () => {
  const { run, calls } = stubGh();
  await editPr({ repo: "o/n", pr: 1, addAssignees: [], removeAssignees: [], milestone: "" }, { run });
  assert.deepEqual(calls[0], ["pr", "edit", "1", "--repo", "o/n", "--milestone", ""]);
});

test("editPr: throws when gh fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "forbidden" });
  await assert.rejects(
    () => editPr({ repo: "o/n", pr: 1, title: "x", addAssignees: [], removeAssignees: [] }, { run }),
    /gh pr edit failed: forbidden/,
  );
});

test("runCli: --jq extracts an edited field; --silent maps to exit code", async () => {
  const { run } = stubGh();
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "1", "--title", "T", "--jq", ".edited[0]"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "title");

  const { run: run2 } = stubGh();
  const code2 = await runCli(["--repo", "o/n", "--pr", "1", "--title", "T", "--silent"], { run: run2, stdout: captureStream() });
  assert.equal(code2, 0);
});
