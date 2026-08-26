import assert from "node:assert/strict";
import test from "node:test";

import { parseViewIssueCliArgs, viewIssue, runCli } from "../../scripts/github/view-issue.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

function stubGh(payload, { code = 0, stderr = "" } = {}) {
  return makeGhStub([{ code, stdout: code === 0 ? JSON.stringify(payload) : "", stderr }], { repeatLastOnOverflow: true });
}

const ISSUE = {
  number: 1354,
  title: "Fact-ground and deslop the intro deck",
  body: "## Summary\nApply the grounding pass to the intro deck.",
  state: "OPEN",
  author: { login: "mfittko" },
  labels: [],
};

test("parseViewIssueCliArgs: defaults include the loop field set", () => {
  const out = parseViewIssueCliArgs(["--repo", "o/n", "--issue", "1354"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.issue, 1354);
  assert.match(out.fields, /body/);
  assert.match(out.fields, /state/);
});

test("parseViewIssueCliArgs: requires --repo and --issue", () => {
  assert.throws(() => parseViewIssueCliArgs(["--repo", "o/n"]), /requires both --repo/);
  assert.throws(() => parseViewIssueCliArgs(["--issue", "1"]), /requires both --repo/);
});

test("parseViewIssueCliArgs: --json overrides fields and rejects junk", () => {
  const out = parseViewIssueCliArgs(["--repo", "o/n", "--issue", "1", "--json", "state, body"]);
  assert.equal(out.fields, "state,body");
  assert.throws(() => parseViewIssueCliArgs(["--repo", "o/n", "--issue", "1", "--json", "state;drop"]), /field names/);
  assert.throws(() => parseViewIssueCliArgs(["--repo", "o/n", "--issue", "1", "--json", " "]), /at least one field/);
});

test("viewIssue: passes the field list to gh and returns the object", async () => {
  const { run, calls } = stubGh(ISSUE);
  const result = await viewIssue({ repo: "o/n", issue: 1354, fields: "number,state,body" }, { run });
  assert.equal(result.ok, true);
  assert.equal(result.issue.number, 1354);
  assert.deepEqual(calls[0], ["issue", "view", "1354", "--repo", "o/n", "--json", "number,state,body"]);
});

test("viewIssue: throws when gh fails", async () => {
  const { run } = stubGh(null, { code: 1, stderr: "no issue" });
  await assert.rejects(() => viewIssue({ repo: "o/n", issue: 1354, fields: "state" }, { run }), /gh issue view failed: no issue/);
});

test("viewIssue: throws when gh returns a non-object", async () => {
  const { run } = stubGh([1, 2]);
  await assert.rejects(() => viewIssue({ repo: "o/n", issue: 1354, fields: "state" }, { run }), /did not return a JSON object/);
});

test("runCli: --jq extracts the issue body", async () => {
  const { run } = stubGh(ISSUE);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "1354", "--jq", ".issue.body"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "## Summary\nApply the grounding pass to the intro deck.");
});

test("runCli: --silent + --jq predicate maps to exit code only", async () => {
  const { run } = stubGh(ISSUE);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--issue", "1354", "--jq", ".issue.number==1354", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});

test("runCli: invalid --jq fails closed with exit 2", async () => {
  const { run } = stubGh(ISSUE);
  const code = await runCli(["--repo", "o/n", "--issue", "1354", "--jq", "bogus!!"], { run, stdout: captureStream(), stderr: captureStream() });
  assert.equal(code, 2);
});
