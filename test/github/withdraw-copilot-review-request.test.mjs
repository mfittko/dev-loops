import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { main, parseCliArgs, runCli } from "../../scripts/github/withdraw-copilot-review-request.mjs";

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
  // Models the real transition: `gh pr edit --remove-reviewer` clears the
  // pending request, so the post-verify re-read must observe it gone. With
  // removeIsNoop the command "succeeds" while the request stays — the exact
  // shape a wrong reviewer identity produces, which must NOT report success.
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
      if (argv.some((a) => typeof a === "string" && a.includes("requested_reviewers"))) {
        return {
          code: 0,
          stdout: JSON.stringify({ users: requested ? [{ login: "copilot-pull-request-reviewer[bot]" }] : [], teams: [] }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ reviews: reviews ?? [], reviewThreads: threads ?? [], headRefOid: "abc123" }),
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

    it("REFUSES while unresolved threads remain", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: SUBMITTED_COPILOT_REVIEW,
        threads: [{ isResolved: false }, { isResolved: true }],
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
  });

  describe("the stranded-request case this exists for", () => {
    it("withdraws when a request is pending, a prior review exists, and threads are clean", async () => {
      const gh = ghStub({
        copilotRequested: true,
        reviews: SUBMITTED_COPILOT_REVIEW,
        threads: [{ isResolved: true }],
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

  describe("CLI surface", () => {
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
});
