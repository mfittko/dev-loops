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

test("parseEditIssueCliArgs: --state alone is a valid edit", () => {
  const out = parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--state", "closed"]);
  assert.equal(out.state, "closed");
});

test("parseEditIssueCliArgs: rejects an invalid --state value", () => {
  assert.throws(
    () => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--state", "archived"]),
    /--state must be "open" or "closed"/,
  );
});

test("parseEditIssueCliArgs: rejects an invalid --reason value", () => {
  assert.throws(
    () => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--state", "closed", "--reason", "duplicate"]),
    /--reason must be "completed" or "not_planned"/,
  );
});

test("parseEditIssueCliArgs: rejects --reason without --state closed", () => {
  assert.throws(
    () => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--reason", "completed"]),
    /--reason is only valid together with --state closed/,
  );
  assert.throws(
    () => parseEditIssueCliArgs(["--repo", "o/n", "--issue", "1", "--state", "open", "--reason", "completed"]),
    /--reason is only valid together with --state closed/,
  );
});

test("editIssue: --state closed (no reason) calls gh issue close and reports state", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue({ repo: "o/n", issue: 9, state: "closed" }, { run });
  assert.deepEqual(result.edited, ["state"]);
  assert.deepEqual(calls, [["issue", "close", "9", "--repo", "o/n"]]);
});

test("editIssue: --state closed --reason not_planned maps to gh's space-form \"not planned\"", async () => {
  // gh issue close rejects the underscore form client-side; the CLI-facing flag value
  // stays `not_planned` (stable/shell-friendly) but the gh arg must be the space form.
  const { run, calls } = stubGh();
  const result = await editIssue({ repo: "o/n", issue: 9, state: "closed", reason: "not_planned" }, { run });
  assert.deepEqual(result.edited, ["state"]);
  assert.deepEqual(calls, [["issue", "close", "9", "--repo", "o/n", "--reason", "not planned"]]);
});

test("editIssue: an unexpected state value fails closed instead of degrading to reopen", async () => {
  const { run, calls } = stubGh();
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 9, state: "archived" }, { run }),
    /invalid state "archived"/,
  );
  assert.deepEqual(calls, []); // no gh invocation happened
});

test("editIssue: --state open calls gh issue reopen", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue({ repo: "o/n", issue: 9, state: "open" }, { run });
  assert.deepEqual(result.edited, ["state"]);
  assert.deepEqual(calls, [["issue", "reopen", "9", "--repo", "o/n"]]);
});

test("editIssue: --body combined with --state closed runs edit then close, in order", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue({ repo: "o/n", issue: 9, body: "New body", state: "closed", reason: "completed" }, { run });
  assert.deepEqual(result.edited, ["body", "state"]);
  assert.deepEqual(calls, [
    ["issue", "edit", "9", "--repo", "o/n", "--body", "New body"],
    ["issue", "close", "9", "--repo", "o/n", "--reason", "completed"],
  ]);
});

test("editIssue: throws when the gh issue close call fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "already closed" });
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 9, state: "closed" }, { run }),
    /gh issue close failed: already closed/,
  );
});

test("editIssue: a close failure after a successful field edit reports the edits that landed", async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    // First call (the edit) succeeds; second call (the close) fails.
    return calls.length === 1
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 1, stdout: "", stderr: "already closed" };
  };
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 9, title: "New", state: "closed" }, { run }),
    /state change failed after edits were applied: title — gh issue close failed: already closed/,
  );
});

test("editIssue: throws when the gh issue reopen call fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "not closed" });
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 9, state: "open" }, { run }),
    /gh issue reopen failed: not closed/,
  );
});

test("editIssue: a reopen failure after a successful field edit reports the edits that landed", async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return calls.length === 1
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 1, stdout: "", stderr: "not closed" };
  };
  await assert.rejects(
    () => editIssue({ repo: "o/n", issue: 9, body: "New body", state: "open" }, { run }),
    /state change failed after edits were applied: body — gh issue reopen failed: not closed/,
  );
});

test("runCli: --state closed reports state in edited via --jq", async () => {
  const { run } = stubGh();
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "9", "--state", "closed", "--jq", ".edited[0]"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "state");
});

test("editIssue: GRILL-SUBLOOP-NO-EMBED-SYNTHESIS (#1628) refuses a body embedding grill headings under --enforce-grill", async () => {
  const { run } = stubGh();
  await assert.rejects(
    () => editIssue({
      repo: "o/n", issue: 5,
      body: "## Acceptance criteria\n\n- [ ] ac\n\n## Grill synthesis\n\n- findings here\n",
      addAssignees: [], removeAssignees: [],
      enforceGrill: true,
    }, { run }),
    /GRILL-SUBLOOP-NO-EMBED-SYNTHESIS/,
  );
});

test("editIssue: --enforce-grill does not refuse a clean body containing no grill embed", async () => {
  const { run, calls } = stubGh();
  const result = await editIssue({
    repo: "o/n", issue: 5,
    body: "## Acceptance criteria\n\n- [ ] ac\n\n<!-- loop-grill: 2026-08-14 mode:interactive -->",
    addAssignees: [], removeAssignees: [],
    enforceGrill: true,
  }, { run });
  assert.equal(result.ok, true);
  assert.ok(calls.length === 1);
});

test("parseEditIssueCliArgs: --enforce-grill flag is wired", () => {
  const out = parseEditIssueCliArgs(["--repo", "o/n", "--issue", "5", "--title", "x", "--enforce-grill"]);
  assert.equal(out.enforceGrill, true);
});
