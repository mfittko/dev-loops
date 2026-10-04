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

// Structural claim check. A claim is a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities)
// that must co-occur in ONE sentence of the located block, so rewording keeps passing and a dropped literal
// or modality fails. `assertClaims` also proves both directions on the real block: a reworded copy (filler clause between tokens, sentence order reversed) passes,
// and removing a claim's last token makes exactly that claim fail.
const collapse = (text) => text.replace(/\s+/g, " ");
const sentences = (text) => collapse(text).split(/(?<=[.!?:])\s+(?=[A-Z`*(|-])/);
const missingClaims = (block, claims) => claims.filter((tokens) => !sentences(block).some((s) => tokens.every((t) => s.includes(t))));
const reword = (block, claims) => sentences(block).map((s) => (claims.find((tokens) => tokens.every((t) => s.includes(t)))?.slice(0, -1) ?? []).reduce((acc, t) => acc.replace(t, `${t} (as the contract records, without exception)`), s)).reverse().join(" ");
function assertClaims(block, claims, label) {
  assert.deepEqual(missingClaims(block, claims), [], `${label}: missing claim`);
  assert.deepEqual(missingClaims(reword(block, claims), claims), [], `${label}: a reworded copy must pass`);
  for (const tokens of claims) {
    const broken = collapse(block).split(tokens.at(-1)).join("");
    assert.ok(missingClaims(broken, claims).includes(tokens), `${label}: dropping ${tokens.at(-1)} must fail ${tokens.join(" + ")}`);
  }
}

test("GATE-EXEC-DEFERRAL-RECORD names the comment target and states no tool creates an issue", async () => {
  const section = ruleSection(await readFile(`${repoRoot}${CONTRACT}`, "utf8"), "GATE-EXEC-DEFERRAL-RECORD");
  assertClaims(section, [
    ["`judge-pass.mjs`", "`close-gate-findings.mjs`", "never creates an issue"],
    ["`tracker.provider`", "`github`", "exactly one closing issue reference"],
    ["otherwise", "the PR itself"],
    ["ONE batched", "deferral comment"],
    ["never selects", "`act`", "prior round"],
  ], "GATE-EXEC-DEFERRAL-RECORD");
  assert.doesNotMatch(section, /ONE tracked (GitHub )?follow-up issue/, "the old one-follow-up-issue wording must not return");
});

test("GATE-EXEC-THREAD-DISPOSITION states the act-thread exclusion and the fixer reply-and-resolve sentence", async () => {
  const section = ruleSection(await readFile(`${repoRoot}${CONTRACT}`, "utf8"), "GATE-EXEC-THREAD-DISPOSITION");
  assertClaims(section, [
    ["never selects", "`act`", "severity", "round"],
    ["current round's ledger", "decides first"],
    ["prior local ledgers", "judge: <disposition>"],
    ["`act`", "no stamp", "no reply", "no resolve", "no deferral comment entry", "fixing commit", "decline reason", "judge rerun"],
    ["fixer", "replies", "`act`", "decline reason", "resolves it", "`close-gate-findings.mjs`"],
  ], "GATE-EXEC-THREAD-DISPOSITION");
  assert.doesNotMatch(section, /PR's tracked follow-up issue/);
});

test("the judge-pass paragraph names the comment target, the act-thread exclusion, and states judge-pass never creates an issue", async () => {
  const text = await readFile(`${repoRoot}${CONTRACT}`, "utf8");
  // Located by its literals (the `judge-pass` bridge and the deferral writer), not by an opening sentence.
  const paragraph = text.split("\n\n").find((p) => p.includes("`judge-pass`") && p.includes("`commentDeferredFindings`"));
  assert.ok(paragraph, "the judge-pass deferral paragraph must exist");
  assertClaims(paragraph, [
    ["`judge-pass`", "never creates an issue"],
    ["linked spec issue", "the PR itself"],
    ["`act`", "never defer-closed", "fixer", "decline reason", "`GATE-EXEC-THREAD-DISPOSITION`"],
  ], "judge-pass deferral paragraph");
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
    assertClaims(bullet, [
      ["batched", "deferral comment"],
      ["new issue", "only when", "blocker", "`MAIN-AGENT-FILING-BLOCKER-ONLY`"],
    ], file);
    assert.doesNotMatch(bullet, /create-issue\.mjs|files it by hand|new issue is warranted/, `${file}`);
  }
});
