// Internal-gate coverage of the CommonMark nested / multi-backtick code-span
// fail-open class (#1961).
//
// On #1954 the internal fan-out review gate ran clean while an external
// reviewer caught a real fail-open: a nested / multi-backtick CommonMark code
// span survived the approval stripper and matched as prose. The gate had no
// independent coverage of these forms, so it relied on the external backstop.
// This suite gives the internal gate its own coverage via the shared fixture
// set, so the class is caught deterministically in CI without depending on any
// external reviewer.
import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_CODE_SPAN_FIXTURES,
  APPROVAL_MARKER,
  buildCodeSpanFixtures,
} from "../../scripts/lib/code-span-fixtures.mjs";
import {
  resolveApprovalState,
  stripNonAssertionMarkdown,
} from "../../scripts/release/verify-release-approval.mjs";

const RELEASE_REF = "2020-01-01T00:00:00Z";
const AFTER = "2020-01-02T00:00:00Z";

// The four AC-enumerated classes that must be treated as code.
const REQUIRED_CATEGORIES = [
  "single-backtick span",
  "multi-backtick delimiter",
  "inner-backtick pair",
  "unterminated fence",
];

test("shared fixture set enumerates every required code-span class (#1961)", () => {
  const present = new Set(APPROVAL_CODE_SPAN_FIXTURES.map((f) => f.category));
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(present.has(category), `fixture set must enumerate a ${category} form`);
  }
  assert.ok(APPROVAL_CODE_SPAN_FIXTURES.every((f) => f.treatment === "code"));
});

test("stripNonAssertionMarkdown strips the marker from every enumerated form (#1961)", () => {
  for (const { name, body } of APPROVAL_CODE_SPAN_FIXTURES) {
    const stripped = stripNonAssertionMarkdown(body);
    assert.doesNotMatch(
      stripped,
      /approve release/i,
      `${name} must be treated as code (marker stripped): ${JSON.stringify(body)}`,
    );
  }
});

test("the internal gate refuses approval for every enumerated code-span form (#1961)", () => {
  // This is the nested-backtick fail-open the external reviewer caught on #1954,
  // now caught by the internal gate: no fixture form may satisfy the gate.
  for (const { name, body } of APPROVAL_CODE_SPAN_FIXTURES) {
    const decision = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(
      decision.approved,
      false,
      `${name} must not approve: ${JSON.stringify(body)}`,
    );
    assert.ok(decision.refusal && decision.refusal.length > 0);
  }
});

test("buildCodeSpanFixtures is reusable for an arbitrary marker phrase (#1961)", () => {
  // AC: the coverage is reusable by any gate or reviewer validating marker
  // text, not one-off to the release phrase.
  const marker = "unlock deploy channel prod";
  const fixtures = buildCodeSpanFixtures(marker);
  assert.equal(fixtures.length, APPROVAL_CODE_SPAN_FIXTURES.length);
  for (const { name, body } of fixtures) {
    assert.doesNotMatch(
      stripNonAssertionMarkdown(body),
      new RegExp(marker, "i"),
      `${name} must strip the custom marker: ${JSON.stringify(body)}`,
    );
  }
  assert.throws(() => buildCodeSpanFixtures(""), /non-empty marker/);
});

test("positive control: a genuine top-level assertion is NOT stripped (#1961)", () => {
  // The stripper must not pass by deleting everything: a real approval with an
  // unrelated trailing inline code span still survives.
  const genuine = `${APPROVAL_MARKER} \`see notes\``;
  assert.match(stripNonAssertionMarkdown(genuine), /approve release/i);
});
