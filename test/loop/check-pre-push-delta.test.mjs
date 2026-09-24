import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";

import { parseCheckPrePushDeltaArgs, runCli } from "../../scripts/loop/check-pre-push-delta.mjs";

const A = "aaaaaaa1111111";
const B = "bbbbbbb2222222";
const ACT_LIST = [{ severity: "low", angle: "correctness", summary: "s", judgeDisposition: "act" }];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const result = path.join(dir, "result.json");
  fs.writeFileSync(result, JSON.stringify({
    reviewBaselineHead: A,
    candidateHead: B,
    actSetId: startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId,
    actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }],
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
  }));
  return { dir, actList, result };
}

const quiet = { stdout: { write: () => {} } };
const headAt = (head) => ({ ...quiet, revParse: (_worktree, rev) => (rev === "HEAD" ? head : rev), isAncestor: () => true });

test("without --result the CLI prints the cumulative delta input for the worktree head", () => {
  const { dir, actList } = fixture();
  const out = runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1"], headAt(B));
  assert.equal(out.input.diffRange, `${A}..${B}`);
  assert.equal(out.input.specIdentity, "spec@1");
  // Read-only: nothing is written next to the inputs.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["act-list.json", "result.json"]);
});

test("with --result the CLI authorizes the push only for the reviewed head", () => {
  const { actList, result } = fixture();
  const args = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  assert.equal(runCli(args, headAt(B)).nextStep, "push");
  const stale = runCli(args, headAt("ccccccc3333333"));
  assert.equal(stale.fresh, false);
  assert.equal(stale.nextStep, "rereview_current_head");
});

test("the baseline resolves to a full SHA, and HEAD equal to the baseline fails", () => {
  const { actList } = fixture();
  const full = `${A}${"0".repeat(26)}`;
  const resolve = (head) => ({ ...quiet, revParse: (_worktree, rev) => (rev === "HEAD" ? head : full), isAncestor: () => true });
  assert.equal(runCli(["--act-list", actList, "--baseline", A], resolve(B)).input.reviewBaselineHead, full);
  assert.throws(() => runCli(["--act-list", actList, "--baseline", A], resolve(full)), /equals the baseline/);
});

test("a baseline that is not an ancestor of HEAD fails", () => {
  const { actList } = fixture();
  const calls = [];
  const seam = {
    ...headAt(B),
    isAncestor: (_worktree, ancestor, descendant) => {
      calls.push([ancestor, descendant]);
      return false;
    },
  };
  assert.throws(() => runCli(["--act-list", actList, "--baseline", A], seam), /is not an ancestor of worktree HEAD/);
  assert.deepEqual(calls, [[A, B]]);
});

test("argument errors fail closed", () => {
  assert.throws(() => parseCheckPrePushDeltaArgs(["--baseline", A]), /--act-list/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r"]), /--invocation/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--bogus"]), /bogus/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", "HEAD~1"]), /hex commit SHA/);
  for (const n of ["0", "4", "1.5"]) {
    assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r", "--invocation", n]), /1\.\.3/, n);
  }
});
