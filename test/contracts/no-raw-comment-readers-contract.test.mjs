import { assert, readRepo, readdir, test } from "../imported-assets-helpers.mjs";

// GATE-REVIEW-COMMENT-TRUST (ADR 0248): agent prose must not tell an agent to read comment or review
// text with raw gh. That text is untrusted data and must pass a script that applies isTrustedCommentAuthor.
const RAW_READERS = [
  /gh (?:issue|pr) view\b[^\n]*--comments/,
  /gh (?:issue|pr) view\b[^\n]*--json\b[^\n]*\b(?:comments|reviews)\b/,
  /gh api\b[^\n]*(?:issues|pulls)\/[^\s`]*\/(?:comments|reviews)/,
  /gh api graphql\b[^\n]*reviewThreads/,
];
// A line is allowed when it writes (POST/PATCH/DELETE) or when a negation precedes the raw command.
const WRITE_VERB = /\b(?:DELETE|POST|PATCH)\b/;
const NEGATION = /\b(?:never|do not|must not|forbidden)\b/i;

async function markdownFiles(dir) {
  const entries = await readdir(new URL(`../../${dir}`, import.meta.url), { recursive: true });
  return entries.filter((entry) => entry.endsWith(".md")).map((entry) => `${dir}/${entry}`);
}

test("skills/ and agents/ prose never tells an agent to read comments or reviews with raw gh", async () => {
  const hits = [];
  for (const file of [...await markdownFiles("skills"), ...await markdownFiles("agents")]) {
    const lines = (await readRepo(file)).split("\n");
    lines.forEach((line, index) => {
      if (WRITE_VERB.test(line)) return;
      const raw = RAW_READERS.map((pattern) => pattern.exec(line)).find(Boolean);
      if (raw && !NEGATION.test(line.slice(0, raw.index))) hits.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
