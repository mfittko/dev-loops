import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, parseCliArgs, runCli } from "../../scripts/github/post-merge-board-sync.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

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

// gh runChild stub that always reports the gh CLI failing. syncBoardStatus
// wraps such failures in its fail-open contract (skipped + reason), so the
// command must still exit 0 — this is the merge-must-never-fail contract.
function failingRunChild() {
  return async () => ({ code: 1, stdout: "", stderr: "gh: authentication required" });
}

async function withBoardConfig(fn, { devloops = "version: 1\nqueue:\n  board:\n    number: 3\n" } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "post-merge-board-sync-"));
  try {
    writeFileSync(path.join(tempDir, ".devloops"), devloops, "utf8");
    // Async + awaited: rmSync must not fire until fn's whole async body has
    // settled, not at its first `await` (a sync `return fn(tempDir)` in a
    // try/finally deletes the fixture out from under any await inside fn).
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Stub syncBoardStatus that records every call's (repo, cwd, itemNumber,
// targetColumn) so success-path tests can assert the CLI's own glue logic
// (--issue-vs-PR target selection, Done-column resolution) reaches the core,
// without needing a real/stubbed gh call.
function recordingSyncBoardStatus(calls) {
  return async (repo, repoRoot, itemNumber, targetColumn) => {
    calls.push({ repo, repoRoot, itemNumber, targetColumn });
    return { ok: true, skipped: false, result: { item: { newColumn: targetColumn } } };
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("post-merge-board-sync", () => {
  describe("argument parsing", () => {
    it("requires --repo", () => {
      assert.throws(() => parseCliArgs(["--pr", "10"]), /--repo is required/);
    });

    it("requires --pr", () => {
      assert.throws(() => parseCliArgs(["--repo", "mfittko/dev-loops"]), /--pr is required/);
    });

    it("--help does not require --repo/--pr", () => {
      const args = parseCliArgs(["--help"]);
      assert.equal(args.help, true);
    });

    it("parses --repo/--pr/--issue into the canonical shape", () => {
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--issue", "42"]);
      assert.equal(args.repo, "mfittko/dev-loops");
      assert.equal(args.pr, 10);
      assert.equal(args.issue, 42);
    });

    it("rejects a non-numeric --pr", () => {
      assert.throws(() => parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "nope"]), /--pr must be a positive integer/);
    });

    it("rejects an invalid repo slug at the CLI/parse surface (usage error, not a best-effort no-op)", () => {
      // Drives the CLI surface (parseCliArgs), not main() directly: a
      // malformed --repo must be a usage error (exit 1) caught before
      // runCli's best-effort catch-all, not a silent {ok:true,skipped:true}.
      assert.throws(() => parseCliArgs(["--repo", "no-slash", "--pr", "10"]), /--repo must match/);
    });

    it("runCli exits 1 (not the best-effort exit 0) on an invalid --repo slug", async () => {
      const prevExitCode = process.exitCode;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--repo", "no-slash", "--pr", "10"], { stdout, stderr, env: {}, cwd: "/nonexistent" });
      assert.equal(process.exitCode, 1);
      assert.match(stderr.text(), /--repo must match/);
      assert.equal(stdout.text(), "");
      process.exitCode = prevExitCode;
    });

    it("treats an empty --issue as omitted (documented PR-is-the-queue-item case), not a usage error", () => {
      // e.g. an unfilled `<linked-issue>` template substitution producing
      // `--issue ""` must not abort the rest of the post-merge hook.
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--issue", ""]);
      assert.equal(args.issue, undefined);
      assert.equal(args.pr, 10);
    });

    it("treats a bare --issue with no value at all as omitted, same as --issue \"\"", () => {
      // The shell result of `--issue <linked-issue>` when the substitution is
      // dropped entirely rather than quoted-empty.
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--issue"]);
      assert.equal(args.issue, undefined);
      assert.equal(args.pr, 10);
    });
  });

  describe("success path (board move actually happens)", () => {
    // These tests stub syncBoardStatus itself (the seam main() now accepts,
    // mirroring scripts/github/ready-for-review.mjs's syncBoardStatus
    // override), rather than gh's runChild, so a real move is observable
    // without needing a real/stubbed gh call. Mutating `args.issue ?? args.pr`
    // to `args.pr`, or the resolved Done column to `undefined`, fails these
    // assertions.
    it("targets the issue number (not the PR number) when --issue is given, moving it to the configured Done column", async () => {
      await withBoardConfig(async (tempDir) => {
        const calls = [];
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10, issue: 42 },
          { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, false);
        assert.equal(result.result.item.newColumn, "Done");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].repo, "mfittko/dev-loops");
        assert.equal(calls[0].itemNumber, 42);
        assert.equal(calls[0].targetColumn, "Done");
      });
    });

    it("targets the PR number when --issue is omitted", async () => {
      await withBoardConfig(async (tempDir) => {
        const calls = [];
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10 },
          { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
        );
        assert.equal(result.skipped, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].itemNumber, 10);
        assert.equal(calls[0].targetColumn, "Done");
      });
    });

    it("resolves a renamed Done column from queue.statusColumns (a board that renamed Done still converges)", async () => {
      await withBoardConfig(
        async (tempDir) => {
          const calls = [];
          const result = await main(
            { repo: "mfittko/dev-loops", pr: 10, issue: 42 },
            { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
          );
          assert.equal(result.skipped, false);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].targetColumn, "Merged");
        },
        { devloops: "version: 1\nqueue:\n  board:\n    number: 3\n  statusColumns:\n    done: Merged\n" },
      );
    });

    it("runCli reports skipped:false and exit 0 with no stderr warning on a successful move", async () => {
      const prevExitCode = process.exitCode;
      await withBoardConfig(async (tempDir) => {
        const stdout = collectingStream();
        const stderr = collectingStream();
        await runCli(
          ["--repo", "mfittko/dev-loops", "--pr", "10", "--issue", "42"],
          { stdout, stderr, env: {}, cwd: tempDir, syncBoardStatus: recordingSyncBoardStatus([]) },
        );
        assert.equal(process.exitCode, 0);
        assert.equal(stderr.text(), "");
        const parsed = JSON.parse(stdout.text());
        assert.equal(parsed.ok, true);
        assert.equal(parsed.skipped, false);
        assert.equal(parsed.result.item.newColumn, "Done");
      });
      process.exitCode = prevExitCode;
    });
  });

  describe("best-effort / exit-0 contract (a board failure must never fail the merge)", () => {
    it("returns a skipped result when the board is not configured (no .devloops)", async () => {
      const result = await main(
        { repo: "mfittko/dev-loops", pr: 10, issue: 42 },
        { runChild: failingRunChild(), cwd: "/nonexistent-repo-root-for-post-merge-test", env: {} },
      );
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "board not configured");
    });

    it("targets the issue when --issue is given, moving it to the configured Done column", async () => {
      await withBoardConfig(async (tempDir) => {
        const calls = [];
        const runChild = async (cmd, args, env) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr: "gh: authentication required" };
        };
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10, issue: 42 },
          { runChild, cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        // Reached the real gh call (not the "board not configured" early-out).
        assert.notEqual(result.reason, "board not configured");
        // The GraphQL owner-lookup call carries the repo owner login — proves
        // syncBoardStatus was actually invoked on this configured board.
        assert.ok(calls.some((a) => a.some((v) => typeof v === "string" && v.includes("mfittko"))));
      });
    });

    it("falls back to the PR number when --issue is omitted", async () => {
      await withBoardConfig(async (tempDir) => {
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10 },
          { runChild: failingRunChild(), cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        assert.match(result.reason, /gh api graphql failed|authentication required/);
      });
    });

    it("stays best-effort on a configured board's gh failure (fail-open)", async () => {
      await withBoardConfig(async (tempDir) => {
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10, issue: 42 },
          { runChild: failingRunChild(), cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        assert.notEqual(result.reason, "board not configured");
        assert.match(result.reason, /gh api graphql failed|authentication required/);
      });
    });

    it("surfaces a config read/parse error the same best-effort way", async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "post-merge-board-sync-badcfg-"));
      try {
        writeFileSync(path.join(tempDir, ".devloops"), "not: [valid: yaml", "utf8");
        const result = await main(
          { repo: "mfittko/dev-loops", pr: 10 },
          { runChild: failingRunChild(), cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        assert.match(result.reason, /config read\/parse error/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runCli always exits 0 on a parsed command, even on gh failure, and logs a stderr warning", async () => {
      const prevExitCode = process.exitCode;
      await withBoardConfig(async (tempDir) => {
        const stdout = collectingStream();
        const stderr = collectingStream();
        await runCli(
          ["--repo", "mfittko/dev-loops", "--pr", "10", "--issue", "42"],
          { stdout, stderr, env: {}, cwd: tempDir, runChild: failingRunChild() },
        );
        assert.equal(process.exitCode, 0);
        assert.match(stderr.text(), /\[post-merge-board-sync\] no-op for PR #10 \/ issue #42/);
        const parsed = JSON.parse(stdout.text());
        assert.equal(parsed.ok, true);
      });
      process.exitCode = prevExitCode;
    });

    it("runCli exits 1 with stderr usage on an argument error", async () => {
      const prevExitCode = process.exitCode;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--repo", "mfittko/dev-loops"], { stdout, stderr, env: {}, cwd: "/nonexistent" });
      assert.equal(process.exitCode, 1);
      assert.match(stderr.text(), /--pr is required/);
      assert.equal(stdout.text(), "");
      process.exitCode = prevExitCode;
    });

    it("--help prints usage to stdout and forces exit 0", async () => {
      const prevExitCode = process.exitCode;
      process.exitCode = 7;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--help"], { stdout, stderr, env: {} });
      assert.match(stdout.text(), /post-merge-board-sync\.mjs/);
      assert.equal(process.exitCode, 0);
      process.exitCode = prevExitCode;
    });
  });
});
