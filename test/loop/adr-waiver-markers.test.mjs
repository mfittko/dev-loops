import assert from "node:assert/strict";
import { test } from "bun:test";

import { operatorOwnedCommentLineRefusal } from "../../scripts/loop/adr-waiver-markers.mjs";

const SHA = "a".repeat(40);

test("operatorOwnedCommentLineRefusal: refuses approval-marker lines", () => {
  for (const body of [`approve merge ${SHA}`, "Approve Merge", "> approve merge x", "- approve merge", "approve merge", `ok\n  * approve   merge ${SHA}\nbye`]) {
    assert.match(operatorOwnedCommentLineRefusal(body), /OPERATOR-OWNED-LINE.*approve merge.*operator/s, body);
  }
});

test("operatorOwnedCommentLineRefusal: refuses waiver lines and names the sanctioned writer", () => {
  const msg = operatorOwnedCommentLineRefusal("text\nadr-tripwire:allow standing-authorization head=x");
  assert.match(msg, /OPERATOR-OWNED-LINE.*adr-tripwire:allow.*waive-adr-tripwire/s);
});

test("operatorOwnedCommentLineRefusal: accepts mid-line mentions", () => {
  for (const body of ["disapprove merge", "not approve merge", "the operator must type approve merge <sha>", "use `adr-tripwire:allow` in a sentence", "approve mergeable", ""]) {
    assert.equal(operatorOwnedCommentLineRefusal(body), null, body);
  }
});
