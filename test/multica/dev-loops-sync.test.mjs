import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
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
if (rest[0] === "agent" && rest[1] === "env" && rest[2] === "set") { state.agents.find((a) => a.id === rest[3]).env = JSON.parse(stdin); save(state); json({ ok: true }); process.exit(0); }
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
  const run = () => spawnSync(process.execPath, [scriptPath, "--mca", cliPath, "--source", repoRoot, "--workspace", WS_SLUG], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, MULTICA_WORKSPACE_ID: "" },
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
    assert.match(state.skills.find((s) => s.name === "multica-dispatch").content, /child issue/i,
      "multica-dispatch skill content must describe child-issue dispatch");
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
    ["child issue creation", /child issue/i],
    ["parallel staging / stage barriers", /stage/i],
    ["completion wake-up", /wake/i],
    ["durable inputs (reviewed head SHA)", /head SHA/i],
    ["durable result contract", /result contract/i],
    ["fan-in", /fan-in/i],
    ["failure handling", /blocked/i],
    ["standalone Pi fallback preserved", /subagent/i],
  ]) {
    assert.match(content, re, `multica-dispatch SKILL.md must cover: ${topic}`);
  }
  // No hardcoded workspace-specific IDs (IDs resolve from the live roster at dispatch time).
  assert.doesNotMatch(content, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    "no UUIDs may be persisted in dev-loops skill source");
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
