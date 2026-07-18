import assert from "node:assert/strict";
import test from "node:test";
import { runActionlint } from "../../scripts/github/lint-workflows.mjs";

const FIXTURE_PATH = "test/fixtures/workflows/invalid-on-trigger.yml";

// Negative test for #1409 (root cause #1385): proves the actionlint wiring
// actually catches a server-side-invalid workflow (unknown `on:` event), the
// exact defect class that `gate-evidence-workflow.test.mjs`'s YAML-only parse
// can't see. Skips cleanly when actionlint isn't installed — the missing-
// binary path is a local-tooling gap, never a stand-in for a real lint pass;
// CI always has the pinned binary, so the enforcement itself never no-ops.
test("actionlint flags the deliberately-invalid on: trigger fixture", (t) => {
  const probe = runActionlint(["-version"]);
  if (probe.error?.code === "ENOENT") {
    t.skip("actionlint not installed locally — enforced in CI");
    return;
  }

  const result = runActionlint([FIXTURE_PATH]);

  assert.notEqual(result.status, 0, "actionlint should fail on the invalid on: trigger fixture");
  assert.match(result.stdout, /pull_request_review_thread/);
});
