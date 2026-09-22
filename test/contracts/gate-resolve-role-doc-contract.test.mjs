// AC #2 for issue #2336: the reviewer briefing (agents/review.agent.md) must
// point gate reviewers at the sanctioned `gate resolve-role` CLI to resolve an
// angle's persona/prompt/model from the fully merged config, and must NOT
// instruct (or imply) reviewers self-resolve by grepping/reading the shipped
// `extension-defaults.yaml` — that raw grep misses the `.devloops`
// config-layer merge and yields the wrong persona/model.
//
// The CLI invocation must use the PORTABLE LAUNCHER FORM (`dev-loops-run
// cli/index.mjs gate resolve-role ...`), never the bare `dev-loops gate
// resolve-role` form: a plugin-only install ships no bare `dev-loops` on PATH,
// so the bare form hard-fails there and drops the reviewer to the raw-defaults
// grep AC1 exists to eliminate. The runtime suffix (buildAngleNamingSuffix) and
// the generated `.claude` mirrors already use the launcher form; these
// hand-authored surfaces must not drift back to the bare form.

import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const REVIEW_AGENT_DOC = "agents/review.agent.md";
const COPILOT_SKILL = "skills/copilot-pr-followup/SKILL.md";
const SUB_LOOP_CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";
const COMMENT_CONTRACT = "skills/docs/gate-review-comment-contract.md";

const LAUNCHER_FORM = "dev-loops-run cli/index.mjs gate resolve-role --angle";
const BARE_FORM = "dev-loops gate resolve-role --angle";

// Every hand-authored reviewer-facing surface that names the resolve-role CLI.
const CLI_POINTER_SURFACES = [
  REVIEW_AGENT_DOC,
  COPILOT_SKILL,
  SUB_LOOP_CONTRACT,
  COMMENT_CONTRACT,
];

test("review agent doc points reviewers at the resolve-role CLI in the portable launcher form", async () => {
  const content = await readRepo(REVIEW_AGENT_DOC);
  assert.ok(
    content.includes(LAUNCHER_FORM),
    `review.agent.md must instruct reviewers to run \`${LAUNCHER_FORM} <name>\``,
  );
});

test("EVERY reviewer-facing resolve-role surface uses the portable launcher form, never the bare form", async () => {
  for (const relPath of CLI_POINTER_SURFACES) {
    const content = await readRepo(relPath);
    assert.ok(
      content.includes(LAUNCHER_FORM),
      `${relPath} must name the portable launcher form \`${LAUNCHER_FORM} <name>\``,
    );
    assert.ok(
      !content.includes(BARE_FORM),
      `${relPath} must not use the bare \`${BARE_FORM} <name>\` form — it hard-fails on a plugin-only install`,
    );
  }
});

test("copilot-pr-followup persona-mapping bullet names the resolve-role CLI, not the inline call", async () => {
  const content = await readRepo(COPILOT_SKILL);
  const bullet = content
    .split("\n")
    .find((line) => line.includes("**Persona mapping:**"));
  assert.ok(bullet, "copilot-pr-followup must carry a **Persona mapping:** bullet");
  assert.ok(
    bullet.includes(LAUNCHER_FORM),
    "the persona-mapping bullet must name the portable resolve-role CLI",
  );
  assert.ok(
    !/resolveReviewerRole\(config/.test(bullet),
    "the persona-mapping bullet must not instruct an inline resolveReviewerRole(config, ...) call",
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

test("the GATE-EXEC-BRIEFING-PREFIX owner contract no longer documents inline self-resolution", async () => {
  const content = await readRepo(SUB_LOOP_CONTRACT);
  // The doc that OWNS the emitted angle-suffix must describe the sanctioned CLI,
  // not the removed inline `resolveReviewerRole` self-resolution the PR replaced.
  assert.ok(
    !/self-resolve[^.]*resolveReviewerRole/i.test(content),
    "the sub-loop contract must not instruct reviewers to self-resolve inline via resolveReviewerRole",
  );
  assert.ok(
    content.includes(LAUNCHER_FORM),
    "the sub-loop contract must name the portable resolve-role CLI as what the emitted suffix instructs",
  );
});

test("the comment contract no longer documents inline resolveReviewerRole persona resolution", async () => {
  const content = await readRepo(COMMENT_CONTRACT);
  assert.ok(
    !/resolved via `resolveReviewerRole`/.test(content),
    "the comment contract must not describe persona resolution as the inline resolveReviewerRole call",
  );
});
