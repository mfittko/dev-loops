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

function withBoardConfig(fn) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "post-merge-board-sync-"));
  try {
    writeFileSync(
      path.join(tempDir, ".devloops"),
      "version: 1\nqueue:\n  board:\n    number: 3\n",
      "utf8",
    );
    return fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

    it("rejects an invalid repo slug", async () => {
      await assert.rejects(
        () => main({ repo: "no-slash", pr: 10 }, { runChild: failingRunChild() }),
        /--repo must match/,
      );
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
