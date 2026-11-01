import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const JOIN = "gate wait-for-units --artifact <hand-back path>";

test("COORDINATOR-SINGLE-CHILD-JOIN is registered and carries the no-turn-end and Pi sentences", () => {
  const contract = read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(contract.includes("<!-- rule: COORDINATOR-SINGLE-CHILD-JOIN -->"));
  assert.ok(contract.indexOf("COORDINATOR-SINGLE-CHILD-JOIN -->") > contract.indexOf("rule: GATE-EXEC-HARNESS-JOIN"));
  assert.match(contract, /The hand-back path must not exist at dispatch: each fixer emission and each delta review invocation gets its own path, and the coordinator never reuses a hand-back path\./);
  assert.match(contract, /, and the child writes no extra marker, when the file parses as JSON and carries the terminal field its schema requires/);
  assert.doesNotMatch(contract, /\.done|staging|never satisfies the join/);
  assert.match(contract, /a parseable write without it satisfies the join after 10 unchanged seconds\. A full-phase fixer is final on write \(ADR 0222\)/);
  assert.match(contract, /the stability window does not apply to the full phase/);
  assert.match(contract, /an artifact whose mtime is older than the reference is pending and the result reports `stale: true`, and a missing or relative `--after` exits 1/);
  const adr = read("docs/decisions/0218-slice-a-cap-round-chain-and-single-child-join.md");
  assert.match(adr, /satisfies the join after 10 unchanged seconds, for every hand-back type/);
  assert.doesNotMatch(adr, /leaves the join pending|only for a final hand-back/);
  assert.match(adr, /v1\.0\.9 follow-up slice on #2462 \(`--report-path`\), with a deadline of Tuesday 2026-11-03 evening/);
  assert.doesNotMatch(adr, /staging/);
  assert.match(contract, /A coordinator never ends its turn while a single child runs, before the `--artifact` join returns\./);
  assert.match(contract, /Pi: the coordinator joins the child with a blocking dispatch \(`async: false`\), `runs\.all` or `bg_wait`.*`extension\/index\.ts` runs the foreground `async: false` child/);
  assert.ok(JSON.parse(read("skills/docs/required-rules.json")).requiredRules.some((rule) => rule.id === "COORDINATOR-SINGLE-CHILD-JOIN"));
});

const FALLBACK = "COORDINATOR-SINGLE-CHILD-JOIN-NOTIFICATION-FALLBACK";

test("COORDINATOR-SINGLE-CHILD-JOIN-NOTIFICATION-FALLBACK is registered, follows the join rule and names the Pi equivalent", () => {
  const contract = read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(contract.includes(`<!-- rule: ${FALLBACK} -->`));
  assert.ok(contract.indexOf(`rule: ${FALLBACK} -->`) > contract.indexOf("rule: COORDINATOR-SINGLE-CHILD-JOIN -->"));
  assert.match(contract, /after one `timeout` outcome of the fixer join, the coordinator ends its turn once to receive the fixer's completion notification\. It treats that notification as the join, reads the typed exit code \(`ci_failed`, `ci_pending`, `ci_unknown`\) from the hand-back text, acts on it, and does not repeat the wait/);
  assert.match(contract, /Pi: no fallback is needed\. The child call blocks/);
  assert.ok(JSON.parse(read("skills/docs/required-rules.json")).requiredRules.some((rule) => rule.id === FALLBACK));
  assert.match(read("docs/decisions/0222-single-child-join-final-on-write-and-notification-fallback.md"), /Amends \[0218\]/);
  for (const file of ["skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md", ".claude/skills/dev-loop/SKILL.md", ".claude/agents/dev-loop.md"]) {
    const text = read(file);
    assert.ok(text.includes(FALLBACK), file);
    assert.match(text, /Pi child calls block, so Pi needs no fallback/, file);
  }
});

test("each routed --artifact join command carries the --after reference", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "skills/docs/pre-pr-review-contract.md", "skills/local-implementation/SKILL.md", "skills/copilot-pr-followup/SKILL.md", "skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md"]) {
    const text = read(file);
    for (let at = text.indexOf("gate wait-for-units --artifact"); at >= 0; at = text.indexOf("gate wait-for-units --artifact", at + 1)) {
      assert.match(text.slice(at, at + 160), /--after /, `${file} at ${at}`);
    }
  }
});

test("the routed fixer and delta reviewer dispatch prose names the --artifact join command", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "skills/docs/pre-pr-review-contract.md", "skills/local-implementation/SKILL.md", "skills/copilot-pr-followup/SKILL.md", "skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md"]) {
    assert.ok(read(file).includes(JOIN), file);
  }
});

test("each routed sentence that gives the --artifact join carries the Claude Code qualifier", () => {
  for (const file of ["skills/docs/pre-pr-review-contract.md", "skills/local-implementation/SKILL.md", "skills/copilot-pr-followup/SKILL.md", "skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md", ".claude/skills/dev-loop/SKILL.md", ".claude/agents/dev-loop.md"]) {
    const text = read(file);
    let at = text.indexOf(JOIN);
    assert.ok(at >= 0, file);
    for (; at >= 0; at = text.indexOf(JOIN, at + 1)) {
      assert.match(text.slice(Math.max(0, at - 400), at), /Claude Code/, `${file} at ${at}`);
    }
  }
});

test("the harness-join bullet and the dev-loop agent no longer join the fixer through the completion notification", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "agents/dev-loop.agent.md"]) {
    const text = read(file);
    assert.doesNotMatch(text, /developer and fixer/, file);
    assert.doesNotMatch(text, /developer or fixer completion notification/, file);
    assert.ok(text.includes("COORDINATOR-SINGLE-CHILD-JOIN"), file);
  }
});

test("the delta reviewer is told to write its result to the absolute --result path", () => {
  const sentence = "the delta reviewer writes its `DeltaPrePushReviewResult` to that path with the file-write tool.";
  for (const file of ["skills/docs/pre-pr-review-contract.md", "skills/docs/gate-review-sub-loop-contract.md"]) {
    assert.ok(read(file).includes(sentence), file);
  }
  for (const file of ["agents/review.agent.md", ".claude/agents/review.md"]) {
    assert.ok(read(file).includes("Write your `DeltaPrePushReviewResult` to that path with the file-write tool."), file);
  }
});

test("the Copilot follow-up THREAD-route delta reviewer dispatch sentence names the --artifact join", () => {
  const text = read("skills/copilot-pr-followup/SKILL.md");
  const at = text.indexOf("Otherwise run the delta reviewer");
  assert.ok(at >= 0);
  assert.ok(text.slice(at, at + 400).includes("gate wait-for-units --artifact <the delta reviewer's --result path> --after <the input run's input.patchPath>"));
});
