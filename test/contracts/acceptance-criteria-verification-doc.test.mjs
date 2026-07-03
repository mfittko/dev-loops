import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

test("acceptance-criteria-verification doc covers ticking the PR body after a clean verification", async () => {
  const doc = await readRepo("skills/docs/acceptance-criteria-verification.md");

  // The procedure must reflect verified items into the PR body, not only the issue.
  assert.match(doc, /PR body/i);
  // Via a single gh pr edit --body-file update.
  assert.match(doc, /gh pr edit --body-file/);
  // Using the dedicated helper so it runs as part of the gate, not by memory.
  assert.match(doc, /tick-verified-checkboxes\.mjs/);
});
