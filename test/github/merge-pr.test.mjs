import { test, mock } from "bun:test";
import assert from "node:assert/strict";
import { recordTimedOutProbe, recordUnobservableRequest } from "../../scripts/loop/_unobservable-review-request-record.mjs";
import { mergePr, parseMergePrCliArgs, main, defaultReadMergeDiff, defaultIsAncestor, defaultComputePatchId, defaultFetchPrHead, buildDetectEvidenceArgv, defaultPostMergeComment } from "../../scripts/github/merge-pr.mjs";
import { extractYesApproval, buildApprovalQuestion, writeApprovalRecord, buildApprovalComment } from "@dev-loops/core/github/ask-merge-approval";
import { runChild } from "../../scripts/_cli-primitives.mjs";
import { captureStream } from "../_helpers.mjs";
import { ghJson as defaultGhJson } from "@dev-loops/core/github/gh";
import { scanDiffText } from "@dev-loops/core/security/secret-scan";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";

// The ask-approval directory is isolated and absent, so no host hook key makes every plain approve-merge comment need a record (MERGE-ASK-APPROVAL).
const TEST_ENV = { GH_TOKEN: "t", DEVLOOPS_APPROVAL_TEST_MODE: "1", DEVLOOPS_APPROVAL_DIR: path.join(os.tmpdir(), `pr-no-approval-key-${process.pid}`) };
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
  // refinement.requireCopilotConvergenceAtLatestHead: false (default) selects
  // the converged-once rule; true restores the strict docs-only carry.
  strict = false,
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
  // The review-thread list the carried-convergence predicate reads.
  reviewThreads = [],
  // Issue comments on the `--jq .[]` stream the copilot-body-disposition
  // resolver reads.
  dispositionComments = [],
  // The PR base branch and its base...head delta, for the base-relative
  // reduction the carried-convergence predicate applies. Unset skips it.
  baseRefName = "",
  prOwnFiles = [],
  // PR files API entries and the base tip docs/decisions listing (names, or an Error).
  adrPrFiles = [],
  adrTip = [],
  // The Gate evidence runs `gh run list` returns for the head.
  gateRuns = [],
} = {}) {
  const calls = { ghJson: [], runChild: [], postMerge: [], comments: [] };
  const view = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    title: "feat: sanctioned merge wrapper",
    headRefOid: HEAD,
    baseRefName: "main",
    url: "https://github.com/mfittko/dev-loops/pull/5",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...prView,
  };
  return {
    calls,
    runtime: {
      env: { ...TEST_ENV },
      ghJson: async (args) => {
        calls.ghJson.push(args);
        if (args[0] === "run" && args[1] === "list") return gateRuns;
        if (args.join(" ").includes("/files?")) {
          if (adrPrFiles instanceof Error) throw adrPrFiles;
          return adrPrFiles;
        }
        if (args.join(" ").includes("/contents/docs/decisions")) {
          if (adrTip instanceof Error) throw adrTip;
          return adrTip.map((name) => ({ name }));
        }
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
        if (args[0] === "api" && args[1] === "graphql" && args.some((a) => String(a).includes("reviewThreads"))) {
          return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: reviewThreads, pageInfo: { hasNextPage: false, endCursor: null } } } } } }), stderr: "", code: 0 };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          if (graphql instanceof Error) throw graphql;
          if ("code" in graphql) return { stderr: "", ...graphql };
          return { stdout: JSON.stringify({ data: { repository: { pullRequest: graphql } } }), stderr: "", code: 0 };
        }
        if (args[0] === "api" && String(args[1]).endsWith("/comments") && args.includes("--jq")) {
          return { stdout: dispositionComments.map((c) => JSON.stringify(c)).join("\n"), stderr: "", code: 0 };
        }
        if (baseRefName && String(args[1]).includes(`/compare/${baseRefName}...`)) {
          return { stdout: JSON.stringify({ status: "ahead", files: prOwnFiles.map((filename) => ({ filename, status: "modified" })) }), stderr: "", code: 0 };
        }
        if (args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")) return { stdout: baseRefName, stderr: "", code: 0 };
        if (String(args[1]).includes("/compare/")) {
          if (compare.code) return { stdout: "", stderr: "compare failed", code: compare.code };
          if (compare.stdout !== undefined) return { stdout: compare.stdout, stderr: "", code: 0 };
          return { stdout: JSON.stringify({ status: compare.status ?? "ahead", files: (compareFiles ?? []).map((filename) => ({ filename, status: "modified" })) }), stderr: "", code: 0 };
        }
        // The gate-evidence read (a readable, empty stream); an unreadable one refuses (copilot_reviews_unreadable).
        if (args.includes("--slurp") && /\/(comments|reviews)\?per_page=100$/.test(String(args[args.length - 1]))) {
          return { stdout: "[[]]\n", stderr: "", code: 0 };
        }
        if (args[0] === "pr" && args[1] === "view" && args.includes("files")) {
          return prFilesCode ? { stdout: "", stderr: "files read failed", code: prFilesCode } : { stdout: prFiles.join("\n"), stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      detectEvidence: async () => ({ ...evidence, currentHeadSha: evidenceHead }),
      fetchPrHead: () => {},
      postMergeComment: async (c) => { calls.comments.push(c); },
      isAncestor: () => true,
      computePatchId: () => null,
      detectOriginSlug: () => "mfittko/dev-loops",
      evaluateAdrTripwire: async () => ({ outcome: "pass" }),
      readMergeDiff: () => "",
      detectInternalOnlyPr: async () => (prFilesCode ? { ok: false, error: "files read failed" } : { ok: true, internalOnly: detectorInternalOnly, files: prFiles }),
      loadConfig: async () => ({ config: { autonomy: { humanMergeOnly }, refinement: { maxCopilotRounds, requireCopilotConvergenceAtLatestHead: strict }, ...configExtra }, errors: [] }),
      cwd: process.cwd(),
      // Recording no-op post-merge steps: the real ones would fast-forward and
      // prune the checkout running the tests.
      postMergeSteps: {
        fastForward: async () => { calls.postMerge.push("fastForward"); return { status: "fast_forwarded" }; },
        worktreeCleanup: async () => { calls.postMerge.push("worktreeCleanup"); return { ok: true, removed: null, reason: "stub" }; },
        actions: async () => { calls.postMerge.push("actions"); return { ok: true, results: [] }; },
      },
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

const STALE_BLOCK = { outcome: "block", waiver: { standing: true, stale: true }, reasons: ["stale"] };
const mergeCalls = (calls) => calls.runChild.filter((c) => c.args[0] === "pr" && c.args[1] === "merge");

test("adr_tripwire refuses a block that is not a stale waiver, never merging", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  runtime.evaluateAdrTripwire = async () => ({ outcome: "block", waiver: { requested: false }, reasons: ["no record"] });
  await assert.rejects(() => mergePr(baseOptions(), runtime), /adr_tripwire \(the ADR tripwire blocks.*no record/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_tripwire fails closed when the evaluator throws", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
  runtime.evaluateAdrTripwire = () => { throw new Error("git exploded"); };
  await assert.rejects(() => mergePr(baseOptions(), runtime), /adr_tripwire \(.*unevaluable.*git exploded/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_tripwire re-issues a stale covered waiver through the writer, re-reads the body, and merges", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "old" } });
  const bodies = [];
  runtime.evaluateAdrTripwire = async ({ prBody }) => { bodies.push(prBody); return prBody === "old" ? STALE_BLOCK : { outcome: "pass" }; };
  const written = [];
  runtime.waiveAdrTripwire = async (opts) => { written.push(opts); return { ok: true, action: "waiver_written" }; };
  const base = runtime.ghJson;
  runtime.ghJson = async (args) => (args.join(" ").endsWith("--json body") ? { body: "new" } : base(args));
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.deepEqual(written, [{ repo: "mfittko/dev-loops", pr: 5 }]);
  assert.deepEqual(bodies, ["old", "new"]);
  assert.equal(mergeCalls(calls).length, 1);
});

// Assembled at runtime so this file's own diff carries no whole credential.
const SCAN_TOKEN = ["ghp_", "E".repeat(34), "f5"].join("");
const secretDiff = (line) => ["diff --git a/cfg.sh b/cfg.sh", "--- /dev/null", "+++ b/cfg.sh", "@@ -0,0 +1,2 @@", "+clean", `+${line}`].join("\n");

test("secret_scan refuses a credential that origin/<base>...<head> adds, naming file, line, rule and both exits", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  const read = [];
  runtime.readMergeDiff = (opts) => { read.push({ base: opts.base, head: opts.head }); return secretDiff(`T="${SCAN_TOKEN}"`); };
  const error = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.match(error.message, /secret_scan \(secret scan hit in origin\/main\.\.\..*cfg\.sh:2 @secretlint\/secretlint-rule-github/);
  assert.match(error.message, /remove the credential and rotate it, or add a same-line "secret-scan:allow <reason>" marker/);
  assert.equal(error.mergePrFailure.failures[0].precondition, "secret_scan");
  assert.ok(!JSON.stringify(error.mergePrFailure).includes(SCAN_TOKEN) && !error.message.includes(SCAN_TOKEN));
  assert.deepEqual(read, [{ base: "origin/main", head: HEAD }]);
  assert.equal(mergeCalls(calls).length, 0);
});

test("secret_scan refuses a library hit with no mappable line, even beside an allow marker, and renders it as line unknown", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  // The only added line carries a valid allow marker; the library hit has no loc, so no marker can apply.
  runtime.readMergeDiff = () => secretDiff("T=1 # secret-scan:allow public fixture");
  const specifier = "../../packages/core/node_modules/@secretlint/core/module/index.js";
  const secretlint = await import(specifier);
  const real = secretlint.lintSource;
  mock.module(specifier, () => ({ ...secretlint, lintSource: async () => ({ messages: [{ ruleId: "@secretlint/secretlint-rule-github", messageId: "GITHUB_TOKEN" }] }) }));
  try {
    const error = await mergePr(baseOptions(), runtime).catch((e) => e);
    assert.match(error.message, /secret_scan \(secret scan hit in origin\/main\.\.\..*cfg\.sh:line unknown @secretlint\/secretlint-rule-github/);
    assert.ok(!error.message.includes("null"));
    assert.equal(mergeCalls(calls).length, 0);
  } finally {
    mock.module(specifier, () => ({ ...secretlint, lintSource: real }));
  }
});

test("secret_scan fails closed when the diff read throws", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  runtime.readMergeDiff = () => { throw new Error("git diff exploded"); };
  await assert.rejects(() => mergePr(baseOptions(), runtime), /secret_scan \(the secret scan could not run: git diff exploded; remove the credential/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("secret_scan fails closed when the scan itself throws", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  runtime.readMergeDiff = () => 42; // a non-string makes scanDiffText throw
  await assert.rejects(() => mergePr(baseOptions(), runtime), /secret_scan \(the secret scan could not run: [\s\S]*remove the credential and rotate it, or add a same-line "secret-scan:allow <reason>" marker/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("defaultReadMergeDiff reads base...head from real git, including a NUL-bearing file, and the scan reports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-diff-"));
  try {
    runGitFixture(dir, ["init", "-q", "-b", "main"]);
    runGitFixture(dir, ["config", "user.email", "test@example.com"]);
    runGitFixture(dir, ["config", "user.name", "Test"]);
    runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
    runGitFixture(dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "s.txt"), `x\0y\nT="${SCAN_TOKEN}"\n`);
    runGitFixture(dir, ["add", "s.txt"]);
    runGitFixture(dir, ["commit", "-q", "-m", "head"]);
    const head = runGitFixture(dir, ["rev-parse", "HEAD"]);
    const result = await scanDiffText(defaultReadMergeDiff({ base: "main", head, repoRoot: dir }));
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.file === "s.txt"), JSON.stringify(result.findings));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secret_scan passes a clean diff and an allow-marked public value, and the merge proceeds", async () => {
  for (const diff of ["", secretDiff(`T="${SCAN_TOKEN}" # secret-scan:allow public fixture`)]) {
    const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
    runtime.readMergeDiff = () => diff;
    assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
    assert.equal(mergeCalls(calls).length, 1);
  }
});

test("--check reports a secret_scan hit with the other failures", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  runtime.readMergeDiff = () => secretDiff(`T="${SCAN_TOKEN}"`);
  const result = await mergePr({ ...baseOptions(), check: true }, runtime);
  assert.equal(result.ok, false);
  assert.match(result.failures.find((f) => f.precondition === "secret_scan").reason, /cfg\.sh:2/);
});

test("usage text lists secret_scan among the preconditions", async () => {
  const out = [];
  assert.equal(await main(["--help"], { stdout: { write: (s) => out.push(s) } }), 0);
  assert.match(out.join(""), /adr_tripwire,\s+secret_scan,/);
});

test("the merge fetches the base and PR head once and the tripwire evaluates origin/<base> at the PR head", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  const fetched = [];
  const evaluated = [];
  runtime.fetchPrHead = (opts) => { fetched.push({ pr: opts.pr, baseRefName: opts.baseRefName }); };
  runtime.evaluateAdrTripwire = async (opts) => { evaluated.push({ base: opts.base, head: opts.head }); return { outcome: "pass" }; };
  await mergePr(baseOptions(), runtime);
  assert.deepEqual(fetched, [{ pr: 5, baseRefName: "main" }]);
  assert.deepEqual(evaluated, [{ base: "origin/main", head: HEAD }]);
});

test("base_not_integrated refuses as unevaluable when the PR base branch is unreadable", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "" } });
  await assert.rejects(() => mergePr(baseOptions(), runtime), /base_not_integrated \(.*base branch is unreadable/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("base_not_integrated refuses when the checkout origin is not --repo or unreadable", async () => {
  for (const slug of ["someone/fork", null]) {
    const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
    runtime.detectOriginSlug = () => slug;
    let fetched = false;
    runtime.fetchPrHead = () => { fetched = true; };
    await assert.rejects(() => mergePr(baseOptions(), runtime), /base_not_integrated \(.*checkout origin/);
    assert.equal(fetched, false);
    assert.equal(mergeCalls(calls).length, 0);
  }
});

test("adr_tripwire still refuses when the writer succeeds but the re-read body still blocks", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "old" } });
  runtime.evaluateAdrTripwire = async () => STALE_BLOCK;
  runtime.waiveAdrTripwire = async () => ({ ok: true, action: "waiver_written" });
  const base = runtime.ghJson;
  runtime.ghJson = async (args) => (args.join(" ").endsWith("--json body") ? { body: "new" } : base(args));
  await assert.rejects(() => mergePr(baseOptions(), runtime), /adr_tripwire \(the ADR tripwire blocks/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_tripwire quotes the writer's typed reason when the re-issue is refused", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
  runtime.evaluateAdrTripwire = async () => STALE_BLOCK;
  runtime.waiveAdrTripwire = async () => ({ ok: false, refused: true, reason: "contract_doc_not_in_matrix", detail: "skills/docs/x.md" });
  await assert.rejects(() => mergePr(baseOptions(), runtime), /adr_tripwire \(.*re-issue was refused \(contract_doc_not_in_matrix: skills\/docs\/x\.md\)/);
  assert.equal(mergeCalls(calls).length, 0);
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
  assert.deepEqual(calls.runChild[0].env, TEST_ENV);
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

// Latest review wins: a clean current-head review does not hold against a
// LATER Copilot review on an older commit that is not converged.
for (const strict of [false, true]) {
  const mode = strict ? "strict" : "converged-once";
  const laterOnOlder = (body) => [
    { ...copilotAt(HEAD, "### 🟢 Approval recommended", "2026-01-02T00:00:00Z"), node_id: "PRR_head" },
    { ...copilotAt(OLD_HEAD, body, "2026-01-03T00:00:00Z"), node_id: "PRR_later" },
  ];

  test(`${mode}: a later body-only 🟡 review on an older commit refuses despite a clean current-head review`, async () => {
    const { runtime, calls } = makeRuntime({ maxCopilotRounds: 5, strict, reviews: laterOnOlder("### 🟡 Changes recommended\n\nfix it.") });
    let threw = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
    assert.ok(threw, "a later non-converged review must refuse");
    const failure = threw.mergePrFailure.failures.find((f) => f.precondition === "copilot_convergence");
    assert.ok(failure, JSON.stringify(threw.mergePrFailure.failures));
    assert.match(failure.reason, /later Copilot review PRR_later on an earlier commit \(0{40}\) is not converged and supersedes the current-head review: the prior Copilot review is body-only/);
    assert.equal(calls.runChild.filter((c) => c.args[0] === "pr" && c.args[1] === "merge").length, 0);
  });

  test(`${mode}: a later clean review on an older commit keeps the clean current-head merge`, async () => {
    const { runtime } = makeRuntime({ maxCopilotRounds: 5, strict, reviews: laterOnOlder("### 🟢 Approval recommended") });
    const result = await mergePr(baseOptions(), runtime);
    assert.equal(result.merged, true);
    assert.equal(result.copilotConvergenceState, "current_head_clean");
  });

  test(`${mode}: a later clean review on an older commit refuses while a Copilot review is outstanding on the current head`, async () => {
    const pending = { user: { login: "copilot-pull-request-reviewer[bot]" }, state: "PENDING", commit_id: HEAD, body: "", submitted_at: null };
    for (const [label, extra] of [
      ["Copilot requested", { requestedReviewers: { users: [{ login: "Copilot" }], teams: [] } }],
      ["pending current-head review", { reviews: [...laterOnOlder("### 🟢 Approval recommended"), pending] }],
      ["requested-reviewers read failure", { requestedReviewers: new Error("gh failed") }],
    ]) {
      const { runtime, calls } = makeRuntime({ maxCopilotRounds: 5, strict, reviews: laterOnOlder("### 🟢 Approval recommended"), ...extra });
      let threw = null;
      try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
      assert.ok(threw, `${label}: an outstanding current-head request must refuse`);
      const failure = threw.mergePrFailure.failures.find((f) => f.precondition === "copilot_convergence");
      assert.ok(failure, `${label}: ${JSON.stringify(threw.mergePrFailure.failures)}`);
      assert.match(failure.reason, /Copilot review is outstanding on the current head/);
      assert.equal(calls.runChild.filter((c) => c.args[0] === "pr" && c.args[1] === "merge").length, 0);
    }
  });
}

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
  assert.ok(!calls.runChild.some((c) => String(c.args[1]).includes("/compare/")), "no compare call");
  assert.equal(calls.runChild.filter((c) => c.args[0] === "pr" && c.args[1] === "merge").length, 1);
});

test("no current-head Copilot review with an unobservable-request record merges via copilot_unavailable", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "merge-unobservable-"));
  const pr = { repo: "mfittko/dev-loops", pr: 5 };
  for (let i = 0; i < 2; i += 1) {
    await recordUnobservableRequest({ ...pr, headSha: HEAD }, { checkpointDir });
    await recordTimedOutProbe({ ...pr, headSha: HEAD }, { checkpointDir });
  }
  const { runtime } = makeRuntime({ maxCopilotRounds: 3 });
  const result = await mergePr(baseOptions(), { ...runtime, checkpointDir });
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "copilot_unavailable");
});

test("an unobservable-request record refuses via copilot_convergence below the threshold, on another head, or while a Copilot review is outstanding", async () => {
  const pr = { repo: "mfittko/dev-loops", pr: 5 };
  const record = async (headSha, rounds) => {
    const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "merge-unobservable-refuse-"));
    for (let i = 0; i < rounds; i += 1) {
      await recordUnobservableRequest({ ...pr, headSha }, { checkpointDir });
      await recordTimedOutProbe({ ...pr, headSha }, { checkpointDir });
    }
    return checkpointDir;
  };
  const pending = { user: { login: "copilot-pull-request-reviewer[bot]" }, state: "PENDING", commit_id: HEAD, body: "", submitted_at: null };
  for (const [label, rounds, headSha, extra] of [
    ["below the threshold", 1, HEAD, {}],
    ["a record for another head", 2, OLD_HEAD, {}],
    ["a requested Copilot reviewer", 2, HEAD, { requestedReviewers: { users: [{ login: "Copilot" }], teams: [] } }],
    ["a pending current-head Copilot review", 2, HEAD, { reviews: [pending] }],
  ]) {
    const checkpointDir = await record(headSha, rounds);
    const { runtime, calls } = makeRuntime({ maxCopilotRounds: 3, ...extra });
    let threw = null;
    try { await mergePr(baseOptions(), { ...runtime, checkpointDir }); } catch (e) { threw = e; }
    assert.ok(threw, `${label}: must refuse`);
    assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"], label);
    assert.equal(calls.runChild.filter((c) => c.args[0] === "pr" && c.args[1] === "merge").length, 0, label);
  }
});

test("no current-head Copilot review after a clean review and a docs-only delta merges via docs_only_suppression", async () => {
  const { runtime, calls } = makeRuntime({
    strict: true,
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
    ["strict mode: clean review then a code delta", { strict: true, maxCopilotRounds: 3, compareFiles: ["scripts/x.mjs"], reviews: [copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z")] }],
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
  await expectCopilotRefusal("converged then code push", { strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compareFiles: ["src/a.mjs", "src/b.mjs"] });
});

test("at the round cap an integrate-only base move after a converged review merges via docs_only_suppression", async () => {
  const { runtime } = makeRuntime({
    strict: true,
    maxCopilotRounds: 2,
    reviews: CONVERGED_AT_CAP.map((r, i) => withNodeId(r, `PRR_${i}`)),
    compareFiles: ["src/a.mjs", "src/b.mjs"],
    baseRefName: "main",
    prOwnFiles: ["docs/guide.md"],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotDisposition, "docs_only_suppression");
  assert.deepEqual(result.copilotCarriedConvergence, { source: "carried", sourceReviewId: "PRR_1", sourceHeadSha: OLD_HEAD, bodyDisposition: null });
});

test("at the round cap a compare failure after a converged review fails closed", async () => {
  await expectCopilotRefusal("compare failure", { strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { code: 1 } });
});

test("at the round cap a readable compare payload without a files array fails closed", async () => {
  for (const stdout of [JSON.stringify({ status: "ahead" }), JSON.stringify("ahead"), "42"]) {
    await expectCopilotRefusal(`compare payload ${stdout}`, { strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout } });
  }
});

test("at the round cap a compare file entry without a filename fails closed", async () => {
  for (const files of [[{ status: "modified" }], [{ filename: "", status: "modified" }], [{ filename: "docs/guide.md", status: "modified" }, { status: "modified" }]]) {
    const stdout = JSON.stringify({ status: "ahead", files });
    await expectCopilotRefusal(`compare payload ${stdout}`, { strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout } });
  }
});

test("at the round cap an empty compare delta after a converged review keeps round_cap_clean_fallback", async () => {
  const { runtime } = makeRuntime({ strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout: JSON.stringify({ status: "ahead", files: [] }) } });
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
    await expectCopilotRefusal(label, { strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compare: { stdout: JSON.stringify(payload) } });
  }
});

test("at the round cap a trivial change after a converged review keeps round_cap_clean_fallback", async () => {
  const { runtime } = makeRuntime({ strict: true, maxCopilotRounds: 2, reviews: CONVERGED_AT_CAP, compareFiles: ["docs/guide.md"] });
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
  const docsOnly = { strict: true, maxCopilotRounds: 3, compareFiles: ["docs/guide.md"] };
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
  await expectCopilotRefusal("compare non-zero exit", { strict: true, maxCopilotRounds: 3, reviews: clean, compareFiles: ["docs/guide.md"], compare: { code: 1 } });
  await expectCopilotRefusal("compare not ahead", { strict: true, maxCopilotRounds: 3, reviews: clean, compareFiles: ["docs/guide.md"], compare: { status: "diverged" } });
  await expectCopilotRefusal("last reviewed head had findings", {
    strict: true,
    maxCopilotRounds: 3,
    compareFiles: ["docs/guide.md"],
    reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z")],
  });
});

// The loop's copilot-body-disposition record, as a trusted issue comment.
const dispositionRecord = ({ reviewId, head = HEAD, association = "OWNER" }) => ({
  id: 901,
  body: `Disposition recorded.\n<!-- dev-loops:copilot-body-disposition review=${reviewId} head=${head} operator -->`,
  user: { login: "mfittko", type: "User" },
  author_association: association,
});
const withNodeId = (review, nodeId) => ({ ...review, node_id: nodeId });
const YELLOW_BODY = "### 🟡 Changes recommended";

test("docs_only_suppression through the loop's carried convergence names the source review and its commit", async () => {
  const docsOnly = { strict: true, maxCopilotRounds: 3, compareFiles: ["docs/guide.md"] };
  const clean = await mergePr(baseOptions(), makeRuntime({ ...docsOnly, reviews: [withNodeId(copilotAt(OLD_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z"), "PRR_prior")] }).runtime);
  assert.equal(clean.copilotDisposition, "docs_only_suppression");
  assert.deepEqual(clean.copilotCarriedConvergence, { source: "carried", sourceReviewId: "PRR_prior", sourceHeadSha: OLD_HEAD, bodyDisposition: null });

  // A body-only changes-recommended prior review carries only through a trusted record naming it.
  const yellow = [withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_prior")];
  const recorded = await mergePr(baseOptions(), makeRuntime({ ...docsOnly, reviews: yellow, dispositionComments: [dispositionRecord({ reviewId: "PRR_prior" })] }).runtime);
  assert.equal(recorded.copilotDisposition, "docs_only_suppression");
  assert.equal(recorded.copilotCarriedConvergence.sourceReviewId, "PRR_prior");
  assert.equal(recorded.copilotCarriedConvergence.sourceHeadSha, OLD_HEAD);
  assert.equal(recorded.copilotCarriedConvergence.bodyDisposition.reviewId, "PRR_prior");
  assert.equal(recorded.copilotCarriedConvergence.bodyDisposition.headSha, HEAD);

  const refused = await expectCopilotRefusal("untrusted record", { ...docsOnly, reviews: yellow, dispositionComments: [dispositionRecord({ reviewId: "PRR_prior", association: "CONTRIBUTOR" })] });
  assert.equal(refused.mergePrFailure.copilotCarriedConvergence, null);
});

test("a current-head body finding cleared by a trusted copilot-body-disposition record merges and names the record", async () => {
  const headYellow = [withNodeId(copilotAt(HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_head")];
  const result = await mergePr(baseOptions(), makeRuntime({ maxCopilotRounds: 3, reviews: headYellow, dispositionComments: [dispositionRecord({ reviewId: "PRR_head" })] }).runtime);
  assert.equal(result.merged, true);
  assert.equal(result.copilotConvergenceState, "current_head_findings");
  assert.equal(result.copilotBodyDisposition.reviewId, "PRR_head");
  assert.equal(result.copilotBodyDisposition.headSha, HEAD);

  for (const [label, record] of [
    ["record for a stale head", dispositionRecord({ reviewId: "PRR_head", head: OLD_HEAD })],
    ["record naming another review", dispositionRecord({ reviewId: "PRR_other" })],
    ["untrusted record", dispositionRecord({ reviewId: "PRR_head", association: "NONE" })],
  ]) {
    const { runtime, calls } = makeRuntime({ maxCopilotRounds: 3, reviews: headYellow, dispositionComments: [record] });
    let threw = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
    assert.ok(threw, `${label}: must refuse`);
    assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"], label);
    assert.equal(threw.mergePrFailure.copilotBodyDisposition, null, label);
    assert.ok(!calls.runChild.some((c) => c.args[0] === "pr" && c.args[1] === "merge"), `${label}: no merge`);
  }
});

// Judge-bound `reject=` / `defer=` records: the ledger of the named gate at the head is the authority.
async function judgeLedgerCwd(findings) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "merge-pr-judge-"));
  await writeFile(path.join(cwd, ".devloops"), "");
  const file = path.join(cwd, buildLogPath({ repo: "mfittko/dev-loops", pr: 5, gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ findings }));
  return cwd;
}
const judgeRecord = (action, reviewId = "PRR_head") => ({ ...dispositionRecord({ reviewId }), body: `<!-- dev-loops:copilot-body-disposition review=${reviewId} head=${HEAD} ${action}=pre_approval_gate -->` });
const bodyFinding = (overrides = {}) => ({ angle: "copilot-body", reviewId: "PRR_head", severity: "low", summary: "s", judgeDisposition: "reject", ...overrides });

test("a reject= record backed by the judge ledger clears copilot_convergence and is named in the merge result", async () => {
  const cwd = await judgeLedgerCwd([bodyFinding()]);
  try {
    const headYellow = [withNodeId(copilotAt(HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_head")];
    const { runtime } = makeRuntime({ maxCopilotRounds: 3, reviews: headYellow, dispositionComments: [judgeRecord("reject")] });
    const result = await mergePr(baseOptions(), { ...runtime, cwd });
    assert.equal(result.merged, true);
    assert.equal(result.copilotBodyDisposition.reviewId, "PRR_head");
    assert.deepEqual(result.copilotBodyDisposition.judgeBinding, { action: "reject", gate: "pre_approval_gate" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a defer= record at the Copilot round cap with no thread merges; a high finding stays blocked", async () => {
  const reviews = [
    withNodeId(copilotAt(HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z"), "PRR_round1"),
    withNodeId(copilotAt(HEAD, YELLOW_BODY, "2026-01-02T00:00:00Z"), "PRR_kwDOScHU788AAAABZK9Ziw"),
  ];
  const record = judgeRecord("defer", "PRR_kwDOScHU788AAAABZK9Ziw");
  const cwd = await judgeLedgerCwd([bodyFinding({ reviewId: "PRR_kwDOScHU788AAAABZK9Ziw", judgeDisposition: "defer" })]);
  const highCwd = await judgeLedgerCwd([bodyFinding({ reviewId: "PRR_kwDOScHU788AAAABZK9Ziw", judgeDisposition: "defer", severity: "high" })]);
  try {
    const { runtime } = makeRuntime({ maxCopilotRounds: 2, reviews, dispositionComments: [record] });
    const result = await mergePr(baseOptions(), { ...runtime, cwd });
    assert.equal(result.merged, true);
    assert.equal(result.copilotBodyDisposition.judgeBinding.action, "defer");

    const blocked = makeRuntime({ maxCopilotRounds: 2, reviews, dispositionComments: [record] });
    const threw = await mergePr(baseOptions(), { ...blocked.runtime, cwd: highCwd }).then(() => null, (e) => e);
    assert.ok(threw, "a high finding must refuse");
    assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(highCwd, { recursive: true, force: true });
  }
});

test("a clean draft_gate on an older head resets the round count below the cap and refuses", async () => {
  await expectCopilotRefusal("draft-gate reset", {
    maxCopilotRounds: 2,
    reviews: [copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-01T00:00:00Z"), copilotAt(OLD_HEAD, "### 🟡 Changes recommended", "2026-01-02T00:00:00Z")],
    evidence: { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], draftGate: { verdict: "clean", headSha: MID_HEAD, updatedAt: "2026-01-03T00:00:00Z" } },
  });
});

test("a draft-gate reset puts the later-review carry below the cap, as the detector counts it", async () => {
  // Raw count 2 equals the cap, so a later findings review with a resolved thread of its own carries.
  // The clean draft_gate resets the count to 1, below the cap, so the same carry refuses until the Copilot gate passes, as in the detector.
  const reviews = [copilotAt(MID_HEAD, "### 🟢 Approval recommended", "2026-01-01T00:00:00Z"), withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-03T00:00:00Z"), "PRR_old")];
  const evidence = { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], draftGate: { verdict: "clean", headSha: MID_HEAD, updatedAt: "2026-01-02T00:00:00Z" } };
  const overrides = { maxCopilotRounds: 2, reviews, reviewThreads: [reviewThread({ reviewId: "PRR_old", isResolved: true })] };
  const atCap = await mergePr(baseOptions(), makeRuntime(overrides).runtime);
  assert.equal(atCap.merged, true);
  const { runtime } = makeRuntime({ ...overrides, evidence });
  const threw = await mergePr(baseOptions(), runtime).then(() => null, (e) => e);
  assert.ok(threw, "reset below the cap must refuse");
  assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"]);
  assert.ok(refusalReason(threw).startsWith(NO_CURRENT_HEAD_REVIEW_REFUSAL));
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

test("humanMergeOnly refuses before the base fetch, even when the fetch would throw", async () => {
  const { runtime } = makeRuntime({ humanMergeOnly: true });
  let fetched = false;
  runtime.fetchPrHead = () => { fetched = true; throw new Error("fetch must not run"); };
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.humanMergeOnly, true);
  assert.equal(fetched, false);
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
  assert.ok(threw.message.includes("run `dev-loops-run --repo-root <checkout> scripts/github/reconcile-gate-evidence-status.mjs --repo mfittko/dev-loops --pr 5`"));
  assert.match(threw.message, /no-run-to-refire.*start a new run with a gate-verdict event for the head.*lost-run recovery.*evidence-not-satisfied-fail-closed.*run merge-pr with --check and fix the other failures it lists/);
  assert.doesNotMatch(threw.message, /gh run rerun|<run-id>/);
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

// ── Converged-once default (refinement.requireCopilotConvergenceAtLatestHead: false) ──

// A review thread the named review opened (parseReviewThreads attributes it
// through the root comment's pullRequestReview).
const reviewThread = ({ reviewId, isResolved }) => ({
  id: `thread-${reviewId}`,
  isResolved,
  comments: { nodes: [{ id: `c-${reviewId}`, databaseId: 1, body: "Fix this.", author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, pullRequestReview: { id: reviewId } }] },
});
const NO_CURRENT_HEAD_REVIEW_REFUSAL = `no current-head Copilot review exists on head ${HEAD}`;
const refusalReason = (threw) => threw.mergePrFailure.failures.find((f) => f.precondition === "copilot_convergence").reason;
const cleanAt = (commit, nodeId, submittedAt = "2026-01-01T00:00:00Z") => withNodeId(copilotAt(commit, "### 🟢 Approval recommended", submittedAt), nodeId);

test("converged-once: a code fix after a clean Copilot review merges below the cap without a new Copilot review", async () => {
  const { runtime, calls } = makeRuntime({ maxCopilotRounds: 3, compareFiles: ["src/a.mjs", "src/b.mjs"], reviews: [cleanAt(OLD_HEAD, "PRR_a")] });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "converged_once");
  assert.deepEqual(result.copilotCarriedConvergence, { source: "converged_once", sourceReviewId: "PRR_a", sourceHeadSha: OLD_HEAD, bodyDisposition: null });
  // Ancestry and delta class are not checked.
  assert.ok(!calls.runChild.some((c) => String(c.args[1]).includes("/compare/")), "no compare call");
});

test("converged-once: a code fix after a clean Copilot review merges at the round cap without a new Copilot review", async () => {
  const reviews = CONVERGED_AT_CAP.map((r, i) => withNodeId(r, `PRR_${i}`));
  const { runtime, calls } = makeRuntime({ maxCopilotRounds: 2, compareFiles: ["src/a.mjs", "src/b.mjs"], reviews });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "converged_once");
  assert.deepEqual(result.copilotCarriedConvergence, { source: "converged_once", sourceReviewId: "PRR_1", sourceHeadSha: OLD_HEAD, bodyDisposition: null });
  assert.ok(!calls.runChild.some((c) => String(c.args[1]).includes("/compare/")), "no compare call");
});

test("converged-once: a 🔵 review, a 🟡 review with its own resolved thread, and an unrecognized review with a trusted record each converge at a later head", async () => {
  const blue = await mergePr(baseOptions(), makeRuntime({ maxCopilotRounds: 3, reviews: [withNodeId(copilotAt(OLD_HEAD, "### 🔵 Needs a closer look\n\nhave a look.", "2026-01-01T00:00:00Z"), "PRR_blue")] }).runtime);
  assert.equal(blue.copilotDisposition, "converged_once");
  assert.equal(blue.copilotCarriedConvergence.sourceReviewId, "PRR_blue");

  await expectCopilotRefusal("a review with its own resolved thread below the cap", {
    maxCopilotRounds: 3,
    reviews: [withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_yellow")],
    reviewThreads: [reviewThread({ reviewId: "PRR_yellow", isResolved: true })],
  });
  const ownThread = await mergePr(baseOptions(), makeRuntime({
    maxCopilotRounds: 1,
    reviews: [withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_yellow")],
    reviewThreads: [reviewThread({ reviewId: "PRR_yellow", isResolved: true })],
  }).runtime);
  assert.equal(ownThread.copilotDisposition, "converged_once");
  assert.equal(ownThread.copilotCarriedConvergence.sourceReviewId, "PRR_yellow");
  assert.equal(ownThread.copilotCarriedConvergence.bodyDisposition, null);

  const recorded = await mergePr(baseOptions(), makeRuntime({
    maxCopilotRounds: 3,
    reviews: [withNodeId(copilotAt(OLD_HEAD, "### 🟣 Something new\n\nbody.", "2026-01-01T00:00:00Z"), "PRR_unknown")],
    dispositionComments: [dispositionRecord({ reviewId: "PRR_unknown" })],
  }).runtime);
  assert.equal(recorded.copilotDisposition, "converged_once");
  assert.equal(recorded.copilotCarriedConvergence.bodyDisposition.reviewId, "PRR_unknown");
  assert.equal(recorded.copilotCarriedConvergence.sourceHeadSha, OLD_HEAD);
});

test("final round: a changes_recommended review whose thread the fixer resolved carries convergence to the one fix commit above it", async () => {
  const { runtime } = makeRuntime({
    maxCopilotRounds: 1,
    reviews: [withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_final")],
    reviewThreads: [reviewThread({ reviewId: "PRR_final", isResolved: true })],
  });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.copilotConvergenceState, "no_current_head_review");
  assert.equal(result.copilotDisposition, "converged_once");
  assert.equal(result.copilotCarriedConvergence.sourceReviewId, "PRR_final");
  assert.equal(result.copilotCarriedConvergence.sourceHeadSha, OLD_HEAD);
});

// ADR 0155: the fixer-disposition boundary is advisory; the merge gate still refuses an unresolved review thread.
test("merge-pr refuses a PR with an unresolved review thread and performs no merge", async () => {
  const refused = await expectCopilotRefusal("an unresolved review thread", {
    maxCopilotRounds: 3,
    reviews: [cleanAt(OLD_HEAD, "PRR_a")],
    reviewThreads: [reviewThread({ reviewId: "PRR_a", isResolved: false })],
  });
  assert.ok(refusalReason(refused).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));
});

test("converged-once still refuses a never-reviewed PR, an unconverged latest review, an outstanding request, and a current-head 🟡", async () => {
  const never = await expectCopilotRefusal("no Copilot review", { maxCopilotRounds: 3 });
  assert.ok(refusalReason(never).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));
  const unresolved = await expectCopilotRefusal("an unresolved thread", {
    maxCopilotRounds: 3,
    reviews: [cleanAt(OLD_HEAD, "PRR_a")],
    reviewThreads: [reviewThread({ reviewId: "PRR_a", isResolved: false })],
  });
  assert.ok(refusalReason(unresolved).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));
  const bodyOnly = await expectCopilotRefusal("a body-only 🟡 with no own thread and no record", {
    maxCopilotRounds: 3,
    reviews: [withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_yellow")],
  });
  assert.ok(refusalReason(bodyOnly).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));
  const outstanding = await expectCopilotRefusal("an outstanding request on the current head", {
    maxCopilotRounds: 3,
    reviews: [cleanAt(OLD_HEAD, "PRR_a")],
    requestedReviewers: { users: [{ login: "Copilot" }], teams: [] },
  });
  assert.ok(refusalReason(outstanding).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));

  const { runtime } = makeRuntime({ maxCopilotRounds: 3, reviews: [cleanAt(OLD_HEAD, "PRR_a"), withNodeId(copilotAt(HEAD, YELLOW_BODY, "2026-01-02T00:00:00Z"), "PRR_head")] });
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "a current-head 🟡 must refuse");
  assert.equal(threw.mergePrFailure.copilotConvergenceState, "current_head_findings");
  assert.match(refusalReason(threw), /current-head Copilot review is "Changes recommended"/);
});

test("converged-once: a later Copilot review wins over an earlier convergence until its thread is resolved", async () => {
  const reviews = [cleanAt(OLD_HEAD, "PRR_clean"), withNodeId(copilotAt(MID_HEAD, YELLOW_BODY, "2026-01-02T00:00:00Z"), "PRR_later")];
  const blocked = await expectCopilotRefusal("later 🟡 with an unresolved thread", {
    maxCopilotRounds: 3,
    reviews,
    reviewThreads: [reviewThread({ reviewId: "PRR_later", isResolved: false })],
  });
  assert.ok(refusalReason(blocked).includes(NO_CURRENT_HEAD_REVIEW_REFUSAL));
  const resolved = await mergePr(baseOptions(), makeRuntime({
    maxCopilotRounds: 2,
    reviews,
    reviewThreads: [reviewThread({ reviewId: "PRR_later", isResolved: true })],
  }).runtime);
  assert.equal(resolved.copilotDisposition, "converged_once");
  assert.equal(resolved.copilotCarriedConvergence.sourceReviewId, "PRR_later");
  assert.equal(resolved.copilotCarriedConvergence.sourceHeadSha, MID_HEAD);
});

test("strict mode: a significant change after convergence refuses round_cap_clean_fallback and a docs-only change merges via docs_only_suppression", async () => {
  const reviews = CONVERGED_AT_CAP.map((r, i) => withNodeId(r, `PRR_${i}`));
  await expectCopilotRefusal("strict: converged then code push at the cap", { strict: true, maxCopilotRounds: 2, reviews, compareFiles: ["src/a.mjs", "src/b.mjs"] });
  await expectCopilotRefusal("strict: converged then code push below the cap", { strict: true, maxCopilotRounds: 3, reviews: [cleanAt(OLD_HEAD, "PRR_a")], compareFiles: ["src/a.mjs"] });
  const docsOnly = await mergePr(baseOptions(), makeRuntime({ strict: true, maxCopilotRounds: 3, reviews: [cleanAt(OLD_HEAD, "PRR_a")], compareFiles: ["docs/guide.md"] }).runtime);
  assert.equal(docsOnly.copilotDisposition, "docs_only_suppression");
  assert.equal(docsOnly.copilotCarriedConvergence.source, "carried");
});

test("a record naming a later older-commit review does not clear a current-head finding, and the resolver reads the unreset review list", async () => {
  // Copilot reviews the current head (🟡), then reviews an older commit. A
  // clean draft_gate on another head would reset the round count; the body
  // resolver must still see the current-head review the raw state judged.
  const reviews = [
    withNodeId(copilotAt(HEAD, YELLOW_BODY, "2026-01-01T00:00:00Z"), "PRR_head"),
    withNodeId(copilotAt(OLD_HEAD, YELLOW_BODY, "2026-01-03T00:00:00Z"), "PRR_old"),
  ];
  const threw = await (async () => {
    const { runtime, calls } = makeRuntime({
      maxCopilotRounds: 3,
      reviews,
      dispositionComments: [dispositionRecord({ reviewId: "PRR_old" })],
      evidence: { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], draftGate: { verdict: "clean", headSha: MID_HEAD, updatedAt: "2026-01-02T00:00:00Z" } },
    });
    let error = null;
    try { await mergePr(baseOptions(), runtime); } catch (e) { error = e; }
    assert.ok(!calls.runChild.some((c) => c.args[0] === "pr" && c.args[1] === "merge"), "no merge");
    return error;
  })();
  assert.ok(threw, "must refuse");
  assert.equal(threw.mergePrFailure.copilotConvergenceState, "current_head_findings");
  assert.deepEqual(threw.mergePrFailure.failures.map((f) => f.precondition), ["copilot_convergence"]);
  assert.equal(threw.mergePrFailure.copilotBodyDisposition, null);

  // Positive case under the same reset evidence: records naming both reviews
  // clear them, and the body disposition names PRR_head. A reset-filtered
  // resolver list drops PRR_head and cannot report it.
  const merged = await mergePr(baseOptions(), makeRuntime({
    maxCopilotRounds: 3,
    reviews,
    dispositionComments: [dispositionRecord({ reviewId: "PRR_head" }), { ...dispositionRecord({ reviewId: "PRR_old" }), id: 902 }],
    evidence: { ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], draftGate: { verdict: "clean", headSha: MID_HEAD, updatedAt: "2026-01-02T00:00:00Z" } },
  }).runtime);
  assert.equal(merged.merged, true);
  assert.equal(merged.copilotBodyDisposition.reviewId, "PRR_head");
});

test("merge-pr default evidence probe shells the same detect-checkpoint-evidence script as gate-evidence CI", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../scripts/github/merge-pr.mjs", import.meta.url), "utf8");
  assert.match(source, /new URL\("\.\/detect-checkpoint-evidence\.mjs", import\.meta\.url\)/u);
});

// ---- retrospective_checkpoint precondition (#2488) ----
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildResolveDevLoopStartupResult, resolvePendingRetrospectives } from "../../scripts/loop/resolve-dev-loop-startup.mjs";
import { resolverTestEnv, runGitFixture } from "../_helpers.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETRO_MERGE_COMMIT = "bbbb1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const RETRO_CONFIG = { workflow: { requireRetrospective: true } };

function retroRuntime({ configExtra = RETRO_CONFIG, record } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-retro-"));
  // Hermetic: the fixture is its own git repo with a known origin, so repo-root
  // and repo-slug resolution never depend on the host checkout.
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:mfittko/dev-loops.git"], { cwd: dir, stdio: "ignore" });
  if (record !== undefined) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "dev-loop-retrospective-checkpoint.json"), typeof record === "string" ? record : JSON.stringify(record));
  }
  const made = makeRuntime({ configExtra });
  made.runtime.cwd = dir;
  return { ...made, dir };
}

async function refusal(runtime) {
  let threw = null;
  try { await mergePr(baseOptions(), runtime); } catch (e) { threw = e; }
  assert.ok(threw, "merge must be refused");
  return threw;
}

test("retrospective_checkpoint: an undischarged earlier retro refuses and names the PR and full merge commit", async () => {
  const { runtime, calls, dir } = retroRuntime({ record: { state: "required", identity: { repo: "mfittko/dev-loops", prNumber: 2679, mergeCommit: RETRO_MERGE_COMMIT } } });
  try {
    const threw = await refusal(runtime);
    const failure = threw.mergePrFailure.failures.find((f) => f.precondition === "retrospective_checkpoint");
    assert.ok(failure, JSON.stringify(threw.mergePrFailure));
    assert.ok(failure.reason.includes("#2679") && failure.reason.includes(RETRO_MERGE_COMMIT), failure.reason);
    assert.ok(!calls.runChild.some((c) => c.args[0] === "pr" && c.args[1] === "merge"), "no gh pr merge call");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retrospective_checkpoint: identity-less and malformed records refuse naming the reason and recorded state", async () => {
  const cases = [
    [{ state: "required" }, "checkpoint_identity_missing", "required"],
    ["{not json", "checkpoint_unreadable", "unreadable"],
    [[], "checkpoint_malformed", "malformed"],
  ];
  for (const [record, reason, state] of cases) {
    const { runtime, dir } = retroRuntime({ record });
    try {
      const threw = await refusal(runtime);
      const failure = threw.mergePrFailure.failures.find((f) => f.precondition === "retrospective_checkpoint");
      assert.ok(failure && failure.reason.includes(reason) && failure.reason.includes(`state ${state}`), JSON.stringify(failure));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("retrospective_checkpoint: an empty pendingRetrospectives result (evaluator stubbed) allows the merge", async () => {
  for (const checkpointState of ["complete", "skipped"]) {
    const { runtime, calls } = makeRuntime({ configExtra: RETRO_CONFIG });
    runtime.resolvePendingRetrospectives = () => ({ checkpointState, pendingRetrospectives: [] });
    const result = await mergePr(baseOptions(), runtime);
    assert.equal(result.merged, true);
    assert.equal(calls.runChild.length, 1);
  }
});

test("retrospective_checkpoint: a failed association lookup surfaces the helper's pending entry", async () => {
  const { runtime } = makeRuntime({ configExtra: RETRO_CONFIG });
  runtime.resolvePendingRetrospectives = () => ({ checkpointState: "missing", pendingRetrospectives: [{ pr: null, mergeCommit: null, reason: "ancestry_or_association_unverifiable" }] });
  const threw = await refusal(runtime);
  assert.match(threw.mergePrFailure.failures.find((f) => f.precondition === "retrospective_checkpoint").reason, /ancestry_or_association_unverifiable/);
});

test("retrospective_checkpoint: with requireRetrospective unset or false nothing is read and no precondition is evaluated", async () => {
  for (const configExtra of [{}, { workflow: { requireRetrospective: false } }]) {
    const { runtime } = makeRuntime({ configExtra });
    runtime.resolvePendingRetrospectives = () => { throw new Error("must not be called"); };
    const result = await mergePr(baseOptions(), runtime);
    assert.equal(result.merged, true);
  }
});

test("retrospective_checkpoint: startup and merge-pr report the same pending entry for one record", async () => {
  const records = [
    { state: "required", identity: { repo: "mfittko/dev-loops", prNumber: 2679, mergeCommit: RETRO_MERGE_COMMIT } },
    { state: "required", identity: { repo: "other/elsewhere", prNumber: 7, mergeCommit: RETRO_MERGE_COMMIT } },
    { state: "required" },
  ];
  for (const record of records) {
    const { runtime, dir } = retroRuntime({ record });
    try {
      const startup = buildResolveDevLoopStartupResult({
        currentState: { target: { kind: "local_branch", branch: "feature/x" }, ownership: "local", nextActor: "local", status: "active", authorization: "needs_confirmation" },
        artifactState: "not_applicable",
        loopState: "active",
      }, { env: resolverTestEnv(), cwd: dir, config: RETRO_CONFIG });
      const threw = await refusal(runtime);
      const failure = threw.mergePrFailure.failures.find((f) => f.precondition === "retrospective_checkpoint");
      const [entry] = startup.bundle.pendingRetrospectives;
      assert.equal(startup.bundle.pendingRetrospectives.length, 1);
      const expected = entry.pr === null
        ? `reason ${entry.reason}, recorded checkpoint state required`
        : `PR #${entry.pr} (merge commit ${entry.mergeCommit})`;
      assert.ok(failure.reason.includes(expected), `${expected} :: ${failure.reason}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("retrospective_checkpoint: a real complete record runs through the shared evaluator", async () => {
  const record = {
    state: "complete",
    identity: { repo: "mfittko/dev-loops", prNumber: 2679, mergeCommit: RETRO_MERGE_COMMIT },
    provenance: { context: "fresh", seededFrom: "agent_tool_call_record", recordSource: "tmp/record.json" },
  };
  for (const [stale, merged] of [[false, true], [true, false]]) {
    const { runtime, dir } = retroRuntime({ record });
    runtime.resolvePendingRetrospectives = (args) => resolvePendingRetrospectives({
      ...args,
      resolveHasNewerMerge: () => ({ stale, pending: null, reason: stale ? "newer_merge_unidentified" : null }),
    });
    try {
      if (merged) {
        assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
      } else {
        const threw = await refusal(runtime);
        assert.match(threw.mergePrFailure.failures.find((f) => f.precondition === "retrospective_checkpoint").reason, /newer_merge_unidentified/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

const adrFile = (filename, status = "added", previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });
const contentsCalls = (calls) => calls.ghJson.filter((a) => a.join(" ").includes("/contents/docs/decisions"));

test("adr_number_collision: refuses an added record whose number the base tip holds", async () => {
  const { runtime, calls } = makeRuntime({
    prView: { baseRefName: "develop" },
    adrPrFiles: [adrFile("docs/decisions/0095-b.md")],
    adrTip: ["0000-template.md", "0095-a.md"],
  });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.failures.find((f) => f.precondition === "adr_number_collision").reason,
    "PR adds docs/decisions/0095-b.md but develop already holds docs/decisions/0095-a.md (ADR-PATH-NUMBERING); rebase onto develop and renumber the record to 0096");
  assert.equal(mergeCalls(calls).length, 0);
  assert.deepEqual(contentsCalls(calls), [["api", "repos/mfittko/dev-loops/contents/docs/decisions?ref=develop"]]);
});

test("adr_number_collision: a non-colliding added record merges", async () => {
  const { runtime } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0096-b.md")], adrTip: ["0095-a.md"] });
  assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
});

test("adr_number_collision: a PR adding no decision record makes no contents call", async () => {
  const { runtime, calls } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0095-a.md", "modified"), adrFile("src/x.mjs")] });
  assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
  assert.equal(contentsCalls(calls).length, 0);
});

test("adr_number_collision: a 404 on the tip directory is an empty tip", async () => {
  const { runtime } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0001-a.md")], adrTip: new Error("gh command failed: gh: Not Found (HTTP 404)") });
  assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
});

test("adr_number_collision: a blank base branch name refuses before any ADR number read", async () => {
  for (const baseRefName of ["", "  "]) {
    const { runtime, calls } = makeRuntime({ prView: { baseRefName }, adrPrFiles: [adrFile("docs/decisions/0001-a.md")] });
    const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
    // An unreadable base now refuses at the top as base_not_integrated, before any ADR number read.
    assert.match(threw.mergePrFailure.failures.find((f) => f.precondition === "base_not_integrated").reason, /base branch is unreadable/);
    assert.equal(contentsCalls(calls).length, 0);
    assert.equal(mergeCalls(calls).length, 0);
  }
});

test("adr_number_collision: a non-404 tip read error whose text contains 404 still refuses", async () => {
  for (const message of [
    'Get "https://api.github.com/repos/o/r/contents/docs/decisions?ref=hotfix-404": dial tcp: i/o timeout',
    "gh: Server Error (HTTP 500) for repos/o/r404/contents/docs/decisions",
    "gh: Not Found-like text without an HTTP 404 status marker",
    "gh: Repository not found (HTTP 404)",
  ]) {
    const { runtime, calls } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0001-a.md")], adrTip: new Error(message) });
    const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
    assert.match(threw.mergePrFailure.failures.find((f) => f.precondition === "adr_number_collision").reason, /could not read docs\/decisions/);
    assert.equal(mergeCalls(calls).length, 0);
  }
});

test("adr_number_collision: a base-ref-not-found 404 refuses fail-closed", async () => {
  const { runtime, calls } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0001-a.md")], adrTip: new Error("gh: No commit found for the ref main (HTTP 404)") });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.match(threw.mergePrFailure.failures.find((f) => f.precondition === "adr_number_collision").reason, /could not read docs\/decisions/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_number_collision: any other tip read error refuses fail-closed", async () => {
  const { runtime, calls } = makeRuntime({ adrPrFiles: [adrFile("docs/decisions/0001-a.md")], adrTip: new Error("gh command failed: HTTP 500") });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.failures.find((f) => f.precondition === "adr_number_collision").reason,
    "could not read docs/decisions on main to check ADR numbers: gh command failed: HTTP 500");
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_number_collision: a failed files-list read refuses fail-closed", async () => {
  const { runtime, calls } = makeRuntime({ adrPrFiles: new Error("gh command failed: HTTP 500") });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "adr_number_collision"));
  assert.equal(mergeCalls(calls).length, 0);
});

test("adr_number_collision: a removed record is subtracted from the tip", async () => {
  const { runtime } = makeRuntime({
    adrPrFiles: [adrFile("docs/decisions/0095-a.md", "removed"), adrFile("docs/decisions/0095-b.md")],
    adrTip: ["0095-a.md"],
  });
  assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
});

test("adr_number_collision: a collision-repair rename merges", async () => {
  const { runtime } = makeRuntime({
    adrPrFiles: [adrFile("docs/decisions/0105-b.md", "renamed", "docs/decisions/0095-b.md")],
    adrTip: ["0095-a.md", "0095-b.md"],
  });
  assert.equal((await mergePr(baseOptions(), runtime)).merged, true);
});

test("base_not_integrated refuses a head that does not contain origin/<base> and merges one that does", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
  const asked = [];
  runtime.isAncestor = (opts) => { asked.push({ base: opts.base, head: opts.head }); return false; };
  await assert.rejects(() => mergePr(baseOptions(), runtime), /base_not_integrated \(.*GATE-EXEC-BASE-REFRESH/);
  // One read before the evidence (patch-id gate), one for the refusal after the ADR step.
  assert.deepEqual(asked, [{ base: "origin/main", head: HEAD }, { base: "origin/main", head: HEAD }]);
  assert.equal(mergeCalls(calls).length, 0);

  const ok = makeRuntime({ prView: { baseRefName: "main" } });
  ok.runtime.isAncestor = () => true;
  assert.equal((await mergePr(baseOptions(), ok.runtime)).merged, true);
  assert.equal(mergeCalls(ok.calls).length, 1);
});

test("base_not_integrated shapes mergePrFailure like the other refusals", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main" } });
  runtime.isAncestor = () => false;
  const error = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(error.mergePrFailure.ok, false);
  assert.equal(error.mergePrFailure.merged, false);
  assert.equal(error.mergePrFailure.headSha, HEAD);
  assert.equal(error.mergePrFailure.failures[0].precondition, "base_not_integrated");
});

test("base_not_integrated fails closed when the fetch or the ancestry check throws", async () => {
  for (const key of ["fetchPrHead", "isAncestor"]) {
    const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
    runtime[key] = () => { throw new Error("git exploded"); };
    await assert.rejects(() => mergePr(baseOptions(), runtime), /base_not_integrated \(could not verify.*git exploded/);
    assert.equal(mergeCalls(calls).length, 0);
  }
});

test("base_not_integrated fails closed when the checkout origin stops matching --repo", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main" } });
  runtime.detectOriginSlug = () => "someone/fork";
  await assert.rejects(() => mergePr(baseOptions(), runtime), /base_not_integrated \(could not verify.*checkout origin/);
  assert.equal(mergeCalls(calls).length, 0);
});

test("defaultIsAncestor answers true, false, and throws on a bad ref in a real repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "is-ancestor-"));
  try {
  const git = (...args) => runGitFixture(dir, ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1");
  git("add", "a");
  git("commit", "-q", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "b"), "2");
  git("add", "b");
  git("commit", "-q", "-m", "two");
  const side = git("rev-parse", "HEAD");
  assert.equal(defaultIsAncestor({ base: first, head: side, repoRoot: dir }), true);
  assert.equal(defaultIsAncestor({ base: side, head: side, repoRoot: dir }), true);
  assert.equal(defaultIsAncestor({ base: side, head: first, repoRoot: dir }), false);
  assert.throws(() => defaultIsAncestor({ base: "no-such-ref", head: side, repoRoot: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultComputePatchId counts whitespace and binary changes and survives a base-only refresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-id-"));
  try {
    const git = (...args) => runGitFixture(dir, ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    const commitFile = (name, content, msg) => { writeFileSync(join(dir, name), content); git("add", name); git("commit", "-q", "-m", msg); };
    git("init", "-q", "-b", "main");
    commitFile("a.txt", "x\n", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const idAt = (branch, name, content) => {
      git("checkout", "-q", "-B", branch, "refs/remotes/origin/main");
      commitFile(name, content, branch);
      return defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir });
    };
    const spaced = idAt("ws1", "f.txt", "a b\n");
    const unspaced = idAt("ws2", "f.txt", "a  b\n");
    const binA = idAt("bin1", "f.bin", Buffer.from([0, 1, 2, 3]));
    const binB = idAt("bin2", "f.bin", Buffer.from([0, 1, 2, 4]));
    assert.ok(spaced && unspaced && binA && binB);
    assert.notEqual(spaced, unspaced);
    assert.notEqual(binA, binB);
    git("checkout", "-q", "ws1");
    const before = defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir });
    git("checkout", "-q", "-B", "other", "refs/remotes/origin/main");
    commitFile("other.txt", "o\n", "base-only");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "ws1");
    git("merge", "-q", "--no-edit", "origin/main");
    assert.equal(defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir }), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultComputePatchId binds position and bytes, ignores local diff config and fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-id-"));
  try {
    const git = (...args) => runGitFixture(dir, ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    const commitFile = (name, content, msg) => { writeFileSync(join(dir, name), content); git("add", name); git("commit", "-q", "-m", msg); };
    git("init", "-q", "-b", "main");
    commitFile("f.js", "function a() {\n  check();\n}\nfunction b() {\n  check();\n}\n", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const idAt = (branch, name, content) => {
      git("checkout", "-q", "-B", branch, "refs/remotes/origin/main");
      commitFile(name, content, branch);
      return defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir });
    };
    const inA = idAt("in-a", "f.js", "function a() {\n  check();\n  return true;\n}\nfunction b() {\n  check();\n}\n");
    const inB = idAt("in-b", "f.js", "function a() {\n  check();\n}\nfunction b() {\n  check();\n  return true;\n}\n");
    assert.ok(inA && inB);
    assert.notEqual(inA, inB, "relocating an added line changes the id");
    const latinE9 = idAt("l1", "l.txt", Buffer.from([0x63, 0x61, 0xe9, 0x0a]));
    const latinE8 = idAt("l2", "l.txt", Buffer.from([0x63, 0x61, 0xe8, 0x0a]));
    assert.notEqual(latinE9, latinE8, "two non-UTF-8 bytes give distinct ids");
    git("checkout", "-q", "in-a");
    const plain = defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir });
    git("config", "diff.noprefix", "true");
    assert.equal(defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir }), plain, "diff.noprefix leaves the id unchanged");
    writeFileSync(join(dir, ".gitattributes"), "*.js -diff\n");
    assert.equal(defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir }), plain, "an uncommitted working-tree .gitattributes leaves the id unchanged");
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.js -diff\n");
    assert.equal(defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir }), plain, "a local info/attributes line leaves the id unchanged");
    const tpl = join(dir, "tpl");
    mkdirSync(join(tpl, "info"), { recursive: true });
    writeFileSync(join(tpl, "info", "attributes"), "*.js -diff\n");
    const prevTpl = process.env.GIT_TEMPLATE_DIR;
    process.env.GIT_TEMPLATE_DIR = tpl;
    try {
      assert.equal(defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir }), plain, "an init template with info/attributes leaves the id unchanged");
    } finally {
      if (prevTpl === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = prevTpl;
    }
    assert.equal(defaultComputePatchId({ base: "origin/no-such-ref", head: "HEAD", repoRoot: dir }), null, "a git error fails closed");
    const gitlinkId = (branch, sha) => {
      git("checkout", "-q", "-B", branch, "refs/remotes/origin/main");
      git("update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
      git("commit", "-q", "-m", branch);
      return defaultComputePatchId({ base: "origin/main", head: "HEAD", repoRoot: dir });
    };
    const prevEnv = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.ignoreSubmodules", GIT_CONFIG_VALUE_0: "all" });
    try {
      const g1 = gitlinkId("g1", "1".repeat(40));
      const g2 = gitlinkId("g2", "2".repeat(40));
      assert.ok(g1 && g2);
      assert.notEqual(g1, g2, "a gitlink-only change keeps distinct ids under an injected diff.ignoreSubmodules=all");
    } finally {
      for (const [name, value] of [["GIT_CONFIG_COUNT", prevEnv.c], ["GIT_CONFIG_KEY_0", prevEnv.k], ["GIT_CONFIG_VALUE_0", prevEnv.v]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDetectEvidenceArgv adds --patch-id only for a non-empty patchId, and mergePr forwards the computed id", async () => {
  const id = "c".repeat(40);
  const argv = buildDetectEvidenceArgv({ repo: "o/r", pr: 5, patchId: id });
  assert.deepEqual(argv.slice(-2), ["--patch-id", id]);
  assert.equal(buildDetectEvidenceArgv({ repo: "o/r", pr: 5, patchId: null }).includes("--patch-id"), false);
  assert.equal(buildDetectEvidenceArgv({ repo: "o/r", pr: 5, patchId: "" }).includes("--patch-id"), false);
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE, comments: [] });
  const seen = [];
  const detect = runtime.detectEvidence;
  runtime.detectEvidence = async (opts) => { seen.push(opts.patchId); return detect(opts); };
  runtime.computePatchId = () => id;
  await mergePr(baseOptions({ standingAuthorization: false }), runtime).catch(() => {});
  assert.deepEqual(seen, [id]);
});

test("defaultFetchPrHead fetches the base with an explicit refspec so a restricted remote.origin.fetch cannot leave a stale ref", () => {
  const calls = [];
  defaultFetchPrHead({ pr: 7, baseRefName: "main", repoRoot: "/repo" }, (cmd, args) => { calls.push([cmd, ...args]); });
  assert.deepEqual(calls[0], ["git", "fetch", "origin", "--", "+refs/heads/main:refs/remotes/origin/main"]);
  assert.deepEqual(calls[1], ["git", "fetch", "origin", "--", "pull/7/head"]);
});

test("ancestry is rechecked after the ADR tripwire base refresh", async () => {
  // The waiver writer refreshes the base and advances it past the head; the single post-ADR ancestry check must refuse.
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "old" } });
  let advanced = false;
  runtime.isAncestor = () => !advanced;
  runtime.evaluateAdrTripwire = async ({ prBody }) => (prBody === "old" ? STALE_BLOCK : { outcome: "pass" });
  runtime.waiveAdrTripwire = async () => { advanced = true; return { ok: true, action: "waiver_written" }; };
  const base = runtime.ghJson;
  runtime.ghJson = async (args) => (args.join(" ").endsWith("--json body") ? { body: "new" } : base(args));
  const error = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.match(error.message, /base_not_integrated \(.*does not contain origin\/main/);
  assert.equal(error.mergePrFailure.failures[0].precondition, "base_not_integrated");
  assert.equal(advanced, true);
  assert.equal(mergeCalls(calls).length, 0);
});

test("the refusal ancestry check runs after the ADR step and the single fetch; the patch-id gate reads it right after the fetch", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  const order = [];
  runtime.fetchPrHead = () => { order.push("fetch"); };
  runtime.evaluateAdrTripwire = async () => { order.push("adr"); return { outcome: "pass" }; };
  runtime.isAncestor = () => { order.push("ancestry"); return true; };
  await mergePr(baseOptions(), runtime);
  assert.deepEqual(order, ["fetch", "ancestry", "adr", "ancestry"]);
});

test("the evidence detector receives the PR base branch so the cap-fixed proof can be evaluated", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  const seen = [];
  const detect = runtime.detectEvidence;
  runtime.detectEvidence = async (opts) => { seen.push(opts.baseRefName); return detect(opts); };
  await mergePr(baseOptions(), runtime);
  assert.deepEqual(seen, ["main"]);
});

test("buildDetectEvidenceArgv adds --base-ref-name only for a non-empty base ref", () => {
  const withBase = buildDetectEvidenceArgv({ repo: "o/r", pr: 5, baseRefName: "main" });
  assert.deepEqual(withBase.slice(-2), ["--base-ref-name", "main"]);
  const without = buildDetectEvidenceArgv({ repo: "o/r", pr: 5, baseRefName: "" });
  assert.equal(without.includes("--base-ref-name"), false);
});

const ESCALATED_EVIDENCE = { ok: true, sizeOutcome: "escalate", touchesT1: false, failures: [] };

test("parse: --check makes --human-approved-by optional", () => {
  const o = parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--check"]);
  assert.equal(o.check, true);
  assert.equal(o.humanApprovedBy, undefined);
  assert.throws(() => parseMergePrCliArgs(["--repo", "o/r", "--pr", "5", "--check", "--human-approved-by", "no good"]), /real GitHub login/);
});

test("--check on the PR 2630 shape (escalated, no approval comment) reports every failure and never writes", async () => {
  const { runtime, calls } = makeRuntime({ evidence: ESCALATED_EVIDENCE, prView: { title: "wip: x" } });
  runtime.isAncestor = () => false;
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: false }), runtime);
  assert.equal(result.check, true);
  assert.equal(result.ok, false);
  assert.equal(result.merged, false);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.approvalPath, "comment_marker");
  assert.equal(result.approveMergeLine, `approve merge ${HEAD}`);
  assert.equal(result.sizeClass, "escalate");
  const names = result.failures.map((f) => f.precondition);
  for (const expected of ["title_markers", "size_budget_human_approval", "merge_approval", "base_not_integrated"]) assert.ok(names.includes(expected), `${expected} in ${names}`);
  assert.equal(calls.runChild.length, 0, "no merge, comment or write");
  assert.equal(calls.comments.length, 0);
});

const PATCH_ID = "c".repeat(40);
test("a patch-id marker approves a changed head when the head contains the base (AC1)", async () => {
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${OLD_HEAD} patch-id ${PATCH_ID}` }],
  });
  runtime.computePatchId = () => PATCH_ID;
  const result = await mergePr(baseOptions({ standingAuthorization: false }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.approvalVia, "comment_marker");
  assert.equal(result.approvalMatch, "patch_id");
});

test("a patch-id marker for a different patch-id is refused with the stale-approval reason (AC2)", async () => {
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${OLD_HEAD} patch-id ${"d".repeat(40)}` }],
  });
  runtime.computePatchId = () => PATCH_ID;
  const threw = await mergePr(baseOptions({ standingAuthorization: false }), runtime).catch((e) => e);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "merge_approval" && /no fresh mfittko approval on head/.test(f.reason)));
});

// mode: "record" (marked comment with its record), "forge" (marked comment, made-up id) or "typed" (hand-typed line while the hook key exists).
async function askApprovalRuntime({ mode }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-ask-merge-"));
  const env = { ...process.env, DEVLOOPS_APPROVAL_TEST_MODE: "1", DEVLOOPS_APPROVAL_DIR: path.join(dir, "approvals") };
  const text = buildApprovalQuestion({ repo: "mfittko/dev-loops", pr: 5, headSha: OLD_HEAD, patchId: PATCH_ID });
  const q = { question: text, options: [{ label: "Yes", description: "Approve this merge" }, { label: "No", description: "Do not merge" }], multiSelect: false };
  const approval = extractYesApproval({ tool_input: { questions: [q] }, tool_response: { answers: { [text]: "Yes" } } });
  // Every mode writes one record, so the hook key exists: a made-up id or a typed line is then refused. Without a key a reader passes the comment through.
  const written = writeApprovalRecord({ approval }, env);
  const body = mode === "typed" ? `approve merge ${OLD_HEAD} patch-id ${PATCH_ID}` : buildApprovalComment({ id: mode === "forge" ? "f".repeat(64) : written.id, headSha: OLD_HEAD, patchId: PATCH_ID });
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body }],
  });
  runtime.env = env;
  runtime.computePatchId = () => PATCH_ID;
  return runtime;
}

test("a hook-marked approval comment with its harness record approves an escalated merge (MERGE-ASK-APPROVAL)", async () => {
  const result = await mergePr(baseOptions({ standingAuthorization: false }), await askApprovalRuntime({ mode: "record" }));
  assert.equal(result.ok, true);
  assert.equal(result.approvalMatch, "patch_id");
});

for (const mode of ["forge", "typed"]) {
  test(`an approve-merge comment without a harness record fails closed with a recovery (${mode})`, async () => {
    const threw = await mergePr(baseOptions({ standingAuthorization: false }), await askApprovalRuntime({ mode })).catch((e) => e);
    for (const precondition of ["merge_approval", "size_budget_human_approval"]) {
      assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === precondition && /Recovery: ask the operator the approval question again/.test(f.reason)), precondition);
    }
  });
}

test("the base-moved refusal recovery asks the approval question again (MERGE-ASK-APPROVAL)", async () => {
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${OLD_HEAD} patch-id ${PATCH_ID}` }],
  });
  // The first id authorizes the merge; the refreshed id after the ADR step differs (the base moved).
  let calls = 0;
  runtime.computePatchId = () => (++calls === 1 ? PATCH_ID : "e".repeat(40));
  const threw = await mergePr(baseOptions({ standingAuthorization: false }), runtime).catch((e) => e);
  const reason = threw.mergePrFailure.failures.find((f) => f.precondition === "base_not_integrated").reason;
  assert.match(reason, /the base moved/);
  assert.match(reason, /ask the approval question again with the new head and patch-id/);
  assert.match(reason, /without the hook key/);
});

test("a patch-id marker is refused when the base is not contained (no patch-id computed)", async () => {
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${OLD_HEAD} patch-id ${PATCH_ID}` }],
  });
  runtime.isAncestor = () => false;
  runtime.computePatchId = () => { throw new Error("must not run"); };
  const threw = await mergePr(baseOptions({ standingAuthorization: false }), runtime).catch((e) => e);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "merge_approval"));
});

test("--check reports approvalMatch and the patch-id approve-merge line (AC4)", async () => {
  const matched = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${OLD_HEAD} patch-id ${PATCH_ID}` }],
  });
  matched.runtime.computePatchId = () => PATCH_ID;
  const hit = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: false }), matched.runtime);
  assert.equal(hit.approvalMatch, "patch_id");
  assert.equal(hit.approveMergeLine, `approve merge ${HEAD} patch-id ${PATCH_ID}`);
  const head = makeRuntime({ evidence: ESCALATED_EVIDENCE, comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }] });
  const bare = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: false }), head.runtime);
  assert.equal(bare.approvalMatch, "head");
  const none = makeRuntime({ evidence: ESCALATED_EVIDENCE });
  const missing = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: false }), none.runtime);
  assert.equal(missing.approvalMatch, null);
});

test("--check without an approver passes a drain PR under a standing authorization and names the path", async () => {
  const { runtime, calls } = makeRuntime();
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: undefined }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.mergeClass, "drain");
  assert.equal(result.approvalPath, "standing_authorization");
  assert.equal(result.approveMergeLine, null);
  assert.equal(result.approverAssumed, true);
  assert.equal(calls.runChild.length, 0);
});

test("--check is not ok when GitHub reports mergeStateStatus BLOCKED", async () => {
  const { runtime } = makeRuntime({ prView: { mergeStateStatus: "BLOCKED" } });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: undefined }), runtime);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.precondition === "merge_state_blocked"));
});

test("--check with unreadable gate evidence reports a null mergeClass and sizeClass and keeps the gate_evidence failure", async () => {
  const { runtime } = makeRuntime({ evidence: { ok: false, sizeOutcome: null, touchesT1: false, failures: ["gate evidence unreadable"] } });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko" }), runtime);
  assert.equal(result.mergeClass, null);
  assert.equal(result.sizeClass, null);
  assert.equal(result.approverAssumed, false);
  assert.ok(result.failures.some((f) => f.precondition === "gate_evidence"));
});

test("--check reports human_review when a head-pinned APPROVED review satisfies it", async () => {
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE, reviews: [{ user: { login: "mfittko" }, state: "APPROVED", commit_id: HEAD }] });
  const result = await mergePr(baseOptions({ check: true, standingAuthorization: false }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.approvalPath, "human_review");
});

test("a refused non-check run on the PR 2928 shape names escalated, the exact line and the size class", async () => {
  const { runtime, calls } = makeRuntime({ evidence: ESCALATED_EVIDENCE });
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), runtime); } catch (e) { threw = e; }
  const failure = threw.mergePrFailure;
  assert.equal(failure.mergeClass, "escalated");
  assert.equal(failure.approvalPath, "comment_marker");
  assert.equal(failure.approveMergeLine, `approve merge ${HEAD}`);
  assert.equal(failure.sizeClass, "escalate");
  assert.equal(mergeCalls(calls).length, 0);
});

test("a non-check run on the PR 2928 shape with a failing PR head fetch still names the approval line and size class", async () => {
  const { runtime, calls } = makeRuntime({ evidence: ESCALATED_EVIDENCE });
  runtime.fetchPrHead = () => { throw new Error("network down"); };
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), runtime); } catch (e) { threw = e; }
  const failure = threw.mergePrFailure;
  assert.equal(failure.failures[0].precondition, "base_not_integrated");
  assert.equal(failure.mergeClass, "escalated");
  assert.equal(failure.approvalPath, "comment_marker");
  assert.equal(failure.approveMergeLine, `approve merge ${HEAD}`);
  assert.equal(failure.sizeClass, "escalate");
  assert.equal(mergeCalls(calls).length, 0);
});

test("a non-check refusal with evidence for another head reports null sizeClass and mergeClass", async () => {
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE, evidenceHead: "b".repeat(40) });
  let threw = null;
  try { await mergePr(baseOptions({ standingAuthorization: false }), runtime); } catch (e) { threw = e; }
  const failure = threw.mergePrFailure;
  assert.ok(failure.failures.some((f) => f.precondition === "gate_evidence"));
  assert.equal(failure.sizeClass ?? null, null);
  assert.equal(failure.mergeClass, null);
});

test("main --check exits 0 and prints the JSON when preconditions fail", async () => {
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE });
  const out = captureStream();
  const code = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--check"], { ...runtime, stdout: out });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.get()).mergeClass, "escalated");
});

test("an APPROVED review followed by a later PENDING draft still passes the merge gate", async () => {
  const { runtime } = makeRuntime({
    evidence: ESCALATED_EVIDENCE,
    reviews: [
      { user: { login: "mfittko" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "mfittko" }, state: "PENDING", commit_id: HEAD },
    ],
  });
  const result = await mergePr(baseOptions({ standingAuthorization: false }), runtime);
  assert.equal(result.ok, true);
  assert.equal(result.approvalVia, "approved_review");
});

test("a merge posts a record comment naming approvalVia, approver and head, and no approve-merge line", async () => {
  for (const [via, runtimeArgs, options] of [
    ["standing_authorization", {}, {}],
    ["comment_marker", { evidence: ESCALATED_EVIDENCE, comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }] }, { standingAuthorization: false }],
  ]) {
    const { runtime, calls } = makeRuntime(runtimeArgs);
    await mergePr(baseOptions(options), runtime);
    assert.equal(calls.comments.length, 1);
    const body = calls.comments[0].body;
    assert.ok(body.includes(via) && body.includes("mfittko") && body.includes(HEAD), body);
    assert.ok(!/^\s*approve merge/im.test(body));
  }
});

test("a failing record comment never changes ok or merged", async () => {
  const { runtime } = makeRuntime();
  runtime.postMergeComment = async () => { throw new Error("comment api down"); };
  const stderr = captureStream();
  const result = await mergePr(baseOptions(), { ...runtime, stderr });
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.match(stderr.get(), /merge record comment failed: comment api down/);
});

test("a non-zero default record comment logs one stderr line and never changes ok or merged", async () => {
  const { runtime } = makeRuntime();
  const inner = runtime.runChild;
  runtime.runChild = async (cmd, args, env) => (args[0] === "pr" && args[1] === "comment" ? { stdout: "", stderr: "HTTP 403", code: 1 } : inner(cmd, args, env));
  delete runtime.postMergeComment;
  const stderr = captureStream();
  const result = await mergePr(baseOptions(), { ...runtime, stderr });
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(stderr.get().split("\n").filter((l) => l.includes("merge record comment failed")).length, 1);
  assert.match(stderr.get(), /merge record comment failed: HTTP 403/);
});

test("--check under humanMergeOnly reports a human_merge_only failure with the class and writes nothing; a non-check run still refuses", async () => {
  const { runtime, calls } = makeRuntime({ humanMergeOnly: true, evidence: ESCALATED_EVIDENCE });
  const result = await mergePr(baseOptions({ check: true, standingAuthorization: false }), runtime);
  assert.equal(result.ok, false);
  assert.equal(result.humanMergeOnly, true);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.approvalPath, "comment_marker");
  assert.ok(result.failures.some((f) => f.precondition === "human_merge_only"));
  assert.equal(calls.runChild.length, 0, "no merge or write under --check");
  assert.equal(calls.comments.length, 0);
  const refused = makeRuntime({ humanMergeOnly: true });
  const threw = await mergePr(baseOptions(), refused.runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.humanMergeOnly, true);
});

test("--check --stable-release with unreadable gate evidence keeps mergeClass escalated and nulls sizeClass", async () => {
  const { runtime } = makeRuntime({ evidence: { ok: false, sizeOutcome: null, touchesT1: false, failures: ["gate evidence unreadable"] } });
  const result = await mergePr(baseOptions({ check: true, stableRelease: true }), runtime);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.sizeClass, null);
});

test("--check nulls mergeClass and sizeClass when the evidence belongs to another head", async () => {
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE, evidenceHead: "b".repeat(40) });
  const result = await mergePr(baseOptions({ check: true }), runtime);
  assert.equal(result.mergeClass, null);
  assert.equal(result.sizeClass, null);
  assert.ok(result.failures.some((f) => f.precondition === "gate_evidence"));
});

test("--check with a stale standing ADR waiver reports adr_tripwire check_read_only and writes nothing", async () => {
  const { runtime, calls } = makeRuntime({ prView: { baseRefName: "main", body: "old" } });
  runtime.evaluateAdrTripwire = async () => STALE_BLOCK;
  let waived = false;
  runtime.waiveAdrTripwire = async () => { waived = true; return { ok: true, action: "waiver_written" }; };
  const result = await mergePr(baseOptions({ check: true }), runtime);
  const failure = result.failures.find((f) => f.precondition === "adr_tripwire");
  assert.ok(failure, JSON.stringify(result.failures));
  assert.match(failure.reason, /check_read_only/);
  assert.equal(waived, false);
  assert.equal(calls.runChild.length, 0, "no pr edit or merge");
});

test("--check reports a base fetch failure as one base_not_integrated failure instead of throwing", async () => {
  const { runtime } = makeRuntime({ prView: { baseRefName: "main", body: "b" } });
  runtime.fetchPrHead = () => { throw new Error("network down"); };
  const result = await mergePr(baseOptions({ check: true }), runtime);
  assert.equal(result.ok, false);
  assert.equal(result.failures.filter((f) => f.precondition === "base_not_integrated").length, 1);
});

test("a non-check mergePr without humanApprovedBy refuses on human_approver", async () => {
  const { runtime, calls } = makeRuntime();
  const threw = await mergePr(baseOptions({ humanApprovedBy: undefined }), runtime).catch((e) => e);
  assert.ok(threw.mergePrFailure.failures.some((f) => f.precondition === "human_approver"));
  assert.equal(mergeCalls(calls).length, 0);
});

test("--check without an approver does not match an approval by a real account named like the old placeholder", async () => {
  const { runtime } = makeRuntime({ evidence: ESCALATED_EVIDENCE, comments: [{ user: { login: "check-without-approver" }, body: `approve merge ${HEAD}` }] });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: undefined, standingAuthorization: false }), runtime);
  assert.equal(result.ok, false);
  assert.equal(result.approverAssumed, true);
  assert.equal(result.approvalPath, "comment_marker");
  assert.ok(result.failures.some((f) => f.precondition === "merge_approval"));
});

test("buildDetectEvidenceArgv adds --read-only only when asked", () => {
  assert.equal(buildDetectEvidenceArgv({ repo: "o/r", pr: 5, readOnly: true }).includes("--read-only"), true);
  assert.equal(buildDetectEvidenceArgv({ repo: "o/r", pr: 5 }).includes("--read-only"), false);
});

test("--check asks the detector for read-only evidence (no runner heartbeat write); a real run does not", async () => {
  const seen = [];
  for (const check of [true, false]) {
    const { runtime } = makeRuntime();
    const detect = runtime.detectEvidence;
    runtime.detectEvidence = async (opts) => { seen.push(opts.readOnly); return detect(opts); };
    await mergePr(baseOptions({ check, humanApprovedBy: "mfittko" }), runtime).catch(() => {});
  }
  assert.deepEqual(seen, [true, false]);
});

test("--check keeps the escalated class when the detector failed its size-approval gate (escalated, no approval)", async () => {
  const { runtime } = makeRuntime({ evidence: { ok: false, sizeOutcome: "escalate", touchesT1: false, failures: ["size-budget requires a human APPROVED review"] } });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: false }), runtime);
  assert.equal(result.mergeClass, "escalated");
  assert.equal(result.sizeClass, "escalate");
  assert.equal(result.approvalPath, "comment_marker");
});

test("--check fails closed on missing size facts: no confirmed class and no standing_authorization path", async () => {
  const { runtime } = makeRuntime({ evidence: { ok: true, sizeOutcome: null, touchesT1: null, failures: [] } });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko" }), runtime);
  assert.equal(result.mergeClass, null);
  assert.equal(result.approvalPath, null);
  assert.equal(result.approveMergeLine, null);
});

test("--check reports no class or path when the marker has a size outcome but no boolean T1 fact", async () => {
  for (const touchesT1 of [undefined, null]) {
    const { runtime } = makeRuntime({ evidence: { ok: true, sizeOutcome: "pass", touchesT1, failures: [] } });
    const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko", standingAuthorization: true }), runtime);
    assert.equal(result.mergeClass, null);
    assert.equal(result.approvalPath, null);
    assert.equal(result.approveMergeLine, null);
    assert.ok(result.failures.some((f) => f.precondition === "size_budget_human_approval"));
  }
});

test("the default merge record comment kills a hung gh child at the timeout bound", async () => {
  // A stub gh that hangs; the bound must kill it rather than leave it referenced.
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-hung-gh-"));
  const hungGh = join(dir, "gh");
  writeFileSync(hungGh, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  try {
    await assert.rejects(
      defaultPostMergeComment({ repo: "mfittko/dev-loops", pr: 5, body: "b", env: process.env, ghCommand: hungGh, runChild, timeoutMs: 200 }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 5000, "the child was killed at the bound, not awaited to completion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // An external signal death (code null, empty stderr, no timedOut) is not a timeout.
  await assert.rejects(
    defaultPostMergeComment({ repo: "mfittko/dev-loops", pr: 5, body: "b", env: process.env, ghCommand: "gh", runChild: async () => ({ code: null, stderr: "" }) }),
    /gh pr comment returned no result/,
  );
});

test("a PR carrying the spike no-merge marker is refused before any merge (ADR 0293)", async () => {
  const { runtime, calls } = makeRuntime({ prView: { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" } });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.match(threw.message, /spike size exemption/u);
  assert.equal(threw.mergePrFailure.failures[0].precondition, "spike_pr");
  assert.equal(threw.mergePrFailure.ok, false);
  assert.equal(calls.runChild.length, 0);
});

test("main --check on a spike-marked PR exits 0 with the check-shaped spike_pr failure and no merge call", async () => {
  const { runtime, calls } = makeRuntime({ prView: { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" } });
  const out = captureStream();
  const code = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--check"], { ...runtime, stdout: out });
  assert.equal(code, 0);
  const result = JSON.parse(out.get());
  assert.equal(result.ok, false);
  assert.equal(result.check, true);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].precondition, "spike_pr");
  assert.equal(calls.runChild.length, 0);
});

const RUN = (databaseId, status, conclusion) => ({ databaseId, status, conclusion });
const runListCalls = (calls) => calls.ghJson.filter((a) => a[0] === "run" && a[1] === "list");
// Scripts the run-list reads (each entry is a runs array or an Error); the last entry repeats. A fake clock advances with each sleep.
function withRunReads(reads, { intervalMs = 10, timeoutMs = 1000, ...runtimeOptions } = {}) {
  const { runtime, calls } = makeRuntime(runtimeOptions);
  const base = runtime.ghJson;
  const queue = [...reads];
  const timeouts = [];
  runtime.ghJson = async (args, opts) => {
    if (args[0] === "run" && args[1] === "list") {
      calls.ghJson.push(args);
      timeouts.push(opts?.timeoutMs);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }
    return base(args);
  };
  let clock = 0;
  const sleeps = [];
  runtime.now = () => clock;
  runtime.sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  runtime.gateEvidenceWait = { intervalMs, timeoutMs };
  return { runtime, calls, sleeps, timeouts };
}

test("gate_evidence_run waits for an in-progress run that then succeeds, one run list per poll", async () => {
  const { runtime, calls, sleeps } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "queued", null)], [RUN(2, "completed", "success")]]);
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.equal(runListCalls(calls).length, 3);
  assert.deepEqual(sleeps, [10, 10]);
  assert.deepEqual(runListCalls(calls)[0].slice(0, 9), ["run", "list", "--repo", "mfittko/dev-loops", "--workflow", "gate-evidence.yml", "--commit", HEAD, "--limit"]);
  assert.equal(runListCalls(calls)[0][9], "100");
});

test("gate_evidence_run reads the PR view again after a wait and takes the wait before the other reads", async () => {
  const { runtime, calls } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "success")]]);
  await mergePr(baseOptions(), runtime);
  const order = calls.ghJson.map((a) => (a[0] === "run" ? "run" : a[0] === "pr" ? "view" : "other"));
  assert.deepEqual(order.slice(0, 4), ["view", "run", "run", "view"]);
});

test("gate_evidence_run ignores a cancelled run newer than a success", async () => {
  const { runtime, calls } = withRunReads([[RUN(9, "completed", "cancelled"), RUN(8, "completed", "success")]]);
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.equal(runListCalls(calls).length, 1);
});

test("gate_evidence_run passes when every run is cancelled (branch protection still guards the status at merge)", async () => {
  const { runtime } = withRunReads([[RUN(9, "completed", "cancelled"), RUN(8, "completed", "cancelled")]]);
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
});

test("gate_evidence_run decides by the highest run id among completed runs", async () => {
  const { runtime } = withRunReads([[RUN(5, "completed", "success"), RUN(6, "completed", "failure")]]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), /gate_evidence_run \(.*run 6 /);
});

test("gate_evidence_run waits while any run is active, even next to a completed failure", async () => {
  const { runtime, sleeps } = withRunReads([[RUN(6, "completed", "failure"), RUN(7, "queued", null)], [RUN(6, "completed", "failure"), RUN(7, "completed", "success")]]);
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
  assert.deepEqual(sleeps, [10]);

  // An older run 6 is active while the newer run 7 already failed: the wait still happens, then run 7 refuses.
  const older = withRunReads([[RUN(6, "in_progress", null), RUN(7, "completed", "failure")], [RUN(6, "completed", "success"), RUN(7, "completed", "failure")]]);
  await assert.rejects(() => mergePr(baseOptions(), older.runtime), /gate_evidence_run \(.*run 7 /);
  assert.deepEqual(older.sleeps, [10]);
});

test("gate_evidence_run treats a repo without the workflow (HTTP 404) as not applicable", async () => {
  const { runtime } = withRunReads([Object.assign(new Error("gh run list failed: HTTP 404: workflow gate-evidence.yml not found on the default branch"), { code: "GH_API_ERROR" })]);
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
});

test("gate_evidence_run fails closed on a generic HTTP 404", async () => {
  const { runtime } = withRunReads([Object.assign(new Error("gh run list failed: HTTP 404: Not Found"), { code: "GH_API_ERROR" })]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), /HTTP 404: Not Found/);
});

test("gate_evidence_run passes a failed run when the gate-evidence status is success", async () => {
  const { runtime } = withRunReads([[RUN(7, "completed", "failure")]], { prView: { statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS", context: "gate-evidence" }] } });
  const result = await mergePr(baseOptions(), runtime);
  assert.equal(result.merged, true);
});

const OK_ROLLUP = { status: "COMPLETED", conclusion: "SUCCESS" };
const gateStatus = (state) => ({ state, context: "gate-evidence" });
const RECONCILE_CMD = "dev-loops-run --repo-root <checkout> scripts/github/reconcile-gate-evidence-status.mjs --repo mfittko/dev-loops --pr 5";
const PR_VIEW_FIELDS = "headRefOid";
const isPrView = (args) => args[0] === "pr" && args[1] === "view" && String(args[args.length - 1]).includes(PR_VIEW_FIELDS);
// Replaces the Nth (1-based) primary PR view with `patch`, so a test can move the head, the body or the status between reads.
function withViewPatches(runtime, patches) {
  const base = runtime.ghJson;
  let views = 0;
  runtime.ghJson = async (args) => {
    const result = await base(args);
    if (!isPrView(args)) return result;
    views += 1;
    return patches[views] ? { ...result, ...patches[views] } : result;
  };
}
// The refusal's reason and its `recovery` field must carry the same recovery text.
function assertRecovery(error, { reasonPattern, recoveryPattern }) {
  const failure = error.mergePrFailure;
  assert.equal(failure.failures[0].precondition, "gate_evidence_run");
  assert.match(failure.failures[0].reason, reasonPattern);
  assert.match(failure.recovery, recoveryPattern);
  assert.ok(failure.failures[0].reason.endsWith(failure.recovery), "the reason ends with the recovery text");
  return true;
}

test("gate_evidence_run refuses a failed run when the gate-evidence status is not success", async () => {
  const { runtime } = withRunReads([[RUN(7, "completed", "failure")]], { prView: { statusCheckRollup: [OK_ROLLUP, gateStatus("FAILURE")] } });
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.match(error.message, /gate_evidence_run \(.*run 7 /);
    return assertRecovery(error, { reasonPattern: /run 7 .*completed as failure/, recoveryPattern: /reconcile-gate-evidence-status\.mjs/ });
  });
});

test("gate_evidence_run refuses when the head changed during the wait and writes one stderr line", async () => {
  const { runtime } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "success")]]);
  withViewPatches(runtime, { 2: { headRefOid: "f".repeat(40) } });
  let written = "";
  runtime.stderr = { write: (chunk) => { written += chunk; } };
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.match(error.message, /gate_evidence_run \(the head changed from .* while waiting/);
    return assertRecovery(error, { reasonPattern: /the head changed from/, recoveryPattern: /^call merge-pr again to re-gate the new head$/ });
  });
  assert.equal(written.split("\n").filter(Boolean).length, 1);
  assert.match(written, /run 2/);
});

test("gate_evidence_run fails closed on any other gh error and on a non-array payload", async () => {
  const boom = withRunReads([Object.assign(new Error("gh run list failed: HTTP 502"), { code: "GH_API_ERROR" })]);
  await assert.rejects(() => mergePr(baseOptions(), boom.runtime), /HTTP 502/);
  assert.equal(mergeCalls(boom.calls).length, 0);
  const odd = withRunReads([{ runs: [] }]);
  await assert.rejects(() => mergePr(baseOptions(), odd.runtime), /non-array/);
});

test("gate_evidence_run refuses a failed run with the exact reconcile command and the fail-closed exit", async () => {
  const { runtime, calls } = withRunReads([[RUN(1, "completed", "success"), RUN(77, "completed", "failure")]], { prView: { statusCheckRollup: [OK_ROLLUP, gateStatus("FAILURE")] } });
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.match(error.message, /gate_evidence_run \(.*run 77.*completed as failure.*reconcile-gate-evidence-status\.mjs --repo mfittko\/dev-loops --pr \d+.*call merge-pr again/);
    assert.doesNotMatch(error.message, /gh run rerun|edit the/);
    assert.ok(error.mergePrFailure.recovery.includes(`run \`${RECONCILE_CMD}\``));
    return assertRecovery(error, { reasonPattern: /run 77/, recoveryPattern: /evidence-not-satisfied-fail-closed, run merge-pr with --check and fix the other failures it lists/ });
  });
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run names a rerun of a plainly failed run when the head has no gate-evidence status", async () => {
  const { runtime, calls } = withRunReads([[RUN(77, "completed", "failure")]]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.doesNotMatch(error.message, /reconcile-gate-evidence-status/);
    return assertRecovery(error, { reasonPattern: /run 77.*failure/, recoveryPattern: /^rerun it with `gh run rerun 77 --repo mfittko\/dev-loops`, then call merge-pr again/ });
  });
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run names the lost-run recovery, never a rerun, for a startup_failure run without a gate-evidence status", async () => {
  const { runtime, calls } = withRunReads([[RUN(77, "completed", "startup_failure")]]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.doesNotMatch(error.message, /gh run rerun|reconcile-gate-evidence-status/);
    return assertRecovery(error, { reasonPattern: /run 77.*startup_failure/, recoveryPattern: /^the run cannot be rerun, so start a new run with a gate-verdict event for the head.*lost-run recovery.*, then call merge-pr again/ });
  });
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run names the run approval for public-fork runs and the lost-run recovery otherwise for an action_required run", async () => {
  const { runtime } = withRunReads([[RUN(78, "completed", "action_required")]]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => assertRecovery(error, { reasonPattern: /run 78.*action_required/, recoveryPattern: /^approve a public-fork run with `gh api -X POST repos\/mfittko\/dev-loops\/actions\/runs\/78\/approve`, or otherwise start a new run with a gate-verdict event.*lost-run recovery/ }));
});

test("gate_evidence_run merges with a newest skipped or neutral run", async () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const { runtime } = withRunReads([[RUN(3, "completed", "failure"), RUN(4, "completed", conclusion)]]);
    assert.equal((await mergePr(baseOptions(), runtime)).merged, true, conclusion);
  }
});

test("gate_evidence_run refuses a first-read timeout with no known run and the recovery to call again", async () => {
  const { runtime, calls } = withRunReads([Object.assign(new Error("gh run list failed: timed out after 5000ms"), { code: "GH_TIMEOUT" })]);
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => assertRecovery(error, { reasonPattern: /the Gate evidence run read for head .* timed out after \d+s; call merge-pr again$/, recoveryPattern: /^call merge-pr again$/ }));
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run stops waiting when the next poll would start after the deadline, even with read latency", async () => {
  const { runtime, sleeps } = withRunReads([[RUN(9, "in_progress", null)]], { intervalMs: 10, timeoutMs: 35 });
  // Each read takes 4 ms: polls start at 0, 14 and 28; the poll at 28 ends at 32, and 32 + 10 > 35 refuses without a third sleep.
  let latency = 0;
  const now = runtime.now;
  runtime.now = () => now() + latency;
  const list = runtime.ghJson;
  runtime.ghJson = async (args, opts) => {
    const result = await list(args, opts);
    if (args[0] === "run" && args[1] === "list") latency += 4;
    return result;
  };
  await assert.rejects(() => mergePr(baseOptions(), runtime), /run 9 .*still in_progress/);
  assert.deepEqual(sleeps, [10, 10]);
});

test("gate_evidence_run judges a failed run against a status read after the run list, in both directions", async () => {
  // A stale success before the list does not clear a run that failed and posted failure after the first view.
  const stale = withRunReads([[RUN(7, "completed", "failure")]], { prView: { statusCheckRollup: [OK_ROLLUP, gateStatus("SUCCESS")] } });
  withViewPatches(stale.runtime, { 2: { statusCheckRollup: [OK_ROLLUP, gateStatus("FAILURE")] } });
  await assert.rejects(() => mergePr(baseOptions(), stale.runtime), /gate_evidence_run \(.*run 7 /);
  assert.equal(mergeCalls(stale.calls).length, 0);
  // A reconcile rerun that posted success after the first view clears the refusal.
  const fresh = withRunReads([[RUN(7, "completed", "failure")]], { prView: { statusCheckRollup: [OK_ROLLUP, gateStatus("FAILURE")] } });
  withViewPatches(fresh.runtime, { 2: { statusCheckRollup: [OK_ROLLUP, gateStatus("SUCCESS")] } });
  assert.equal((await mergePr(baseOptions(), fresh.runtime)).merged, true);
});

test("gate_evidence_run keeps a changed-head refusal when a failed run meets a success status", async () => {
  // Waited: the run fails after the wait, the head moved and the new head's status is success.
  const waited = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "failure")]]);
  withViewPatches(waited.runtime, { 2: { headRefOid: "f".repeat(40), statusCheckRollup: [OK_ROLLUP, gateStatus("SUCCESS")] } });
  await assert.rejects(() => mergePr(baseOptions(), waited.runtime), (error) => assertRecovery(error, { reasonPattern: /the head changed from .* while waiting/, recoveryPattern: /re-gate the new head/ }));
  assert.equal(mergeCalls(waited.calls).length, 0);
  // No wait: the failed run alone triggers the re-read, and the moved head still refuses.
  const direct = withRunReads([[RUN(7, "completed", "failure")]]);
  withViewPatches(direct.runtime, { 2: { headRefOid: "f".repeat(40), statusCheckRollup: [OK_ROLLUP, gateStatus("SUCCESS")] } });
  await assert.rejects(() => mergePr(baseOptions(), direct.runtime), (error) => assertRecovery(error, { reasonPattern: /the head changed from .* while reading the Gate evidence run/, recoveryPattern: /re-gate the new head/ }));
  assert.equal(mergeCalls(direct.calls).length, 0);
});

test("gate_evidence_run refuses on a wall-clock timeout without suggesting a rerun of the active run", async () => {
  const { runtime, calls } = withRunReads([[RUN(88, "in_progress", null)]], { intervalMs: 10, timeoutMs: 30 });
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => {
    assert.match(error.message, /gate_evidence_run \(.*run 88.*still in_progress after 0s?; wait for it to complete, then call merge-pr again/);
    assert.doesNotMatch(error.message, /gh run rerun/);
    return assertRecovery(error, { reasonPattern: /run 88 .*in_progress after/, recoveryPattern: /^wait for it to complete, then call merge-pr again$/ });
  });
  assert.equal(runListCalls(calls).length, 4);
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run waits with the shipped 15 s interval and refuses after the shipped 540 s deadline", async () => {
  const { runtime, calls, sleeps, timeouts } = withRunReads([[RUN(9, "in_progress", null)]]);
  runtime.gateEvidenceWait = {};
  await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => assertRecovery(error, { reasonPattern: /run 9 .*still in_progress after 540s/, recoveryPattern: /wait for it to complete/ }));
  assert.equal(sleeps.length, 36);
  assert.ok(sleeps.every((ms) => ms === 15_000));
  assert.equal(runListCalls(calls).length, 37);
  // Each read is bounded by the remaining deadline; the last poll starts at the deadline and keeps a usable bound.
  assert.equal(timeouts[0], 540_000);
  assert.equal(timeouts[35], 15_000);
  assert.equal(timeouts[36], 5_000);
});

test("gate_evidence_run re-checks the spike marker after the PR re-read of a failed run without a wait", async () => {
  const { runtime, calls } = withRunReads([[RUN(7, "completed", "failure")]]);
  withViewPatches(runtime, { 2: { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" } });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.failures[0].precondition, "spike_pr");
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run kills a hung gh run list at the remaining deadline and refuses with the last active run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-pr-hung-run-list-"));
  const hungGh = path.join(dir, "gh");
  await writeFile(hungGh, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  try {
    const { runtime, calls } = makeRuntime();
    const base = runtime.ghJson;
    let polls = 0;
    runtime.ghJson = async (args, opts) => {
      if (args[0] === "run" && args[1] === "list") {
        polls += 1;
        calls.ghJson.push(args);
        if (polls === 1) return [RUN(66, "in_progress", null)];
        return defaultGhJson(args, { ...opts, ghCommand: hungGh, runChild: undefined, env: process.env });
      }
      return base(args, opts);
    };
    runtime.sleep = async () => {};
    runtime.gateEvidenceWait = { intervalMs: 1, timeoutMs: 400 };
    const started = Date.now();
    await assert.rejects(() => mergePr(baseOptions(), runtime), (error) => assertRecovery(error, { reasonPattern: /the Gate evidence run read for head .* timed out after \d+s \(last active run 66\)/, recoveryPattern: /^wait for it to complete/ }));
    assert.ok(Date.now() - started < 5000, "the hung child was killed at the deadline");
    assert.equal(mergeCalls(calls).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gate_evidence_run checks the spike marker again after a wait and never merges", async () => {
  const { runtime, calls } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "success")]]);
  withViewPatches(runtime, { 2: { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" } });
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.failures[0].precondition, "spike_pr");
  assert.equal(mergeCalls(calls).length, 0);
});

test("gate_evidence_run loads the merge policy again after a wait and refuses a humanMergeOnly set during it", async () => {
  const { runtime, calls } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "success")]]);
  const base = runtime.loadConfig;
  let loads = 0;
  runtime.loadConfig = async (arg) => {
    loads += 1;
    const config = await base(arg);
    return loads === 1 ? config : { ...config, config: { ...config.config, autonomy: { humanMergeOnly: true } } };
  };
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.humanMergeOnly, true);
  assert.equal(loads, 2);
  assert.equal(mergeCalls(calls).length, 0);
  // A config that becomes invalid during the wait refuses too.
  const bad = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "success")]]);
  let badLoads = 0;
  const badBase = bad.runtime.loadConfig;
  bad.runtime.loadConfig = async (arg) => { badLoads += 1; return badLoads === 1 ? badBase(arg) : { config: {}, errors: ["broken"] }; };
  const badThrew = await mergePr(baseOptions(), bad.runtime).catch((e) => e);
  assert.equal(badThrew.mergePrFailure.configError, true);
  assert.equal(mergeCalls(bad.calls).length, 0);
});

test("gate_evidence_run loads the merge policy again after a run read with no wait and refuses a humanMergeOnly set during it", async () => {
  const { runtime, calls } = withRunReads([[RUN(2, "completed", "success")]]);
  const base = runtime.loadConfig;
  let loads = 0;
  runtime.loadConfig = async (arg) => {
    loads += 1;
    const config = await base(arg);
    return loads === 1 ? config : { ...config, config: { ...config.config, autonomy: { humanMergeOnly: true } } };
  };
  const threw = await mergePr(baseOptions(), runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.humanMergeOnly, true);
  assert.equal(loads, 2);
  assert.equal(mergeCalls(calls).length, 0);
});

test("a spike PR refuses at spike_pr before the config checks, under humanMergeOnly and with a config error", async () => {
  const spike = { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" };
  const human = makeRuntime({ humanMergeOnly: true, prView: spike });
  const threw = await mergePr(baseOptions(), human.runtime).catch((e) => e);
  assert.equal(threw.mergePrFailure.failures[0].precondition, "spike_pr");
  assert.equal(threw.mergePrFailure.humanMergeOnly, undefined);
  const broken = makeRuntime({ prView: spike });
  broken.runtime.loadConfig = async () => ({ config: {}, errors: ["broken"] });
  const result = await mergePr(baseOptions({ check: true }), broken.runtime);
  assert.equal(result.check, true);
  assert.equal(result.failures[0].precondition, "spike_pr");
  const real = await mergePr(baseOptions(), broken.runtime).catch((e) => e);
  assert.equal(real.mergePrFailure.failures[0].precondition, "spike_pr");
});

test("main writes the gate_evidence_run refusal JSON as the last stderr line after a wait line", async () => {
  const { runtime } = withRunReads([[RUN(2, "in_progress", null)], [RUN(2, "completed", "failure")]], { prView: { statusCheckRollup: [OK_ROLLUP, gateStatus("FAILURE")] } });
  const err = captureStream();
  runtime.stderr = err;
  const code = await main(["--repo", "mfittko/dev-loops", "--pr", "5", "--human-approved-by", "mfittko", "--standing-authorization"], { ...runtime, stdout: captureStream() });
  assert.notEqual(code, 0);
  const lines = err.get().split("\n").filter(Boolean);
  assert.match(lines[0], /^merge-pr: waiting for Gate evidence run 2/);
  const refusal = JSON.parse(lines[lines.length - 1]);
  assert.equal(refusal.failures[0].precondition, "gate_evidence_run");
  assert.ok(refusal.failures[0].reason.endsWith(refusal.recovery));
});

test("gate_evidence_run keeps a run with a missing status active until the timeout", async () => {
  const { runtime } = withRunReads([[{ databaseId: 3, conclusion: null }]], { intervalMs: 10, timeoutMs: 20 });
  await assert.rejects(() => mergePr(baseOptions(), runtime), /run 3 .*is still an unknown status/);
});

test("--check reads the runs once, never sleeps, and collects an active run with the other failures", async () => {
  const { runtime, calls, sleeps } = withRunReads([[RUN(5, "in_progress", null)]]);
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko" }), runtime);
  assert.equal(result.check, true);
  assert.equal(result.ok, false);
  assert.deepEqual(sleeps, []);
  assert.equal(runListCalls(calls).length, 1);
  assert.ok(result.failures.some((f) => f.precondition === "gate_evidence_run" && /run 5 .*in_progress/.test(f.reason)));
  assert.ok("mergeClass" in result && "approvalPath" in result && "sizeClass" in result);
});

test("--check collects a failed run as a gate_evidence_run entry", async () => {
  const { runtime } = withRunReads([[RUN(6, "completed", "failure")]]);
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko" }), runtime);
  assert.ok(result.failures.some((f) => f.precondition === "gate_evidence_run" && /run 6 .*failure/.test(f.reason)));
});

test("--check returns spike_pr alone when the PR re-read of a failed run finds the spike marker", async () => {
  const { runtime, calls } = withRunReads([[RUN(7, "completed", "failure")]]);
  withViewPatches(runtime, { 2: { body: "spike\n\n<!-- dev-loops:spike-pr no-merge -->\n" } });
  const result = await mergePr(baseOptions({ check: true, humanApprovedBy: "mfittko" }), runtime);
  assert.equal(result.check, true);
  assert.deepEqual(result.failures.map((f) => f.precondition), ["spike_pr"]);
  assert.equal(mergeCalls(calls).length, 0);
});

// ghJson maps a null exit code to GH_TIMEOUT only when the spawn timer killed the child; any other signal death keeps its stderr in GH_API_ERROR.
test("ghJson reports GH_TIMEOUT only for the spawn timer's kill, not for other signal deaths or a plain failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ghjson-signal-"));
  const stub = async (name, body) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  // Only the hung stub needs the short bound; the self-exiting stubs get a generous one so a slow start cannot trip the timer.
  const run = (ghCommand, timeoutMs = 10000) => defaultGhJson(["run", "list"], { ghCommand, env: process.env, label: "gh run list", timeoutMs }).catch((e) => e);
  try {
    assert.equal((await run(await stub("hung", "exec sleep 30"), 300)).code, "GH_TIMEOUT");
    const forms = { sigterm: ["kill -TERM $$", "killed-by-term"], sigkill: ["kill -KILL $$", "killed-by-kill"], exit1: ["exit 1", "plain-failure"] };
    for (const [name, [action, text]] of Object.entries(forms)) {
      const error = await run(await stub(name, `echo ${text} >&2\n${action}`));
      assert.equal(error.code, "GH_API_ERROR", name);
      assert.match(error.message, new RegExp(`gh run list failed: ${text}`), name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
