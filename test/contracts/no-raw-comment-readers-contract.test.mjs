import { assert, readRepo, readdir, test } from "../imported-assets-helpers.mjs";

// GATE-REVIEW-COMMENT-TRUST (ADR 0248): agent prose must not tell an agent to read comment or review
// text with raw gh. That text is untrusted data and must pass a script that applies isTrustedCommentAuthor.
const RAW_READERS = [
  /gh (?:issue|pr) view\b[^\n]*--comments/,
  /gh (?:issue|pr) view\b[^\n]*--json\b[^\n]*\b(?:comments|reviews)\b/,
  /gh api\b[^\n]*(?:issues|pulls)\/[^\s`]*\/(?:comments|reviews)/,
  /gh api graphql\b[^\n]*reviewThreads/,
];
// A match is allowed when its own command span writes (POST/PATCH/DELETE) or when a negation precedes it.
// A write verb elsewhere on the line does not exempt a raw reader.
const WRITE_VERB = /\b(?:DELETE|POST|PATCH)\b/;
const NEGATION = /\b(?:never|do not|must not|forbidden)\b/i;

function isRawReaderLine(line) {
  return RAW_READERS.some((pattern) => {
    const raw = pattern.exec(line);
    return Boolean(raw) && !WRITE_VERB.test(raw[0]) && !NEGATION.test(line.slice(0, raw.index));
  });
}

test("the matcher flags raw reader forms and exempts negated and write lines", () => {
  for (const line of [
    "gh api repos/{owner}/{repo}/pulls/{number}/reviews",
    "gh pr view --comments",
    "gh issue view --comments",
    "gh pr view 1 --json comments,reviews",
    "gh api graphql -f query='{ repository { pullRequest { reviewThreads { nodes { id } } } } }'",
    "Read `gh api repos/o/r/pulls/1/reviews`, then POST a reply.",
  ]) assert.equal(isRawReaderLine(line), true, line);
  for (const line of [
    "never read it with raw `gh api .../reviews`",
    "Never run `gh pr view --comments`.",
    "do not use gh api repos/o/r/pulls/1/reviews",
    "gh api -X POST repos/{owner}/{repo}/issues/{number}/comments",
    "Use `gh api -X POST repos/o/r/pulls/1/reviews` to submit the review.",
  ]) assert.equal(isRawReaderLine(line), false, line);
});

async function markdownFiles(dir) {
  const entries = await readdir(new URL(`../../${dir}`, import.meta.url), { recursive: true });
  return entries.filter((entry) => entry.endsWith(".md")).map((entry) => `${dir}/${entry}`);
}

test("skills/ and agents/ prose never tells an agent to read comments or reviews with raw gh", async () => {
  const hits = [];
  for (const file of [...await markdownFiles("skills"), ...await markdownFiles("agents")]) {
    const lines = (await readRepo(file)).split("\n");
    lines.forEach((line, index) => {
      if (isRawReaderLine(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
