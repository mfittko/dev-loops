// The no-core fallback poster keeps the OPERATOR-OWNED-LINE refusal through a local
// twin. This parity test runs the twin and the core registry over the same
// fixtures, so drift in either fails CI. The twin matches the Copilot marker on
// the raw body, stricter than core: it also refuses a quoted marker (listed below).
import assert from "node:assert/strict";
import { test } from "bun:test";

import { OPERATOR_OWNED_LINES } from "../../packages/core/src/github/operator-owned-lines.mjs";
import { findFallbackOperatorOwnedLine, postGateVerdictViaGh } from "../../skills/dev-loop/scripts/post-gate-verdict-fallback.mjs";

const SHA = "a".repeat(40);
const MARKER = `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} operator -->`;
const FIX_MARKER = `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} fix=${SHA} -->`;
const GRILL_HEAD = "## 🔬 Grill / refinement results";
const grillLine = (handle) => `bypass: operator-authorized by ${handle}`;

// [fixture, core refuses]
const FIXTURES = [
  [`approve merge ${SHA}`, true],
  [`intro\n> approve merge ${SHA}`, true],
  [`- approve merge ${SHA}`, true],
  [`we do not approve merge ${SHA}`, false],
  [`\`approve merge ${SHA}\``, false],
  ["approve release v1.2.3", true],
  ["Operator says: approve release 1.2.3", true],
  ["`approve release v1.2.3`", false],
  ["```\napprove release v1.2.3\n```", false],
  ["> approve release v1.2.3", false],
  ["adr-tripwire:allow reason", true],
  ["  adr-tripwire:allow reason", true],
  ["`adr-tripwire:allow` reason", false],
  ["mention adr-tripwire:allow mid line", false],
  [MARKER, true],
  [`text ${MARKER}`, true],
  [FIX_MARKER, false],
  [`${GRILL_HEAD}\n\nSummary\n${grillLine("op")}`, true],
  [`${GRILL_HEAD}\n\nSummary\n${grillLine("@Op-1").toUpperCase()}`, true],
  [`${GRILL_HEAD}\n\n\`\`\`\n  ${grillLine("op")}\n\`\`\``, true],
  [`${GRILL_HEAD}\n\nthe line \`${grillLine("op")}\` is operator-owned`, false],
  [`Reviewer note\n${grillLine("op")}`, false],
  ["a clean finding summary", false],
];
// Core ignores a quoted marker; the twin refuses it.
const TWIN_STRICTER = [`\`${MARKER}\``, `> ${MARKER}`];

test("the fallback twin refuses every fixture the core registry refuses and passes every other", () => {
  assert.equal(OPERATOR_OWNED_LINES.length, 5, "a new registry entry needs a twin entry and fixtures");
  for (const [body, coreRefuses] of FIXTURES) {
    const core = OPERATOR_OWNED_LINES.some((entry) => entry.matches(body));
    assert.equal(core, coreRefuses, `core fixture drifted: ${JSON.stringify(body)}`);
    assert.equal(findFallbackOperatorOwnedLine(body) !== null, coreRefuses, `twin parity: ${JSON.stringify(body)}`);
  }
  for (const body of TWIN_STRICTER) {
    assert.equal(OPERATOR_OWNED_LINES.some((entry) => entry.matches(body)), false, body);
    assert.notEqual(findFallbackOperatorOwnedLine(body), null, body);
  }
});

test("each entry has a twin label in the same order of precedence", () => {
  for (const entry of OPERATOR_OWNED_LINES) {
    const sample = { "approve-merge": `approve merge ${SHA}`, "approve-release": "approve release v1.2.3", "adr-tripwire-allow": "adr-tripwire:allow x", "copilot-body-disposition-operator": MARKER, "grill-provenance-bypass": `${GRILL_HEAD}\n${grillLine("op")}` }[entry.id];
    assert.equal(findFallbackOperatorOwnedLine(sample), entry.label, entry.id);
  }
});

test("postGateVerdictViaGh refuses an operator-owned line before any spawn", async () => {
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; throw new Error("must not spawn"); };
  for (const body of [`Findings\napprove merge ${SHA}`, "x\n> note\napprove release v1.2.3", MARKER]) {
    await assert.rejects(postGateVerdictViaGh({ repo: "o/r", pr: 1, body, spawnImpl }), /^Error: OPERATOR-OWNED-LINE: /);
  }
  assert.equal(spawned, 0);
});
