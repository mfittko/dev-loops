import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("parseEditPrCliArgs: --milestone '' parses (empty clears; not rejected as missing)", () => {
  const out = parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone", ""]);
  assert.equal(out.milestone, "");
});

test("parseEditPrCliArgs: --milestone with no value is rejected", () => {
  // A bare --milestone (no following token) is a real omission, not an empty clear.
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone"]), /--milestone requires a value/);
});

test("parseEditPrCliArgs: rejects whitespace-only --title / --body", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--title", "   "]), /--title must not be empty or whitespace/);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--body", "\t\n"]), /--body must not be empty or whitespace/);
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

test("editPr: --body-file fails closed on an empty/whitespace-only file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-"));
  const emptyPath = join(dir, "empty.md");
  writeFileSync(emptyPath, "   \n  ");
  const { run } = stubGh();
  await assert.rejects(
    () => editPr({ repo: "o/n", pr: 5, bodyFile: emptyPath, addAssignees: [], removeAssignees: [] }, { run }),
    /is empty/,
  );
});

test("editPr: --body-file reads the body from a real file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-"));
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, "Body from file\nsecond line");
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 5, bodyFile: bodyPath, addAssignees: [], removeAssignees: [] },
    { run },
  );
  assert.deepEqual(result.edited, ["body"]);
  assert.deepEqual(calls[0], ["pr", "edit", "5", "--repo", "o/n", "--body", "Body from file\nsecond line"]);
});

test("editPr: --remove-assignee builds gh args and reports the edited field", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 5, addAssignees: ["a"], removeAssignees: ["b", "c"] },
    { run },
  );
  assert.deepEqual(result.edited, ["add-assignee", "remove-assignee"]);
  assert.deepEqual(calls[0], [
    "pr", "edit", "5", "--repo", "o/n",
    "--add-assignee", "a", "--remove-assignee", "b", "--remove-assignee", "c",
  ]);
});
