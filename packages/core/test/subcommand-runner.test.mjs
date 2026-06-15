import test from "node:test";
import assert from "node:assert/strict";
import { defineSubcommand } from "@dev-loops/core/cli/subcommand-runner";

test("defineSubcommand creates parser with auto-usage", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Test command.",
    options: [
      { flag: "--repo", type: "string", required: true },
      { flag: "--pr", type: "pr", required: true },
      { flag: "--verbose", type: "boolean", default: false },
    ],
    async run(parsed) { return 0; },
  });

  assert.ok(sub.usage.includes("test-cmd"));
  assert.ok(sub.usage.includes("--repo"));
  assert.ok(sub.usage.includes("--pr"));

  const { parsed } = sub.parseArgs(["--repo", "o/r", "--pr", "42"]);
  assert.equal(parsed.repo, "o/r");
  assert.equal(parsed.pr, 42);
  assert.equal(parsed.verbose, false);
});

test("defineSubcommand rejects removed flags", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Test.",
    options: [
      { flag: "--repo", type: "string", required: true },
      { flag: "--force", type: "boolean", default: false, removedAliases: ["--force-reason"] },
    ],
    async run() { return 0; },
  });

  assert.throws(
    () => sub.parseArgs(["--repo", "o/r", "--force-reason", "x"]),
    /has been removed/
  );
});

test("defineSubcommand shows help", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Test.",
    options: [
      { flag: "--repo", type: "string", required: true },
    ],
    async run() { return 0; },
  });

  const { help } = sub.parseArgs(["--help"]);
  assert.equal(help, true);
});

test("defineSubcommand maps dashed flags to camelCase keys", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Dashed flag test.",
    options: [
      { flag: "--head-sha", type: "string", required: true },
      { flag: "--local-state-path", type: "string", default: "" },
      { flag: "--review-request-status", type: "string" },
    ],
    async run() { return 0; },
  });

  const { parsed } = sub.parseArgs([
    "--head-sha", "abc123",
    "--local-state-path", "/tmp/state.json",
    "--review-request-status", "requested",
  ]);
  assert.equal(parsed.headSha, "abc123");
  assert.equal(parsed.localStatePath, "/tmp/state.json");
  assert.equal(parsed.reviewRequestStatus, "requested");
});

test("defineSubcommand respects opt.key override for dashed flags", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Key override test.",
    options: [
      { flag: "--head-sha", key: "headSha", type: "string", required: true },
      { flag: "--local-validation-head-sha", key: "localValidationHeadSha", type: "string" },
    ],
    async run() { return 0; },
  });

  const { parsed } = sub.parseArgs([
    "--head-sha", "abc123",
    "--local-validation-head-sha", "def456",
  ]);
  assert.equal(parsed.headSha, "abc123");
  assert.equal(parsed.localValidationHeadSha, "def456");
});

test("defineSubcommand boolean flags are presence-only", () => {
  const sub = defineSubcommand({
    name: "test-cmd",
    description: "Boolean flag test.",
    options: [
      { flag: "--verbose", type: "boolean", default: false },
      { flag: "--auto-resume", type: "boolean", default: false },
    ],
    async run() { return 0; },
  });

  const { parsed } = sub.parseArgs(["--verbose", "--auto-resume"]);
  assert.equal(parsed.verbose, true);
  assert.equal(parsed.autoResume, true);

  // Boolean flags in usage do not show <VALUE>
  assert.ok(!sub.usage.includes("<VERBOSE>"));
  assert.ok(!sub.usage.includes("<AUTO_RESUME>"));
});
