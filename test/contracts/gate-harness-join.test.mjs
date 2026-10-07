// Prose guards for GATE-EXEC-HARNESS-JOIN and the Claude Code gate-unit join command.
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const GATE_DOC = "skills/docs/gate-review-sub-loop-contract.md";
const rule = async () => {
  const content = await readRepo(GATE_DOC);
  const start = content.indexOf("<!-- rule: GATE-EXEC-HARNESS-JOIN -->");
  assert.ok(start !== -1, "expected the rule marker");
  return content.slice(start, content.indexOf("**Re-run rule:**", start));
};

test("the join rule is defined once and keeps the Pi blocking join", async () => {
  assert.equal((await readRepo(GATE_DOC)).split("rule: GATE-EXEC-HARNESS-JOIN").length - 1, 1);
  assert.match(await rule(), /Pi: .*`async: false`.*`runs\.all`.*`bg_wait`/);
});

test("the rule names the command, its outcomes and the stall stop", async () => {
  const text = await rule();
  assert.match(text, /gate wait-for-units --emit-plan <path> \[--unit <scope>\]\.\.\. --tmp-root/);
  assert.match(text, /--judge-plan/);
  assert.match(text, /`all_done`/);
  assert.match(text, /three consecutive `timeout` outcomes with the same `missing` scopes.*`units_stalled`/);
  assert.match(text, /`round_retired`/);
});

test("the rule handles a notification in five ordered steps", async () => {
  const text = await rule();
  assert.match(text, /1\. It reads the command's typed outcome first\. On `all_done`.*no-op/);
  assert.match(text, /2\. On `timeout`.*does not reset the consecutive-`timeout` count/);
  assert.match(text, /3\. A notification that reports a failed unit triggers `GATE-EXEC-DISPATCH-RETRY-BACKOFF`.*"has not reported yet" is never trusted over the command/);
  assert.match(text, /4\. A coordinator that is awake at a turn start with no call in flight runs the command before any other action/);
  assert.match(text, /5\. The coordinator never ends its turn with the command running in the background/);
});

test("the rule forbids every non-command wait by purpose", async () => {
  const text = await rule();
  for (const form of ["`until`, `while` or `for` poll loop", "`sleep`", "`read -t`", "`ls ... | wc -l`", "`run_in_background` wait", "`Monitor`", "A loop rewritten to a different test form is the same breach"]) {
    assert.ok(text.includes(form), `expected ${form}`);
  }
});

test("the gate coordinator hands back once, after the join", async () => {
  assert.match(await rule(), /hands back its round result once.*never hands back an interim completion while a dispatched unit is pending/s);
  for (const file of ["agents/gate-coordinator.agent.md", ".claude/agents/gate-coordinator.md"]) {
    assert.match(await readRepo(file), /Return it once, after your wave join completes \(Pi: the blocking join; Claude Code: `wait-for-units` returns `all_done`\) or you stop with `units_stalled` or `round_retired`\. Never hand back an interim completion/);
  }
});

test("the gate coordinator names the command on Claude Code and does not require Pi joins", async () => {
  for (const file of ["agents/gate-coordinator.agent.md", ".claude/agents/gate-coordinator.md"]) {
    const text = await readRepo(file);
    assert.match(text, /gate wait-for-units/);
    assert.doesNotMatch(text, /async: false|bg_wait/);
  }
});

test("the join surfaces name the command and the notification join", async () => {
  assert.match(await readRepo("agents/dev-loop.agent.md"), /On Claude Code, the gate coordinator joins .*gate wait-for-units`.*never dismissed as a repeat/);
  assert.match(await readRepo("skills/docs/main-agent-contract.md"), /gate coordinator's completion notification is the join signal for its round and is never dismissed as a repeat/);
  assert.match(await readRepo("skills/docs/anti-patterns.md"), /on Claude Code, one foreground `[^`]*gate wait-for-units` call per wave/);
  assert.match(await readRepo(GATE_DOC), /completion is detected under Claude Code by `[^`]*gate wait-for-units`/);
  assert.match(await readRepo(GATE_DOC), /`gate wait-for-units` is the one gate step that runs from the main checkout/);
});
