import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const fromRepoRoot = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), "utf8");

test("ui validation contract doc exists at the expected path", async () => {
  await access(fromRepoRoot("docs/ui-validation-contract.md"));
});

test("ui validation contract states the auto-scoped, fail-closed criterion (not opt-in-by-annotation)", async () => {
  const contract = await readRepo("docs/ui-validation-contract.md");

  assert.match(contract, /`dev-loop`/i);
  // Inclusion is path-triggered + registry-backed, not annotation opt-in.
  assert.match(contract, /path-triggered/i);
  assert.match(contract, /registry-backed/i);
  assert.match(contract, /fail-closed/i);
  // The superseded convention is explicitly named as superseded.
  assert.match(contract, /superseded/i);

  // Cross-links to the canonical owner and the shared harness.
  assert.match(contract, /ui-e2e-scoping-step\.md/i);
  assert.match(contract, /deck-fit-harness\.mjs/i);
});

test("ui validation contract carries the intro-deck worked example end to end", async () => {
  const contract = await readRepo("docs/ui-validation-contract.md");

  assert.match(contract, /DECK_REGISTRY\["intro-deck"\]/i);
  assert.match(contract, /defineDeckSuite/i);
  assert.match(contract, /REGISTERED_ARTIFACT_PATHS/i);
  assert.match(contract, /ui_e2e_scoping/i);
  assert.match(contract, /deck-smoke/i);
  assert.match(contract, /UI_E2E_CHECK_NAMES/i);
  // Mobile-fit assertions subsume the standalone slide responsive-fit goal (#939).
  assert.match(contract, /390/);
  assert.match(contract, /multi-browser/i);
});

test("local-implementation skill points to the ui validation contract and states the auto-scoped requirement", async () => {
  const localImplementationSkill = await readRepo("skills/local-implementation/SKILL.md");

  assert.match(localImplementationSkill, /docs\/ui-validation-contract\.md/i);
  assert.match(localImplementationSkill, /required and auto-scoped/i);
  assert.match(localImplementationSkill, /ui-e2e-scoping-step\.md/i);
});
