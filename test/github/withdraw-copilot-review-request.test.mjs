import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, parseCliArgs, runCli } from "../../scripts/github/withdraw-copilot-review-request.mjs";
import { interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";
import { readSuppressionMarker } from "../../scripts/loop/_post-convergence-review-suppression.mjs";
import { resolvePostConvergenceReviewSuppressed } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";

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

// gh stub driven by argv shape: the requested-reviewers probe, the PR view, the
// compare (head-advanced classification), and the DELETE. Records every call so
// a test can assert the DELETE did or did not fire — the difference between
// withdrawing and merely reporting. Defaults every review's commit to the
// default `headRefOid` ("currentsha"), i.e. the same-head case, unless a test
// overrides either.
function ghStub({ copilotRequested, reviews, threads, headRefOid = "currentsha", compare, removeFails = false, removeIsNoop = false } = {}) {
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
      if (argv.some((a) => typeof a === "string" && a.includes("/compare/"))) {
        if (!compare) return { code: 1, stdout: "", stderr: "compare not stubbed" };
        return { code: 0, stdout: JSON.stringify(compare), stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ headRefOid, reviews: reviews ?? [] }),
        stderr: "",
      };
    },
  };
}

const SUBMITTED_COPILOT_REVIEW = [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "currentsha" } }];
// Head-advanced fixture: Copilot's only submitted review is on an OLDER head
// ("oldsha"), not the current one — the sibling shape #1441 covers.
const SUBMITTED_COPILOT_REVIEW_OLD_HEAD = [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "oldsha" } }];

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
          reviews: [{ author: { login: "Copilot" }, state, commit: { oid: "currentsha" } }],
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
      // Stubbed delayImpl keeps this fast: the request stays pending on every
      // attempt, so the helper exhausts the full bounded retry window.
      const gh = ghStub({ copilotRequested: true, reviews: SUBMITTED_COPILOT_REVIEW, threads: [], removeIsNoop: true });
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild, delayImpl: async () => {} }),
        /still pending after/,
      );
    });
  });

  // Race regressions on the post-verify read, mirroring
  // test/github/request-copilot-review.test.mjs: the requested-reviewers read
  // that confirms a `gh pr edit --remove-reviewer` landed is eventually
  // consistent, so it is retried on the same bounded backoff the request path
  // uses. A custom runChild scripts the exact requested_reviewers response
  // sequence (the before-state check, then the initial post-edit read, then
  // one entry per bounded retry) independent of the removal call itself, so
  // each test pins the exact race it exercises.
  describe("the post-verify read race (mirrors request-copilot-review.mjs)", () => {
    function raceRunChild(requestedReviewersSequence) {
      const calls = [];
      let index = 0;
      const runChild = async (_cmd, argv) => {
        calls.push(argv);
        if (argv.some((a) => typeof a === "string" && a.includes("requested_reviewers"))) {
          const step = requestedReviewersSequence[index];
          index += 1;
          if (!step) throw new Error("raceRunChild: requested_reviewers read beyond scripted sequence");
          if (step.throws) {
            return { code: 1, stdout: "", stderr: step.message };
          }
          return {
            code: 0,
            stdout: JSON.stringify({ users: step.requested ? [{ login: "copilot-pull-request-reviewer[bot]" }] : [], teams: [] }),
            stderr: "",
          };
        }
        if (argv.includes("--remove-reviewer")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv.includes("graphql")) {
          return {
            code: 0,
            stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
            stderr: "",
          };
        }
        return { code: 0, stdout: JSON.stringify({ headRefOid: "currentsha", reviews: SUBMITTED_COPILOT_REVIEW }), stderr: "" };
      };
      return { calls, runChild };
    }

    it("verification succeeds on a later attempt after an empty-then-populated race", async () => {
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check: request is pending
        { requested: true }, // initial post-edit read: still stale
        { requested: false }, // retry read: the removal has now landed
      ]);
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl });
      assert.equal(result.status, "withdrawn");
      assert.deepEqual(delayCalls, [5000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });

    it("a throwing read consumes a delay and a later read succeeds", async () => {
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check
        { requested: true }, // initial post-edit read: stale
        { throws: true, message: "rate limited" }, // attempt 0: transient gh failure
        { requested: false }, // attempt 1: recovers, removal confirmed
      ]);
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl });
      assert.equal(result.status, "withdrawn");
      assert.deepEqual(delayCalls, [5000, 10000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });

    it("fails closed with the byte-identical exhaustion message when every bounded retry stays pending", async () => {
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check
        { requested: true }, // initial post-edit read
        { requested: true }, // attempt 0
        { requested: true }, // attempt 1
        { requested: true }, // attempt 2
      ]);
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl }),
        (error) => {
          // Exact match, not a substring: this is a claimed byte-identical
          // contract with pre-retry-loop behavior, so any drift must fail.
          assert.equal(
            error.message,
            "Copilot review request is still pending after gh pr edit --remove-reviewer; nothing was withdrawn.",
          );
          return true;
        },
      );
      assert.deepEqual(delayCalls, [5000, 10000, 15000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });

    it("recovers when the INITIAL post-edit read throws and a later read succeeds", async () => {
      // The initial post-edit read sits inside the retry window: a throw there
      // consumes the first scheduled delay and re-probes instead of
      // propagating, so a transient blip immediately after a successful
      // removal self-heals. This also pins the fail-closed `stillRequested`
      // initializer — an initial throw never touches `stillRequested`, so it
      // must start `true` for the loop below to run at all.
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check
        { throws: true, message: "rate limited (initial read)" }, // initial post-edit read: throws
        { requested: false }, // attempt 0: recovers, removal confirmed
      ]);
      const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl });
      assert.equal(result.status, "withdrawn");
      assert.deepEqual(delayCalls, [5000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });

    it("fails closed with the byte-identical exhaustion message when a mid-window throw recovers into a still-pending read", async () => {
      // Mixed window: a non-final attempt throws, later attempts succeed but
      // stay pending. The recovery clears the recorded read error, so
      // exhaustion yields the generic still-pending message, never the stale
      // mid-window error.
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check
        { requested: true }, // initial post-edit read: stale
        { throws: true, message: "rate limited (attempt 1)" }, // attempt 0: throws mid-window
        { requested: true }, // attempt 1: recovers but still pending
        { requested: true }, // attempt 2: still pending
      ]);
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl }),
        (error) => {
          assert.equal(
            error.message,
            "Copilot review request is still pending after gh pr edit --remove-reviewer; nothing was withdrawn.",
          );
          return true;
        },
      );
      assert.deepEqual(delayCalls, [5000, 10000, 15000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });

    it("propagates the final attempt's raw read error when every bounded retry read throws", async () => {
      const delayCalls = [];
      const delayImpl = async (ms) => {
        delayCalls.push(ms);
      };
      const { calls, runChild } = raceRunChild([
        { requested: true }, // before-state check
        { requested: true }, // initial post-edit read: stale, not a throw
        { throws: true, message: "rate limited (attempt 1)" },
        { throws: true, message: "rate limited (attempt 2)" },
        { throws: true, message: "rate limited (attempt 3, final)" },
      ]);
      await assert.rejects(
        () => main({ repo: "o/n", pr: 10 }, { env: {}, runChild, delayImpl }),
        (error) => {
          assert.equal(error.message, "gh command failed: rate limited (attempt 3, final)");
          return true;
        },
      );
      assert.deepEqual(delayCalls, [5000, 10000, 15000]);
      assert.equal(calls.filter((argv) => argv.includes("--remove-reviewer")).length, 1);
    });
  });

  // The sibling shape #1441 covers: the loop converged, its threads were
  // reply-resolved on a NEW head, so Copilot's submitted review is no longer on
  // the current head. Withdrawing alone would just make the loop re-request and
  // strand again — eligible only when the delta since that review is provably
  // docs-only, and on success it writes the suppression marker
  // request-copilot-review.mjs reads to avoid re-requesting on this exact head.
  describe("the head-advanced case (#1441)", () => {
    async function withTempCheckpointDir(fn) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "withdraw-suppression-"));
      try {
        await fn(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it("withdraws and records a suppression marker when the delta since Copilot's last review is provably docs-only", async () => {
      await withTempCheckpointDir(async (checkpointDir) => {
        const gh = ghStub({
          copilotRequested: true,
          headRefOid: "newsha",
          reviews: SUBMITTED_COPILOT_REVIEW_OLD_HEAD,
          threads: [],
          compare: { status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }] },
        });
        const result = await main(
          { repo: "o/n", pr: 10, reason: "Copilot declined a converged reword on the new head" },
          { env: {}, runChild: gh.runChild, checkpointDir },
        );
        assert.equal(result.ok, true);
        assert.equal(result.withdrawn, true);
        assert.equal(result.status, "withdrawn");
        assert.equal(result.headAdvanced, true);
        assert.match(result.reason, /pure doc\/prose bump/);
        assert.equal(gh.requested, false);

        const marker = await readSuppressionMarker({ repo: "o/n", pr: 10 }, { checkpointDir });
        assert.ok(marker, "expected a suppression marker to be written");
        assert.equal(marker.headSha, "newsha");
        assert.equal(marker.lastReviewedHeadSha, "oldsha");
        assert.equal(marker.operatorReason, "Copilot declined a converged reword on the new head");
      });
    });

    it("refuses when the delta touches Copilot's review surface (a code file) — never widens what counts as docs-only", async () => {
      await withTempCheckpointDir(async (checkpointDir) => {
        const gh = ghStub({
          copilotRequested: true,
          headRefOid: "newsha",
          reviews: SUBMITTED_COPILOT_REVIEW_OLD_HEAD,
          threads: [],
          compare: { status: "ahead", files: [{ filename: "src/foo.mjs", status: "modified" }] },
        });
        const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild, checkpointDir });
        assert.equal(result.ok, false);
        assert.equal(result.status, "refused");
        assert.match(result.reason, /not provably a pure doc\/prose bump/);
        assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "must not remove the reviewer");
        assert.equal(await readSuppressionMarker({ repo: "o/n", pr: 10 }, { checkpointDir }), null);
      });
    });

    it("refuses when commit SHA data is unavailable rather than guessing", async () => {
      await withTempCheckpointDir(async (checkpointDir) => {
        const gh = ghStub({
          copilotRequested: true,
          headRefOid: "newsha",
          reviews: [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED" }],
          threads: [],
        });
        const result = await main({ repo: "o/n", pr: 10 }, { env: {}, runChild: gh.runChild, checkpointDir });
        assert.equal(result.status, "refused");
        assert.match(result.reason, /commit SHA data is unavailable/);
        assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "must not remove the reviewer");
      });
    });

    it("--dry-run reports headAdvanced without removing the reviewer or writing the marker", async () => {
      await withTempCheckpointDir(async (checkpointDir) => {
        const gh = ghStub({
          copilotRequested: true,
          headRefOid: "newsha",
          reviews: SUBMITTED_COPILOT_REVIEW_OLD_HEAD,
          threads: [],
          compare: { status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }] },
        });
        const result = await main({ repo: "o/n", pr: 10, dryRun: true }, { env: {}, runChild: gh.runChild, checkpointDir });
        assert.equal(result.status, "dry-run");
        assert.equal(result.headAdvanced, true);
        assert.ok(!gh.calls.some((argv) => argv.includes("--remove-reviewer")), "dry-run must not remove the reviewer");
        assert.equal(await readSuppressionMarker({ repo: "o/n", pr: 10 }, { checkpointDir }), null);
      });
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

    const gateAllowsPreApproval = (snap, { postConvergenceReviewSuppressed = false } = {}) => {
      const interpretation = interpretLoopState(snap, { maxCopilotRounds: 5 });
      const result = evaluatePrGateCoordination({
        pr: 17,
        currentHeadSha: "29aa40b7deadbeef",
        prDraft: false,
        lifecycleState: interpretation.state,
        sameHeadCleanConverged: interpretation.sameHeadCleanConverged,
        postConvergenceReviewSuppressed,
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

    it("with the head ADVANCED past that review, a plain withdrawal alone does not open the gate", () => {
      const before = snapshot({ copilotReviewRequestStatus: "requested", copilotReviewOnCurrentHead: false });
      const after = snapshot({ copilotReviewRequestStatus: "none", copilotReviewOnCurrentHead: false });
      assert.equal(gateAllowsPreApproval(before), false);
      assert.equal(gateAllowsPreApproval(after), false, "a head past its review stays blocked without the explicit suppression signal");
    });

    it("with the head ADVANCED past that review AND an operator-authorized suppression, the gate now accepts it (#1441)", () => {
      const after = snapshot({ copilotReviewRequestStatus: "none", copilotReviewOnCurrentHead: false });
      assert.equal(
        gateAllowsPreApproval(after, { postConvergenceReviewSuppressed: true }),
        true,
        "the gate coordinator must accept the head-advanced case once the caller has verified the explicit withdrawal",
      );
    });
  });

  // Definition of done (#1441): reproduce the deadlock end-to-end — a converged
  // loop, a trivial reword pushed to a new head, and a force-rerequest that
  // stranded the pre_approval_gate verdict — and prove the extended withdrawal
  // resolves it via the REAL withdraw tool, the REAL marker it writes, and the
  // REAL gate coordinator, not hand-asserted booleans.
  describe("the deadlock this issue closes end-to-end", () => {
    it("a stranded head-advanced request blocks the gate; the extended withdrawal resolves it", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "withdraw-e2e-"));
      try {
        // Step 1: reproduce the deadlock. The loop converged at "oldsha", its
        // threads were reply-resolved on a NEW head ("newsha"), and a forced
        // re-request left Copilot's review request stranded there — Copilot
        // will not re-engage a change it effectively already approved.
        const stranded = {
          prExists: true,
          prNumber: 17,
          prDraft: false,
          copilotReviewRequestStatus: "requested",
          copilotReviewPresent: true,
          copilotReviewOnCurrentHead: false,
          unresolvedThreadCount: 0,
          actionableThreadCount: 0,
          copilotReviewRoundCount: 1,
          ciStatus: "success",
        };
        const blockedInterpretation = interpretLoopState(stranded, { maxCopilotRounds: 5 });
        const blockedResult = evaluatePrGateCoordination({
          pr: 17,
          currentHeadSha: "newsha",
          prDraft: false,
          lifecycleState: blockedInterpretation.state,
          sameHeadCleanConverged: blockedInterpretation.sameHeadCleanConverged,
          ciStatus: stranded.ciStatus,
          copilotReviewRequestStatus: stranded.copilotReviewRequestStatus,
          unresolvedThreadCount: stranded.unresolvedThreadCount,
          copilotReviewRoundCount: stranded.copilotReviewRoundCount,
          maxCopilotRounds: 5,
          draftGate: { visible: true, headSha: "newsha", verdict: "clean" },
          draftGateMarker: { visible: true, headSha: "newsha", verdict: "clean", contractComplete: true },
          preApprovalGate: { visible: false },
          preApprovalGateMarker: { visible: false },
        });
        assert.ok(
          blockedResult.forbiddenActions.includes("run_pre_approval_gate"),
          "the pre_approval_gate verdict must be blocked while the stranded request is pending",
        );

        // Step 2: run the REAL withdraw tool against the head-advanced, provably
        // docs-only scenario (the reply-resolve commit was a trivial reword).
        const gh = ghStub({
          copilotRequested: true,
          headRefOid: "newsha",
          reviews: SUBMITTED_COPILOT_REVIEW_OLD_HEAD,
          threads: [],
          compare: { status: "ahead", files: [{ filename: "docs/adr-0041.md", status: "modified" }] },
        });
        const withdrawal = await main(
          { repo: "o/n", pr: 17, reason: "Copilot declined the converged reword" },
          { env: {}, runChild: gh.runChild, checkpointDir: dir },
        );
        assert.equal(withdrawal.status, "withdrawn");
        assert.equal(withdrawal.headAdvanced, true);

        // Step 3: the REAL marker the withdrawal wrote is what a caller reads to
        // compute postConvergenceReviewSuppressed — not a hand-asserted boolean.
        const marker = await readSuppressionMarker({ repo: "o/n", pr: 17 }, { checkpointDir: dir });
        assert.ok(marker);
        assert.equal(marker.headSha, "newsha");

        // Step 4: run the REAL producer, resolvePostConvergenceReviewSuppressed —
        // marker/head match, live compare re-verification (a stubbed
        // repos/o/n/compare/oldsha...newsha reply), and the
        // copilotReviewRequestStatus === "none" && unresolvedThreadCount === 0
        // precondition — end to end, then feed its return into the gate
        // coordinator. No hand-computed boolean.
        const postConvergenceReviewSuppressed = await resolvePostConvergenceReviewSuppressed(
          {
            repo: "o/n",
            pr: 17,
            currentHeadSha: "newsha",
            snapshot: { copilotReviewRequestStatus: "none", unresolvedThreadCount: 0 },
            prData: { headRefOid: "newsha", reviews: SUBMITTED_COPILOT_REVIEW_OLD_HEAD },
          },
          { env: {}, runChild: gh.runChild, checkpointDir: dir },
        );
        assert.equal(postConvergenceReviewSuppressed, true);

        const settled = { ...stranded, copilotReviewRequestStatus: "none" };
        const settledInterpretation = interpretLoopState(settled, { maxCopilotRounds: 5 });
        const settledResult = evaluatePrGateCoordination({
          pr: 17,
          currentHeadSha: marker.headSha,
          prDraft: false,
          lifecycleState: settledInterpretation.state,
          sameHeadCleanConverged: settledInterpretation.sameHeadCleanConverged,
          postConvergenceReviewSuppressed,
          ciStatus: settled.ciStatus,
          copilotReviewRequestStatus: settled.copilotReviewRequestStatus,
          unresolvedThreadCount: settled.unresolvedThreadCount,
          copilotReviewRoundCount: settled.copilotReviewRoundCount,
          maxCopilotRounds: 5,
          draftGate: { visible: true, headSha: "newsha", verdict: "clean" },
          draftGateMarker: { visible: true, headSha: "newsha", verdict: "clean", contractComplete: true },
          preApprovalGate: { visible: false },
          preApprovalGateMarker: { visible: false },
        });
        assert.ok(
          !settledResult.forbiddenActions.includes("run_pre_approval_gate"),
          "the extended withdrawal must resolve the deadlock: pre_approval_gate is now legal",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
