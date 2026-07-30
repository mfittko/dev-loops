import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { main, parseCliArgs, runCli } from "../../scripts/github/withdraw-copilot-review-request.mjs";
import { interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";

function collectingStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.text = () => chunks.join("");
  return stream;
}

// gh stub driven by argv shape: the requested-reviewers probe, the PR view, and
// the DELETE. Records every call so a test can assert the DELETE did or did not
// fire — the difference between withdrawing and merely reporting.
function ghStub({ copilotRequested, reviews, threads, removeFails = false, removeIsNoop = false } = {}) {
  const calls = [];
  // Payload shapes are the REAL ones gh emits: `gh pr view --json` has no
  // reviewThreads field (threads come from the GraphQL connection), so a stub
  // that invents one hides a tool that cannot run at all.
  let requested = Boolean(copilotRequested);
  return {
    calls,
    get requested() {
      return requested;
    },
    runChild: async (_cmd, argv) => {
      calls.push(argv);
      if (argv.includes("--remove-reviewer")) {
        if (removeFails) return { code: 1, stdout: "", stderr: "gh: not authorized" };
        if (!removeIsNoop) requested = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("graphql")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: { nodes: threads ?? [] } } } },
          }),
          stderr: "",
        };
      }
      if (argv.some((a) => typeof a === "string" && a.includes("requested_reviewers"))) {
        return {
          code: 0,
          stdout: JSON.stringify({ users: requested ? [{ login: "copilot-pull-request-reviewer[bot]" }] : [], teams: [] }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ reviews: reviews ?? [], headRefOid: "abc123" }),
        stderr: "",
      };
    },
  };
}

const SUBMITTED_COPILOT_REVIEW = [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED" }];

describe("withdraw-copilot-review-request", () => {
  describe("argument parsing", () => {
    it("requires --repo and --pr", () => {
      assert.throws(() => parseCliArgs(["--pr", "10"]), /--repo is required/);
      assert.throws(() => parseCliArgs(["--repo", "o/n"]), /--pr is required/);
    });

    it("rejects a malformed repo slug at the parse surface", () => {
      assert.throws(() => parseCliArgs(["--repo", "no-slash", "--pr", "10"]), /--repo must match/);
    });
  });

  describe("guards (each one is what makes the withdrawal safe)", () => {
    it("no-ops when no Copilot request is pending", async () => {
      const gh = ghStub({ copilotRequested: false, reviews: SUBMITTED_COPILOT_REVIEW });
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
      assert.equal(result.ok, true);
      assert.equal(result.status, "not-requested");
      assert.equal(result.withdrawn, false);
      assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "must not remove the reviewer");
    });

    it("REFUSES when Copilot never submitted a review — withdrawing would skip the first review", async () => {
      const gh = ghStub({ copilotRequested: true, reviews: [] });
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
      assert.equal(result.ok, false);
      assert.equal(result.status, "refused");
      assert.match(result.reason, /no prior review to fall back on/);
      assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "must not remove the reviewer");
    });

    it("counts a thread with no isResolved field as unresolved — unknown must not read as clean", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: SUBMITTED_COPILOT_REVIEW,
        threads: [{ id: "t1", comments: { nodes: [] } }],
      });
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
      assert.equal(result.status, "refused");
    });

    it("REFUSES while unresolved threads remain", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: SUBMITTED_COPILOT_REVIEW,
        threads: [{ id: "t1", isResolved: false, comments: { nodes: [] } }, { id: "t2", isResolved: true, comments: { nodes: [] } }],
      });
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
      assert.equal(result.ok, false);
      assert.equal(result.status, "refused");
      assert.match(result.reason, /1 unresolved review thread/);
      assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "must not remove the reviewer");
    });

    it("a PENDING Copilot review does not count as a submitted prior review", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: [{ author: { login: "Copilot" }, state: "PENDING" }],
      });
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
      assert.equal(result.status, "refused");
    });

    it("an unknown or missing review state is not a submitted review either — states are whitelisted", async () => {
      for (const state of [undefined, null, "", "pending", "WEIRD_NEW_STATE"]) {
        const gh = ghStub({
          copilotRequested: true,
          reviews: [{ author: { login: "Copilot" }, state }],
        });
        const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild });
        assert.equal(result.status, "refused", `state ${JSON.stringify(state)} must not count as submitted`);
      }
    });

    it("accepts every real submitted state", async () => {
      for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]) {
        const gh = ghStub({
          copilotRequested: true,
          reviews: [{ author: { login: "Copilot" }, state }],
          threads: [],
        });
        const result = await main({ repo: "o/n", pr: 10, dryRun: true }, { env: {}, runChild: gh.runChild });
        assert.equal(result.status, "dry-run", `state ${state} should count as submitted`);
      }
    });
  });

  describe("the stranded-request case this exists for", () => {
    it("withdraws when a request is pending, a prior review exists, and threads are clean", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: SUBMITTED_COPILOT_REVIEW,
        threads: [{ id: "t1", isResolved: true, comments: { nodes: [] } }],
      });
      const result = await main({ repo: "o/n", pr: 10, reason: "Copilot declined a converged reword" }, { env: {}, runChild: gh.runChild });
      assert.equal(result.ok, true);
      assert.equal(result.withdrawn, true);
      assert.equal(result.status, "withdrawn");
      assert.equal(result.operatorReason, "Copilot declined a converged reword");
      const removal = gh.calls.find((argv) => argv.includes("--remove-reviewer"));
      assert.ok(removal, "expected the removal to fire");
      // gh resolves the Copilot identity; hard-coding a login here is what
      // silently deletes nothing (the real one is the [bot] form).
      assert.ok(removal.includes("@copilot"));
      assert.equal(gh.requested, false);
    });

    it("--dry-run reports the guards hold without issuing the DELETE", async () => {
      const gh = ghStub({ copilotRequested: true, reviews: SUBMITTED_COPILOT_REVIEW, threads: [] });
      const result = await main({ repo: "o/n", pr: 10, dryRun: true }, { env: {}, runChild: gh.runChild });
      assert.equal(result.status, "dry-run");
      assert.equal(result.withdrawn, false);
      assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "dry-run must not remove the reviewer");
    });

    it("surfaces a failing removal as an error rather than reporting success", async () => {
      const gh = ghStub({ copilotRequested: true, reviews: SUBMITTED_COPILOT_REVIEW, threads: [], removeFails: true });
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild }),
        /gh command failed/,
      );
    });

    it("refuses to claim success when the removal succeeded but the request is still pending", async () => {
      // A wrong reviewer identity exits 0 and removes nothing. Without the
      // post-verify re-read the operator would be told the deadlock is cleared
      // while the PR stays stuck — the one lie this tool must never tell.
      const gh = ghStub({ copilotRequested: true, reviews: SUBMITTED_COPILOT_REVIEW, threads: [], removeIsNoop: true });
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild }),
        /still pending after/,
      );
    });
  });

  describe("gh failures must never read as \"nothing is stranded\"", () => {
    // The inverse of the post-verify lie: if the tool never saw the PR, the
    // operator must not be told the deadlock is absent.
    it("raises when gh exits non-zero rather than reporting not-requested", async () => {
      const runChild = async () => ({ code: 1, stdout: "", stderr: "HTTP 403: rate limit exceeded" });
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild }),
        /gh command failed/,
      );
    });

    it("raises when gh returns something that is not JSON", async () => {
      const runChild = async () => ({ code: 0, stdout: "<html>502 Bad Gateway</html>", stderr: "" });
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild }),
        /Invalid JSON from gh/,
      );
    });
  });

  describe("CLI surface", () => {
    it("rejects an unknown flag — a typo'd --dry-runn must not perform a real withdrawal", () => {
      // parseArgs runs with strict:false, so this throw is the only thing
      // standing between a mistyped dry run and a live state change.
      assert.throws(
        () => parseCliArgs(["--repo", "o/n", "--pr", "10", "--dry-runn"]),
        /Unknown flag/,
      );
    });

    it("rejects a stray positional", () => {
      assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "10", "oops"]), /Unexpected argument/);
    });

    it("a usage error exits 1 and --help exits 0", async () => {
      const prevExitCode = process.exitCode;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--repo", "no-slash", "--pr", "10"], { stdout, stderr, env: {}, runChild: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
      assert.equal(process.exitCode, 1);

      const helpOut = collectingStream();
      await runCli(["--help"], { stdout: helpOut, stderr, env: {}, runChild: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
      assert.equal(process.exitCode, 0);
      assert.match(helpOut.text(), /Withdraw a STRANDED Copilot review request/);
      process.exitCode = prevExitCode;
    });

    it("a refusal exits 1, so a hook cannot mistake it for a completed withdrawal", async () => {
      const prevExitCode = process.exitCode;
      const gh = ghStub({ copilotRequested: true, reviews: [] });
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--repo", "o/n", "--pr", "10"], { stdout, stderr, env: {}, runChild: gh.runChild });
      assert.equal(process.exitCode, 1);
      process.exitCode = prevExitCode;
    });

    it("a successful withdrawal exits 0 and prints the result", async () => {
      const prevExitCode = process.exitCode;
      const gh = ghStub({ copilotRequested: true, reviews: SUBMITTED_COPILOT_REVIEW, threads: [] });
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--repo", "o/n", "--pr", "10"], { stdout, stderr, env: {}, runChild: gh.runChild });
      assert.equal(process.exitCode, 0);
      assert.equal(JSON.parse(stdout.text()).status, "withdrawn");
      process.exitCode = prevExitCode;
    });
  });

  // The tool's justification lives in OTHER modules: withdrawing only helps if
  // the loop then routes to the gate. Pin that interaction in both directions,
  // so the header's promise and its stated limit are executable fact rather
  // than prose that can drift (it has already been misdescribed once).
  describe("the gate interaction this tool depends on", () => {
    const snapshot = ({ copilotReviewRequestStatus, copilotReviewOnCurrentHead }) => ({
      prExists: true,
      prNumber: 17,
      prDraft: false,
      copilotReviewRequestStatus,
      copilotReviewPresent: true,
      copilotReviewOnCurrentHead,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      copilotReviewRoundCount: 1,
      ciStatus: "success",
    });

    const gateAllowsPreApproval = (snap) => {
      const interpretation = interpretLoopState(snap, { maxCopilotRounds: 5 });
      const result = evaluatePrGateCoordination({
        pr: 17,
        currentHeadSha: "29aa40b7deadbeef",
        prDraft: false,
        lifecycleState: interpretation.state,
        sameHeadCleanConverged: interpretation.sameHeadCleanConverged,
        ciStatus: snap.ciStatus,
        copilotReviewRequestStatus: snap.copilotReviewRequestStatus,
        unresolvedThreadCount: snap.unresolvedThreadCount,
        copilotReviewRoundCount: snap.copilotReviewRoundCount,
        maxCopilotRounds: 5,
        draftGate: { visible: true, headSha: "29aa40b7", verdict: "clean" },
        draftGateMarker: { visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true },
        preApprovalGate: { visible: false },
        preApprovalGateMarker: { visible: false },
      });
      return !result.forbiddenActions.includes("run_pre_approval_gate");
    };

    it("with Copilot's review on the CURRENT head, withdrawing turns a forbidden gate into a legal one", () => {
      const before = snapshot({ copilotReviewRequestStatus: "requested", copilotReviewOnCurrentHead: true });
      const after = snapshot({ copilotReviewRequestStatus: "none", copilotReviewOnCurrentHead: true });
      assert.equal(gateAllowsPreApproval(before), false, "pending request should block the gate");
      assert.equal(gateAllowsPreApproval(after), true, "withdrawal should let same-head clean convergence open it");
    });

    it("with the head ADVANCED past that review, withdrawing does not open the gate — the documented limit", () => {
      const before = snapshot({ copilotReviewRequestStatus: "requested", copilotReviewOnCurrentHead: false });
      const after = snapshot({ copilotReviewRequestStatus: "none", copilotReviewOnCurrentHead: false });
      assert.equal(gateAllowsPreApproval(before), false);
      assert.equal(gateAllowsPreApproval(after), false, "a head past its review must stay blocked, withdrawal or not");
    });
  });
});
