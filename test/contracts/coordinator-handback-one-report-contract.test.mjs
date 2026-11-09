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

async function rule(id) {
  const content = await readRepo(MAIN);
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
  assert.match(text, /dev-loop coordinator's thread.*duplicate child wake.*child is in flight and the run state did not change.*no child in flight.*continues its runnable next step/s);
});

test("COORDINATOR-HANDBACK-ONE-REPORT carries one final report and the refusal path", async () => {
  const text = await rule(ONE);
  assert.match(text, /one `SubagentHandback` call of a run carries its final report at one of the run-ending cases in the Unit coordinator boundaries section, the one canonical list\./);
  assert.match(await readRepo(GATE), /`units_stalled` or `round_retired` makes a terminal hand-back, not a pause.*keeps the child list/s);
  assert.match(text, /no child in flight is never a pause.*never ends silently while its next step is runnable/s);
  assert.match(text, /refused `SubagentHandback`.*no further call.*full report as plain text/s);
  assert.match(text, /names the last relayed message it consumed, by first line and arrival time, or states that it consumed none/);
});

test("MAIN-AGENT-COORDINATOR-REPORT-READ defines the orchestrator read path", async () => {
  const text = await rule(READ);
  assert.match(text, /^<!-- rule: MAIN-AGENT-COORDINATOR-REPORT-READ -->\n`MAIN-AGENT-COORDINATOR-REPORT-READ`: The orchestrator reads a coordinator's rep/);
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
  assert.match(text, /agent id, `joinRef`, and the next step/);
  assert.match(text, /treats the reporter as still running, unless the forced hand-back's packet status names a run-ending case.*final\. On Claude Code the parent reads the reporter's output file on its next notification \(`MAIN-AGENT-COORDINATOR-REPORT-READ`.*terminal hand-back, not a pause.*keeps the child list\. The wait command cancels no child, so the parent treats each listed child as still running\./s);
  assert.ok(!/last assistant message/.test(text), "the read rule is cited, not restated");
});

test("GATE-EXEC-HARNESS-JOIN in-flight report names each joinRef and states a forced hand-back is interim", async () => {
  const content = await readRepo(GATE);
  const start = content.indexOf("<!-- rule: GATE-EXEC-HARNESS-JOIN -->");
  const text = content.slice(start, content.indexOf("**Re-run rule:**", start));
  assert.match(text, /report sent while a child is in flight.*carries its `joinRef`: for a fixer or delta reviewer the hand-back path that `COORDINATOR-SINGLE-CHILD-JOIN` names, for a gate coordinator child its agent id and the round-result hand-back it returns through the completion notification, for a gate review unit or judge child the `--emit-plan` or `--judge-plan` path that its `wait-for-units` join reads, for a developer child, which writes no artifact, its worktree path and branch\./s);
  const own = text.slice(0, text.indexOf("- Claude Code: before dispatch"));
  assert.ok(!/emitter prints|<outputRef>\.report|input\.patchPath/.test(own),"the join rule owns its own phrases");
  assert.match(text, /never hands back an interim completion while a dispatched unit is pending, except a hand-back the harness forces, which states that it is interim/);
  assert.match(text, /hand-back the harness forces while a child runs carries the same list and states that it is interim/);
  assert.match(text, /hand-back the harness forces is a hand-back the harness ends the actor's run with while a child runs\. The Claude Code "report has not been delivered" prompt is not a forced hand-back and stays a plain-text pause under `COORDINATOR-HANDBACK-ONE-REPORT`/);
});

test("the Claude mirror carries the three harness-neutral bullets", async () => {
  const mirror = await readRepo(".claude/skills/docs/main-agent-contract.md");
  assert.equal(mirror.split("\n").filter((l) => l.startsWith("- Every harness:")).length, 3);
});

test("MAIN-AGENT-COORDINATOR-REPORT-READ has three harness-neutral bullets", async () => {
  const text = await rule(READ);
  const bullets = text.split("\n").filter((l) => l.startsWith("- Every harness:"));
  assert.equal(bullets.length, 3);
  assert.match(bullets[0], /hand-back or pause that lists children in flight and names no run-ending case is interim, whether or not it says so.*status, not a result.*re-dispatch a listed child.*next report/s);
  assert.match(bullets[1], /names a run-ending case.*Unit coordinator boundaries.*`units_stalled` or `round_retired` hand-back under `GATE-EXEC-HARNESS-JOIN`.*final even when it lists children.*treats each listed child as still running.*hand-back that states it is interim under `GATE-EXEC-HARNESS-JOIN` and whose packet status names no run-ending case is interim.*names a run-ending case.*ended the reporter's run.*final.*waits for no further report/s);
  assert.match(bullets[2], /second hand-back that repeats the report.*already consumed.*first line and child list.*same coordinator.*run state unchanged.*duplicate.*interim reports too.*precedence over the interim bullet.*reads the state.*acts on nothing.*relays nothing/s);
});

test("the read rule keeps Claude Code bullets Claude-specific and neutral bullets harness-neutral", async () => {
  const lines = (await rule(READ)).split("\n");
  const neutral = lines.filter((l) => l.startsWith("- Every harness:"));
  const claude = lines.filter((l) => l.startsWith("- Claude Code:"));
  for (const l of neutral) assert.ok(!/output file|SubagentHandback|Claude Code only/.test(l), l);
  assert.equal(claude.length, 4);
  assert.match(claude[0], /output file/);
  assert.match(claude[0], /not repeated here/);
  assert.match(claude[1], /one message/);
  assert.match(claude[2], /latest hand-back/);
  assert.match(claude[3], /output file/);
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

test("the packet list cites the hand-back rule and no hand-back goes out with a child in flight", async () => {
  assert.match(await readRepo(MAIN), /compact relay packet.*also carries the consumed relayed message under `COORDINATOR-HANDBACK-ONE-REPORT`/s);
  assert.match(await readRepo(MAIN), /compact relay packet.*child list under `GATE-EXEC-HARNESS-JOIN`/s);
  assert.match(await readRepo(MAIN), /packet `status` of a run-ending hand-back names the run-ending case.*hand-back sent with a child in flight that ends no run carries an interim status and names no run-ending case/s);
  assert.match(await rule(ONE), /never calls `SubagentHandback` while a child is in flight/);
  assert.match(await readRepo(GATE), /on Pi a hand-back, on Claude Code a plain-text pause under `COORDINATOR-HANDBACK-ONE-REPORT`/);
});

test("required-rules lists both rules", async () => {
  const { requiredRules: rules } = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  for (const id of [ONE, READ]) assert.ok(rules.some((r) => r.id === id), `${id} listed`);
});

test("the Claude mirror of the main-agent contract carries both rules", async () => {
  const mirror = await readRepo(".claude/skills/docs/main-agent-contract.md");
  for (const id of [ONE, READ]) assert.ok(mirror.includes(`<!-- rule: ${id} -->`), `${id} in .claude mirror`);
});

test("both gate coordinator agent files cite the forced hand-back exception", async () => {
  for (const f of ["agents/gate-coordinator.agent.md", ".claude/agents/gate-coordinator.md"]) {
    assert.match(await readRepo(f), /except the forced hand-back that `GATE-EXEC-HARNESS-JOIN` allows/, f);
  }
});
