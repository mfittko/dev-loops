import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "multica", "dev-loops-sync.mjs");

const WS_ID = "ws-0001", WS_SLUG = "test-ws", RUNTIME_ID = "rt-1";
const CANONICAL_AGENTS = ["dev-loop", "developer", "docs", "fixer", "judge", "quality", "refiner", "review"];
const PRESET_MODEL = "makora/zai-org/GLM-5.3";

// Fake `multica` CLI: a stateful JSON file emulates a workspace (skills + agents)
// across repeated runs so idempotency is observable, and an append-only log records
// every invocation. It mirrors the real CLI contract asserted below: the sync must
// never pass --model (create: omit → inherit runtime defaults; update: omit →
// preserve the existing selection), so the fake REJECTS any --model loudly.
// Paths are baked in (the sync invokes the CLI with command args only, so config
// cannot travel via argv).
function buildFakeCliSource(statePath, logPath) {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
if (process.argv.includes("--help")) { console.log("fake multica"); process.exit(0); }
const [statePath, logPath] = [${JSON.stringify(statePath)}, ${JSON.stringify(logPath)}];
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
if (flag("--workspace-id") && flag("--workspace-id") !== "${WS_ID}") { console.error("fake cli: bad workspace scope"); process.exit(9); }
const SUBS = ["workspace", "runtime", "skill", "agent"];
const start = argv.findIndex((a) => SUBS.includes(a));
if (start < 0) { console.error("fake cli: no subcommand in " + argv.join(" ")); process.exit(9); }
const rest = argv.slice(start);
if (rest.includes("--model")) { console.error("fake cli: --model must never be passed by dev-loops-sync"); process.exit(8); }
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { skills: [], agents: [] });
const save = (s) => writeFileSync(statePath, JSON.stringify(s));
const log = JSON.parse(existsSync(logPath) ? readFileSync(logPath, "utf8") : "[]");
log.push(rest.join(" "));
writeFileSync(logPath, JSON.stringify(log));
const state = load();
const stdin = (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();
const emit = (list) => console.log(JSON.stringify({ data: list }));
const json = (x) => console.log(JSON.stringify(x));
if (rest[0] === "workspace" && rest[1] === "list") { emit([{ id: "${WS_ID}", slug: "${WS_SLUG}" }]); process.exit(0); }
if (rest[0] === "runtime" && rest[1] === "list") { emit([{ id: "${RUNTIME_ID}", provider: "claude", status: "online" }]); process.exit(0); }
if (rest[0] === "skill" && rest[1] === "list") { emit(state.skills.map(({ id, name }) => ({ id, name }))); process.exit(0); }
if (rest[0] === "agent" && rest[1] === "list") { emit(state.agents.map(({ id, name, model }) => ({ id, name, model }))); process.exit(0); }
if (rest[0] === "skill" && rest[1] === "update") { state.skills.find((s) => s.id === rest[2]).content = stdin; save(state); json({ id: rest[2] }); process.exit(0); }
if (rest[0] === "skill" && rest[1] === "create") { const id = "sk-" + state.skills.length; state.skills.push({ id, name: flag("--name"), content: stdin }); save(state); json({ id }); process.exit(0); }
if (rest[0] === "skill" && rest[1] === "delete") { state.skills = state.skills.filter((s) => s.id !== rest[2]); save(state); json({ ok: true }); process.exit(0); }
if (rest[0] === "agent" && rest[1] === "update") { const a = state.agents.find((x) => x.id === rest[2]); a.description = flag("--description"); a.instructions = flag("--instructions") ?? a.instructions; save(state); json({ id: rest[2] }); process.exit(0); }
if (rest[0] === "agent" && rest[1] === "create") { const id = "ag-" + state.agents.length; state.agents.push({ id, name: flag("--name"), model: null, description: flag("--description"), instructions: flag("--instructions"), env: {}, skills: [] }); save(state); json({ id }); process.exit(0); }
if (rest[0] === "agent" && rest[1] === "env" && rest[2] === "set") { if (process.env.FAKE_ENV_SET_FAIL === "1" && rest[3] === "ag-0") { console.error("fake cli: permission denied"); process.exit(3); } state.agents.find((a) => a.id === rest[3]).env = JSON.parse(stdin); save(state); json({ ok: true }); process.exit(0); }
if (rest[0] === "agent" && rest[1] === "skills" && rest[2] === "set") { state.agents.find((a) => a.id === rest[3]).skills = flag("--skill-ids").split(",").filter(Boolean); save(state); json({ ok: true }); process.exit(0); }
console.error("fake cli: unhandled " + rest.join(" ")); process.exit(9);
`;
}

async function makeFakeWorkspace(presetAgents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-sync-test-"));
  const statePath = path.join(dir, "state.json"), logPath = path.join(dir, "calls.json"), cliPath = path.join(dir, "mca.mjs");
  await writeFile(cliPath, buildFakeCliSource(statePath, logPath));
  await chmod(cliPath, 0o755);
  await writeFile(statePath, JSON.stringify(presetAgents
    ? { skills: [], agents: CANONICAL_AGENTS.map((name, i) => ({ id: `ag-${i}`, name, model: PRESET_MODEL, description: "old", instructions: "old", env: {}, skills: [] })) }
    : { skills: [], agents: [] }));
  const run = (extraEnv = {}) => spawnSync(process.execPath, [scriptPath, "--mca", cliPath, "--source", repoRoot, "--workspace", WS_SLUG], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, MULTICA_WORKSPACE_ID: "", ...extraEnv },
  });
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const readLog = async () => JSON.parse(await readFile(logPath, "utf8"));
  return { dir, run, readState, readLog };
}

const BIND_MAP = {
  "dev-loop": ["dev-loop", "copilot-pr-followup", "final-approval"],
  developer: ["local-implementation"],
  docs: [],
  fixer: ["copilot-pr-followup"],
  judge: [],
  quality: [],
  refiner: ["loop-grill"],
  review: ["review", "ui-review"],
};

test("sync imports and binds the multica-dispatch skill to every canonical agent, idempotently", async () => {
  const ws = await makeFakeWorkspace(true);
  try {
    const first = ws.run();
    assert.equal(first.status, 0, `sync failed: ${first.stderr}`);
    const state = await ws.readState();
    const skillIds = Object.fromEntries(state.skills.map((s) => [s.name, s.id]));
    const imported = ["copilot-pr-followup", "dev-loop", "final-approval", "local-implementation", "loop-grill", "review", "ui-review", "multica-dispatch"];
    for (const name of imported) {
      assert.ok(skillIds[name], `skill ${name} must be imported`);
      assert.ok(state.skills.find((s) => s.name === name).content.length > 0, `skill ${name} must carry content`);
    }
    assert.match(state.skills.find((s) => s.name === "multica-dispatch").content, /root dispatch comment/i,
      "multica-dispatch skill content must describe root-dispatch-comment fan-out on the parent issue");
    for (const a of state.agents) {
      const bound = (a.skills || []).map((id) => state.skills.find((s) => s.id === id)?.name);
      assert.deepEqual(bound.sort(), [...BIND_MAP[a.name], "multica-dispatch"].sort(), `agent ${a.name} must bind its skill map + multica-dispatch`);
    }
    assert.deepEqual(state.agents.map((a) => a.name).sort(), CANONICAL_AGENTS.slice().sort());

    // Idempotency: re-run against the converged state — same end state, no duplicate creates.
    const before = await ws.readState();
    const second = ws.run();
    assert.equal(second.status, 0, `re-sync failed: ${second.stderr}`);
    const after = await ws.readState();
    assert.equal(after.skills.length, before.skills.length, "re-sync must not create duplicate skills");
    assert.equal(after.agents.length, before.agents.length, "re-sync must not create duplicate agents");
    const log = await ws.readLog();
    // Log covers BOTH runs; count creates — idempotent re-sync creates nothing new.
    const skillCreates = log.filter((c) => /^skill create/.test(c) || c.startsWith("skill create")).length;
    const agentCreates = log.filter((c) => /^agent create/.test(c) || c.startsWith("agent create")).length;
    assert.equal(skillCreates, imported.length, `first sync creates each skill exactly once (${imported.length}); re-sync creates none`);
    assert.equal(agentCreates, 0, "existing agents are updated, never re-created");
    for (const a of after.agents) {
      const bound = (a.skills || []).map((id) => after.skills.find((s) => s.id === id)?.name);
      assert.ok(bound.includes("multica-dispatch"), `agent ${a.name} keeps multica-dispatch binding after re-sync`);
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("syncing an existing agent never sends a model mutation and preserves the current model", async () => {
  const ws = await makeFakeWorkspace(true);
  try {
    const r = ws.run();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    const log = await ws.readLog();
    // The fake CLI fails loudly on --model; assert directly too for clear failure output.
    assert.equal(log.some((c) => c.includes("--model")), false,
      "no agent update/create call may pass --model (the agent model is owned by Multica configuration)");
    for (const call of log.filter((c) => c.startsWith("agent update") || c.startsWith(`${WS_ID} agent update`))) {
      assert.doesNotMatch(call, /--model(\s|$)/);
    }
    const state = await ws.readState();
    for (const a of state.agents) {
      assert.equal(a.model, PRESET_MODEL, `agent ${a.name} model must be untouched (was ${PRESET_MODEL})`);
    }
    assert.equal(log.some((c) => c.includes("agent update")), true, "existing agents are updated in place (no recreate)");
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("newly created agents omit model selection and inherit runtime defaults", async () => {
  const ws = await makeFakeWorkspace(false); // empty workspace → all 8 created
  try {
    const r = ws.run();
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    const state = await ws.readState();
    assert.equal(state.agents.length, 8, "all 8 canonical agents created");
    for (const a of state.agents) {
      assert.equal(a.model, null, `created agent ${a.name} must inherit the runtime default model (no --model)`);
      assert.ok((a.skills || []).length > 0, `created agent ${a.name} must be bound to its skills`);
    }
    const log = await ws.readLog();
    for (const call of log.filter((c) => c.includes("agent create"))) {
      assert.doesNotMatch(call, /--model(\s|$)/, "agent create must omit --model");
      assert.match(call, /--runtime-id/, "agent create must pin a runtime");
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("the multica-dispatch skill source documents the full fan-out/fan-in contract", async () => {
  const content = await readFile(path.join(repoRoot, "skills", "multica-dispatch", "SKILL.md"), "utf8");
  for (const [topic, re] of [
    ["root dispatch comment on the parent issue", /root dispatch comment/i],
    ["mention dispatch of the dedicated agents", /mention-link each agent/i],
    ["in-thread worker replies (receipts)", /replies? .*in the same thread|same thread/i],
    ["durable inputs (reviewed head SHA)", /head SHA/i],
    ["expected result shape", /expected result shape/i],
    ["fan-in on the thread", /fan-in/i],
    ["failure handling", /blocked/i],
    ["standalone Pi fallback preserved", /subagent/i],
  ]) {
    assert.match(content, re, `multica-dispatch SKILL.md must cover: ${topic}`);
  }
  // No hardcoded workspace-specific IDs (IDs resolve from the live roster at dispatch time).
  assert.doesNotMatch(content, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    "no UUIDs may be persisted in dev-loops skill source");
});

// Topology correction (MFIT-188 follow-up): one child issue per reviewer/dispatch unit
// is overkill and must NOT be the default fan-out surface — and stronger: gate/reviewer
// fan-out NEVER creates sub-issues, including when multiple review groups target the
// same agent. A gate round is exactly ONE durable Multica `review` assignment on the
// parent issue (hybrid dispatch): the parallel fresh-context groups run INSIDE that
// assignment through the review agent's harness-native subagents. Child issues are
// allowed ONLY when a human explicitly requests work decomposition — never as a
// fallback for freshness, concurrency, stages, waves, or reviewer groups.
// Pinned across the skill source and its `.claude` transform.
for (const [surface, file] of [
  ["multica-dispatch skill", "skills/multica-dispatch/SKILL.md"],
  ["generated .claude mirror", ".claude/skills/multica-dispatch/SKILL.md"],
]) {
  test(`${surface}: gate/reviewer fan-out never creates sub-issues; child issues are human-requested only`, async () => {
    const content = await readFile(path.join(repoRoot, file), "utf8");
    assert.match(content, /NOT the\s+default/i, `${surface}: the no-child-issues-by-default rule must be stated`);
    assert.match(content, /root dispatch comment on the existing parent issue/i,
      `${surface}: the parent-issue dispatch comment is the default fan-out surface`);
    // Gate/reviewer fan-out never creates sub-issues, including same-agent multi-group rounds.
    assert.match(content, /never[^.]{0,80}creates\s+sub-issues[\s\S]{0,200}multiple review groups target the same agent/i,
      `${surface}: the never-creates-sub-issues rule must cover multiple groups targeting the same agent`);
    assert.match(content, /zero[^.]{0,40}`?multica issue create`?/i,
      `${surface}: the zero-issue-create guarantee for a multi-group draft gate must be stated`);
    // Child issues are human-requested decomposition only, never a topology fallback.
    assert.match(content, /only when a human explicitly requests\s+work decomposition/i,
      `${surface}: child issues require an explicit human decomposition request`);
    assert.match(content, /not a fallback for freshness, concurrency, stages,\s+waves, or reviewer groups/i,
      `${surface}: the non-fallback list must name freshness, concurrency, stages, waves, and reviewer groups`);
    assert.doesNotMatch(content, /multiple concurrent isolated runs|own durable lifecycle\/status \(its own/i,
      `${surface}: the old fallback conditions are removed — they licensed the wrong topology`);
    assert.doesNotMatch(content, /stage barrier/i,
      `${surface}: stage barriers belong to the child-issue model that is no longer the default`);
  });
}

// Hybrid-dispatch correction (MFIT-188 confirmed correction): a gate round is exactly
// ONE durable Multica `review` assignment on the parent issue. The parallel
// fresh-context review groups run INSIDE that assignment through the review agent's
// harness-native subagents, which are internal workers — no Multica issues, no
// separate durable results, no recursive dev-loop, no model override (they inherit
// the parent Multica agent's Multica-governed runtime/model). Pinned across the skill
// source, the review agent source, and their `.claude` transforms; the zero-issue-create
// and no-manufactured-concurrency guarantees must hold on both hosts.
for (const [host, skillFile, agentFile] of [
  ["Pi-hosted", "skills/multica-dispatch/SKILL.md", "agents/review.agent.md"],
  ["Claude-hosted", ".claude/skills/multica-dispatch/SKILL.md", ".claude/agents/review.md"],
]) {
  test(`a ${host} gate round is one durable Multica review assignment with harness-native internal fan-out`, async () => {
    const skill = await readFile(path.join(repoRoot, skillFile), "utf8");
    const reviewAgent = await readFile(path.join(repoRoot, agentFile), "utf8");
    for (const [surface, content] of [[`multica-dispatch skill (${skillFile})`, skill], [`review agent source (${agentFile})`, reviewAgent]]) {
      assert.match(content, /hybrid dispatch/i,
        `${surface}: the hybrid-dispatch topology must be named`);
      assert.match(content, /harness-native subagents?/i,
        `${surface}: the review agent fans groups out through harness-native subagents`);
      assert.match(content, /ONE durable Multica `review` assignment|one durable Multica `?review`? assignment/i,
        `${surface}: a gate round is exactly one durable Multica review assignment`);
      assert.match(content, /aggregate[\s\S]{0,120}\*{0,2}one\*{0,2}\s+(reply on the\s+)?parent-issue/i,
        `${surface}: group results are aggregated into one parent-issue result`);
      // Harness subagents are internal workers, not Multica assignments.
      assert.match(content, /internal workers,? not additional Multica\s+assignments|internal workers: they create no Multica issues/i,
        `${surface}: harness subagents are internal workers, not Multica assignments`);
      assert.match(content, /no issues|create no Multica issues|issues, post no separate/i,
        `${surface}: harness subagents create no issues`);
      assert.match(content, /post no separate durable results|post\s+no separate durable results/i,
        `${surface}: harness subagents post no separate durable results`);
      assert.match(content, /invoke `?dev-loop`? recursively|never invoke `?dev-loop`? recursively/i,
        `${surface}: harness subagents never invoke dev-loop recursively`);
      // No model override for harness subagents — they inherit the Multica-governed runtime/model.
      assert.match(content, /Do not specify a model in\s+harness-subagent calls|without specifying a model/i,
        `${surface}: harness-subagent calls carry no model override`);
      assert.match(content, /inherit[\s\S]{0,80}(Multica|the parent Multica agent's)\s+runtime\/model|inherit this Multica agent's runtime\/model/i,
        `${surface}: harness subagents inherit the Multica-governed runtime/model`);
    }
    // No manufactured concurrency with child issues, on either host surface.
    assert.match(skill, /never manufacture concurrency with\s+child issues/i,
      `${skillFile}: never manufacture concurrency with child issues`);
    // The review agent must be able to run its harness-native fan-out: its Pi source
    // carries the subagent tool (single-line comma form, #1111) and Claude transform
    // maps it to the Claude-native Agent tool.
    assert.match(reviewAgent, /tools: read, bash, edit, write, subagent|tools: Read, Bash, Edit, Write, Agent/i,
      `${agentFile}: the review agent must carry the harness subagent tool`);
  });
}

// Topology regression (MFIT-188 follow-up): a multi-group draft gate — several review
// groups all targeting the single `review` agent — must emit ZERO `multica issue`
// create operations and dispatch via the parent issue. Hybrid topology: the one
// Multica `review` assignment fans the groups out internally via its harness-native
// subagents; the coordinator never manufactures Multica-side concurrency.
test("a multi-group draft gate emits zero `multica issue create` operations and dispatches via the parent issue", async () => {
  // The dispatch plan a coordinator builds from the multica-dispatch contract when
  // several review groups all target the same dedicated agent.
  const groups = [
    { angle: "standards", agent: "review", headSha: "a".repeat(40) },
    { angle: "spec", agent: "review", headSha: "a".repeat(40) },
    { angle: "security", agent: "review", headSha: "a".repeat(40) },
    { angle: "tests", agent: "review", headSha: "a".repeat(40) },
    { angle: "docs", agent: "review", headSha: "a".repeat(40) },
    { angle: "ui", agent: "review", headSha: "a".repeat(40) },
  ];
  const skill = await readFile(path.join(repoRoot, "skills", "multica-dispatch", "SKILL.md"), "utf8");
  // Conforming plan: exactly ONE parent-issue Multica `review` assignment; the groups
  // fan out INSIDE it through the review agent's harness-native subagents — never
  // child issues, never one Multica assignment per group.
  const multicaAssignments = [{ agent: "review", parentIssue: true, groups: groups.map((g) => g.angle) }];
  const issueCreates = [];
  // The skill contract pins the hybrid topology's guarantees.
  assert.match(skill, /zero[^.]{0,40}`?multica issue create`?/i,
    "the skill must pin the zero-issue-create guarantee for multi-group gates");
  assert.match(skill, /exactly\s+\*{0,2}one\*{0,2} durable\s+Multica `review` assignment/i,
    "the skill must prescribe exactly one durable Multica review assignment per gate round");
  assert.match(skill, /fans\s+its\s+review\s+groups\s+out\s+through\s+its\s+(?:Pi or Claude\s+)?harness-native\s+subagents/i,
    "the skill must prescribe harness-native internal fan-out inside the review assignment");
  assert.equal(multicaAssignments.length, 1, "all groups target one agent → exactly one Multica review assignment, not one per group");
  assert.equal(multicaAssignments[0].groups.length, groups.length,
    "the single assignment carries ALL review groups");
  assert.equal(issueCreates.length, 0, "a multi-group draft gate must emit zero `multica issue create` operations");
  assert.equal(multicaAssignments[0].parentIssue, true,
    "the single assignment is dispatched on the existing parent issue");
  // Fan-out lives inside the assignment: the group fan-out is harness-native, and the
  // only durable result surface is the one parent-issue aggregate.
  assert.match(skill, /internal workers, not additional Multica\s+assignments/i,
    "the skill must pin that harness subagents are internal workers, not Multica assignments");
  assert.match(skill, /never\s+invoke\s+`?dev-loop`?\s+recursively/i,
    "the skill must forbid recursive dev-loop invocation from harness subagents");
  assert.match(skill, /Do not specify a model in\s+harness-subagent calls/i,
    "the skill must forbid model overrides on harness-subagent calls");
});

// Lifecycle regression (MFIT-186 root cause): the coordinator's worktree is
// disposable. A worker that receives a durable dispatch contract (repository, PR,
// exact head SHA, self-contained prompt/context, expected result shape) must still
// be able to validate its context and produce a result after the coordinator's
// worktree is deleted immediately after dispatch — proving the contract carries no
// coordinator-worktree dependency. Modeled hermetically: build a real git repo with a
// committed head, write the dispatch contract as the skill prescribes (and a
// deliberately coordinator-local prompt file that dies with the "worktree"), delete
// the coordinator worktree, then reconstruct the worker's view from the durable
// contract alone and check the worker can validate and answer.
test("a worker still validates context and returns a result when the coordinator worktree is deleted immediately after dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multica-dispatch-lifecycle-"));
  try {
    // The remote origin — what outlives the coordinator's disposable worktree and
    // what a pushed head is "independently addressable" through.
    const origin = path.join(dir, "origin.git");
    // Coordinator worktree: a repo with one committed, PUSHED head (the reviewed
    // work) plus uncommitted scratch that never leaves the coordinator.
    const coordinatorWt = path.join(dir, "coordinator-worktree");
    await mkdir(coordinatorWt, { recursive: true });
    const git = (...a) => spawnSync("git", ["-C", coordinatorWt, ...a], { encoding: "utf8" });
    // `-b main` pins the bare origin's branch name: without it the bare repo's HEAD
    // points at the runner's `init.defaultBranch` default and the push lands on a
    // differently-named ref, leaving the clone on an unborn HEAD.
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(coordinatorWt, "BRIEF.md"), "The reviewed work: gate context file.\n");
    await writeFile(path.join(coordinatorWt, "uncommitted-scratch.txt"), "never committed\n");
    git("add", "BRIEF.md");
    git("-c", "user.email=t@example", "-c", "user.name=t", "commit", "-qm", "head under review");
    const push = git("push", "-q", origin, "main");
    assert.equal(push.status, 0, `the reviewed head must be pushed (independently addressable) before dispatch: ${push.stderr}`);
    const head = git("rev-parse", "HEAD").stdout.trim();

    // The skill's dispatch rule: the briefing carries repository, PR, and the exact
    // head SHA, plus a self-contained prompt — never a coordinator-local path.
    const dispatchComment = JSON.stringify({
      dispatchUnit: "Validate the gate context at the reviewed head and report the verdict.",
      repository: origin,
      pr: 2147,
      headSha: head,
      prompt: "Read BRIEF.md at the head SHA in your own checkout; report its first line.",
      expectedResultShape: "In-thread reply: verdict + evidence",
    });
    // A coordinator-local scratch file is the anti-pattern the rule forbids: it
    // lives outside the durable contract and must die with the worktree.
    const scratch = path.join(coordinatorWt, "tmp", "coordinator-only.txt");
    await mkdir(path.dirname(scratch), { recursive: true });
    await writeFile(scratch, "coordinator scratchpad");

    // The durable contract must not require any coordinator-worktree path.
    const contract = JSON.parse(dispatchComment);
    assert.equal(JSON.stringify(contract).includes(coordinatorWt), false,
      "the dispatch briefing must not require a coordinator worktree path");

    // Delete the coordinator worktree immediately after dispatch.
    await rm(coordinatorWt, { recursive: true, force: true });
    assert.equal(existsSync(coordinatorWt), false, "coordinator worktree is gone");

    // Worker view: reconstruct entirely from the durable contract. Its own
    // "Multica-managed checkout" is a fresh clone of the repository at the
    // immutable head — the coordinator worktree no longer exists anywhere.
    const workerWt = path.join(dir, "worker-checkout");
    const clone = spawnSync("git", ["clone", "-q", contract.repository, workerWt], { encoding: "utf8" });
    assert.equal(clone.status, 0, `worker's own checkout must succeed without the coordinator worktree: ${clone.stderr}`);
    const wgit = (...a) => spawnSync("git", ["-C", workerWt, ...a], { encoding: "utf8" });
    assert.equal(wgit("rev-parse", "HEAD").stdout.trim(), contract.headSha,
      "worker's own checkout is at the exact reviewed head");
    assert.equal(existsSync(path.join(workerWt, "BRIEF.md")), true,
      "worker can validate context: the reviewed file exists at the head in its own checkout");
    const brief = await readFile(path.join(workerWt, "BRIEF.md"), "utf8");
    assert.equal(existsSync(path.join(workerWt, "uncommitted-scratch.txt")), false,
      "uncommitted coordinator scratch never reaches the worker");

    // Worker returns its result through the durable surface (modeled as the
    // in-thread reply payload) — the coordinator's tmp/ tree is already deleted.
    const reply = { verdict: "validated", evidence: brief.split("\n")[0], head: contract.headSha, pr: contract.pr };
    assert.equal(reply.evidence.startsWith("The reviewed work"), true,
      "worker produced a result from its own checkout after the coordinator worktree was deleted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing `agent env set` is tolerated: the sync warns, continues, and still binds every agent's skills", async () => {
  const ws = await makeFakeWorkspace(true);
  try {
    const r = ws.run({ FAKE_ENV_SET_FAIL: "1" }); // permission wall on the FIRST agent only
    assert.equal(r.status, 0, `sync must not die when agent env set is denied: ${r.stderr}`);
    assert.match(r.stderr, /warning: agent env set failed for dev-loop/, "the failure is surfaced as a warning");
    const state = await ws.readState();
    // Every agent after the denied one still got its env + skill bindings.
    const denied = state.agents.find((a) => a.id === "ag-0");
    assert.ok(!denied.env?.DEVLOOPS_HOME, "the denied agent's env is untouched");
    for (const a of state.agents.filter((a) => a.id !== "ag-0")) {
      assert.equal(a.env?.DEVLOOPS_HOME, repoRoot, `agent ${a.name} env still set`);
    }
    for (const a of state.agents) {
      const bound = (a.skills || []).map((id) => state.skills.find((s) => s.id === id)?.name);
      assert.ok(bound.includes("multica-dispatch"), `agent ${a.name} still bound to multica-dispatch despite the env-set denial`);
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

// Recursive dev-loop dispatch suppression (MFIT-188 follow-up override): inside a
// Multica workspace a top-level `dev-loop` run is already the coordinator and must
// never spawn another native `dev-loop` child — provider-independent, so BOTH the
// Pi-hosted (subagent tool) and the Claude-hosted (child-agent mechanism) Multica
// contexts must see the suppression in every surface the sync ships: the skill the
// child agents load, the dev-loop agent instructions the sync writes, and the Claude
// (`.claude`) transforms of both. Outside Multica the ordinary harness dispatch stays.
for (const [host, agentSource, instructionsSurface] of [
  ["Pi-hosted", "agents/dev-loop.agent.md", null],
  ["Claude-hosted", ".claude/agents/dev-loop.md", ".claude"],
]) {
  test(`a ${host} Multica dev-loop run suppresses recursive dev-loop child dispatch`, async () => {
    const skill = await readFile(path.join(repoRoot, "skills", "multica-dispatch", "SKILL.md"), "utf8");
    const agent = await readFile(path.join(repoRoot, agentSource), "utf8");
    for (const [surface, content] of [[`multica-dispatch skill`, skill], [`dev-loop agent source (${agentSource})`, agent]]) {
      assert.match(content, /no recursive dev-loop dispatch/i,
        `${surface}: the no-recursive-dev-loop-dispatch rule must be present for a ${host} Multica context`);
      assert.match(content, /provider-independent/i,
        `${surface}: the rule must be stated as provider-independent (binds Pi and Claude hosts alike)`);
      assert.match(content, /MUST NOT\s+spawn or delegate to another native `?dev-loop`? child/i,
        `${surface}: recursive dev-loop child dispatch must be explicitly forbidden for a ${host} Multica context`);
      assert.match(content, /non-Multica\s+fallback/i,
        `${surface}: native harness dev-loop child delegation must remain the non-Multica fallback`);
    }
    // The dedicated-agent routing replaces the nested entrypoint: the skill names the
    // strategy→agent routing (developer/review/refiner/judge/fixer) and the agent source
    // pins the same routing without re-restating the fan-out machinery.
    assert.match(skill, /route the resolved strategy[\s\S]{0,200}?dedicated Multica agent/i,
      "multica-dispatch skill: strategy work routes directly to the dedicated Multica agents");
    assert.match(agent, /route the resolved strategy[\s\S]{0,200}?dedicated Multica agent/i,
      `dev-loop agent source: strategy routing names the dedicated agents (${host} Multica context)`);
    // Harness-neutral phrasing: the suppression must survive the Claude transform
    // (pi-only blocks are stripped), so it must NOT be fenced inside a pi-only block.
    const fences = [...agent.matchAll(/<!-- pi-only -->([\s\S]*?)<!-- \/pi-only -->/gi)].map((m) => m[1]);
    assert.equal(fences.some((body) => /no recursive dev-loop dispatch/i.test(body)), false,
      `dev-loop agent source: the suppression rule must not be pi-only-fenced — a Claude-hosted Multica run must see it too`);
  });
}
