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

async function withBoardConfig(fn, { devloops = "version: 1\nqueue:\n  board:\n    number: 3\n" } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "sync-item-status-board-"));
  try {
    writeFileSync(path.join(tempDir, ".devloops"), devloops, "utf8");
    // Async + awaited: rmSync must not fire until fn's whole async body has
    // settled, not at its first `await`.
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Stub syncBoardStatus that records every call's (repo, cwd, itemNumber,
// targetColumn) so success-path tests can assert the CLI's own glue logic
// (--item-vs---pr target selection, logical-column resolution) reaches the
// core, without needing a real/stubbed gh call.
function recordingSyncBoardStatus(calls) {
  return async (repo, repoRoot, itemNumber, targetColumn) => {
    calls.push({ repo, repoRoot, itemNumber, targetColumn });
    return { ok: true, skipped: false, result: { item: { newColumn: targetColumn } } };
  };
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

    it("requires one of --to-column / --logical-column", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "10" }, { runChild: failingRunChild() }),
        /one of --to-column or --logical-column is required/,
      );
    });

    it("rejects --to-column and --logical-column together", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "10", toColumn: "Done", logicalColumn: "done" }, { runChild: failingRunChild() }),
        /--to-column and --logical-column are mutually exclusive/,
      );
    });

    it("rejects an unrecognized --logical-column name", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "10", logicalColumn: "shipped" }, { runChild: failingRunChild() }),
        /--logical-column must be one of/,
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

    it("parses --pr and --logical-column", () => {
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--logical-column", "done"]);
      assert.equal(args.pr, "10");
      assert.equal(args.logicalColumn, "done");
    });

    it("treats an empty --item as omitted (unfilled template substitution), not a usage error", () => {
      // e.g. an unfilled `<linked-issue>` substitution producing `--item ""`
      // must fall back to --pr instead of failing the whole post-merge step.
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--item", ""]);
      assert.equal(args.item, undefined);
      assert.equal(args.pr, "10");
    });

    it("treats a bare --item with no value at all as omitted, same as --item \"\"", () => {
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--pr", "10", "--item"]);
      assert.equal(args.item, undefined);
      assert.equal(args.pr, "10");
    });

    it("rejects --item swallowing a neighbouring flag as its value", () => {
      assert.throws(() => parseCliArgs(["--repo", "o/n", "--item", "--to-column", "Done"]), /--item requires a value/);
    });

    it("rejects a non-numeric --pr", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", pr: "nope", toColumn: "Done" }, { runChild: failingRunChild() }),
        /--pr must be a positive integer/,
      );
    });
  });

  describe("target + column resolution (the move that actually reaches the core)", () => {
    // These stub syncBoardStatus itself so the CLI's own glue logic is
    // observable without a real/stubbed gh call. Mutating `item ?? pr` to
    // `pr`, or the resolved logical column to `undefined`, fails them.
    it("targets --item (not --pr) when both are given, moving it to the logical Done column", async () => {
      await withBoardConfig(async (tempDir) => {
        const calls = [];
        const result = await main(
          { repo: "mfittko/dev-loops", pr: "10", item: "42", logicalColumn: "done" },
          { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, false);
        assert.equal(result.result.item.newColumn, "Done");
        assert.deepEqual(calls, [{ repo: "mfittko/dev-loops", repoRoot: tempDir, itemNumber: 42, targetColumn: "Done" }]);
      });
    });

    it("targets the PR number when no item is supplied", async () => {
      await withBoardConfig(async (tempDir) => {
        const calls = [];
        const result = await main(
          { repo: "mfittko/dev-loops", pr: "10", logicalColumn: "done" },
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
          await main(
            { repo: "mfittko/dev-loops", item: "42", logicalColumn: "done" },
            { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
          );
          assert.equal(calls.length, 1);
          assert.equal(calls[0].targetColumn, "Merged");
        },
        { devloops: "version: 1\nqueue:\n  board:\n    number: 3\n  statusColumns:\n    done: Merged\n" },
      );
    });

    it("passes --to-column through literally (no logical mapping)", async () => {
      await withBoardConfig(
        async (tempDir) => {
          const calls = [];
          await main(
            { repo: "mfittko/dev-loops", item: "42", toColumn: "Done" },
            { cwd: tempDir, env: {}, syncBoardStatus: recordingSyncBoardStatus(calls) },
          );
          assert.equal(calls[0].targetColumn, "Done");
        },
        { devloops: "version: 1\nqueue:\n  board:\n    number: 3\n  statusColumns:\n    done: Merged\n" },
      );
    });

    it("a whitespace-only --item counts as omitted at parse time (documented lenience, falls back to --pr)", () => {
      const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--item", "   ", "--pr", "10", "--logical-column", "done"]);
      assert.equal(args.item, undefined);
      assert.equal(args.pr, "10");
    });

    it("runCli exits 0 with the stdout skip record and empty stderr when gh itself fails (best-effort contract end to end)", async () => {
      const prevExitCode = process.exitCode;
      await withBoardConfig(async (tempDir) => {
        const stdout = collectingStream();
        const stderr = collectingStream();
        await runCli(
          ["--repo", "mfittko/dev-loops", "--pr", "10", "--logical-column", "done"],
          { stdout, stderr, env: {}, cwd: tempDir, runChild: failingRunChild() },
        );
        assert.equal(process.exitCode, 0);
        assert.equal(stderr.text(), "");
        const parsed = JSON.parse(stdout.text());
        assert.equal(parsed.ok, true);
        assert.equal(parsed.skipped, true);
        assert.match(parsed.reason, /./);
      });
      process.exitCode = prevExitCode;
    });

    it("runCli reports a successful move on stdout with exit 0", async () => {
      const prevExitCode = process.exitCode;
      await withBoardConfig(async (tempDir) => {
        const stdout = collectingStream();
        const stderr = collectingStream();
        await runCli(
          ["--repo", "mfittko/dev-loops", "--pr", "10", "--item", "42", "--logical-column", "done"],
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

    // Pins the --jq/--silent wiring itself: if it were dropped, both flags
    // would become unknown-flag usage errors (exit 1). The docs' `|| true`
    // guidance rests on exactly these exit codes.
    it("wires --jq/--silent/invalid-filter exit codes", async () => {
      const prevExitCode = process.exitCode;
      await withBoardConfig(async (tempDir) => {
        const run = async (extra) => {
          const stdout = collectingStream();
          const stderr = collectingStream();
          await runCli(
            ["--repo", "mfittko/dev-loops", "--pr", "10", "--logical-column", "done", ...extra],
            { stdout, stderr, env: {}, cwd: tempDir, syncBoardStatus: recordingSyncBoardStatus([]) },
          );
          return { code: process.exitCode, out: stdout.text() };
        };
        const jqRun = await run(["--jq", ".skipped"]);
        assert.equal(jqRun.code, 0);
        assert.equal(jqRun.out.trim(), "false");
        assert.deepEqual(await run(["--jq", ".skipped == true", "--silent"]), { code: 1, out: "" });
        assert.equal((await run(["--jq", "(("])).code, 2);
      });
      process.exitCode = prevExitCode;
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
          "version: 1\nqueue:\n  board:\n    number: 3\n",
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

    it("surfaces a config read/parse error the same best-effort way under --logical-column", async () => {
      // loadStateColumnMap must not throw on a broken .devloops: it falls back
      // to the default column names and syncBoardStatus reports the skip.
      const tempDir = mkdtempSync(path.join(tmpdir(), "sync-item-status-badcfg-"));
      try {
        writeFileSync(path.join(tempDir, ".devloops"), "not: [valid: yaml", "utf8");
        const result = await main(
          { repo: "mfittko/dev-loops", pr: "10", logicalColumn: "done" },
          { runChild: failingRunChild(), cwd: tempDir, env: {} },
        );
        assert.equal(result.ok, true);
        assert.equal(result.skipped, true);
        assert.match(result.reason, /config read\/parse error/);
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

    it("--help prints usage to stdout and forces exit 0 (clears a leaked non-zero code)", async () => {
      const prevExitCode = process.exitCode;
      // Seed a non-zero code to prove the --help path clears it rather than
      // inheriting a pre-existing failure code from a prior test/runner.
      process.exitCode = 7;
      const stdout = collectingStream();
      const stderr = collectingStream();
      await runCli(["--help"], { stdout, stderr, env: {} });
      assert.match(stdout.text(), /dev-loops project sync-status/);
      assert.equal(process.exitCode, 0);
      process.exitCode = prevExitCode;
    });
  });
});
