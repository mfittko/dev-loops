import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  DEFAULT_MAX_SUPERSEDED_MINIMIZE,
  minimizeSupersededGateReviews,
  parseGateReviewHeadAndGate,
  selectSupersededGateReviewIds,
} from "../../scripts/github/_minimize-superseded-verdicts.mjs";

const HEAD_A = "f1a62cf978ef9cd2ca42b9c8684101cd9d3f84cc";
const HEAD_B = "bb7fa8c4e4d52155deeb6f5742a73df8bda0fcc3";
const HEAD_CUR = "050d262a0000000000000000000000000000abcd";

function markerReview(id, gate, head, { round = 3, minimized = false } = {}) {
  return {
    id,
    isMinimized: minimized,
    body: `### Gate review: \`${gate}\`\n<!-- dev-loops:gate-findings-review ${gate} ${head} round=${round} -->\n\n**Reviewed head SHA:** \`${head}\`\n**Verdict:** findings_present`,
  };
}

function bareReview(id, gate, head, { minimized = false } = {}) {
  // A round-less verdict post: no marker, only the visible header.
  return {
    id,
    isMinimized: minimized,
    body: `### Gate review: \`${gate}\`\n\n**Reviewed head SHA:** \`${head}\`\n**Verdict:** clean`,
  };
}

test("parseGateReviewHeadAndGate reads the marker, then falls back to the visible header", () => {
  assert.deepEqual(
    parseGateReviewHeadAndGate(markerReview("x", "draft_gate", HEAD_A).body),
    { gate: "draft_gate", headSha: HEAD_A },
  );
  assert.deepEqual(
    parseGateReviewHeadAndGate(bareReview("x", "pre_approval_gate", HEAD_B).body),
    { gate: "pre_approval_gate", headSha: HEAD_B },
  );
  assert.equal(parseGateReviewHeadAndGate("just a normal comment"), null);
  assert.equal(parseGateReviewHeadAndGate(""), null);
  assert.equal(parseGateReviewHeadAndGate(null), null);
});

test("selects prior same-gate reviews, skips the current head, the other gate, and already-minimized", () => {
  const reviews = [
    markerReview("R_a", "draft_gate", HEAD_A),
    markerReview("R_b", "draft_gate", HEAD_B),
    markerReview("R_cur", "draft_gate", HEAD_CUR), // current head → keep
    markerReview("R_pre", "pre_approval_gate", HEAD_A), // other gate → keep
    markerReview("R_min", "draft_gate", HEAD_B, { minimized: true }), // already folded
    { id: "R_plain", isMinimized: false, body: "a normal review" }, // not a verdict
  ];

  const { ids, overflow } = selectSupersededGateReviewIds({ reviews, gate: "draft_gate", currentHeadSha: HEAD_CUR });
  assert.deepEqual(ids.sort(), ["R_a", "R_b"]);
  assert.equal(overflow, 0);
});

test("a new pre_approval verdict folds only prior pre_approval verdicts, never draft", () => {
  const reviews = [
    markerReview("D_a", "draft_gate", HEAD_A),
    markerReview("P_a", "pre_approval_gate", HEAD_A),
    markerReview("P_b", "pre_approval_gate", HEAD_B),
  ];
  const { ids } = selectSupersededGateReviewIds({ reviews, gate: "pre_approval_gate", currentHeadSha: HEAD_CUR });
  assert.deepEqual(ids.sort(), ["P_a", "P_b"]);
});

test("the cap bounds the fan-out and reports the overflow", () => {
  const reviews = Array.from({ length: 5 }, (_, i) => markerReview(`R_${i}`, "draft_gate", `${"a".repeat(39)}${i}`));
  const { ids, overflow } = selectSupersededGateReviewIds({ reviews, gate: "draft_gate", currentHeadSha: HEAD_CUR, max: 3 });
  assert.equal(ids.length, 3);
  assert.equal(overflow, 2);
});

test("malformed inputs select nothing rather than throwing", () => {
  assert.deepEqual(selectSupersededGateReviewIds({ reviews: null, gate: "draft_gate", currentHeadSha: HEAD_CUR }).ids, []);
  assert.deepEqual(selectSupersededGateReviewIds({ reviews: [markerReview("x", "draft_gate", HEAD_A)], gate: "draft_gate", currentHeadSha: "" }).ids, []);
});

test("minimizeSupersededGateReviews folds the prior reviews and reports the count", async () => {
  const minimized = [];
  const result = await minimizeSupersededGateReviews(
    { owner: "o", name: "r", pr: 2247, gate: "draft_gate", currentHeadSha: HEAD_CUR },
    {
      listReviewsImpl: async () => [
        markerReview("R_a", "draft_gate", HEAD_A),
        markerReview("R_b", "draft_gate", HEAD_B),
        markerReview("R_cur", "draft_gate", HEAD_CUR),
      ],
      minimizeImpl: async (id) => { minimized.push(id); },
    },
  );
  assert.deepEqual(result, { ok: true, minimized: 2, overflow: 0 });
  assert.deepEqual(minimized.sort(), ["R_a", "R_b"]);
});

test("a failed list is swallowed into a warning, never thrown", async () => {
  const result = await minimizeSupersededGateReviews(
    { owner: "o", name: "r", pr: 1, gate: "draft_gate", currentHeadSha: HEAD_CUR },
    { listReviewsImpl: async () => { throw new Error("rate limit"); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.minimized, 0);
  assert.match(result.warning, /best-effort.*rate limit/);
});

test("one failed minimize does not abort the rest and never throws", async () => {
  const minimized = [];
  const result = await minimizeSupersededGateReviews(
    { owner: "o", name: "r", pr: 1, gate: "draft_gate", currentHeadSha: HEAD_CUR },
    {
      listReviewsImpl: async () => [
        markerReview("R_a", "draft_gate", HEAD_A),
        markerReview("R_b", "draft_gate", HEAD_B),
      ],
      minimizeImpl: async (id) => {
        if (id === "R_a") { throw new Error("forbidden"); }
        minimized.push(id);
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.minimized, 1);
  assert.deepEqual(minimized, ["R_b"]);
  assert.match(result.warning, /1\/2.*forbidden/);
});

test("the review gate is a no-op: it posts no head-keyed verdict that supersedes", async () => {
  let listed = false;
  const result = await minimizeSupersededGateReviews(
    { owner: "o", name: "r", pr: 1, gate: "review", currentHeadSha: HEAD_CUR },
    { listReviewsImpl: async () => { listed = true; return []; } },
  );
  assert.deepEqual(result, { ok: true, minimized: 0, overflow: 0 });
  assert.equal(listed, false);
});

test("the default cap is a bounded, sane number", () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_SUPERSEDED_MINIMIZE) && DEFAULT_MAX_SUPERSEDED_MINIMIZE > 0 && DEFAULT_MAX_SUPERSEDED_MINIMIZE <= 200);
});
