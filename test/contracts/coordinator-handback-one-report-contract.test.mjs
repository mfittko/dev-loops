// Issue 2611 slice 1: one SubagentHandback per run, plain-text pauses, orchestrator read path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectContractMarkdownFiles, findEmbeddedRuleBodies } from "../../scripts/docs/validate-rule-ownership.mjs";
import { assert, fromRepoRoot, readRepo, test } from "../imported-assets-helpers.mjs";

const MAIN = "skills/docs/main-agent-contract.md";
const GATE = "skills/docs/gate-review-sub-loop-contract.md";
const ONE = "COORDINATOR-HANDBACK-ONE-REPORT";
const READ = "MAIN-AGENT-COORDINATOR-REPORT-READ";

async function rule(id, file = MAIN) {
  const content = await readRepo(file);
  assert.equal(content.split(`<!-- rule: ${id} -->`).length - 1, 1, `${id} defined once`);
  const start = content.indexOf(`<!-- rule: ${id} -->`);
  const ends = ["\n<!-- rule:", "\n## "].map((m) => content.indexOf(m, start + 1)).filter((i) => i !== -1);
  return content.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("COORDINATOR-HANDBACK-ONE-REPORT defines pauses as plain text", async () => {
  const text = await rule(ONE);
  assert.match(text, /Claude Code only/);
  assert.match(text, /pause is a turn end while the dev-loop coordinator's run is not finished/);
  assert.match(text, /plain text and never calls `SubagentHandback`/);
  assert.match(text, /"report has not been delivered" prompt.*plain text/);
  assert.match(text, /dev-loop coordinator's thread.*duplicate child wake.*run state did not change/s);
});

test("COORDINATOR-HANDBACK-ONE-REPORT carries one final report and the refusal path", async () => {
  const text = await rule(ONE);
  assert.match(text, /one `SubagentHandback` call of a run carries its final report.*`final_approval_ready`.*caller decision/s);
  assert.match(text, /no child in flight is never a pause.*never ends silently while its next step is runnable/s);
  assert.match(text, /refused `SubagentHandback`.*no further call.*full report as plain text/s);
  assert.match(text, /names the last relayed message it consumed, by first line and arrival time, or states that it consumed none/);
});

test("MAIN-AGENT-COORDINATOR-REPORT-READ defines the orchestrator read path", async () => {
  const text = await rule(READ);
  assert.match(text, /"not repeated here".*idle without a delivered report.*last assistant message of the coordinator's output file before it resumes or re-asks/s);
  assert.match(text, /all decisions for one block in one message/);
  assert.match(text, /latest hand-back before it re-instructs/);
  assert.match(text, /next notification of a reporter that named children in flight, read its output file/);
});

test("GATE-EXEC-HARNESS-JOIN names children in flight and cites the read rule", async () => {
  const content = await readRepo(GATE);
  const start = content.indexOf("<!-- rule: GATE-EXEC-HARNESS-JOIN -->");
  const text = content.slice(start, content.indexOf("**Re-run rule:**", start));
  assert.match(text, /report sent while a child is in flight.*`COORDINATOR-HANDBACK-ONE-REPORT`/s);
  assert.match(text, /names every such child: agent id, expected artifact path or hand-back, and the next step/);
  assert.match(text, /gate coordinator child the expected hand-back is its round result/);
  assert.match(text, /still running and reads its output file.*`MAIN-AGENT-COORDINATOR-REPORT-READ`/s);
  assert.ok(!/last assistant message/.test(text), "the read rule is cited, not restated");
});

test("both agent files cite the hand-back rule and embed no rule body", async () => {
  const agent = await readRepo("agents/dev-loop.agent.md");
  const mirror = await readRepo(".claude/agents/dev-loop.md");
  for (const text of [agent, mirror]) assert.ok(text.includes(ONE));
  const mainAbs = fileURLToPath(fromRepoRoot(MAIN));
  const sources = (await collectContractMarkdownFiles())
    .filter((file) => path.resolve(file) === mainAbs)
    .map((file) => ({ file, content: fs.readFileSync(file, "utf8") }));
  assert.equal(sources.length, 1);
  for (const text of [agent, mirror]) assert.deepEqual(findEmbeddedRuleBodies(text, sources).map((def) => def.id), []);
});

test("required-rules lists both rules", async () => {
  const { requiredRules: rules } = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  for (const id of [ONE, READ]) assert.ok(rules.some((r) => r.id === id), `${id} listed`);
});
