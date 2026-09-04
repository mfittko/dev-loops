import assert from "node:assert/strict";
import test from "node:test";

import { reconcileGateEvidenceStatus } from "../../scripts/github/reconcile-gate-evidence-status.mjs";

const HEAD = "d5642cf";
const RUN_URL = "https://github.com/o/r/actions/runs/701";

// Route gh calls: the commit-status read returns the supplied gate-evidence
// status; `gh run rerun <id>` is recorded so the test can assert whether the
// stuck run was re-fired. Any other gh call is unexpected.
function stubRunChild({ statusState, targetUrl = RUN_URL, rerunCalls }) {
  return async function runChild(command, args) {
    assert.equal(command, "gh");
    const joined = args.join(" ");
    if (joined.includes("commits/") && joined.includes("/status")) {
      const statuses = statusState === "none" ? [] : [{ context: "gate-evidence", state: statusState, target_url: targetUrl }];
      return { code: 0, stdout: `${JSON.stringify({ state: statusState, statuses })}\n`, stderr: "" };
    }
    if (args[0] === "run" && args[1] === "rerun") {
      rerunCalls.push(args[2]);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected gh invocation: ${joined}`);
  };
}

const detectStub = (evidenceState) => async () => ({ evidenceState, currentHeadSha: HEAD });

test("reconcile: re-fires the stuck run when the verdict IS posted but the status is failure (issue #1935 — no manual rerun)", async () => {
  // The push-before-verdict race: evidence satisfied for the current head, but
  // the required status is still `failure` (a cancelled/raced verdict-post
  // re-fire). Reconcile must re-fire the run so it flips to success.
  const rerunCalls = [];
  const result = await reconcileGateEvidenceStatus(
    { repo: "mfittko/dev-loops", pr: 1934 },
    { runChild: stubRunChild({ statusState: "failure", rerunCalls }), detectEvidence: detectStub("satisfied") },
  );

  assert.equal(result.ok, true);
  assert.equal(result.evidenceState, "satisfied");
  assert.equal(result.statusState, "failure");
  assert.equal(result.action, "refire");
  assert.equal(result.refired, true);
  assert.deepEqual(rerunCalls, ["701"]);
});

test("reconcile: fail-closed — never re-fires when the verdict is genuinely missing (AC #3)", async () => {
  const rerunCalls = [];
  const result = await reconcileGateEvidenceStatus(
    { repo: "mfittko/dev-loops", pr: 1934 },
    { runChild: stubRunChild({ statusState: "failure", rerunCalls }), detectEvidence: detectStub("not_established") },
  );

  assert.equal(result.action, "none");
  assert.equal(result.reason, "evidence-not-satisfied-fail-closed");
  assert.equal(result.refired, false);
  assert.deepEqual(rerunCalls, [], "must NOT re-fire when evidence is not satisfied");
});

test("reconcile: no-op when the status is already success", async () => {
  const rerunCalls = [];
  const result = await reconcileGateEvidenceStatus(
    { repo: "mfittko/dev-loops", pr: 1934 },
    { runChild: stubRunChild({ statusState: "success", rerunCalls }), detectEvidence: detectStub("satisfied") },
  );

  assert.equal(result.action, "none");
  assert.equal(result.reason, "already-success");
  assert.deepEqual(rerunCalls, []);
});

test("reconcile: --dry-run reports the refire decision without re-firing", async () => {
  const rerunCalls = [];
  const result = await reconcileGateEvidenceStatus(
    { repo: "mfittko/dev-loops", pr: 1934, dryRun: true },
    { runChild: stubRunChild({ statusState: "failure", rerunCalls }), detectEvidence: detectStub("satisfied") },
  );

  assert.equal(result.action, "refire");
  assert.equal(result.refired, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(rerunCalls, [], "dry-run must NOT re-fire");
});
