import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCarryForwardPlan,
  parseResolveAngleCarryForwardCliArgs,
} from "../../scripts/github/resolve-angle-carry-forward.mjs";

const cleanLog = {
  headSha: "aaaaaaa",
  verdict: "clean",
  provenance: {
    distinctReviewers: 3,
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "coverage", reviewer: "review-b" },
      { angle: "docs", reviewer: "review-c" },
    ],
  },
};

test("buildCarryForwardPlan carries code angles on a doc-only delta, marks provenance honestly", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["docs/guide.md"] });
  assert.equal(plan.prevHead, "aaaaaaa");
  const carriedAngles = plan.carried.map((c) => c.angle).sort();
  assert.deepEqual(carriedAngles, ["correctness", "coverage"]);
  // Carried verdict records the prior head + the prior reviewer (not fabricated).
  const correctness = plan.carried.find((c) => c.angle === "correctness");
  assert.equal(correctness.carriedFromHead, "aaaaaaa");
  assert.equal(correctness.reviewer, "review-a");
  // docs angle's surface changed -> must re-run.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle), ["docs"]);
});

test("buildCarryForwardPlan re-runs code angles but carries the docs angle on a code delta", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["src/foo.mjs"] });
  // Code delta touches correctness + coverage surfaces; docs surface untouched.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle).sort(), ["correctness", "coverage"]);
  assert.deepEqual(plan.carried.map((c) => c.angle), ["docs"]);
});

test("buildCarryForwardPlan fails closed on a non-clean or missing prior log", () => {
  assert.throws(() => buildCarryForwardPlan({ log: null, changedFiles: ["docs/x.md"] }), /not found or unreadable/);
  assert.throws(
    () => buildCarryForwardPlan({ log: { ...cleanLog, verdict: "findings_present" }, changedFiles: ["docs/x.md"] }),
    /not "clean"/,
  );
  assert.throws(
    () => buildCarryForwardPlan({ log: { headSha: "aaaaaaa", verdict: "clean", provenance: { distinctReviewers: 0, perAngle: [] } }, changedFiles: ["docs/x.md"] }),
    /no provenance\.perAngle reviewers/,
  );
});

test("parseResolveAngleCarryForwardCliArgs requires the core args", () => {
  assert.throws(() => parseResolveAngleCarryForwardCliArgs(["--repo", "o/n"]), /Missing required arguments/);
  const opts = parseResolveAngleCarryForwardCliArgs([
    "--repo", "o/n", "--pr", "5", "--gate", "draft_gate", "--prev-head", "aaaaaaa", "--head-sha", "bbbbbbb",
  ]);
  assert.equal(opts.gate, "draft_gate");
  assert.equal(opts.prevHead, "aaaaaaa");
  assert.equal(opts.headSha, "bbbbbbb");
});
