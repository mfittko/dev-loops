import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, parseCliArgs, parseItemNumber, runCli } from "../../scripts/projects/sync-item-status.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

// Collect everything written to a stream into a string buffer.
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
// command must still exit 0.
function failingRunChild() {
  return async () => ({ code: 1, stdout: "", stderr: "gh: authentication required" });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("sync-item-status", () => {
  describe("argument parsing", () => {
    it("requires --repo", async () => {
      await assert.rejects(
        () => main({ item: "10", toColumn: "In Progress" }, { runChild: failingRunChild() }),
        /--repo is required/,
      );
    });

    it("requires --item", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", toColumn: "In Progress" }, { runChild: failingRunChild() }),
        /--item is required/,
      );
    });

    it("requires --to-column", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "10" }, { runChild: failingRunChild() }),
        /--to-column is required/,
      );
    });

    it("rejects a non-numeric item", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "not-a-number", toColumn: "In Progress" }, { runChild: failingRunChild() }),
        /--item must be a positive integer/,
      );
    });

    it("rejects a node-id item (numbers only)", () => {
      assert.throws(() => parseItemNumber("PVTI_42"), /--item must be a positive integer/);
    });

    it("rejects zero / negative item", () => {
      assert.throws(() => parseItemNumber("0"), /--item must be a positive integer/);
      assert.throws(() => parseItemNumber("-3"), /--item must be a positive integer/);
    });

    it("rejects an invalid repo slug", async () => {
      await assert.rejects(
        () => main({ repo: "no-slash", item: "10", toColumn: "Done" }, { runChild: failingRunChild() }),
        /--repo must be exactly owner\/name/,
      );
    });

    it("rejects a boolean flag given an inline value (--help=foo)", () => {
      assert.throws(() => parseCliArgs(["--help=foo"]), /Unknown flag: --help=foo/);
    });

    it("rejects an unexpected positional argument", () => {
      assert.throws(() => parseCliArgs(["stray", "--repo", "o/n"]), /Unexpected argument: stray/);
    });

    it("parses required flags into the canonical shape", () => {
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--item", "10", "--to-column", "In Progress"]);
      assert.equal(args.repo, "mfittko/dev-loops");
      assert.equal(args.item, "10");
      assert.equal(args.toColumn, "In Progress");
    });
  });

  describe("best-effort / exit-0 contract", () => {
    it("returns a skipped result when the board is not configured (no .devloops)", async () => {
      // cwd has no .devloops → syncBoardStatus skips without any gh call.
      const result = await main(
        { repo: "mfittko/dev-loops", item: "10", toColumn: "In Progress" },
        { runChild: failingRunChild(), cwd: "/nonexistent-repo-root-for-sync-test", env: {} },
      );
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "board not configured");
    });

    it("stays best-effort when a configured board's gh call fails (fail-open)", async () => {
      // Drive the REAL gh-failure → fail-open path: configure a board in
      // .devloops so syncBoardStatus proceeds past the "board not configured"
      // early-return, then stub gh to fail. The result must be a skipped
      // fail-open (NOT the "board not configured" skip), and exit code stays 0.
      const tempDir = mkdtempSync(path.join(tmpdir(), "sync-item-status-"));
      try {
        writeFileSync(
          path.join(tempDir, ".devloops"),
          "version: 1\nqueue:\n  projectNumber: 3\n",
          "utf8",
        );
        const result = await main(
          { repo: "mfittko/dev-loops", item: "10", toColumn: "Done" },
          { runChild: failingRunChild(), cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        // Must NOT be the not-configured skip — the gh failure was reached.
        assert.notEqual(result.reason, "board not configured");
        assert.match(result.reason, /gh api graphql failed|authentication required/);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("runCli exits 1 with stderr usage on an argument error", async () => {
      const prevExitCode = process.exitCode;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(
        ["--repo", "mfittko/dev-loops", "--item", "not-a-number", "--to-column", "Done"],
        { stdout, stderr, env: {}, cwd: "/nonexistent-repo-root-for-sync-test" },
      );
      assert.equal(process.exitCode, 1);
      assert.match(stderr.text(), /--item must be a positive integer/);
      assert.equal(stdout.text(), "");
      process.exitCode = prevExitCode;
    });

    it("--help prints usage to stdout without exiting non-zero", async () => {
      const prevExitCode = process.exitCode;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--help"], { stdout, stderr, env: {} });
      assert.match(stdout.text(), /dev-loops project sync-status/);
      assert.equal(process.exitCode ?? 0, prevExitCode ?? 0);
    });
  });
});
