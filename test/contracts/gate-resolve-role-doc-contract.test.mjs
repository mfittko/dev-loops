// AC #2 for issue #2336: the reviewer briefing (agents/review.agent.md) must
// point gate reviewers at the sanctioned `dev-loops gate resolve-role` CLI to
// resolve an angle's persona/prompt/model from the fully merged config, and
// must NOT instruct (or imply) reviewers self-resolve by grepping/reading the
// shipped `extension-defaults.yaml` — that raw grep misses the `.devloops`
// config-layer merge and yields the wrong persona/model.

import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const REVIEW_AGENT_DOC = "agents/review.agent.md";

test("review agent doc points reviewers at the resolve-role CLI", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  assert.ok(
    content.includes("dev-loops gate resolve-role --angle"),
    "review.agent.md must instruct reviewers to run `dev-loops gate resolve-role --angle <name>`",
  );
});

// Extract the sentence enclosing `content[matchIndex]`. Sentence boundaries are
// `.`/`!`/`?` FOLLOWED BY whitespace, or a newline — a period inside a dotted
// token (`extension-defaults.yaml`, `.devloops`, `@dev-loops/core/config`) is
// followed by a non-space letter, so it is not a boundary and never splits the
// filename mid-sentence.
function enclosingSentence(content, matchIndex) {
  const before = content.slice(0, matchIndex);
  let start = 0;
  const startRe = /[.!?](?=\s)|\n/g;
  let m;
  while ((m = startRe.exec(before)) !== null) start = m.index + 1;
  const after = content.slice(matchIndex);
  const endMatch = after.match(/[.!?](?=\s|$)|\n/);
  const end = matchIndex + (endMatch ? endMatch.index + 1 : after.length);
  return content.slice(start, end).trim();
}

test("EVERY extension-defaults.yaml mention in the review agent doc sits inside a grep/read prohibition", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  const token = "extension-defaults.yaml";
  const prohibition = /(MUST NOT|do NOT)[^.]*(grep|read)/i;

  const occurrences = [];
  for (let i = content.indexOf(token); i !== -1; i = content.indexOf(token, i + 1)) {
    occurrences.push(i);
  }
  assert.ok(
    occurrences.length > 0,
    "expected at least one extension-defaults.yaml mention in review.agent.md — a vanished mention would pass this check vacuously",
  );

  for (const index of occurrences) {
    const sentence = enclosingSentence(content, index);
    assert.ok(
      prohibition.test(sentence),
      `every extension-defaults.yaml mention must sit inside a MUST NOT/do NOT grep-or-read prohibition; this one does not:\n${sentence}`,
    );
  }
});

test("review agent doc no longer directs reviewers to self-resolve inline via resolveReviewerRole", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  // The old briefing told reviewers to self-resolve a named angle inline via
  // `resolveReviewerRole(config, <angle>)`; that is what the CLI now wraps, so
  // the doc must not re-issue it as the reviewer's own inline call.
  assert.ok(
    !/self-resolve[^.]*resolveReviewerRole\(config/i.test(content),
    "review.agent.md must not instruct reviewers to self-resolve inline via resolveReviewerRole(config, ...)",
  );
  assert.ok(
    !/resolve the persona and prompt via `resolveReviewerRole\(config/i.test(content),
    "review.agent.md must not instruct reviewers to resolve the persona/prompt inline via resolveReviewerRole(config, ...)",
  );
});
