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
  // Default: Copilot gate disabled, so a head without a current-head Copilot
  // review converges via copilot_gate_disabled.
  maxCopilotRounds = 0,
  compareFiles = null,
  compare = {},
  configExtra = {},
  prFiles = [],
  prFilesCode = 0,
  // The detector's own internal-only verdict, stubbed so it never reads the
  // host checkout's .devloops.
  detectorInternalOnly = true,
  requestedReviewers = { users: [], teams: [] },
  // The GraphQL reviewRequests/review-node read: a pull-request object, an
  // Error (runChild throws), or { code, stdout } for a raw result.
  graphql = { reviewRequests: { nodes: [] }, reviews: { nodes: [] } },
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
        if (args.join(" ").includes("/requested_reviewers")) {
          if (requestedReviewers instanceof Error) throw requestedReviewers;
          return requestedReviewers;
        }
        if (args.includes("pull") || (args.join(" ").includes("/pulls/"))) return reviews;
        if (args.join(" ").includes("/issues/")) return comments;
        if (args.includes("mergeCommit,state")) return { mergeCommit: { oid: MERGE_COMMIT }, state: postMergeState };
        return view; // the primary pr view
      },
      // runChild's real signature is (cmd, args, env) — record env to prove it is
      // passed positionally, not wrapped in an options object.
      runChild: async (cmd, args, env) => {
        calls.runChild.push({ cmd, args, env });
        if (args[0] === "api" && args[1] === "graphql") {
          if (graphql instanceof Error) throw graphql;
          if ("code" in graphql) return { stderr: "", ...graphql };
          return { stdout: JSON.stringify({ data: { repository: { pullRequest: graphql } } }), stderr: "", code: 0 };
        }
        if (String(args[1]).includes("/compare/")) {
          if (compare.code) return { stdout: "", stderr: "compare failed", code: compare.code };
          if (compare.stdout !== undefined) return { stdout: compare.stdout, stderr: "", code: 0 };
          return { stdout: JSON.stringify({ status: compare.status ?? "ahead", files: (compareFiles ?? []).map((filename) => ({ filename, status: "modified" })) }), stderr: "", code: 0 };
        }
        if (args[0] === "pr" && args[1] === "view" && args.includes("files")) {
          return prFilesCode ? { stdout: "", stderr: "files read failed", code: prFilesCode } : { stdout: prFiles.join("\n"), stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      detectEvidence: async () => ({ ...evidence, currentHeadSha: evidenceHead }),
      detectInternalOnlyPr: async () => (prFilesCode ? { ok: false, error: "files read failed" } : { ok: true, internalOnly: detectorInternalOnly, files: prFiles }),
      loadConfig: async () => ({ config: { autonomy: { humanMergeOnly }, refinement: { maxCopilotRounds }, ...configExtra }, errors: [] }),
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
  // An explicit disable is honored, not read as enabled (no presence-means-true fail-open).
  assert.equal(parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", "mfittko", "--standing-authorization=false"]).standingAuthorization, false);
  assert.equal(parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--human-approved-by", "mfittko", "--stable-release=0"]).stableRelease, false);
});

test("a config load/validation error fails closed (cannot verify humanMergeOnly or standing auth)", async () => {
  const { runtime, calls } = makeRuntime();
  runtime.loadConfig = async () => ({ config: null, errors: [{ message: "malformed .devloops" }] });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.equal(threw.mergePrFailure.configError, true);
  assert.equal(calls.runChild.length, 0, "no merge when config is unverifiable");
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

test("a current-head Copilot 🟡 non-approval refuses via copilot_convergence (proves the review body reaches the gate)", async () => {
  const { runtime, calls } = makeRuntime({
    reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit_id: HEAD, body: "### 🟡 Changes recommended\n\nfix the off-by-one." }],
  });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a current-head 🟡 must refuse");
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "copilot_convergence"), JSON.stringify(threw.mergePrFailure.failures));
  assert.equal(threw.mergePrFailure.copilotConvergenceState, "current_head_findings");
  assert.equal(threw.mergePrFailure.copilotDisposition, "changes_recommended");
  assert.equal(calls.runChild.length, 0, "no merge on a current-head 🟡");
});

test("a current-head Copilot 🟢 merges and records the disposition for audit", async () => {
  const { runtime } = makeRuntime({
    reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit_id: HEAD, body: "### 🟢 Approval recommended\n\nlooks good." }],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.copilotConvergenceState, "current_head_clean");
  assert.equal(result.copilotDisposition, "clean");
});

const OLD_HEAD = "0".repeat(40);
const copilotAt = (commit, body, submittedAt) => ({ user: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit_id: commit, body, submitted_at: submittedAt });

test("no current-head Copilot review with the Copilot gate disabled merges via copilot_gate_disabled", async () => {
  const { runtime } = makeRuntime({ maxCopilotRounds: 0 });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "copilot_gate_disabled");
});

test("no current-head Copilot review at the round cap merges via round_cap_clean_fallback", async () => {
  const { runtime, calls } = makeRuntime({
    maxCopilotRounds: 2,
    reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z"), copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-02T00:00:00Z")],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "round_cap_clean_fallback");
  assert.equal(calls.runChild.length, 1, "no compare call; only the merge");
});

test("no current-head Copilot review after a clean review and a docs-only delta merges via docs_only_suppression", async () => {
  const { runtime, calls } = makeRuntime({
    maxCopilotRounds: 3,
    compareFiles: ["docs/guide.md"],
    reviews: [copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z")],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "docs_only_suppression");
  assert.ok(calls.runChild[0].args[1].includes(`/compare/${OLD_HEAD}...${HEAD}`));
  assert.ok(calls.runChild.some((c) => c.args[0] === "api" && c.args[1] === "graphql"), "the GraphQL outstanding-review probe ran");
});

test("no current-head Copilot review and no sanctioned disposition refuses via copilot_convergence", async () => {
  for (const [label, overrides] of [
    ["stale findings below the cap", { maxCopilotRounds: 3, reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z")] }],
    ["clean review then a code delta", { maxCopilotRounds: 3, compareFiles: ["scripts/x.mjs"], reviews: [copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z")] }],
    ["never reviewed with the gate enabled", { maxCopilotRounds: 3 }],
  ]) {
    const { runtime, calls } = makeRuntime(overrides);
    let threw = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
    assert.ok(threw, `${label}: must refuse`);
    assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"], label);
    assert.equal(threw.mergePrFailure.copilotConvergenceState, "no_current_head_review", label);
    assert.equal(threw.mergePrFailure.copilotDisposition, null, label);
    assert.ok(!calls.runChild.some((c) => c.args[0] === "pr" && c.args[1] === "merge"), `${label}: no merge`);
  }
});

async function expectCopilotRefusal(label, overrides, options = {}) {
  const { runtime, calls } = makeRuntime(overrides);
  let threw = null;
  try { await mergePr(baseOptions(options), runtime); } catch (e) { threw = e; }
  assert.ok(threw, `${label}: must refuse`);
  assert.deepEqual(threw.mergePrFailure.failures?.map((f) => f.precondition), ["copilot_convergence"], label);
  assert.equal(threw.mergePrFailure.copilotDisposition, null, label);
  assert.ok(!calls.runChild.some((c) => c.args[0] === "pr" && c.args[1] === "merge"), `${label}: no merge`);
  return threw;
}

// Internal-only patterns pinned through the runtime config, so the verdict does
// not depend on the host checkout's .devloops.
const INTERNAL_ONLY = { maxCopilotRounds: 3, configExtra: { internalPathPatterns: ["^tools/", "^notes/"] } };

test("an internal-only PR with the Copilot gate enabled merges via copilot_gate_disabled", async () => {
  const { runtime } = makeRuntime({ ...INTERNAL_ONLY, prFiles: ["tools/x.mjs", "notes/guide.md"] });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "copilot_gate_disabled");
});

test("an internal-only detection failure, a non-matching file, or no configured patterns fails closed", async () => {
  await expectCopilotRefusal("detection failure", { ...INTERNAL_ONLY, prFiles: ["tools/x.mjs"], prFilesCode: 1 });
  await expectCopilotRefusal("file outside the configured patterns", { ...INTERNAL_ONLY, prFiles: ["tools/x.mjs", "scripts/x.mjs"] });
  await expectCopilotRefusal("no configured patterns", { maxCopilotRounds: 3, prFiles: ["tools/x.mjs"] });
});

test("merge-pr refuses copilot_gate_disabled when its patterns match but the detector says not internal-only", async () => {
  await expectCopilotRefusal("detector and merged patterns disagree", { ...INTERNAL_ONLY, prFiles: ["tools/x.mjs"], detectorInternalOnly: false });
});

test("a no-current-head-review refusal names --lightweight only when the composed cap is lower and the flag is absent", async () => {
  const LIGHTWEIGHT_REMEDY = "--lightweight";
  const reasonOf = (threw) => threw.mergePrFailure.failures.find((f) => f.precondition === "copilot_convergence").reason;
  const stale = { reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z")] };
  const named = await expectCopilotRefusal("composed cap lower, flag absent", { maxCopilotRounds: 3, ...stale });
  assert.ok(reasonOf(named).includes(LIGHTWEIGHT_REMEDY));
  assert.ok(named.message.includes(LIGHTWEIGHT_REMEDY));
  const flagPassed = await expectCopilotRefusal("flag passed", { maxCopilotRounds: 3 }, { lightweight: true });
  assert.ok(!reasonOf(flagPassed).includes(LIGHTWEIGHT_REMEDY));
  const equalCap = await expectCopilotRefusal("composed cap equals full cap", { maxCopilotRounds: 1 });
  assert.ok(!reasonOf(equalCap).includes(LIGHTWEIGHT_REMEDY));
});

test("parse: --lightweight is a boolean flag that honors =false", () => {
  const argv = ["--repo", "o/r", "--pr", "5", "--human-approved-by", "mfittko"];
  assert.equal(parseMergePrCliArgs(argv).lightweight, false);
  assert.equal(parseMergePrCliArgs([...argv, "--lightweight"]).lightweight, true);
  assert.equal(parseMergePrCliArgs([...argv, "--lightweight=false"]).lightweight, false);
});

test("--lightweight composes the round cap: a composed cap of 0 disables the Copilot gate", async () => {
  const overrides = { maxCopilotRounds: 3, configExtra: { localImplementation: { lightMode: { maxCopilotRounds: 0 } } } };
  const { runtime } = makeRuntime(overrides);
  const result = await mergePr(baseOptions({ lightweight: true }), runtime);
  assert.equal(result.copilotDisposition, "copilot_gate_disabled");
  await expectCopilotRefusal("full-PR cap is not composed", overrides);
});

test("--lightweight composes the round cap: the composed cap drives the round-cap fallback", async () => {
  const overrides = { maxCopilotRounds: 3, reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z")] };
  const { runtime } = makeRuntime(overrides);
  const result = await mergePr(baseOptions({ lightweight: true }), runtime);
  assert.equal(result.copilotDisposition, "round_cap_clean_fallback");
  await expectCopilotRefusal("full-PR cap not reached", overrides);
});

const MID_HEAD = "1".repeat(40);
const CONVERGED_AT_CAP = [copilotAt(MID_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z"), copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-02T00:00:00Z")];

test("at the round cap a significant change after a converged review opens a new cycle and refuses", async () => {
  await expectCopilotRefusal("converged then code push", { maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compareFiles: ["src/a.mjs", "src/b.mjs"] });
});

test("at the round cap a compare failure after a converged review fails closed", async () => {
  await expectCopilotRefusal("compare failure", { maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { code: 1 } });
});

test("at the round cap a readable compare payload without a files array fails closed", async () => {
  for (const stdout of [JSON.stringify({ status: "ahead" }), JSON.stringify("ahead"), "42"]) {
    await expectCopilotRefusal(`compare payload ${stdout}`, { maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout } });
  }
});

test("at the round cap a compare file entry without a filename fails closed", async () => {
  for (const files of [[{ status: "modified" }], [{ filename: "", status: "modified" }], [{ filename: "docs/guide.md", status: "modified" }, { status: "modified" }]]) {
    const stdout = JSON.stringify({ status: "ahead", files });
    await expectCopilotRefusal(`compare payload ${stdout}`, { maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout } });
  }
});

test("at the round cap an empty compare delta after a converged review keeps round_cap_clean_fallback", async () => {
  const { runtime } = makeRuntime({ maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout: JSON.stringify({ status: "ahead", files: [] }) } });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotDisposition, "round_cap_clean_fallback");
});

test("at the round cap an untrusted compare (not ahead, rename/copy, page cap) fails closed", async () => {
  const docs = (n) => Array.from({ length: n }, (_, i) => ({ filename: `docs/g${i}.md`, status: "modified" }));
  for (const [label, payload] of [
    ["diverged, no files", { status: "diverged", files: [] }],
    ["renamed entry", { status: "ahead", files: [{ filename: "docs/moved.md", status: "renamed", previous_filename: "src/a.mjs" }] }],
    ["copied entry", { status: "ahead", files: [{ filename: "docs/copy.md", status: "copied" }] }],
    ["300-file page cap", { status: "ahead", files: docs(300) }],
  ]) {
    await expectCopilotRefusal(label, { maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout: JSON.stringify(payload) } });
  }
});

test("at the round cap a trivial change after a converged review keeps round_cap_clean_fallback", async () => {
  const { runtime } = makeRuntime({ maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compareFiles: ["docs/guide.md"] });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotDisposition, "round_cap_clean_fallback");
});

test("at the round cap a fix pushed after a 🟡 review keeps round_cap_clean_fallback without a compare", async () => {
  const { runtime, calls } = makeRuntime({
    maxCopilotRounds: 2,
    compareFiles: ["src/a.mjs", "src/b.mjs"],
    reviews: [copilotAt(MID_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z"), copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-02T00:00:00Z")],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotDisposition, "round_cap_clean_fallback");
  assert.ok(!calls.runChild.some((c) => String(c.args[1]).includes("/compare/")));
});

test("docs_only_suppression refuses while a Copilot review is outstanding on the current head", async () => {
  const docsOnly = { maxCopilotRounds: 3, compareFiles: ["docs/guide.md"] };
  const clean = copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z");
  const pending = { user: { login: "copilot-pull-request-reviewer[bot]" }, state: "PENDING", commit_id: HEAD, body: "", submitted_at: null };
  await expectCopilotRefusal("pending current-head review", { ...docsOnly, reviews: [clean, pending] });
  await expectCopilotRefusal("Copilot requested", { ...docsOnly, reviews: [clean], requestedReviewers: { users: [{ login: "Copilot" }], teams: [] } });
  await expectCopilotRefusal("requested-reviewers read failure", { ...docsOnly, reviews: [clean], requestedReviewers: new Error("gh failed") });
  await expectCopilotRefusal("requested-reviewers users not an array", { ...docsOnly, reviews: [clean], requestedReviewers: {} });
  const copilotBot = { __typename: "Bot", login: "copilot-pull-request-reviewer" };
  await expectCopilotRefusal("GraphQL review request", { ...docsOnly, reviews: [clean], graphql: { reviewRequests: { nodes: [{ requestedReviewer: copilotBot }] }, reviews: { nodes: [] } } });
  await expectCopilotRefusal("GraphQL PENDING current-head review", { ...docsOnly, reviews: [clean], graphql: { reviewRequests: { nodes: [] }, reviews: { nodes: [{ state: "PENDING", author: { login: "copilot-pull-request-reviewer" }, commit: { oid: HEAD } }] } } });
  await expectCopilotRefusal("GraphQL read throws", { ...docsOnly, reviews: [clean], graphql: new Error("gh graphql failed") });
  await expectCopilotRefusal("GraphQL non-zero exit", { ...docsOnly, reviews: [clean], graphql: { code: 1, stdout: "" } });
  await expectCopilotRefusal("GraphQL state unobservable", { ...docsOnly, reviews: [clean], graphql: { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) } });
});

test("docs_only_suppression refuses on an unproven or findings-bearing baseline", async () => {
  const clean = [copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z")];
  await expectCopilotRefusal("compare non-zero exit", { maxCopilotRounds: 3, reviews: clean, compareFiles: ["docs/guide.md"], compare: { code: 1 } });
  await expectCopilotRefusal("compare not ahead", { maxCopilotRounds: 3, reviews: clean, compareFiles: ["docs/guide.md"], compare: { status: "diverged" } });
  await expectCopilotRefusal("last reviewed head had findings", {
    maxCopilotRounds: 3,
    compareFiles: ["docs/guide.md"],
    reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z")],
  });
});

test("a clean draft_gate on an older head resets the round count below the cap and refuses", async () => {
  await expectCopilotRefusal("draft-gate reset", {
    maxCopilotRounds: 2,
    reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z"), copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-02T00:00:00Z")],
    evidence: { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], draftGate: { verdict: "clean", headSha: MID_HEAD, updatedAt: "2026-01-03T00:00:00Z" } },
  });
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

test("solo-owner escalated PR: zero review objects + a head-pinned approve-merge comment satisfies both size_budget_human_approval and merge_approval (AC1, AC4)", async () => {
  const { runtime } = makeRuntime({
    evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] },
    reviews: [],
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
  });
  const result = await mergePr(baseOptions({ standingAuthorization: false }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.approvalVia, "comment_marker");
});

test("solo-owner escalated PR: a comment pinned to a superseded head refuses both size_budget_human_approval and merge_approval (AC2, AC4)", async () => {
  const staleHead = "b".repeat(40);
  const { runtime, calls } = makeRuntime({
    evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] },
    reviews: [],
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${staleHead}` }],
  });
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "size_budget_human_approval"));
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "merge_approval"));
  assert.equal(calls.runChild.length, 0);
});

test("an unresolved human CHANGES_REQUESTED still blocks size_budget_human_approval despite a valid head-pinned approve-merge comment (AC2)", async () => {
  const { runtime } = makeRuntime({
    evidence: { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] },
    reviews: [{ user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: HEAD }],
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
  });
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), runtime); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "size_budget_human_approval"));
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

test("a merge blocked by branch protection with a stale gate-evidence context names the real cause and recovery (#2262)", async () => {
  const { runtime } = makeRuntime({
    prView: {
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS", name: "verify" },
        { status: "COMPLETED", conclusion: "CANCELLED", name: "gate-evidence-runner" },
        { state: "FAILURE", context: "gate-evidence" },
      ],
    },
  });
  runtime.runChild = async () => ({ stdout: "", stderr: "GraphQL: Base branch policy prohibits the merge (mergePullRequest)", code: 1 });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a branch-protection-blocked merge must throw");
  assert.match(threw.message, /Base branch policy prohibits the merge/, "the original gh stderr must still be present");
  assert.match(threw.message, /gate-evidence/);
  assert.match(threw.message, /failure/i);
  assert.match(threw.message, /COMPLETED Gate-evidence run/);
  assert.match(threw.message, /re-run|verdict comment/i);
});

test("a base-branch-policy block with a SUCCESS gate-evidence context gets no gate-evidence note (#2262)", async () => {
  const { runtime } = makeRuntime({
    prView: {
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS", name: "verify" },
        { state: "SUCCESS", context: "gate-evidence" },
      ],
    },
  });
  runtime.runChild = async () => ({ stdout: "", stderr: "GraphQL: Base branch policy prohibits the merge (mergePullRequest)", code: 1 });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a branch-protection-blocked merge must throw");
  assert.match(threw.message, /Base branch policy prohibits the merge/, "the original gh stderr must still be present");
  assert.ok(
    !/COMPLETED Gate-evidence run/.test(threw.message),
    "a real branch-policy block must not get the gate-evidence recovery note when gate-evidence is already SUCCESS — the real cause is a different required check",
  );
});

test("a transient gh/API error is NOT misattributed to a stale gate-evidence context even when gate-evidence is non-success (#2262)", async () => {
  const { runtime } = makeRuntime({
    prView: {
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS", name: "verify" },
        { state: "FAILURE", context: "gate-evidence" },
      ],
    },
  });
  runtime.runChild = async () => ({ stdout: "", stderr: "gh: connection reset by peer", code: 1 });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a transient gh failure must still throw");
  assert.match(threw.message, /connection reset by peer/, "the original gh stderr must still be present");
  assert.ok(
    !/COMPLETED Gate-evidence run/.test(threw.message),
    "a non-branch-policy stderr must not get the gate-evidence recovery note, even when gate-evidence is non-success",
  );
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
