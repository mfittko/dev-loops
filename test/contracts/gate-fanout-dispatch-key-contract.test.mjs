import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

// The rule prose spans several lines, so grab the full block from the marker up to
// the next `<!-- rule:` marker (or end of doc) rather than the single owned line.
function extractRuleBlock(content, id) {
  const marker = new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`);
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => marker.test(line));
  assert.ok(start !== -1, `expected rule marker ${id} to be present`);
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex(
    (line) => /<!--\s*rule:\s*[A-Z][A-Z0-9-]*\s*-->/.test(line) || /^\*\*[^*].*\*\*\s*$/.test(line.trim()),
  );
  const block = remaining.slice(0, end === -1 ? remaining.length : end);
  return block.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * #1681 — runs.all workflowScript dispatch "invalid key"
 *
 * The Pi harness's `runs.all` workflowScript API requires every collection item
 * to declare its own `key` field. A fan-out that omits it fails the whole
 * dispatch with an "invalid key" validation error, which previously degraded a
 * requireFanoutEvidence gate to a single inline reviewer. This test pins the
 * authoritative gate contract so the conductor always emits the `key` field and
 * fails closed (never silently degrades to inline_single_agent) on a dispatch
 * failure.
 */
test("gate fan-out contract owns the runs.all dispatch-key + fail-closed requirement", async () => {
  const content = await readRepo("skills/docs/gate-review-sub-loop-contract.md");

  // The rule must live in exactly the canonical gate contract doc, nowhere else.
  assertRuleOwned("GATE-EXEC-FANOUT-DISPATCH-KEY", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(content, /GATE-EXEC-FANOUT-DISPATCH-KEY/);

  const owned = extractRuleBlock(content, "GATE-EXEC-FANOUT-DISPATCH-KEY");
  // The harness `key`-field requirement is encoded.
  assert.match(owned, /runs\.all/);
  assert.match(owned, /`key` field on EACH item/);
  assert.match(owned, /invalid key/);
  // The conductor fail-closed obligation is encoded (AC2): refusal to degrade
  // to inline_single_agent on a requireFanoutEvidence gate.
  assert.match(owned, /fails closed/);
  assert.match(owned, /inline_single_agent/);
  assert.match(owned, /requireFanoutEvidence/);
});
