import assert from "node:assert/strict";
import test from "node:test";

import {
  parseListIssuesCliArgs,
  listIssues,
  runCli,
} from "../../scripts/github/list-issues.mjs";

function stubGh(payload, { code = 0, stderr = "" } = {}) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return { code, stdout: code === 0 ? JSON.stringify(payload) : "", stderr };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

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

test("runCli: --jq extracts a single issue number", async () => {
  const { run } = stubGh(ISSUES);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--jq", ".issues[0].number"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "10");
});

test("runCli: invalid --jq filter fails closed with exit 2", async () => {
  const { run } = stubGh(ISSUES);
  const code = await runCli(["--repo", "o/n", "--jq", "bogus!!"], { run, stdout: captureStream(), stderr: captureStream() });
  assert.equal(code, 2);
});

test("runCli: --silent + --jq predicate maps to exit code only", async () => {
  const { run } = stubGh(ISSUES);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--jq", ".issues | length", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});
