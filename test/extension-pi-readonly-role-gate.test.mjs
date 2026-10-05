import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { READONLY_SUBAGENT_ROLES } from "@dev-loops/core/claude/hook-decisions";
import { NATIVE_PI_PARENT_SESSION_MARKER } from "@dev-loops/core/loop/run-context";
import extension from "../extension/index.ts";
import { mapAgentToolsForPi, renderPiAgent } from "../extension/sync-packaged-agents.ts";
import { BASH_RESTRICTED_ROLES, DEV_LOOPS_ROLES } from "../extension/readonly-role-gate.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const PULL = "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd";

// Registers the extension on a Pi double and returns the real `tool_call` handler.
function toolCallHandler() {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return events.get("tool_call");
}

// The native async markers the runner sets in-process, alongside the calling session id the ctx
// supplies. Both are snapshotted/restored so a test never leaks a marker into a sibling test.
const NATIVE_ENV_MARKERS = ["PI_SUBAGENT_CHILD", NATIVE_PI_PARENT_SESSION_MARKER];

async function callWith(prompt, command, toolName = "bash", env = {}, sessionId) {
  const priors = NATIVE_ENV_MARKERS.map((name) => [name, process.env[name]]);
  for (const name of NATIVE_ENV_MARKERS) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  try {
    const ctx = {
      getSystemPrompt: prompt === undefined ? undefined : () => prompt,
      ...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
    };
    return await toolCallHandler()({ toolName, input: { command } }, ctx);
  } finally {
    for (const [name, prior] of priors) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
}

const tag = (name) => `<active_agent name="${name}"/>`;

// role undefined = untagged main agent; otherwise a pi-subagents tag for that name.
async function callAs(role, command, toolName = "bash") {
  return callWith(role === undefined ? "base prompt" : tag(role), command, toolName);
}

test("Pi judge runs the sanctioned pull and nothing else (J7)", async () => {
  assert.deepEqual(await callAs("judge", PULL), { block: false });
  assert.deepEqual(await callAs("dev-loops:judge", PULL), { block: false });
  for (const cmd of ["rm -rf /", "bun run test", `${PULL} && ls`, `${PULL}; id`, "git diff", "cat README.md"]) {
    assert.equal((await callAs("judge", cmd)).block, true, cmd);
  }
});

test("Pi reviewer reads and searches but cannot run tests or builds", async () => {
  for (const cmd of ["git diff origin/main...HEAD", "grep -rn foo src", "rg foo", "cat README.md", PULL,
    "cd /w/tree && dev-loops-run scripts/github/verify-fresh-review-context.mjs --context-path a.json",
    "dev-loops-run scripts/github/emit-reviewer-blocked.mjs --head abc", "jq .adjacentCode a.json", "find src -name x.ts", 'git -C "/w/tree" diff origin/main...HEAD']) {
    assert.deepEqual(await callAs("review", cmd), { block: false }, cmd);
  }
  for (const cmd of ["bun run test", "npm test", "bun run build", "node script.mjs", "cat a > b", "git push", "grep x $(id)", "ls; bun test",
    "rg --pre bun foo test/", "rg --pre sh . x", "git grep -Obun foo", "git grep --open-files-in-pager=sh x", "git diff --output=x", "git diff --ext-diff",
    "find . -exec sh -c x ;", "find . -delete", "dev-loops-run scripts/other.mjs", "cd /w && bun test", "git -C /w push",
    "rg '--pre' bun foo test/", "rg --p're' bun foo", 'git diff "--output=x"', 'git grep "-Obun" foo', "git grep -nObun foo", "file -bC -m x", "find . '-delete'", "rg foo *", "find . -delet?", "rg --hostname-bin=make foo", "rg --host=make foo", "file --compile -m x", "file --comp -m x"]) {
    assert.equal((await callAs("review", cmd)).block, true, cmd);
  }
});

test("Pi tool_call fails closed on a blank marker and leaves the unmarked and non-read-only callers alone", async () => {
  for (const marker of ["", "  ", "dev-loops:"]) assert.equal((await callAs(marker, "ls")).block, true, JSON.stringify(marker));
  assert.equal((await callAs("dev-loops: judge", "rm -rf /")).block, true);
  assert.deepEqual(await callAs(undefined, "bun run test"), { block: false });
  assert.deepEqual(await callAs("developer", "bun run test"), { block: false });
  assert.deepEqual(await callAs("judge", "bun run test", "read"), { block: false });
});

function toolsOf(file) {
  return /^tools:\s*(.*)$/m.exec(fs.readFileSync(path.join(repoRoot, file), "utf8"))[1].split(/[\s,]+/).filter(Boolean);
}

test("source agents, generated .claude assets and the Pi mapping agree on read-only role capabilities", () => {
  for (const role of BASH_RESTRICTED_ROLES) assert.ok(READONLY_SUBAGENT_ROLES.includes(role), role);
  for (const role of READONLY_SUBAGENT_ROLES) {
    const source = toolsOf(`agents/${role}.agent.md`);
    const claude = toolsOf(`.claude/agents/${role}.md`).map((t) => t.toLowerCase());
    const pi = mapAgentToolsForPi(source);
    const piRendered = renderPiAgent(fs.readFileSync(path.join(repoRoot, `agents/${role}.agent.md`), "utf8"));
    assert.deepEqual(toolsOfText(piRendered), pi);
    // Shell access exists on all three surfaces; the Pi gate restricts it to the role's allowed operations.
    assert.equal(source.includes("bash"), claude.includes("bash"), role);
    assert.equal(pi.includes("bash"), claude.includes("bash"), role);
    // Write access agrees across the three surfaces.
    for (const tool of ["edit", "write"]) {
      assert.equal(pi.includes(tool), claude.includes(tool), `${role} ${tool}`);
    }
  }
});

function toolsOfText(text) {
  return /^tools:\s*(.*)$/m.exec(text)[1].split(/[\s,]+/).filter(Boolean);
}

test("the Pi pull-line matcher agrees with the Claude gate's parseSanctionedPullLine", async () => {
  const { parseSanctionedPullLine } = await import("@dev-loops/core/claude/hook-decisions");
  const lines = [
    PULL,
    "dev-loops-run scripts/github/pull-work-order.mjs --ref r1 --digest abc --execution j1-0123abcd",
    `${PULL} extra`,
    `${PULL}; id`,
    "dev-loops-run scripts/github/pull-work-order.mjs",
    "node scripts/github/pull-work-order.mjs j1-0123abcd",
  ];
  for (const line of lines) {
    assert.equal((await callAs("judge", line)).block, parseSanctionedPullLine(line) === null, line);
  }
});

test("the role comes from the tag in prefix or appended form, and the env marker is gone", async () => {
  assert.equal((await callWith(`${tag("judge")}\n\nYou are a judge.`, "cat README.md")).block, true);
  assert.equal((await callWith(`Base prompt.\n\n${tag("judge")}`, "cat README.md")).block, true);
  assert.deepEqual(await callWith(`${tag("dev-loops:judge")} x`, PULL), { block: false });
  const legacyEnv = "DEVLOOPS_" + "AGENT_TYPE";
  const prior = process.env[legacyEnv];
  process.env[legacyEnv] = "judge";
  try {
    assert.deepEqual(await callWith("base prompt", "cat README.md"), { block: false });
  } finally {
    if (prior === undefined) delete process.env[legacyEnv];
    else process.env[legacyEnv] = prior;
  }
  assert.deepEqual(await callWith(undefined, "cat README.md"), { block: false });
});

test("every roster role resolves to its capability", async () => {
  const names = fs.readdirSync(path.join(repoRoot, "agents")).filter((n) => n.endsWith(".agent.md"))
    .map((n) => /^name:\s*"?([^"\n]+)"?/m.exec(fs.readFileSync(path.join(repoRoot, "agents", n), "utf8"))[1]);
  assert.deepEqual([...names].sort(), [...DEV_LOOPS_ROLES].sort());
  for (const name of names) {
    assert.deepEqual(await callAs(name, PULL), { block: false }, name);
    assert.equal((await callAs(name, "cat README.md")).block, name === "judge", `${name} cat`);
    assert.equal((await callAs(name, "bun run test")).block, name === "judge" || name === "review", `${name} bun`);
  }
});

const FAIL_CLOSED_PROMPTS = [
  tag(""), tag("  "), tag("dev-loops:"), tag("dev-loops:nope"),
  tag("dev-loops :nope"), tag("dev-loops : nope"),
  `${tag("nope")} ${tag("dev-loops:nope")}`, `${tag("dev-loops:nope")} ${tag("nope")}`,
  `${tag("judge")} ${tag("developer")}`, `${tag("judge")} ${tag("review")}`,
];
for (const prompt of FAIL_CLOSED_PROMPTS) {
  test(`role resolution fails closed for ${JSON.stringify(prompt)}`, async () => {
    assert.equal((await callWith(prompt, "ls")).block, true, prompt);
  });
}

test("role resolution fails closed per the resolution table", async () => {
  // A native async child: the runner's in-process child flag plus a non-blank parent session.
  const childEnv = { PI_SUBAGENT_CHILD: "1", [NATIVE_PI_PARENT_SESSION_MARKER]: "parent-1" };
  // The child's own session id differs from the recorded parent: fail closed to the pull line.
  assert.equal((await callWith("base prompt", "ls", "bash", childEnv, "child-1")).block, true);
  // Same shared process env, but the calling session is the recorded parent: unrestricted.
  assert.deepEqual(await callWith("base prompt", "ls", "bash", childEnv, "parent-1"), { block: false });
  // A lone child flag without the parent marker is not native-async evidence: unrestricted.
  assert.deepEqual(await callWith("base prompt", "ls", "bash", { PI_SUBAGENT_CHILD: "1" }), { block: false });
  assert.deepEqual(await callWith("base prompt", "ls"), { block: false });
  assert.deepEqual(await callWith(tag("developer"), "bun run test", "bash", childEnv, "child-1"), { block: false });
  assert.deepEqual(await callWith(tag("judge"), PULL, "bash", childEnv, "child-1"), { block: false });
  assert.equal((await callWith(tag("judge"), "cat README.md", "bash", childEnv, "child-1")).block, true);
  assert.deepEqual(await callWith(`${tag("judge")} ${tag("dev-loops:judge")}`, PULL), { block: false });
  for (const bare of ["reviewer", "worker", "scout"]) assert.deepEqual(await callWith(tag(bare), "bun run test"), { block: false }, bare);
});

test("the untagged fail-closed row scopes to the calling session, not the shared process env", async () => {
  // Model the real native-child lifetime: the runner sets PI_SUBAGENT_CHILD=1 and the parent
  // session marker in the shared process env once and leaves them set. The gate must then decide
  // per calling session from ctx.sessionManager.getSessionId() rather than the process-global flag
  // alone, so an untagged main agent in the same process is not locked to the pull line.
  const handler = toolCallHandler();
  const priors = NATIVE_ENV_MARKERS.map((name) => [name, process.env[name]]);
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env[NATIVE_PI_PARENT_SESSION_MARKER] = "parent-session";
  try {
    const call = (sessionId, command) =>
      handler({ toolName: "bash", input: { command } }, { getSystemPrompt: () => "base prompt", sessionManager: { getSessionId: () => sessionId } });
    // The parent's own session id equals the recorded parent marker: unrestricted.
    assert.deepEqual(await call("parent-session", "bun run test"), { block: false });
    // A child's session id differs from the parent marker: fail closed.
    assert.equal((await call("child-session", "bun run test")).block, true);
    // The shared env markers are unchanged across both calls, so the decision cannot come from them.
    assert.equal(process.env.PI_SUBAGENT_CHILD, "1");
    assert.equal(process.env[NATIVE_PI_PARENT_SESSION_MARKER], "parent-session");
  } finally {
    for (const [name, prior] of priors) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});

test("parallel children resolve independently", async () => {
  const handler = toolCallHandler();
  const judge = { getSystemPrompt: () => tag("judge") };
  const dev = { getSystemPrompt: () => tag("developer") };
  const call = (ctx) => handler({ toolName: "bash", input: { command: "cat README.md" } }, ctx);
  assert.equal((await call(judge)).block, true);
  assert.equal((await call(dev)).block, false);
  assert.equal((await call(judge)).block, true);
});

test("the Pi judge has a shell-free read and search path", () => {
  const rendered = renderPiAgent(fs.readFileSync(path.join(repoRoot, "agents/judge.agent.md"), "utf8"));
  const tools = toolsOfText(rendered);
  for (const t of ["read", "grep", "find", "ls"]) assert.ok(tools.includes(t), t);
});

const ACCEPT = {
  A1: `jq '{resolvedAngles, scope}' "tmp/gate-context/o-r/pr-80/draft_gate-abc.json"`,
  A2: `jq '.allPassed' "/abs/tmp/gate-context/o-r/pr-1/draft_gate-abc.validation.json"`,
  A3: "grep -rn foo src | cut -c1-200",
  A4: 'grep -rn "foo bar" src',
  A5: "rg 'foo bar' src",
  A6: 'grep -rn "foo bar" src | cut -c1-200',
};
const REJECT = {
  R1: "rg --p're' bun foo",
  R2: `rg '--pre' bun foo`,
  R2b: 'git diff "--output=x"',
  R3: 'grep "$(id)" src',
  R3b: 'grep "a`id`" src',
  R3c: 'grep "a\\b" src',
  R3d: 'grep "a!" src',
  R4: "grep 'foo src",
  R5: "grep foo src | sh",
  R6: "grep foo src | cut -c1-200 | sh",
  R7: "grep foo src | cut -f1",
  R8: "'bun' test",
  R9: "rg foo *",
  R5b: "grep foo src |",
  R5c: "grep foo src | cut",
  R5d: "| cut -c1-200",
  R9b: `cd abc" && grep '"; touch PWN; #' src`,
  R9c: `git -C abc" grep '"; touch PWN2; #' src`,
  R11: "grep foo src\nbun run test",
  R12: "cd /w && grep x src\nrm -rf x",
  R13: "dev-loops-run scripts/github/verify-fresh-review-context.mjs --scope x && rm -rf y",
  R13b: "dev-loops-run scripts/github/emit-reviewer-blocked.mjs --head abc; rm -rf y",
};
for (const [id, cmd] of Object.entries(ACCEPT)) {
  test(`reviewer accepts ${id}`, async () => assert.deepEqual(await callAs("review", cmd), { block: false }));
}
for (const [id, cmd] of Object.entries(REJECT)) {
  test(`reviewer rejects ${id}`, async () => assert.equal((await callAs("review", cmd)).block, true));
}
test("reviewer rejects R10: the judge gains no reviewer form", async () => {
  for (const cmd of Object.values(ACCEPT)) assert.equal((await callAs("judge", cmd)).block, true, cmd);
  assert.equal((await callAs("judge", "jq '.allPassed' x.json")).block, true);
});
