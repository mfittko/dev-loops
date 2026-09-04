import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFetchCiLogsCliArgs,
  fetchCiLogs,
  runCli,
} from "../../scripts/github/fetch-ci-logs.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

// Stub gh by matching the leading subcommand of each invocation. Each matcher is
// { match: (args)=>bool, resp: { code, stdout, stderr } }.
const stubGh = (matchers) => makeGhStub(matchers);

const isPrView = (a) => a[0] === "pr" && a[1] === "view";
const isRunList = (a) => a[0] === "run" && a[1] === "list";
const isRunView = (a) => a[0] === "run" && a[1] === "view";

test("parseFetchCiLogsCliArgs: requires repo + pr; defaults tail=200", () => {
  const out = parseFetchCiLogsCliArgs(["--repo", "o/n", "--pr", "5"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.pr, 5);
  assert.equal(out.failedOnly, false);
  assert.equal(out.tail, 200);
  assert.throws(() => parseFetchCiLogsCliArgs(["--repo", "o/n"]), /requires both/);
});

test("parseFetchCiLogsCliArgs: --failed-only + --tail", () => {
  const out = parseFetchCiLogsCliArgs(["--repo", "o/n", "--pr", "5", "--failed-only", "--tail", "50"]);
  assert.equal(out.failedOnly, true);
  assert.equal(out.tail, 50);
});

test("parseFetchCiLogsCliArgs: rejects non-positive --tail", () => {
  assert.throws(() => parseFetchCiLogsCliArgs(["--repo", "o/n", "--pr", "5", "--tail", "0"]), /--tail must be a positive integer/);
});

test("fetchCiLogs: returns failing job log tail for a red PR", async () => {
  const logBody = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const { run, calls } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "abc123" }) } },
    {
      match: isRunList,
      resp: {
        stdout: JSON.stringify([
          { databaseId: 42, name: "ci", conclusion: "failure", status: "completed" },
          { databaseId: 43, name: "lint", conclusion: "success", status: "completed" },
        ]),
      },
    },
    { match: (a) => isRunView(a) && a.includes("--log-failed"), resp: { stdout: logBody } },
  ]);
  const result = await fetchCiLogs(
    { repo: "o/n", pr: 5, failedOnly: true, tail: 3 },
    { run },
  );
  assert.equal(result.ok, true);
  assert.equal(result.headSha, "abc123");
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].runId, 42);
  assert.equal(result.runs[0].conclusion, "failure");
  // tail=3 keeps only the last 3 lines.
  assert.equal(result.runs[0].logTail, "line 8\nline 9\nline 10");
  // run list was scoped to the head SHA.
  assert.ok(calls.some((a) => isRunList(a) && a.includes("abc123")));
});

test("fetchCiLogs: CRLF log tail normalizes without a stray trailing \\r", async () => {
  const logBody = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "crlf01" }) } },
    { match: isRunList, resp: { stdout: JSON.stringify([{ databaseId: 1, name: "ci", conclusion: "failure", status: "completed" }]) } },
    { match: (a) => isRunView(a) && a.includes("--log-failed"), resp: { stdout: logBody } },
  ]);
  const result = await fetchCiLogs({ repo: "o/n", pr: 5, failedOnly: true, tail: 2 }, { run });
  assert.equal(result.runs[0].logTail, "line 4\nline 5");
});

test("fetchCiLogs: without --failed-only includes all runs and uses --log for non-failures", async () => {
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "def456" }) } },
    {
      match: isRunList,
      resp: { stdout: JSON.stringify([{ databaseId: 7, name: "ci", conclusion: "success", status: "completed" }]) },
    },
    { match: (a) => isRunView(a) && a.includes("--log"), resp: { stdout: "all good" } },
  ]);
  const result = await fetchCiLogs({ repo: "o/n", pr: 5, failedOnly: false, tail: 200 }, { run });
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].logTail, "all good");
});

test("fetchCiLogs: log fetch failure records an unavailable note, not a throw", async () => {
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "abc" }) } },
    { match: isRunList, resp: { stdout: JSON.stringify([{ databaseId: 9, name: "ci", conclusion: "failure" }]) } },
    { match: isRunView, resp: { code: 1, stderr: "log expired" } },
  ]);
  const result = await fetchCiLogs({ repo: "o/n", pr: 5, failedOnly: true, tail: 10 }, { run });
  assert.match(result.runs[0].logTail, /log unavailable: log expired/);
});

test("fetchCiLogs: throws when pr view yields no head SHA", async () => {
  const { run } = stubGh([{ match: isPrView, resp: { stdout: JSON.stringify({}) } }]);
  await assert.rejects(() => fetchCiLogs({ repo: "o/n", pr: 5, failedOnly: false, tail: 10 }, { run }), /did not return headRefOid/);
});

test("runCli: --jq extracts a failing run's name", async () => {
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "abc" }) } },
    { match: isRunList, resp: { stdout: JSON.stringify([{ databaseId: 1, name: "ci", conclusion: "failure" }]) } },
    { match: isRunView, resp: { stdout: "boom" } },
  ]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "5", "--failed-only", "--jq", ".runs[0].name"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "ci");
});

test("runCli: invalid --jq filter fails closed with exit 2", async () => {
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "abc" }) } },
    { match: isRunList, resp: { stdout: JSON.stringify([]) } },
  ]);
  const code = await runCli(["--repo", "o/n", "--pr", "5", "--jq", "bad!!"], { run, stdout: captureStream(), stderr: captureStream() });
  assert.equal(code, 2);
});

test("runCli: --silent maps success to exit 0 with no stdout", async () => {
  const { run } = stubGh([
    { match: isPrView, resp: { stdout: JSON.stringify({ headRefOid: "abc" }) } },
    { match: isRunList, resp: { stdout: JSON.stringify([]) } },
  ]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "5", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});

test("runCli: gh failure returns exit 1", async () => {
  const { run } = stubGh([{ match: isPrView, resp: { code: 1, stderr: "nope" } }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "5"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /nope/);
});
