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

  test("a CSV-string allowedRefs is comma-split, not character-split", () => {
    const body = "Deliberate cross-ref to issue #1670, approved.";
    // Array.from over a bare string would character-split "1670" into
    // ["1","6","7","0"], silently allowlisting every single-digit ref while
    // still refusing 1670 itself — the opposite of the caller's intent.
    assert.equal(guardCommentBodyNoIssuePrIds(body, { allowedRefs: "1670" }), body);
    assert.equal(
      guardCommentBodyNoIssuePrIds("cross-refs #1670 and #9000 both allowed", { allowedRefs: "1670, 9000" }),
      "cross-refs #1670 and #9000 both allowed",
    );
    // a single-digit ref is NOT silently allowed as a side effect of the split
    assert.throws(() => guardCommentBodyNoIssuePrIds("see #1", { allowedRefs: "1670" }), /#1\b/);
  });

  test("does not match #digits inside an HTML numeric character reference", () => {
    assert.deepEqual(extractIssuePrIds("entity-encoded bracket: &#91;checkbox&#93;"), []);
    assert.equal(
      guardCommentBodyNoIssuePrIds("summary: &#91;x&#93; done", { ref: "inline finding" }),
      "summary: &#91;x&#93; done",
    );
    // a genuine bare id right next to an entity is still refused
    assert.throws(
      () => guardCommentBodyNoIssuePrIds("&#91;see #123&#93;"),
      /#123/,
    );
    // the SAME digit run as a well-formed entity AND as a bare id in one body:
    // the entity occurrence is excluded, the bare occurrence still refuses —
    // exclusion is per-occurrence, never per-id.
    assert.deepEqual(extractIssuePrIds("&#91; and bare #91 too"), ["91"]);
    assert.throws(
      () => guardCommentBodyNoIssuePrIds("&#91; and bare #91 too"),
      /#91/,
    );
  });

  test("the numeric-character-reference exclusion requires BOTH the leading `&` AND the terminating `;` (well-formed &#<digits>; only)", () => {
    // Well-formed entity: excluded.
    assert.deepEqual(extractIssuePrIds("&#91;"), []);
    // No terminating `;`: not a well-formed entity, still a refused auto-link
    // candidate — even though it happens to be `&`-preceded.
    assert.deepEqual(extractIssuePrIds("&#91 no semicolon"), ["91"]);
    // Bare `#<digits>`, no `&` at all: still refused.
    assert.deepEqual(extractIssuePrIds("bare #123"), ["123"]);
    // An `&`-preceded, issue-length digit run with no terminating `;` reads
    // exactly like a real auto-link candidate that happens to sit after an
    // ampersand (e.g. a query-string fragment) — the exclusion must not
    // swallow it just because it starts with `&#`.
    assert.deepEqual(extractIssuePrIds("A&#123 forms"), ["123"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("A&#123 forms"), /#123/);
    // Third non-entity shape from the docblock: `;`-followed with no leading
    // `&` — a bare id that happens to precede a semicolon still refuses.
    assert.deepEqual(extractIssuePrIds("see #456; details follow"), ["456"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("see #456; details follow"), /#456/);
  });

  test("an entity decoding to the hash character followed by a digit run is treated as a bare id (renders as an auto-link)", () => {
    // decimal form
    assert.deepEqual(extractIssuePrIds("see &#35;123 there"), ["123"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("see &#35;123 there"), /#123/);
    // hex form, case-insensitive
    assert.deepEqual(extractIssuePrIds("see &#x23;456 there"), ["456"]);
    assert.deepEqual(extractIssuePrIds("see &#X23;789 there"), ["789"]);
    // an allowlisted id is still allowed through the encoded form
    assert.equal(
      guardCommentBodyNoIssuePrIds("see &#35;123 there", { allowedRefs: ["123"] }),
      "see &#35;123 there",
    );
    // a hash-entity with no digit run after it stays inert
    assert.deepEqual(extractIssuePrIds("literal hash: &#35; alone"), []);
    // an unrelated entity whose code STARTS with the hash code point does not match
    assert.deepEqual(extractIssuePrIds("&#3512; is one character"), []);
    // zero-padded forms decode identically and are refused too
    assert.deepEqual(extractIssuePrIds("see &#035;321 there"), ["321"]);
    assert.deepEqual(extractIssuePrIds("see &#0035;654 there"), ["654"]);
    assert.deepEqual(extractIssuePrIds("see &#x0023;987 there"), ["987"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("see &#035;321 there"), /#321/);
  });

  test("the HTML5 named entity for the hash character followed by a digit run is treated as a bare id", () => {
    // &num; is a real HTML5 named entity for the hash code point; GitHub
    // decodes it, so &num;123 renders as the #123 auto-link.
    assert.deepEqual(extractIssuePrIds("see &num;123 there"), ["123"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("see &num;123 there"), /#123/);
    // Case-variants do not decode on GitHub, but the guard over-refuses them
    // deliberately (fail-closed on a suspicious near-miss).
    assert.deepEqual(extractIssuePrIds("see &NUM;456 there"), ["456"]);
    // The named entity with no digit run after it stays inert.
    assert.deepEqual(extractIssuePrIds("a literal hash: &num; alone"), []);
    // A different named entity followed by digits does not match.
    assert.deepEqual(extractIssuePrIds("&nbsp;123 stays"), []);
    // An allowlisted id is still allowed through the named form.
    assert.equal(
      guardCommentBodyNoIssuePrIds("see &num;123 there", { allowedRefs: ["123"] }),
      "see &num;123 there",
    );
  });

  // Decode-aware extraction on the DIGIT side: GitHub decodes entity-encoded
  // digits too, so an id assembled from entity pieces still renders as a live
  // auto-link and must refuse. A double-encoded form renders as inert literal
  // text (the renderer decodes once) and must NOT refuse.
  test("an id assembled from entity-encoded digits is treated as a bare id", () => {
    // literal hash + encoded first digit
    assert.deepEqual(extractIssuePrIds("see #&#49;23 there"), ["123"]);
    assert.throws(() => guardCommentBodyNoIssuePrIds("see #&#49;23 there"), /#123/);
    // encoded hash + mixed literal/encoded digits (hex form included)
    assert.deepEqual(extractIssuePrIds("see &#35;&#49;2&#x33; there"), ["123"]);
    // named hash entity + encoded digit
    assert.deepEqual(extractIssuePrIds("see &num;&#52;2 there"), ["42"]);
    // cmark-gfm decodes numeric references up to 8 digits (decimal or hex):
    // maximally padded hash forms still refuse.
    assert.deepEqual(extractIssuePrIds("see &#00000035;77 there"), ["77"]);
    assert.deepEqual(extractIssuePrIds("see &#x00000023;88 there"), ["88"]);
    // allowlist still works through the assembled form
    assert.equal(
      guardCommentBodyNoIssuePrIds("see #&#49;23 there", { allowedRefs: ["123"] }),
      "see #&#49;23 there",
    );
  });

  test("the single-pass decode never manufactures a refusal from a double-encoded form", () => {
    // Both forms render as inert literal entity text (the renderer decodes
    // once). The named double-encoded form extracts nothing. The numeric
    // double-encoded form was already over-refused BEFORE the decode pass —
    // the raw scan sees the inner hash-digit run in a non-entity context
    // (preceded by the semicolon of the outer entity) — and stays refused:
    // pre-existing fail-closed behavior, not a decode regression.
    assert.deepEqual(extractIssuePrIds("see &amp;num;123 there"), []);
    assert.deepEqual(extractIssuePrIds("see &amp;#35;123 there"), ["35"]);
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
