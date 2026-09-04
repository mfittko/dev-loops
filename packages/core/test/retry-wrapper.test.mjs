import test from "node:test";
import assert from "node:assert/strict";

import {
  isUsageError,
  extractValidFlags,
  extractUsageText,
  filterArgs,
  buildCorrectedArgs,
} from "../src/cli/retry-wrapper.mjs";

// ── isUsageError ──

test("isUsageError — JSON usage error with usage field", () => {
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument: --timeout-ms",
    usage: "Usage: run-watch-cycle.mjs --repo <owner/name> --pr <number>",
  });
  assert.equal(isUsageError(stderr), true);
});

test("isUsageError — JSON runtime error without usage field", () => {
  const stderr = JSON.stringify({
    ok: false,
    error: "gh command failed: Bad credentials",
  });
  assert.equal(isUsageError(stderr), false);
});

test("isUsageError — current short-error envelope { ok: false, hint } (formatCliError never emits usage anymore)", () => {
  const stderr = JSON.stringify({
    ok: false,
    error: "Missing required argument: --findings-dir",
    hint: "run with --help for usage",
  });
  assert.equal(isUsageError(stderr), true);
});

test("isUsageError — hint envelope detects a usage error even when the message matches NONE of the USAGE_PATTERNS regexes", () => {
  // "Missing required argument:" (plural "arguments" shape) matches none of
  // the /Unknown argument:|Missing required option:|.../ patterns — before
  // the hint field was recognized, this whole error class silently stopped
  // being retryable once formatCliError dropped the `usage` field.
  const stderr = JSON.stringify({
    ok: false,
    error: "Missing required arguments: gate, headSha",
    hint: "run with --help for usage",
  });
  assert.equal(isUsageError(stderr), true);
});

test("isUsageError — { ok: false } with neither usage nor hint is a non-retryable runtime error", () => {
  const stderr = JSON.stringify({ ok: false, error: "gh command failed: Bad credentials" });
  assert.equal(isUsageError(stderr), false);
});

test("isUsageError — unknown argument text pattern", () => {
  assert.equal(isUsageError("Unknown argument: --timeout-ms"), true);
});

test("isUsageError — missing required option text pattern", () => {
  assert.equal(isUsageError("Missing required option: --repo"), true);
});

test("isUsageError — missing value text pattern", () => {
  assert.equal(isUsageError("Missing value for --pr"), true);
});

test("isUsageError — removed flag text pattern", () => {
  assert.equal(isUsageError("--probe-only has been removed"), true);
});

test("isUsageError — unrecognized text pattern", () => {
  assert.equal(isUsageError("Unrecognized command: xyz"), true);
});

test("isUsageError — network error not usage", () => {
  assert.equal(isUsageError("ECONNREFUSED: Connection refused"), false);
});

test("isUsageError — auth error not usage", () => {
  assert.equal(isUsageError("401 Unauthorized"), false);
});

test("isUsageError — empty stderr", () => {
  assert.equal(isUsageError(""), false);
  assert.equal(isUsageError("  "), false);
});

test("isUsageError — null/undefined stderr", () => {
  assert.equal(isUsageError(null), false);
  assert.equal(isUsageError(undefined), false);
});

test("isUsageError — runtime JSON error without usage", () => {
  const stderr = JSON.stringify({ ok: false, error: "Something went wrong" });
  assert.equal(isUsageError(stderr), false);
});

// ── extractValidFlags ──

test("extractValidFlags — typical usage text", () => {
  const usage = "Usage: run-watch-cycle.mjs --repo <owner/name> --pr <number>";
  const flags = extractValidFlags(usage);
  assert.deepEqual(flags, new Set(["--repo", "--pr"]));
});

test("extractValidFlags — usage with optional flags in brackets", () => {
  const usage = "Usage: detect.mjs [--input <file>] [--verbose]";
  const flags = extractValidFlags(usage);
  assert.deepEqual(flags, new Set(["--input", "--verbose"]));
});

test("extractValidFlags — usage with repeated flags (deduplication)", () => {
  const usage = "  --repo <owner/name>    Repository slug\n  --pr <number>          PR number\n  --repo <owner/name>    (duplicate)";
  const flags = extractValidFlags(usage);
  assert.deepEqual(flags, new Set(["--repo", "--pr"]));
});

test("extractValidFlags — multi-line conductor usage", () => {
  const usage = `Usage: run-conductor-cycle.mjs --repo <owner/name>
Poll all open PRs, detect state, and output an ordered action queue.`;
  const flags = extractValidFlags(usage);
  assert.deepEqual(flags, new Set(["--repo"]));
});

test("extractValidFlags — empty usage", () => {
  const flags = extractValidFlags("");
  assert.equal(flags.size, 0);
});

test("extractValidFlags — no flags in text", () => {
  const flags = extractValidFlags("This is just a description");
  assert.equal(flags.size, 0);
});

test("extractValidFlags — flags with numbers and hyphens", () => {
  const usage = "--head-sha <sha> --max-retries <num> --timeout-ms <ms>";
  const flags = extractValidFlags(usage);
  assert.deepEqual(flags, new Set(["--head-sha", "--max-retries", "--timeout-ms"]));
});

// ── extractUsageText ──

test("extractUsageText — from JSON with usage field", () => {
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument",
    usage: "Usage: script.mjs --repo <name>",
  });
  assert.equal(extractUsageText(stderr), "Usage: script.mjs --repo <name>");
});

test("extractUsageText — from plain text with Usage: marker", () => {
  const stderr = "Unknown argument: --bogus\n\nUsage: script.mjs --repo <owner/name>";
  assert.equal(extractUsageText(stderr), "Usage: script.mjs --repo <owner/name>");
});

test("extractUsageText — JSON without usage field returns null", () => {
  const stderr = JSON.stringify({ ok: false, error: "Failed" });
  assert.equal(extractUsageText(stderr), null);
});

test("extractUsageText — plain text without Usage: marker returns null", () => {
  const stderr = "Something went wrong, no usage info";
  assert.equal(extractUsageText(stderr), null);
});

test("extractUsageText — empty stderr returns null", () => {
  assert.equal(extractUsageText(""), null);
  assert.equal(extractUsageText("  "), null);
});

// ── filterArgs ──

test("filterArgs — keeps recognized flags and their values", () => {
  const args = ["--repo", "owner/repo", "--pr", "483", "--timeout-ms", "5000"];
  const validFlags = new Set(["--repo", "--pr"]);
  const result = filterArgs(args, validFlags);
  assert.deepEqual(result, ["--repo", "owner/repo", "--pr", "483"]);
});

test("filterArgs — drops unknown flags and their values", () => {
  const args = ["--repo", "owner/repo", "--bogus", "value", "--pr", "42"];
  const validFlags = new Set(["--repo", "--pr"]);
  const result = filterArgs(args, validFlags);
  assert.deepEqual(result, ["--repo", "owner/repo", "--pr", "42"]);
});

test("filterArgs — drops unknown boolean flags", () => {
  const args = ["--repo", "owner/repo", "--verbose", "--pr", "42"];
  const validFlags = new Set(["--repo", "--pr"]);
  const result = filterArgs(args, validFlags);
  assert.deepEqual(result, ["--repo", "owner/repo", "--pr", "42"]);
});

test("filterArgs — keeps only flag present when no value follows", () => {
  const args = ["--repo", "--pr", "42"];
  const validFlags = new Set(["--repo", "--pr"]);
  // --repo has no value (--pr is a flag), --pr gets value "42"
  const result = filterArgs(args, validFlags);
  assert.deepEqual(result, ["--repo", "--pr", "42"]);
});

test("filterArgs — empty validFlags set", () => {
  const args = ["--repo", "owner/repo"];
  const result = filterArgs(args, new Set());
  assert.deepEqual(result, []);
});

// ── buildCorrectedArgs ──

test("buildCorrectedArgs — corrects unknown flag and retries", () => {
  const args = ["--repo", "owner/repo", "--timeout-ms", "5000"];
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument: --timeout-ms",
    usage: "Usage: script.mjs --repo <owner/name>",
  });
  const result = buildCorrectedArgs(args, stderr);
  assert.deepEqual(result, ["--repo", "owner/repo"]);
});

test("buildCorrectedArgs — returns null when args unchanged (already correct)", () => {
  const args = ["--repo", "owner/repo"];
  const stderr = JSON.stringify({
    ok: false,
    error: "Missing required option: --pr",
    usage: "Usage: script.mjs --repo <owner/name> --pr <number>",
  });
  const result = buildCorrectedArgs(args, stderr);
  // args unchanged — args only have --repo which is valid, no --pr to fix
  // Since filtered == original, returns null
  assert.equal(result, null);
});

test("buildCorrectedArgs — returns null for runtime error (no usage field)", () => {
  const args = ["--repo", "owner/repo"];
  const stderr = JSON.stringify({ ok: false, error: "Network error" });
  const result = buildCorrectedArgs(args, stderr);
  assert.equal(result, null);
});

test("buildCorrectedArgs — returns null for empty args", () => {
  const result = buildCorrectedArgs([], "some error");
  assert.equal(result, null);
});

test("buildCorrectedArgs — returns null when no flags in usage", () => {
  const args = ["--repo", "owner/repo"];
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument: --bogus",
    usage: "Usage: This script takes no arguments",
  });
  const result = buildCorrectedArgs(args, stderr);
  assert.equal(result, null);
});

test("buildCorrectedArgs — plain text stderr with Usage: marker", () => {
  const args = ["--repo", "owner/repo", "--bogus-flag"];
  const stderr = "Unknown argument: --bogus-flag\n\nUsage: script.mjs --repo <owner/name>";
  const result = buildCorrectedArgs(args, stderr);
  assert.deepEqual(result, ["--repo", "owner/repo"]);
});

test("buildCorrectedArgs — plain text stderr without Usage: marker returns null", () => {
  const args = ["--repo", "owner/repo"];
  const stderr = "Unknown argument: --bogus";
  const result = buildCorrectedArgs(args, stderr);
  assert.equal(result, null);
});

// ── End-to-end scenario: #483 reproduction ──

test("buildCorrectedArgs — #483 scenario: --timeout-ms on run-watch-cycle", () => {
  const args = ["--repo", "owner/repo", "--pr", "42", "--timeout-ms", "5000"];
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument: --timeout-ms",
    usage: `Usage: run-watch-cycle.mjs --repo <owner/name> --pr <number>
Run one deterministic Copilot wait-cycle boundary.
Required:
  --repo <owner/name>       Repository slug (e.g. owner/repo)
  --pr <number>             Pull request number`,
  });
  const result = buildCorrectedArgs(args, stderr);
  assert.deepEqual(result, ["--repo", "owner/repo", "--pr", "42"]);
});

test("buildCorrectedArgs — #483 scenario: conductor with wrong flag", () => {
  const args = ["--repo", "owner/repo", "--pr", "42"];
  const stderr = JSON.stringify({
    ok: false,
    error: "Unknown argument: --pr",
    usage: "Usage: run-conductor-cycle.mjs --repo <owner/name>",
  });
  const result = buildCorrectedArgs(args, stderr);
  assert.deepEqual(result, ["--repo", "owner/repo"]);
});
