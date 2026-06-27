import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  PLAN_FILE_PROMOTE_ACTION,
  PLAN_FILE_PR_FRONT_MATTER_KEY,
  parsePlanFrontMatter,
  readLinkedPrNumber,
  writeLinkedPrNumber,
  evaluatePromoteEligibility,
  buildPromotionPrBody,
} from "../src/loop/plan-file-promote-contract.mjs";

const READY = { baseSectionsValid: true, hasAcceptanceCriteria: true, hasDefinitionOfDone: true };

describe("plan-file-promote-contract: eligibility (ready gate)", () => {
  test("ready + no link → promote", () => {
    const result = evaluatePromoteEligibility(READY);
    assert.equal(result.ok, true);
    assert.equal(result.action, PLAN_FILE_PROMOTE_ACTION.PROMOTE);
    assert.equal(result.planFileIntakeState, "plan_refined_ready_for_promotion");
  });

  test("ready + existing PR link → already_promoted (idempotent)", () => {
    const result = evaluatePromoteEligibility({ ...READY, existingPrNumber: 42 });
    assert.equal(result.ok, true);
    assert.equal(result.action, PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED);
    assert.equal(result.existingPrNumber, 42);
  });

  test("not refined (needs refinement) → fail closed, no action", () => {
    const result = evaluatePromoteEligibility({
      baseSectionsValid: true,
      hasAcceptanceCriteria: false,
      hasDefinitionOfDone: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_promotion");
    assert.equal(result.action, undefined);
    assert.equal(result.planFileIntakeState, "new_plan_needs_refinement");
  });

  test("ambiguous (base invalid) → fail closed", () => {
    const result = evaluatePromoteEligibility({ ...READY, baseSectionsValid: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_promotion");
    assert.equal(result.planFileIntakeState, "ambiguous_fail_closed");
  });

  test("partially refined (only AC) → fail closed", () => {
    const result = evaluatePromoteEligibility({
      baseSectionsValid: true,
      hasAcceptanceCriteria: true,
      hasDefinitionOfDone: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_promotion");
  });
});

describe("plan-file-promote-contract: front-matter link", () => {
  test("parses no front-matter → empty object + full body", () => {
    const text = "# Plan\n\n## Status\nDraft.\n";
    const { frontMatter, body } = parsePlanFrontMatter(text);
    assert.deepEqual(frontMatter, {});
    assert.equal(body, text);
  });

  test("parses a leading front-matter block and strips it from body", () => {
    const text = "---\nprNumber: 7\nfoo: bar\n---\n# Plan\n\nbody\n";
    const { frontMatter, body } = parsePlanFrontMatter(text);
    assert.equal(frontMatter[PLAN_FILE_PR_FRONT_MATTER_KEY], "7");
    assert.equal(frontMatter.foo, "bar");
    assert.equal(body, "# Plan\n\nbody\n");
  });

  test("a `---` that is not at line 0 is not treated as front-matter", () => {
    const text = "# Plan\n\n---\nprNumber: 7\n---\n";
    const { frontMatter, body } = parsePlanFrontMatter(text);
    assert.deepEqual(frontMatter, {});
    assert.equal(body, text);
  });

  test("front-matter parsing ignores prototype-pollution keys from untrusted plans", () => {
    const text = "---\n__proto__: polluted\nconstructor: x\nprototype: y\nprNumber: 7\n---\n# Plan\n";
    const { frontMatter } = parsePlanFrontMatter(text);
    assert.equal(frontMatter.prNumber, "7");
    // The dangerous keys are dropped, and the object prototype is untouched.
    assert.equal(Object.prototype.hasOwnProperty.call(frontMatter, "__proto__"), false);
    assert.equal(Object.getPrototypeOf(frontMatter), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(readLinkedPrNumber(text), 7);
  });

  test("readLinkedPrNumber returns the number when present and valid", () => {
    assert.equal(readLinkedPrNumber("---\nprNumber: 12\n---\n# Plan\n"), 12);
    assert.equal(readLinkedPrNumber("# Plan\n"), null);
    assert.equal(readLinkedPrNumber("---\nprNumber: notanumber\n---\n# Plan\n"), null);
    assert.equal(readLinkedPrNumber("---\nprNumber: 0\n---\n# Plan\n"), null);
  });

  test("writeLinkedPrNumber adds a fresh block to a plan that had none", () => {
    const text = "# Plan\n\n## Status\nDraft.\n";
    const out = writeLinkedPrNumber(text, 99);
    assert.equal(out, "---\nprNumber: 99\n---\n# Plan\n\n## Status\nDraft.\n");
    assert.equal(readLinkedPrNumber(out), 99);
  });

  test("writeLinkedPrNumber preserves other keys and replaces prNumber; idempotent", () => {
    const text = "---\nfoo: bar\nprNumber: 1\n---\n# Plan\n";
    const out = writeLinkedPrNumber(text, 5);
    const { frontMatter, body } = parsePlanFrontMatter(out);
    assert.equal(frontMatter.foo, "bar");
    assert.equal(frontMatter.prNumber, "5");
    assert.equal(body, "# Plan\n");
    // round-trip with the same number reproduces the same text
    assert.equal(writeLinkedPrNumber(out, 5), out);
  });

  test("writeLinkedPrNumber rejects a non-positive-integer prNumber", () => {
    assert.throws(() => writeLinkedPrNumber("# Plan\n", 0));
    assert.throws(() => writeLinkedPrNumber("# Plan\n", -1));
    assert.throws(() => writeLinkedPrNumber("# Plan\n", 1.5));
  });
});

describe("plan-file-promote-contract: PR body", () => {
  const args = {
    planDocPath: "docs/phases/phase-4.md",
    acceptanceCriteria: "- AC one.\n- AC two.",
    definitionOfDone: "- DoD one.\n- DoD two.",
  };

  test("carries the full AC + DoD and references the plan doc path", () => {
    const body = buildPromotionPrBody(args);
    assert.match(body, /docs\/phases\/phase-4\.md/u);
    assert.match(body, /## Acceptance criteria/u);
    assert.match(body, /- AC one\./u);
    assert.match(body, /- AC two\./u);
    assert.match(body, /## Definition of done/u);
    assert.match(body, /- DoD one\./u);
    assert.match(body, /- DoD two\./u);
  });

  test("does not reference an issue (no issue is ever minted)", () => {
    const body = buildPromotionPrBody(args);
    assert.doesNotMatch(body, /Closes #\d+/u);
    assert.doesNotMatch(body, /Fixes #\d+/u);
  });

  test("fails closed on missing pieces", () => {
    assert.throws(() => buildPromotionPrBody({ ...args, planDocPath: "" }));
    assert.throws(() => buildPromotionPrBody({ ...args, acceptanceCriteria: "" }));
    assert.throws(() => buildPromotionPrBody({ ...args, definitionOfDone: "" }));
  });
});
