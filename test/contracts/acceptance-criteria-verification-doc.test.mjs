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

test("#1877: the doc states the deterministic pre-approval completeness block and its boundary", async () => {
  const doc = await readRepo("skills/docs/acceptance-criteria-verification.md");

  // The deterministic block: any unchecked PR-body AC/DoD box fails the gate closed.
  assert.match(doc, /Deterministic pre-approval completeness block/);
  assert.match(doc, /completeness.*NOT.*truthfulness/is);
  assert.match(doc, /stays unchecked.*therefore blocks/is);
  // The reviewer/judge truthfulness check explicitly remains.
  assert.match(doc, /remains the reviewer\/judge's responsibility/);
  // Composition with tick-verified-checkboxes is stated.
  assert.match(doc, /never blanket-checks/);
});
