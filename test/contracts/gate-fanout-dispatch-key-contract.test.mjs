import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

// The rule prose spans several lines, so grab the full block from the marker up to
// the next `<!-- rule:` marker or a non-empty bold heading (never silently to EOF).
// An unanchored block is a test error, not a pass: if neither end condition matches,
// assert fails so a reworded/reflowed heading cannot silently broaden the owned
// block and mask a cut-off rule.
function extractRuleBlock(content, id) {
  const marker = new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`);
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => marker.test(line));
  assert.ok(start !== -1, `expected rule marker ${id} to be present`);
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex(
    // A bold heading terminates the rule block even when it carries trailing
    // prose on the same line (e.g. `**Grouped dispatch (default).** Before …`),
    // so the block never swallows the next section: match any line that STARTS
    // a bold heading, not one that must also end in `**` on the same line.
    (line) => /<!--\s*rule:\s*[A-Z][A-Z0-9-]*\s*-->/.test(line) || /^\*\*[^*]/.test(line.trim()),
  );
  assert.ok(end !== -1, `expected rule block ${id} to be terminated by the next rule marker or bold heading`);
  const block = remaining.slice(0, end);
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
  // The grouped-dispatch per-group slug mention is present so grouped fan-out is pinned.
  assert.match(content, /a per-angle or per-group slug/);

  const owned = extractRuleBlock(content, "GATE-EXEC-FANOUT-DISPATCH-KEY");
  // Negative case: the owned block must terminate at the next bold heading
  // (`**Grouped dispatch (default).**`), never swallow the following section.
  assert.equal(owned.includes("Grouped dispatch (default)"), false, "rule block must terminate at the next bold heading, not extend into the grouped-dispatch section");
  // The harness `key`-field requirement is encoded (AC1).
  assert.match(owned, /runs\.all/);
  assert.match(owned, /`key` field on EACH item/);
  assert.match(owned, /invalid key/);
  // AC1's uniqueness + missing/blank-key edge cases are pinned, so a normative
  // weakening (MUST->MAY, dropping `unique`/`missing or blank`) cannot pass.
  assert.match(owned, /unique/);
  assert.match(owned, /missing or blank/);
  // The conductor fail-closed obligation is encoded (AC2): refusal to degrade
  // to inline_single_agent on a requireFanoutEvidence gate.
  assert.match(owned, /fails closed/);
  assert.match(owned, /inline_single_agent/);
  assert.match(owned, /requireFanoutEvidence/);
});
