// Conformance guard for the gate tools' comment-only deferral path (ADR 0092,
// amends ADR 0051). No gate tool creates an issue for a deferred finding; the
// disposition pass never defer-closes an open judge `act` thread; the fixer
// replies to and resolves every thread it fixed before close-gate-findings
// runs. Assertions key on load-bearing tokens with bounded gaps, so a
// semantics-preserving rewording does not falsely break them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";

// The rule's own section: from its marker to the next rule marker.
function ruleSection(text, id) {
  const start = text.indexOf(`<!-- rule: ${id} -->`);
  assert.notEqual(start, -1, `${id} marker must exist`);
  const next = text.indexOf("<!-- rule: ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test("GATE-EXEC-DEFERRAL-RECORD names the comment target and states no tool creates an issue", async () => {
  const section = ruleSection(await readFile(`${repoRoot}${CONTRACT}`, "utf8"), "GATE-EXEC-DEFERRAL-RECORD");
  assert.match(section, /never\s+creates\s+an\s+issue/);
  assert.match(section, /linked spec issue when `tracker\.provider` resolves to\s+`github`[\s\S]{0,120}exactly one closing issue reference/);
  assert.match(section, /otherwise it is the PR itself/);
  assert.match(section, /ONE batched\s+comment/);
  assert.match(section, /never selects a thread whose finding the judge disposed `act` in the current\s+or a prior round/);
  assert.doesNotMatch(section, /ONE tracked (GitHub )?follow-up issue/, "the old one-follow-up-issue wording must not return");
});

test("GATE-EXEC-THREAD-DISPOSITION states the act-thread exclusion and the fixer reply-and-resolve sentence", async () => {
  const section = ruleSection(await readFile(`${repoRoot}${CONTRACT}`, "utf8"), "GATE-EXEC-THREAD-DISPOSITION");
  assert.match(section, /never selects a\s+thread whose finding the judge disposed `act`, whatever its severity and round/);
  assert.match(section, /current round's ledger decides first[\s\S]{0,200}prior local ledgers decide, then the\s+thread's rendered ` — judge: <disposition>` suffix/);
  assert.match(section, /no stamp,\s+no reply, no resolve, and no deferral comment entry/);
  assert.match(
    section,
    /The fixer\s+replies to every gate thread whose finding it fixed or declined on reproduction grounds, of any severity and including a judge `act`\s+item past the medium fix window, with the fixing commit or a decline reason, and resolves it before\s+`close-gate-findings\.mjs` runs\./,
  );
  assert.match(section, /closes it\s+with a fixing commit or a decline reason, or a judge rerun/);
  assert.doesNotMatch(section, /PR's tracked follow-up issue/);
});

test("the judge-pass paragraph names the comment target, the act-thread exclusion, and states judge-pass never creates an issue", async () => {
  const text = await readFile(`${repoRoot}${CONTRACT}`, "utf8");
  const start = text.indexOf("`judge-pass` is also where a judge `defer` is recorded");
  assert.notEqual(start, -1, "the judge-pass deferral paragraph must exist");
  const paragraph = text.slice(start, text.indexOf("\n\n", start));
  assert.match(paragraph, /`judge-pass` never\s+creates\s+an\s+issue/);
  assert.match(paragraph, /linked spec issue[\s\S]{0,120}otherwise it is the PR itself/);
  assert.match(
    paragraph,
    /A thread whose finding the judge disposes\s+`act` is never defer-closed[\s\S]{0,160}fixer replies with the fixing commit or a\s+decline reason and resolves it \(see `GATE-EXEC-THREAD-DISPOSITION`\)/,
  );
  assert.doesNotMatch(paragraph, /ensureFollowUpIssue|createIssue/);
});

test("MAIN-AGENT-FILING-BLOCKER-ONLY lives in the main-agent contract: new issue only for a blocker", async () => {
  const text = await readFile(`${repoRoot}skills/docs/main-agent-contract.md`, "utf8");
  assert.equal(text.split("<!-- rule: MAIN-AGENT-FILING-BLOCKER-ONLY -->").length, 2, "exactly one rule marker");
  const section = ruleSection(text, "MAIN-AGENT-FILING-BLOCKER-ONLY");
  assert.match(section, /files a new issue from a runner finding only\s+when the finding is a blocker/);
  assert.match(section, /blocks a merge or deadlocks a PR/);
  assert.match(section, /comment on an existing issue or epic/);
});

test("the judge `defer` bullets file a new issue only for a blocker, never via create-issue.mjs", async () => {
  for (const file of [CONTRACT, "agents/judge.agent.md"]) {
    const text = await readFile(`${repoRoot}${file}`, "utf8");
    const start = text.indexOf("- `defer` — ");
    assert.notEqual(start, -1, `${file}: the judge defer bullet must exist`);
    const bullet = text.slice(start, text.indexOf("- `reject` — ", start));
    assert.match(bullet, /batched deferral comment/, `${file}`);
    assert.match(bullet, /only when the finding is a blocker/, `${file}`);
    assert.match(bullet, /MAIN-AGENT-FILING-BLOCKER-ONLY/, `${file}`);
    assert.doesNotMatch(bullet, /create-issue\.mjs|files it by hand|new issue is warranted/, `${file}`);
  }
});
