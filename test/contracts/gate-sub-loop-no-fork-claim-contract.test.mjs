// Enforcement guard for issue #895 (build-once neutral context bundle for the
// gate fan-out; drop the fork claim). The gate-review sub-loop contract must
// NOT assert that reviewers fork from a parent agent's loaded context — that
// claim was the dishonesty #895 fixes. The accurate model is: a deterministic
// context-builder builds ONE neutral bundle and each independent reviewer is
// seeded with it verbatim (no fork primitive, no Workflow tool).
//
// Heuristic: scan the contract for any POSITIVE fork claim (e.g. "fork fan-out",
// "forks ... reviewer", "forks from", "forked reviewer", "fork the context").
// Explicit DENIALS of forking ("does not fork", "no fork primitive", "do NOT
// fork ...") are allowed and must not false-positive — they are exactly how the
// corrected contract states the model.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractUrl = new URL("../../docs/gate-review-sub-loop-contract.md", import.meta.url);

// Strip markdown emphasis so "does **not** fork" reads as "does not fork".
function stripEmphasis(line) {
  return line.replace(/[*_`]/g, "");
}

/** Lines that NEGATE forking are allowed; everything else with "fork" is a claim. */
const DENIAL_MARKERS = [
  // "do/does/did not [ever] fork", tolerant of intervening words like "ever".
  /\b(?:do|does|did)\s+not\s+(?:\w+\s+){0,2}fork/i,
  /\bnot fork\b/i,
  /\bno fork\b/i,
  /\bnever (?:inherit|fork)/i,
  /\(no fork\)/i,
  /\bwithout (?:a )?fork/i,
  /\bnot depend on any fork/i,
  // "do NOT fork from, or inherit ..." (the reviewer-independence statement)
  /\bnot fork from\b/i,
];

function isDenial(rawLine) {
  const line = stripEmphasis(rawLine);
  return DENIAL_MARKERS.some((re) => re.test(line));
}

test("gate-review sub-loop contract contains no positive 'fork' claim (#895)", async () => {
  const text = await readFile(contractUrl, "utf8");
  const offending = [];
  text.split("\n").forEach((line, idx) => {
    const clean = stripEmphasis(line);
    if (!/\bfork(?:s|ed|ing)?\b/i.test(clean)) return;
    if (isDenial(line)) return;
    offending.push(`${idx + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    offending,
    [],
    `gate-review sub-loop contract must not assert reviewers fork; offending lines:\n${offending.join("\n")}`,
  );
});

test("gate-review sub-loop contract explicitly describes the build-once neutral-bundle model (#895)", async () => {
  const text = await readFile(contractUrl, "utf8");
  // Must affirmatively describe the corrected model so the honesty fix is durable.
  assert.match(text, /build once/i);
  assert.match(text, /neutral context bundle/i);
  assert.match(text, /seed(?:ed|s)?\b/i);
  assert.match(text, /work-dedup/i);
});
