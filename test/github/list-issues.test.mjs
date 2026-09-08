import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  parseListIssuesCliArgs,
  listIssues,
  runCli,
} from "../../scripts/github/list-issues.mjs";
import { captureStream, makeJsonGhStub as stubGh } from "../_helpers.mjs";

const ISSUES = [
  { number: 10, title: "Fix bug", state: "OPEN", labels: [{ name: "bug" }, { name: "p1" }] },
  { number: 11, title: "Add docs", state: "OPEN", labels: [] },
];

test("parseListIssuesCliArgs: defaults state=open, limit=30", () => {
  const out = parseListIssuesCliArgs(["--repo", "o/n"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.state, "open");
  assert.equal(out.limit, 30);
  assert.deepEqual(out.labels, []);
});

test("parseListIssuesCliArgs: requires --repo", () => {
  assert.throws(() => parseListIssuesCliArgs([]), /requires --repo/);
});

test("parseListIssuesCliArgs: rejects invalid state", () => {
  assert.throws(() => parseListIssuesCliArgs(["--repo", "o/n", "--state", "weird"]), /--state must be one of/);
});

test("parseListIssuesCliArgs: collects repeated --label", () => {
  const out = parseListIssuesCliArgs(["--repo", "o/n", "--label", "bug", "--label", "p1"]);
  assert.deepEqual(out.labels, ["bug", "p1"]);
});

test("parseListIssuesCliArgs: rejects non-positive --limit", () => {
  assert.throws(() => parseListIssuesCliArgs(["--repo", "o/n", "--limit", "0"]), /--limit must be a positive integer/);
});

test("listIssues: returns normalized issues (state lowercased, labels flattened)", async () => {
  const { run, calls } = stubGh(ISSUES);
  const result = await listIssues(
    { repo: "o/n", state: "open", labels: ["bug"], limit: 30 },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, [
    { number: 10, title: "Fix bug", state: "open", labels: ["bug", "p1"] },
    { number: 11, title: "Add docs", state: "open", labels: [] },
  ]);
  // gh invocation carries state, limit, json fields, and the label filter.
  assert.deepEqual(calls[0], [
    "issue", "list", "--repo", "o/n", "--state", "open", "--limit", "30",
    "--json", "number,title,state,labels", "--label", "bug",
  ]);
});

test("listIssues: drops entries missing a required field so the shape stays well-typed", async () => {
  const { run } = stubGh([
    { number: 10, title: "ok", state: "OPEN", labels: [] },
    { number: null, title: "no number", state: "OPEN", labels: [] },
    { number: 12, title: 42, state: "OPEN", labels: [] },
    { number: 13, title: "no state", labels: [] },
  ]);
  const result = await listIssues({ repo: "o/n", state: "open", labels: [], limit: 30 }, { run });
  assert.deepEqual(result.issues, [{ number: 10, title: "ok", state: "open", labels: [] }]);
});

test("listIssues: throws when gh fails", async () => {
  const { run } = stubGh(null, { code: 1, stderr: "rate limited" });
  await assert.rejects(() => listIssues({ repo: "o/n", state: "open", labels: [], limit: 30 }, { run }), /gh issue list failed: rate limited/);
});

// Wiring: this command's parser + listIssues operation compose through the shared
// runReadCommandCli shell to produce the `.issues[]` result shape. The generic
// shell matrix (--silent, invalid-filter refusal, parse-vs-runtime errors) is
// covered once in test/lib/run-read-command-cli.test.mjs (#2037).
test("runCli: parser + listIssues wire through the shared shell (--jq extracts a single issue number)", async () => {
  const { run } = stubGh(ISSUES);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--jq", ".issues[0].number"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "10");
});
