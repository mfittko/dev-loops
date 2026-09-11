import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergePr, parseMergePrCliArgs, main } from "../../scripts/github/merge-pr.mjs";
import { captureStream } from "../_helpers.mjs";

const HEAD = "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const MERGE_COMMIT = "aaaa1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";

// A drain merge asserting a recorded standing authorization (--standing-authorization).
function baseOptions(overrides = {}) {
  return { repo: "mfittko/dev-loops", pr: 5, humanApprovedBy: "mfittko", method: "squash", stableRelease: false, standingAuthorization: true, ...overrides };
}

// A runtime whose facts default to a fully-satisfied drain merge; overrides tune
// individual facts to drive one failing precondition at a time.
function makeRuntime({
  prView = {},
  reviews = [],
  comments = [],
  evidence = { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [] },
  evidenceHead = HEAD,
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
      env: { GH_TOKEN: "t" },
      ghJson: async (args) => {
        calls.ghJson.push(args);
        if (args.includes("pull") || (args.join(" ").includes("/pulls/"))) return reviews;
        if (args.join(" ").includes("/issues/")) return comments;
        if (args.includes("mergeCommit,state")) return { mergeCommit: { oid: MERGE_COMMIT }, state: postMergeState };
        return view; // the primary pr view
      },
      // runChild's real signature is (cmd, args, env) — record env to prove it is
      // passed positionally, not wrapped in an options object.
      runChild: async (cmd, args, env) => { calls.runChild.push({ cmd, args, env }); return { stdout: "", stderr: "", code: 0 }; },
      detectEvidence: async () => ({ ...evidence, currentHeadSha: evidenceHead }),
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
  assert.equal(ok.standingAuthorization, false);
  assert.equal(parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", "mfittko", "--standing-authorization"]).standingAuthorization, true);
});

test("fully-satisfied standing-authorized drain merge succeeds, stamps the approver, head-pins the merge", async () => {
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
  assert.deepEqual(calls.runChild[0].args, ["pr", "merge", "5", "--repo", "mfittko/dev-loops", "--squash", "--match-head-commit", HEAD]);
  // env is passed positionally (a real GH_TOKEN reaches the child), not as { env }.
  assert.deepEqual(calls.runChild[0].env, { GH_TOKEN: "t" });
  assert.ok(!calls.runChild.some((c) => c.args.join(" ").match(/release|publish|tag/)));
});

test("each missing precondition refuses with a machine-readable reason naming it", async () => {
  const cases = [
    ["mergeable", makeRuntime({ prView: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } }), {}],
    ["ci_green", makeRuntime({ prView: { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] } }), {}],
    ["title_markers", makeRuntime({ prView: { title: "WIP: wrapper" } }), {}],
    ["title_markers", makeRuntime({ prView: { title: null } }), {}], // missing title fails closed
    ["gate_evidence", makeRuntime({ evidence: { ok: false, sizeOutcome: null, touchesT1: false, failures: ["missing visible clean draft_gate comment"] } }), {}],
    ["gate_evidence", makeRuntime({ evidenceHead: "b".repeat(40) }), {}], // evidence head != current head (a push mid-check)
    ["size_budget_human_approval", makeRuntime({ evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] } }), {}],
    ["merge_approval", makeRuntime(), { standingAuthorization: false }], // no standing auth asserted, no fresh approval
  ];
  for (const [expected, { runtime, calls }, optsOverride] of cases) {
    let threw = null;
    try { await mergePr(baseOptions(optsOverride), runtime); } catch (e) { threw = e; }
    assert.ok(threw, `${expected} should throw`);
    assert.equal(threw.mergePrFailure.ok, false);
    assert.equal(threw.mergePrFailure.merged, false);
    assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === expected), `expected ${expected}, got ${JSON.stringify(threw.mergePrFailure.failures)}`);
    assert.equal(calls.runChild.length, 0, `${expected}: merge must not run when a precondition fails`);
  }
});

test("under autonomy.humanMergeOnly the wrapper refuses outright, even with a fresh approval", async () => {
  const { runtime, calls } = makeRuntime({
    humanMergeOnly: true,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
  });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.equal(threw.mergePrFailure.humanMergeOnly, true);
  assert.equal(threw.mergePrFailure.merged, false);
  assert.equal(calls.runChild.length, 0, "no merge under humanMergeOnly");
});

test("a drain merge without --standing-authorization requires a fresh operator approval", async () => {
  // No standing flag, no fresh approval -> refused.
  const noApproval = makeRuntime();
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), noApproval.runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "merge_approval"));
  // No standing flag but a fresh operator comment marker -> allowed.
  const withMarker = makeRuntime({ comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }] });
  const result = await mergePr(baseOptions({ standingAuthorization: false }), withMarker.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.approvalVia, "comment_marker");
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
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }],
    evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] },
  });
  const result = await mergePr(baseOptions({ stableRelease: true, standingAuthorization: false }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.approvalVia, "comment_marker");
});

test("a non-zero or signal-killed `gh pr merge` throws instead of reporting a false success", async () => {
  for (const code of [1, null]) { // non-zero exit; signal-kill (runChild resolves { code: null })
    const { runtime } = makeRuntime();
    runtime.runChild = async () => ({ stdout: "", stderr: "protected branch", code });
    let threw = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
    assert.ok(threw, `a failed merge (code ${code}) must throw`);
    assert.match(threw.message, /gh pr merge did not succeed/);
    assert.ok(!threw.mergePrFailure, "a merge-execution failure is not a precondition failure");
  }
});

test("a code-0 merge whose PR is not MERGED afterwards is a false success and throws", async () => {
  const { runtime } = makeRuntime({ postMergeState: "OPEN" });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.match(threw.message, /not MERGED/);
});

test("main honors --jq and --silent identically to the sibling wrappers", async () => {
  const stdout = captureStream();
  const { runtime } = makeRuntime();
  const code = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--human-approved-by", "mfittko", "--standing-authorization", "--jq", ".mergeCommit"], { ...runtime, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), MERGE_COMMIT);

  const silentOut = captureStream();
  const silentCode = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--human-approved-by", "mfittko", "--standing-authorization", "--silent"], { ...makeRuntime().runtime, stdout: silentOut });
  assert.equal(silentCode, 0);
  assert.equal(silentOut.get(), "");
});
