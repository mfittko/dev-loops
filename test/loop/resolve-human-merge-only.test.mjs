// STOP-HUMAN-MERGE-001 wiring contract (#1622): the Claude Bash-gate hook defers the
// `autonomy.humanMergeOnly` resolution to scripts/loop/resolve-human-merge-only.mjs (the hook
// bundle cannot import @dev-loops/core), then fails closed on a `"true\n"` stdout. The hook always
// runs the script with cwd = repoRoot, so this test locks the script's output against the
// repository config it reads — a regression in the config->script->parse->decideBashGate chain
// (the only enforcement path for the actor-independent human-merge invariant) is caught here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadDevLoopConfig, resolveHumanMergeOnly } from "@dev-loops/core/config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = pathJoin(repoRoot, "scripts", "loop", "resolve-human-merge-only.mjs");

function pathJoin(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}

test("resolve-human-merge-only prints exactly what the repo config's resolveHumanMergeOnly resolves", async () => {
  const r = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // the script must emit a single-line binary contract the hook compares with === "true"
  assert.match(r.stdout.trim(), /^(true|false)$/);
  const { config } = await loadDevLoopConfig({ cwd: repoRoot });
  assert.equal(r.stdout.trim(), String(resolveHumanMergeOnly(config)));
  // and the hook-decisions gate must agree: under this repo's resolved invariant, a gh pr merge is
  // refused actor-independently (STOP-HUMAN-MERGE-001)
  const { decideBashGate } = await import("../../packages/core/src/claude/hook-decisions.mjs");
  const d = decideBashGate({
    command: "gh pr merge 1 --squash",
    repoSlug: "mfittko/dev-loops",
    gatePassed: true,
    agentType: null,
    humanMergeOnly: r.stdout.trim() === "true",
  });
  assert.equal(d.decision, resolveHumanMergeOnly(config) ? "deny" : "allow");
  if (resolveHumanMergeOnly(config)) assert.match(d.reason, /STOP-HUMAN-MERGE-001/);
});
