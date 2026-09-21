// AC #2 for issue #2336: the reviewer briefing (agents/review.agent.md) must
// point gate reviewers at the sanctioned `dev-loops gate resolve-role` CLI to
// resolve an angle's persona/prompt/model from the fully merged config, and
// must NOT instruct (or imply) reviewers self-resolve by grepping/reading the
// shipped `extension-defaults.yaml` — that raw grep misses the `.devloops`
// config-layer merge and yields the wrong persona/model.

import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const REVIEW_AGENT_DOC = "agents/review.agent.md";

test("review agent doc points reviewers at the resolve-role CLI", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  assert.ok(
    content.includes("dev-loops gate resolve-role --angle"),
    "review.agent.md must instruct reviewers to run `dev-loops gate resolve-role --angle <name>`",
  );
});

test("review agent doc forbids grepping extension-defaults.yaml for a persona/model", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  // Every mention of the shipped defaults file must sit inside a prohibition.
  assert.ok(
    /(MUST NOT|do NOT)[^.]*(grep|read)[^.]*extension-defaults\.yaml/i.test(content),
    "review.agent.md must explicitly forbid grepping/reading extension-defaults.yaml to derive a persona/model",
  );
});

test("review agent doc no longer directs reviewers to self-resolve inline via resolveReviewerRole", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  // The old briefing told reviewers to self-resolve a named angle inline via
  // `resolveReviewerRole(config, <angle>)`; that is what the CLI now wraps, so
  // the doc must not re-issue it as the reviewer's own inline call.
  assert.ok(
    !/self-resolve[^.]*resolveReviewerRole\(config/i.test(content),
    "review.agent.md must not instruct reviewers to self-resolve inline via resolveReviewerRole(config, ...)",
  );
  assert.ok(
    !/resolve the persona and prompt via `resolveReviewerRole\(config/i.test(content),
    "review.agent.md must not instruct reviewers to resolve the persona/prompt inline via resolveReviewerRole(config, ...)",
  );
});
