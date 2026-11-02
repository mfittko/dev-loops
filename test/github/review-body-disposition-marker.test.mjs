import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseReviewBodyDispositionMarkers } from "../../scripts/github/_copilot-body-disposition.mjs";

const FIX = "b".repeat(40);
const marker = (review = "PRR_R1", fix = FIX) => `<!-- dev-loops:review-body-disposition review=${review} fix=${fix} -->`;

test("a bare marker parses; text without one, and a non-string body, parse to nothing", () => {
  assert.deepEqual(parseReviewBodyDispositionMarkers(`${marker()}\nAddressed.`), [{ reviewId: "PRR_R1", fixSha: FIX }]);
  assert.deepEqual(parseReviewBodyDispositionMarkers("no marker"), []);
  assert.deepEqual(parseReviewBodyDispositionMarkers(null), []);
});

test("a marker inside an inline code span, a backtick fence, a tilde fence, an indented code block or a quote line is no marker", () => {
  const cases = {
    "code span": `see \`${marker()}\` here`,
    "backtick fence": `\`\`\`\n${marker()}\n\`\`\``,
    "tilde fence": `~~~\n${marker()}\n~~~`,
    "indented block": `text\n\n    ${marker()}\n`,
    "quote line": `> ${marker()}`,
  };
  for (const [name, body] of Object.entries(cases)) assert.deepEqual(parseReviewBodyDispositionMarkers(body), [], name);
});

test("one comment returns every bare marker, so the caller filters by review id", () => {
  const found = parseReviewBodyDispositionMarkers(`${marker("PRR_OTHER", "c".repeat(40))}\n${marker()}`);
  assert.deepEqual(found, [{ reviewId: "PRR_OTHER", fixSha: "c".repeat(40) }, { reviewId: "PRR_R1", fixSha: FIX }]);
});
