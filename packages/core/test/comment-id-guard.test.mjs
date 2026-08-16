import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  extractIssuePrIds,
  guardCommentBodyNoIssuePrIds,
} from "../src/github/comment-id-guard.mjs";

describe("comment-id-guard (#1731 no-issue/PR-ids-in-comments)", () => {
  test("extractIssuePrIds finds raw #digits references", () => {
    assert.deepEqual(extractIssuePrIds("see issue #1670 and PR #123"), ["1670", "123"]);
    assert.deepEqual(extractIssuePrIds("no references here"), []);
    assert.deepEqual(extractIssuePrIds(null), []);
    assert.deepEqual(extractIssuePrIds(42), []);
    // dedupes
    assert.deepEqual(extractIssuePrIds("#5 #5 #6"), ["5", "6"]);
  });

  test("does not match hex SHAs or non-digit # tokens", () => {
    assert.deepEqual(extractIssuePrIds("head deb5837b21440cc757c2ae67430363584125d7d7"), []);
    assert.deepEqual(extractIssuePrIds("#deadbeef"), []);
    assert.deepEqual(extractIssuePrIds("round #1 heading #root"), ["1"]);
  });

  test("guard passes a clean body unchanged (no stripping)", () => {
    const body = "Verdict: clean. Reviewed head deb5837b.";
    assert.equal(guardCommentBodyNoIssuePrIds(body), body);
  });

  test("guard refuses (throws) a body containing a raw issue/PR id", () => {
    assert.throws(() => guardCommentBodyNoIssuePrIds("Depends on issue #1670"), /#1670/);
    assert.throws(() => guardCommentBodyNoIssuePrIds("See #123"), /#123/);
  });

  test("guard allows an explicitly allowlisted deliberate cross-reference", () => {
    const body = "Deliberate cross-ref to issue #1670, approved.";
    assert.equal(
      guardCommentBodyNoIssuePrIds(body, { allowedRefs: ["1670"] }),
      body,
    );
    // non-allowlisted id still refused even when another is allowed
    assert.throws(() => guardCommentBodyNoIssuePrIds("a #1670 b #999", { allowedRefs: ["1670"] }), /#999/);
  });

  test("a generated gate verdict body (the production render) contains no issue/PR id", () => {
    // Representative of renderGateReviewCommentBody output for a clean gate:
    // gate name, head SHA (hex), verdict, severity/angle labels — never a #digit.
    const verdictBody = [
      "### Gate review: `draft_gate`",
      "**Reviewed head SHA:** `deb5837b21440cc757c2ae67430363584125d7d7`",
      "**Verdict:** clean",
      "**Execution mode:** fanout_fanin",
      "- `correctness` → `clean`",
      "**Next action:** ready-for-review",
    ].join("\n");
    assert.deepEqual(extractIssuePrIds(verdictBody), []);
    // Guard passes it through without throwing.
    assert.equal(
      guardCommentBodyNoIssuePrIds(verdictBody, { ref: "gate verdict body" }),
      verdictBody,
    );
  });
});
