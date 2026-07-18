import { parse as parseYaml } from "yaml";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

// Pins #1385: gate-evidence must re-fire on review-thread state changes (not
// just push/ready), so a required green check can't go stale on the thread
// axis. Head-staleness (synchronize) and the draft no-op guard must survive
// unchanged.
test("gate-evidence workflow re-fires on review submission and thread resolve/unresolve", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const triggers = workflow.on;

  assert.deepEqual(triggers.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(triggers.pull_request_review.types, ["submitted"]);
  assert.deepEqual(triggers.pull_request_review_thread.types, ["resolved", "unresolved"]);

  // Draft PRs must still no-op regardless of which event triggered the run —
  // pull_request_review and pull_request_review_thread payloads carry the same
  // pull_request.draft field as pull_request events.
  assert.equal(workflow.jobs["gate-evidence"].if, "github.event.pull_request.draft == false");
});
