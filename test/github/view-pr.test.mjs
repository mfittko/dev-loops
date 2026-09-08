import assert from "node:assert/strict";
import { test } from "bun:test";

import { parseViewPrCliArgs, viewPr, runCli } from "../../scripts/github/view-pr.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

function stubGh(payload, { code = 0, stderr = "" } = {}) {
  return makeGhStub([{ code, stdout: code === 0 ? JSON.stringify(payload) : "", stderr }], { repeatLastOnOverflow: true });
}

const PR = {
  number: 88,
  title: "Wrap gh pr reads",
  state: "OPEN",
  isDraft: true,
  headRefName: "issue-1057",
  baseRefName: "main",
  headRefOid: "abc123",
  mergeStateStatus: "CLEAN",
};

test("parseViewPrCliArgs: defaults include the loop field set", () => {
  const out = parseViewPrCliArgs(["--repo", "o/n", "--pr", "88"]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.pr, 88);
  assert.match(out.fields, /mergeStateStatus/);
  assert.match(out.fields, /headRefOid/);
});

test("parseViewPrCliArgs: requires --repo and --pr", () => {
  assert.throws(() => parseViewPrCliArgs(["--repo", "o/n"]), /requires both --repo/);
  assert.throws(() => parseViewPrCliArgs(["--pr", "1"]), /requires both --repo/);
});

test("parseViewPrCliArgs: --json overrides fields and rejects junk", () => {
  const out = parseViewPrCliArgs(["--repo", "o/n", "--pr", "1", "--json", "state, mergeable"]);
  assert.equal(out.fields, "state,mergeable");
  assert.throws(() => parseViewPrCliArgs(["--repo", "o/n", "--pr", "1", "--json", "state;drop"]), /field names/);
  assert.throws(() => parseViewPrCliArgs(["--repo", "o/n", "--pr", "1", "--json", " "]), /at least one field/);
});

test("viewPr: passes the field list to gh and returns the object", async () => {
  const { run, calls } = stubGh(PR);
  const result = await viewPr({ repo: "o/n", pr: 88, fields: "number,state,mergeStateStatus" }, { run });
  assert.equal(result.ok, true);
  assert.equal(result.pr.number, 88);
  assert.deepEqual(calls[0], ["pr", "view", "88", "--repo", "o/n", "--json", "number,state,mergeStateStatus"]);
});

test("viewPr: throws when gh fails", async () => {
  const { run } = stubGh(null, { code: 1, stderr: "no such PR" });
  await assert.rejects(() => viewPr({ repo: "o/n", pr: 88, fields: "state" }, { run }), /gh pr view failed: no such PR/);
});

test("viewPr: throws when gh returns a non-object", async () => {
  const { run } = stubGh([1, 2]);
  await assert.rejects(() => viewPr({ repo: "o/n", pr: 88, fields: "state" }, { run }), /did not return a JSON object/);
});

// Wiring: this command's parser + viewPr operation compose through the shared
// runReadCommandCli shell to produce the `.pr.*` result shape. The generic shell
// matrix (--silent, invalid-filter refusal, parse-vs-runtime errors) is covered
// once in test/lib/run-read-command-cli.test.mjs (#2037).
test("runCli: parser + viewPr wire through the shared shell (--jq extracts mergeStateStatus)", async () => {
  const { run } = stubGh(PR);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "88", "--jq", ".pr.mergeStateStatus"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "CLEAN");
});
