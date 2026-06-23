import test from "node:test";
import assert from "node:assert/strict";

import { createClaudeExtensionAdapter } from "@dev-loops/core/harness";

import { createExtensionCoreRuntime } from "../extension/checks.ts";
import { executeDevLoopsCommand } from "../lib/dev-loops-core.mjs";

// CA1 acceptance: executeDevLoopsCommand runs unchanged against a runtime built from the
// Claude adapter (same interface as the Pi adapter), proving the seam is harness-neutral.

test("executeDevLoopsCommand resolves help against the Claude adapter runtime", async () => {
  const adapter = createClaudeExtensionAdapter();
  const result = await executeDevLoopsCommand({
    input: "help",
    surface: "extension",
    runtime: createExtensionCoreRuntime(adapter),
  });
  assert.equal(result.kind, "help");
});

test("executeDevLoopsCommand resolves status checks against the Claude adapter runtime", async () => {
  const adapter = createClaudeExtensionAdapter();
  const result = await executeDevLoopsCommand({
    input: "status",
    surface: "extension",
    runtime: createExtensionCoreRuntime(adapter),
  });

  assert.equal(result.kind, "checks");
  assert.equal(result.action, "status");
  assert.deepEqual(
    result.checks.map((c) => c.id),
    ["gh-installed", "gh-auth", "subagent-command", "git-repo"],
  );
  // Every check has a boolean ok + non-empty detail regardless of host environment.
  for (const check of result.checks) {
    assert.equal(typeof check.ok, "boolean");
    assert.ok(check.detail.length > 0);
  }
});
