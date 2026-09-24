import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { parseCheckPrePushDeltaArgs, runCli } from "../../scripts/loop/check-pre-push-delta.mjs";

const A = "aaaaaaa1111111";
const B = "bbbbbbb2222222";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-delta-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify([{ severity: "low", angle: "correctness", summary: "s", judgeDisposition: "act" }]));
  const result = path.join(dir, "result.json");
  fs.writeFileSync(result, JSON.stringify({
    reviewBaselineHead: A,
    candidateHead: B,
    actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }],
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
  }));
  return { dir, actList, result };
}

const quiet = { stdout: { write: () => {} } };

test("without --result the CLI prints the cumulative delta input for the worktree head", () => {
  const { dir, actList } = fixture();
  const out = runCli(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1"], { ...quiet, readHead: () => B });
  assert.equal(out.input.diffRange, `${A}..${B}`);
  assert.equal(out.input.specIdentity, "spec@1");
  // Read-only: nothing is written next to the inputs.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["act-list.json", "result.json"]);
});

test("with --result the CLI authorizes the push only for the reviewed head", () => {
  const { actList, result } = fixture();
  const args = ["--act-list", actList, "--baseline", A, "--result", result, "--invocation", "1"];
  assert.equal(runCli(args, { ...quiet, readHead: () => B }).nextStep, "push");
  const stale = runCli(args, { ...quiet, readHead: () => "ccccccc3333333" });
  assert.equal(stale.fresh, false);
  assert.equal(stale.nextStep, "rereview_current_head");
});

test("argument errors fail closed", () => {
  assert.throws(() => parseCheckPrePushDeltaArgs(["--baseline", A]), /--act-list/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--result", "r"]), /--invocation/);
  assert.throws(() => parseCheckPrePushDeltaArgs(["--act-list", "x", "--baseline", A, "--bogus"]), /bogus/);
});
