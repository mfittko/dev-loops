import { assert, readRepo, readdir, test } from "../imported-assets-helpers.mjs";

// GATE-REVIEW-COMMENT-TRUST (ADR 0248): agent prose must not tell an agent to read comment or review
// text with raw gh. That text is untrusted data and must pass a script that applies isTrustedCommentAuthor.
const RAW_READERS = [
  /gh (?:issue|pr) view\b[^\n]*--comments/,
  /gh (?:issue|pr) view\b[^\n]*--json\b[^\n]*\b(?:comments|reviews)\b/,
  /gh api\b[^\n]*(?:issues|pulls)\/[^\s`]*\/(?:comments|reviews)/,
  /gh api graphql\b[^\n]*reviewThreads/,
];
// A raw reader command is exempt only when (a) the command text itself carries an explicit write method
// flag, or (b) a negation word precedes it in the same sentence. Nothing outside the command exempts it.
const WRITE_FLAG = /(?:-X|--method)[ =]+(?:POST|PATCH|DELETE|PUT)\b/;
const NEGATION = /\b(?:never|do not|must not|forbidden|banned)\b/i;

// One gh command runs to a backtick, sentence end, shell joiner or a clause joiner ("..., then gh ...").
// A comma inside the arguments (GraphQL "owner: o, name: r") does not end it.
const COMMAND = /gh (?:issue|pr|api)\b(?:(?!&&|\|\||[|;]|[.!?](?=\s|$)|,\s+(?:then|and|or|gh)\b|\s(?:and|then|or)\s+gh\b)[^`\n])*/g;

function isRawReaderLine(line) {
  return [...line.matchAll(COMMAND)].some(({ 0: command, index }) => {
    if (!RAW_READERS.some((pattern) => pattern.test(command)) || WRITE_FLAG.test(command)) return false;
    const sentence = line.slice(0, index).split(/[.!?](?=\s)/).pop();
    return !NEGATION.test(sentence);
  });
}

test("the matcher flags raw reader forms and exempts negated and write lines", () => {
  for (const line of [
    "gh api repos/{owner}/{repo}/pulls/{number}/reviews",
    "gh pr view --comments",
    "gh issue view --comments",
    "gh pr view 1 --json comments,reviews",
    "gh api graphql -f query='{ repository { pullRequest { reviewThreads { nodes { id } } } } }'",
    "gh api graphql -f query='{ repository(owner: \"o\", name: \"r\") { pullRequest(number: 1) { reviewThreads { nodes { id } } } } }'",
    "Read `gh api repos/o/r/pulls/1/reviews`, then POST a reply.",
    "Run gh pr view 1 --comments, then gh api -X POST repos/o/r/issues/1/comments.",
    "Run `gh api -X POST repos/o/r/issues/1/comments` and then `gh pr view 1 --comments`.",
    "gh pr view 1 --comments && gh api -X POST repos/o/r/issues/1/comments",
    "gh api -X POST repos/o/r/issues/1/comments and gh pr view 1 --comments",
    "gh api -X POST repos/o/r/issues/1/comments | gh pr view 1 --comments",
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
