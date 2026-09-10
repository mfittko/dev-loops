import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergePr, parseMergePrCliArgs, main } from "../../scripts/github/merge-pr.mjs";
import { captureStream } from "../_helpers.mjs";

const HEAD = "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const MERGE_COMMIT = "aaaa1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";

function baseOptions(overrides = {}) {
  return { repo: "mfittko/dev-loops", pr: 5, humanApprovedBy: "mfittko", method: "squash", stableRelease: false, ...overrides };
}

// A runtime whose facts default to a fully-satisfied drain merge; overrides tune
// individual facts to drive one failing precondition at a time.
function makeRuntime({
  prView = {},
  reviews = [],
  comments = [],
  evidence = { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [] },
  humanMergeOnly = false,
  postMergeState = "MERGED",
} = {}) {
  const calls = { ghJson: [], runChild: [] };
  const view = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    title: "feat: sanctioned merge wrapper",
    headRefOid: HEAD,
    url: "https://github.com/mfittko/dev-loops/pull/5",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...prView,
  };
  return {
    calls,
    runtime: {
      env: {},
      ghJson: async (args) => {
        calls.ghJson.push(args);
        if (args.includes("pull") || (args.join(" ").includes("/pulls/"))) return reviews;
        if (args.join(" ").includes("/issues/")) return comments;
        if (args.includes("mergeCommit,state")) return { mergeCommit: { oid: MERGE_COMMIT }, state: postMergeState };
        return view; // the primary pr view
      },
      runChild: async (cmd, args) => { calls.runChild.push([cmd, ...args]); return { stdout: "", stderr: "", code: 0 }; },
      detectEvidence: async () => evidence,
      loadConfig: async () => ({ config: { autonomy: { humanMergeOnly } }, errors: [] }),
      cwd: process.cwd(),
    },
  };
}

test("parse: --human-approved-by is mandatory and login-validated", () => {
  assert.throws(() => parseMergePrCliArgs(["--repo", "o/r", "--pr", "5"]), /human-approved-by/);
  assert.throws(() => parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", ""]), /human-approved-by/);
  assert.throws(() => parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", "no good"]), /real GitHub login/);
  const ok = parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", "mfittko"]);
  assert.equal(ok.humanApprovedBy, "mfittko");
  assert.equal(ok.method, "squash");
});

test("fully-satisfied standing-authorized drain merge succeeds and stamps the approver", async () => {
  const { runtime, calls } = makeRuntime();
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.mergeCommit, MERGE_COMMIT);
  assert.equal(result.approvedBy, "mfittko");
  assert.equal(result.mergeClass, "drain");
  assert.equal(result.approvalVia, "standing_authorization");
  assert.equal(result.method, "squash");
  // exactly one lifecycle mutation, and it is the base merge — never a tag/publish.
  assert.equal(calls.runChild.length, 1);
  assert.deepEqual(calls.runChild[0], ["gh", "pr", "merge", "5", "--repo", "mfittko/dev-loops", "--squash"]);
  assert.ok(!calls.runChild.some((c) => c.join(" ").match(/release|publish|tag/)));
});

test("each missing precondition refuses with a machine-readable reason naming it", async () => {
  const cases = [
    ["mergeable", makeRuntime({ prView: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } })],
    ["ci_green", makeRuntime({ prView: { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] } })],
    ["title_markers", makeRuntime({ prView: { title: "WIP: wrapper" } })],
    ["gate_evidence", makeRuntime({ evidence: { ok: false, sizeOutcome: null, touchesT1: false, failures: ["missing visible clean draft_gate comment"] } })],
    ["size_budget_human_approval", makeRuntime({ evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] } })],
    ["merge_approval", makeRuntime({ humanMergeOnly: true })], // no standing auth, no fresh approval
  ];
  for (const [expected, { runtime, calls }] of cases) {
    let threw = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
    assert.ok(threw, `${expected} should throw`);
    assert.equal(threw.mergePrFailure.ok, false);
    assert.equal(threw.mergePrFailure.merged, false);
    assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === expected), `expected ${expected}, got ${JSON.stringify(threw.mergePrFailure.failures)}`);
    assert.equal(calls.runChild.length, 0, `${expected}: merge must not run when a precondition fails`);
  }
});

test("stable-release merge with only a standing authorization is refused", async () => {
  const { runtime } = makeRuntime();
  let threw = null;
  try { await mergePr(baseOptions({ stableRelease: true }), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.equal(threw.mergePrFailure.mergeClass, "escalated");
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "merge_approval"));
});

test("stable-release merge with a fresh head-pinned operator comment marker succeeds", async () => {
  const { runtime } = makeRuntime({
    humanMergeOnly: true, // standing auth off, so only the fresh marker can satisfy
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }],
    evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] },
  });
  const result = await mergePr(baseOptions({ stableRelease: true }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.approvalVia, "comment_marker");
});

test("a non-zero `gh pr merge` exit throws instead of reporting a false success", async () => {
  const { runtime } = makeRuntime();
  // Override runChild so the merge call exits non-zero (e.g. a branch-protection block).
  runtime.runChild = async (cmd, args) => ({ stdout: "", stderr: "protected branch", code: 1, cmd, args });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a failed merge must throw");
  assert.match(threw.message, /gh pr merge exited 1/);
  assert.ok(!threw.mergePrFailure, "a merge-execution failure is not a precondition failure");
});

test("main honors --jq and --silent identically to the sibling wrappers", async () => {
  const stdout = captureStream();
  const { runtime } = makeRuntime();
  const code = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--human-approved-by", "mfittko", "--jq", ".mergeCommit"], { ...runtime, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), MERGE_COMMIT);

  const silentOut = captureStream();
  const silentCode = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--human-approved-by", "mfittko", "--silent"], { ...makeRuntime().runtime, stdout: silentOut });
  assert.equal(silentCode, 0);
  assert.equal(silentOut.get(), "");
});
