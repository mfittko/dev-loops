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

test("reconcile: no-op with reason no-run-to-refire when no gate-evidence status exists (fail-safe path, AC #3)", async () => {
  // Evidence satisfied but the current head carries no gate-evidence status at
  // all (statusState 'none', no run id): there is nothing to re-fire, so the
  // reconcile leaves it to the native path and re-fires nothing.
  const rerunCalls = [];
  const result = await reconcileGateEvidenceStatus(
    { repo: "mfittko/dev-loops", pr: 1934 },
    { runChild: stubRunChild({ statusState: "none", rerunCalls }), detectEvidence: detectStub("satisfied") },
  );

  assert.equal(result.action, "none");
  assert.equal(result.reason, "no-run-to-refire");
  assert.equal(result.statusState, "none");
  assert.equal(result.refired, false);
  assert.deepEqual(rerunCalls, []);
});

test("reconcile: the REAL default detectEvidence reads evidenceState from stderr on a not-satisfied head → fail-closed action none (issue #1935, no throw)", async () => {
  // The detector writes its JSON result (with evidenceState) to STDOUT when
  // satisfied but to STDERR (empty stdout, exit 1) when NOT satisfied. This
  // drives the real default detectEvidence — NOT the stub — so the stdout/stderr
  // fallback is exercised end-to-end: a genuinely-missing verdict must return
  // action:none, never throw.
  const rerunCalls = [];
  const detectorStderrPayload = JSON.stringify({
    ok: false,
    error: "Pre-merge gate evidence check failed: no clean current-head pre_approval_gate verdict",
    currentHeadSha: "d5642cf",
    evidenceState: "not_established",
  });
  const runChild = async (command, args) => {
    // Default detectEvidence spawns `node detect-checkpoint-evidence.mjs ...`.
    if (String(command).length > 0 && Array.isArray(args) && args.some((a) => String(a).includes("detect-checkpoint-evidence.mjs"))) {
      return { code: 1, stdout: "", stderr: `${detectorStderrPayload}\n` };
    }
    if (command === "gh" && args[0] === "api") {
      return { code: 0, stdout: `${JSON.stringify({ state: "failure", statuses: [{ context: "gate-evidence", state: "failure", target_url: RUN_URL }] })}\n`, stderr: "" };
    }
    if (command === "gh" && args[0] === "run" && args[1] === "rerun") {
      rerunCalls.push(args[2]);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected invocation: ${command} ${args.join(" ")}`);
  };

  const result = await reconcileGateEvidenceStatus({ repo: "mfittko/dev-loops", pr: 1934 }, { runChild });

  assert.equal(result.evidenceState, "not_established");
  assert.equal(result.action, "none");
  assert.equal(result.reason, "evidence-not-satisfied-fail-closed");
  assert.equal(result.refired, false);
  assert.deepEqual(rerunCalls, [], "a genuinely-missing verdict must NEVER re-fire");
});
