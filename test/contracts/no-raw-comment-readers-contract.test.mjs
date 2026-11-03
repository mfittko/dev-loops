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

// A command span ends at a backtick, a sentence boundary, a semicolon or a comma followed by space,
// so a write verb in one command never exempts a raw reader in another.
const SPAN_BREAK = /`|[.;!?](?=\s|$)|,\s/;

function isRawReaderLine(line) {
  let start = 0;
  const spans = [];
  line.split(new RegExp(`(${SPAN_BREAK.source})`)).forEach((part, index) => {
    if (index % 2 === 0) spans.push({ text: part, start }); // odd indexes are the captured breaks
    start += part.length;
  });
  return spans.some(({ text, start: spanStart }) => RAW_READERS.some((pattern) => {
    const raw = pattern.exec(text);
    return Boolean(raw) && !WRITE_VERB.test(text) && !NEGATION.test(line.slice(0, spanStart + raw.index));
  }));
}

test("the matcher flags raw reader forms and exempts negated and write lines", () => {
  for (const line of [
    "gh api repos/{owner}/{repo}/pulls/{number}/reviews",
    "gh pr view --comments",
    "gh issue view --comments",
    "gh pr view 1 --json comments,reviews",
    "gh api graphql -f query='{ repository { pullRequest { reviewThreads { nodes { id } } } } }'",
    "Read `gh api repos/o/r/pulls/1/reviews`, then POST a reply.",
    "Run gh pr view 1 --comments, then gh api -X POST repos/o/r/issues/1/comments.",
    "Run `gh api -X POST repos/o/r/issues/1/comments` and then `gh pr view 1 --comments`.",
  ]) assert.equal(isRawReaderLine(line), true, line);
  for (const line of [
    "never read it with raw `gh api .../reviews`",
    "Never run `gh pr view --comments`.",
    "do not use gh api repos/o/r/pulls/1/reviews",
    "gh api -X POST repos/{owner}/{repo}/issues/{number}/comments",
    "Use `gh api -X POST repos/o/r/pulls/1/reviews` to submit the review.",
    "Never run gh pr view 1 --comments. Use gh api -X POST repos/o/r/issues/1/comments instead.",
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
