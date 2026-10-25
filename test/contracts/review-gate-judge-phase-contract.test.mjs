import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

const flat = (text) => text.replace(/\s+/gu, " ");

test("review SKILL.md orders the judge phase between the fan-in ledger and the verdict post, with the zero-finding skip", async () => {
  const skill = flat(await readRepo("skills/review/SKILL.md"));
  const fanIn = skill.indexOf("consolidate-fanin.mjs --gate review");
  const judge = skill.indexOf("Phase 3.5 — judge");
  const durableWrite = skill.indexOf("write-gate-findings-log.mjs` with `--findings-file");
  const post = skill.indexOf("scripts/github/upsert-checkpoint-verdict.mjs --repo <owner/repo> --pr <n> --gate review");
  assert.ok(fanIn >= 0 && fanIn < judge && judge < durableWrite && durableWrite < post, `order ${[fanIn, judge, durableWrite, post]}`);
  assert.match(skill, /A ledger with zero findings skips this phase/);
  assert.match(skill, /emit-judge-work-order\.mjs --gate review/);
  assert.match(skill, /judge-pass\.mjs --gate review/);
  assert.match(skill, /Pass no `--out`/);
});

test("review SKILL.md posts unjudged with the matching reason when judge-pass exits 1, never aborting the post", async () => {
  const skill = flat(await readRepo("skills/review/SKILL.md"));
  assert.match(skill, /judge-pass\.mjs` exits 1 .*never abort the post/);
  assert.match(skill, /--judge-spec-source unavailable --judge-unavailable-reason spec_cannot_decide/);
  assert.match(skill, /`judge_failed` \(any other failure\)/);
  assert.match(skill, /several closing issues are never merged/);
  assert.match(skill, /Each closing issue carries its repository/);
  assert.match(skill, /a body keyword matches only a bare\s+`#N`, which is in the PR repository/);
  assert.match(skill, /--repo <issue-owner\/issue-repo> --issue <closing-issue>/);
  assert.match(skill, /exits 1 because the issue body has no formal spec, or when the PR has zero or several closing issues, go on to \(b\)/);
  assert.match(skill, /--judge-spec-source none/);
  assert.match(skill, /when that list is empty, they are the issues named by `Closes`\/`Fixes`\/`Resolves #N` keywords in the PR body, the same resolution `resolveLinkedIssuesFromPr` applies in Phase 1/);
});

test("the judge agent and its generated Claude asset carry the review-gate reject rules", async () => {
  for (const file of ["agents/judge.agent.md", ".claude/agents/judge.md"]) {
    const text = flat(await readRepo(file));
    assert.match(text, /On the review gate, a finding that is FYI-only or names no actionable defect is `reject`/, file);
    assert.match(text, /On every spec source, a finding whose only claim is that a section the repo.s PR template does not define .* is absent is `reject`/, file);
  }
});

test("REVIEW-GATE-JUDGE-PHASE is owned by the comment contract and registered", async () => {
  assertRuleOwned("REVIEW-GATE-JUDGE-PHASE", "skills/docs/gate-review-comment-contract.md");
  const rules = JSON.parse(await readRepo("skills/docs/required-rules.json")).requiredRules.map((r) => r.id);
  assert.ok(rules.includes("REVIEW-GATE-JUDGE-PHASE"));
  assert.match(flat(await readRepo("skills/docs/gate-review-sub-loop-contract.md")), /Phases 1, 1\.5, 2, 3 and 3\.5 with `--gate review`/);
  assert.match(flat(await readRepo("skills/docs/spec-authority-contract.md")), /`pr_scope` spec for them, naming the spec kind/);
});

test("ADR 0179 amends ADR 0060 and cites the unchanged ADRs", async () => {
  const adr = await readRepo("docs/decisions/0179-judge-in-standalone-review.md");
  assert.match(adr, /^Amends \[ADR 0060\]/m);
  for (const n of ["0046", "0092", "0051", "0078", "0054", "0089", "0106", "0107", "0115"]) {
    assert.match(adr, new RegExp(`/${n}-`), `ADR ${n} linked`);
  }
});
