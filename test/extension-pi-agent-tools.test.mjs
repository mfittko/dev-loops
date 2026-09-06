import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, lstat, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOL_NAME_MAP_PI,
  mapAgentToolsForPi,
  renderPiAgent,
  syncPackagedAgents,
  syncProjectAgentsDir,
} from "../extension/sync-packaged-agents.ts";

// #1583 — the harness-neutral tool names that Pi must NOT see in a rendered
// ~/.agents/*.agent.md (they have no Pi builtin equivalent and cause the
// "requested unavailable child tools" failure).
const FORBIDDEN_UNDER_PI = ["search", "execute", "agent", "todo"];

// Hand-authored Pi builtin/tool allowlist — INDEPENDENT of TOOL_NAME_MAP_PI's
// values. The contract assertions below check rendered tools against THIS set, not
// against the map's own output, so a mapped value that is not a real Pi builtin
// (e.g. a bad `review_loop` mapping) is caught rather than passing tautologically.
// These are the Pi-accepted tool names reachable from the canonical agent
// `tools:` vocabulary (builtins + the extension-registered `subagent` and the
// `review_loop` tool declared in this repo's skill `allowed-tools`).
const VALID_PI_TOOLS = new Set(["read", "bash", "edit", "write", "subagent", "review_loop"]);

test("TOOL_NAME_MAP_PI mirrors the Claude map's vocabulary to Pi builtins", () => {
  assert.equal(TOOL_NAME_MAP_PI.read, "read");
  assert.equal(TOOL_NAME_MAP_PI.search, "bash");
  assert.equal(TOOL_NAME_MAP_PI.execute, "bash");
  assert.equal(TOOL_NAME_MAP_PI.bash, "bash");
  assert.equal(TOOL_NAME_MAP_PI.edit, "edit");
  assert.equal(TOOL_NAME_MAP_PI.write, "write");
  assert.equal(TOOL_NAME_MAP_PI.agent, "subagent");
  assert.equal(TOOL_NAME_MAP_PI.subagent, "subagent");
  assert.equal(TOOL_NAME_MAP_PI.todo, null); // dropped — no Pi todo builtin
  assert.equal(TOOL_NAME_MAP_PI.review_loop, "review_loop");
});

test("every TOOL_NAME_MAP_PI value is a valid Pi tool (non-tautological check)", () => {
  // The map's non-null values must all be real Pi-accepted tool names. This is
  // independent of the map itself (VALID_PI_TOOLS is hand-authored), so a bad
  // mapping cannot pass by construction.
  for (const [name, mapped] of Object.entries(TOOL_NAME_MAP_PI)) {
    if (mapped == null) continue; // dropped entries (todo) are intentionally null
    assert.ok(
      VALID_PI_TOOLS.has(mapped),
      `TOOL_NAME_MAP_PI.${name} -> "${mapped}" is not a valid Pi tool`,
    );
  }
});

test("mapAgentToolsForPi dedupes and drops todo, preserving first-seen order", () => {
  // dev-loop agent vocabulary: read, search, execute, bash, agent, todo, subagent
  assert.deepEqual(
    mapAgentToolsForPi(["read", "search", "execute", "bash", "agent", "todo", "subagent"]),
    ["read", "bash", "subagent"],
  );
  // developer/docs/fixer/quality/refiner vocabulary: read, search, execute, bash, edit, write
  // (review dropped search/execute per #1659 — see the dedicated test below)
  assert.deepEqual(
    mapAgentToolsForPi(["read", "search", "execute", "bash", "edit", "write"]),
    ["read", "bash", "edit", "write"],
  );
  assert.deepEqual(mapAgentToolsForPi(["todo"]), []);
  assert.deepEqual(mapAgentToolsForPi([]), []);
});

test("mapAgentToolsForPi silently drops an unknown tool name (defensive — documented gap)", () => {
  // An unknown harness-neutral name not present in the map is dropped (lookup
  // returns undefined). This is the documented best-effort contract; the
  // canonical-agents completeness test below guards the real set.
  assert.deepEqual(mapAgentToolsForPi(["read", "mystery-tool", "bash"]), ["read", "bash"]);
});

test("renderPiAgent rewrites the tools: line and preserves the body verbatim", () => {
  const raw = `---
name: "dev-loop"
tools: read, search, execute, bash, agent, todo, subagent
maxSubagentDepth: 3
---

You are the dev-loop entrypoint.

<!-- pi-only -->
pi-only prose stays in the body
<!-- /pi-only -->
`;
  const rendered = renderPiAgent(raw);

  // tools line is remapped (deduped, todo dropped)
  const toolsLine = rendered.match(/^tools:\s*(.*)$/m)[1];
  assert.deepEqual(toolsLine.split(/,\s*/), ["read", "bash", "subagent"]);
  // forbidden names are absent from the whole rendered doc
  for (const forbidden of FORBIDDEN_UNDER_PI) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(rendered), false, `rendered doc must not leak forbidden tool name: ${forbidden}`);
  }
  // body is preserved verbatim (pi-only blocks are NOT stripped — Pi consumes them)
  assert.ok(rendered.includes("You are the dev-loop entrypoint."));
  assert.ok(rendered.includes("<!-- pi-only -->"));
  assert.ok(rendered.includes("pi-only prose stays in the body"));
  assert.ok(rendered.includes("<!-- /pi-only -->"));
  // other frontmatter fields are preserved
  assert.match(rendered, /name: "dev-loop"/);
  assert.match(rendered, /maxSubagentDepth: 3/);
});

test("renderPiAgent passes review_loop through unchanged", () => {
  const raw = `---
name: "x"
tools: read, review_loop
---

body
`;
  const rendered = renderPiAgent(raw);
  assert.deepEqual(rendered.match(/^tools:\s*(.*)$/m)[1].split(/,\s*/), ["read", "review_loop"]);
  assert.ok(rendered.includes("review_loop"));
});

test("renderPiAgent removes the tools: line when all tools drop (no forbidden-name leak)", () => {
  // A source whose tools: line maps entirely to dropped entries (e.g. only `todo`)
  // must NOT return raw — that would leave the forbidden name in the rendered
  // allowlist and re-trigger the exact failure this PR fixes (#1583).
  const raw = `---
name: "x"
tools: todo
---

body
`;
  const rendered = renderPiAgent(raw);
  // No tools: line in the rendered output
  assert.equal(/^tools:/m.test(rendered), false, "tools: line must be removed when all tools drop");
  // The forbidden name must not appear anywhere in the rendered doc
  assert.equal(rendered.includes("todo"), false, "rendered doc must not leak the dropped tool name");
  // Body and other frontmatter are preserved
  assert.match(rendered, /name: "x"/);
  assert.ok(rendered.includes("body"));
});

test("renderPiAgent returns a frontmatter-less source unchanged (defensive)", () => {
  // The existing extension-command-contract test syncs a bare "developer\n" file.
  const bare = "developer\n";
  assert.equal(renderPiAgent(bare), bare);
});

test("renderPiAgent returns a frontmatter source with no tools: line unchanged (defensive)", () => {
  const raw = `---
name: "x"
---

body
`;
  assert.equal(renderPiAgent(raw), raw);
});

test("syncPackagedAgents renders only Pi-valid tool names from the canonical agents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-agent-tools-"));
  const sourceRoot = path.join(tempDir, "source");
  const targetRoot = path.join(tempDir, "target");

  await mkdir(sourceRoot, { recursive: true });
  // Representative of the two real canonical tool vocabularies.
  await writeFile(
    path.join(sourceRoot, "dev-loop.agent.md"),
    `---
name: "dev-loop"
tools: read, search, execute, bash, agent, todo, subagent
---

dev-loop body
`,
  );
  await writeFile(
    path.join(sourceRoot, "developer.agent.md"),
    `---
name: "developer"
tools: read, search, execute, bash, edit, write
---

developer body
`,
  );
  // Non-agent file must be ignored.
  await writeFile(path.join(sourceRoot, "ignore.txt"), "ignore\n");

  await syncPackagedAgents({ sourceRoot, targetRoot });

  const rendered = await readdir(targetRoot);
  assert.deepEqual(rendered.sort(), ["dev-loop.agent.md", "developer.agent.md"]);

  for (const file of rendered) {
    const content = await readFile(path.join(targetRoot, file), "utf8");
    const toolsLine = content.match(/^tools:\s*(.*)$/m);
    assert.ok(toolsLine, `${file} must have a rendered tools: line`);
    const tools = toolsLine[1].split(/[\s,]+/).filter(Boolean);
    for (const tool of tools) {
      assert.ok(
        VALID_PI_TOOLS.has(tool),
        `${file} rendered tool must be a valid Pi builtin: ${tool}`,
      );
      assert.equal(
        FORBIDDEN_UNDER_PI.includes(tool),
        false,
        `${file} must not list a forbidden tool under Pi: ${tool}`,
      );
    }
  }
});

test("syncPackagedAgents renders the real canonical agents/ set with only Pi builtins", async () => {
  // Exercise the real committed agents/*.agent.md through the sync seam so the
  // contract guards future agent additions against introducing non-Pi tool names.
  const canonicalSource = new URL("../agents/", import.meta.url);
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-agent-canonical-"));

  await syncPackagedAgents({ sourceRoot: fileURLToPath(canonicalSource), targetRoot });

  const files = (await readdir(targetRoot)).filter((f) => f.endsWith(".agent.md"));
  assert.ok(files.length >= 7, `expected the canonical agent set, got ${files.length}`);

  for (const file of files) {
    const content = await readFile(path.join(targetRoot, file), "utf8");
    const toolsLine = content.match(/^tools:\s*(.*)$/m);
    assert.ok(toolsLine, `${file} must have a rendered tools: line`);
    const tools = toolsLine[1].split(/[\s,]+/).filter(Boolean);
    assert.ok(tools.length > 0, `${file} must render at least one Pi builtin tool`);
    for (const tool of tools) {
      assert.ok(
        VALID_PI_TOOLS.has(tool),
        `${file} rendered tool must be a valid Pi builtin: ${tool}`,
      );
      assert.equal(
        FORBIDDEN_UNDER_PI.includes(tool),
        false,
        `${file} must not list a forbidden tool under Pi: ${tool}`,
      );
    }
    // The rendered tools line must stay a pi-safe comma-token scalar (#1111).
    assert.match(toolsLine[0], /^tools:\s*[a-z][\w-]*(,\s*[a-z][\w-]*)*$/);
  }
});

test("syncPackagedAgents preserves every mappable source tool in the canonical set (completeness)", async () => {
  // Guard against a future canonical agent introducing a harness-neutral tool name
  // MISSING from TOOL_NAME_MAP_PI: such a name would be silently dropped with no
  // validity-test failure. This asserts every source `tools:` name either survives
  // in the rendered output (mapped) or is the explicitly-dropped `todo`.
  const canonicalSource = new URL("../agents/", import.meta.url);
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-agent-completeness-"));
  await syncPackagedAgents({ sourceRoot: fileURLToPath(canonicalSource), targetRoot });

  const files = (await readdir(targetRoot)).filter((f) => f.endsWith(".agent.md"));
  for (const file of files) {
    const source = await readFile(fileURLToPath(new URL(`../agents/${file}`, import.meta.url)), "utf8");
    const rendered = await readFile(path.join(targetRoot, file), "utf8");
    const sourceTools = (source.match(/^tools:\s*(.*)$/m)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
    const renderedTools = (rendered.match(/^tools:\s*(.*)$/m)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
    for (const srcTool of sourceTools) {
      if (srcTool === "todo") continue; // explicitly dropped — no Pi todo builtin
      const mapped = TOOL_NAME_MAP_PI[srcTool];
      assert.ok(mapped != null, `agents/${file} declares "${srcTool}" which is MISSING from TOOL_NAME_MAP_PI — would be silently dropped`);
      assert.ok(renderedTools.includes(mapped), `agents/${file} source tool "${srcTool}" -> "${mapped}" did not survive in the rendered output`);
    }
  }
});

// The source entrypoint stays Pi-valid while role templates remain harness-neutral.
test("#1604 dev-loop.agent.md source drops agent/todo and declares edit/write", async () => {
  const raw = await readFile(fileURLToPath(new URL("../agents/dev-loop.agent.md", import.meta.url)), "utf8");
  const toolsLine = raw.match(/^tools:\s*(.*)$/m);
  assert.ok(toolsLine, "dev-loop.agent.md must declare a tools: line");
  const tools = toolsLine[1].split(/[\s,]+/).filter(Boolean);
  assert.equal(tools.includes("agent"), false, "dev-loop source must not declare redundant `agent` (subagent covers it)");
  assert.equal(tools.includes("todo"), false, "dev-loop source must not declare `todo` (no Pi builtin)");
  assert.ok(tools.includes("edit"), "dev-loop source must declare `edit` (conductor mutates under Pi)");
  assert.ok(tools.includes("write"), "dev-loop source must declare `write` (conductor mutates under Pi)");
  assert.ok(tools.includes("search"), "dev-loop source keeps neutral `search`");
  assert.ok(tools.includes("execute"), "dev-loop source keeps neutral `execute`");
  assert.ok(tools.includes("subagent"), "dev-loop source keeps `subagent`");
});

test("#1604 dev-loop source renders to a Pi-valid conductor toolset (read, bash, edit, write, subagent)", () => {
  const raw = `---
name: "dev-loop"
tools: read, search, execute, bash, edit, write, subagent
---

body
`;
  const rendered = renderPiAgent(raw);
  const toolsLine = rendered.match(/^tools:\s*(.*)$/m)[1];
  assert.deepEqual(toolsLine.split(/,\s*/), ["read", "bash", "edit", "write", "subagent"]);
  for (const forbidden of FORBIDDEN_UNDER_PI) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(rendered), false, `rendered dev-loop must not leak ${forbidden}`);
  }
});

test("#1604 role-agent sources keep neutral search/execute (no Claude regression — #1086)", async () => {
  // Role agents MUST keep search/execute in source: Claude maps search->Grep+Glob
  // and execute->Bash; dropping them removes Grep/Glob from the Claude-rendered
  // role agents (a cross-harness regression). Pi sync already maps them to bash.
  //
  // The `review` agent is exempted per #1659: it drops search/execute from source
  // so Pi does not mark review steps `failed` for unavailable declared tools (which
  // aborts runs.all / GATE-EXEC-PRIME). The review agent can search via `bash`
  // (rg/grep) on both harnesses, and code-execution verification is delegated to CI.
  // See the dedicated `#1659 review agent source is Pi-safe` test below.
  const roleAgents = ["fixer", "developer", "docs", "quality", "refiner"];
  for (const name of roleAgents) {
    const raw = await readFile(fileURLToPath(new URL(`../agents/${name}.agent.md`, import.meta.url)), "utf8");
    const tools = (raw.match(/^tools:\s*(.*)$/m)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
    assert.ok(tools.includes("search"), `agents/${name}.agent.md must keep neutral \`search\` (Claude maps to Grep+Glob)`);
    assert.ok(tools.includes("execute"), `agents/${name}.agent.md must keep neutral \`execute\` (Claude maps to Bash)`);
    assert.equal(tools.includes("agent"), false, `role agent ${name} must not declare \`agent\``);
    assert.equal(tools.includes("todo"), false, `role agent ${name} must not declare \`todo\``);
  }
});

// #1659 — the review agent drops search/execute from source so Pi does not mark
// review fan-out steps `failed` for unavailable declared tools. The review agent
// uses `bash` (rg/grep) for search on both harnesses; code-execution verification
// is delegated to CI. This is the root-cause fix for shallow gate review on Pi:
// the GATE-EXEC-PRIME primer-then-parallel pattern dispatches `review` agents,
// and a `failed` status on the primer aborts the entire `runs.all`.
test("#1659 review agent source is Pi-safe (no search/execute) and keeps bash/read", async () => {
  const raw = await readFile(fileURLToPath(new URL("../agents/review.agent.md", import.meta.url)), "utf8");
  const tools = (raw.match(/^tools:\s*(.*)$/m)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
  // search/execute dropped — these cause Pi to mark the step `failed`
  assert.equal(tools.includes("search"), false, "review agent must not declare `search` (Pi has no builtin — #1659)");
  assert.equal(tools.includes("execute"), false, "review agent must not declare `execute` (Pi has no builtin — #1659)");
  // bash + read + edit + write retained — the full Pi-valid toolset (#1659 coverage finding)
  assert.ok(tools.includes("bash"), "review agent must declare `bash` (search via rg/grep on both harnesses)");
  assert.ok(tools.includes("read"), "review agent must declare `read` (read diff/source)");
  assert.ok(tools.includes("edit"), "review agent must declare `edit` (part of retained toolset)");
  assert.ok(tools.includes("write"), "review agent must declare `write` (part of retained toolset)");
  // every declared tool is already a Pi builtin — no sync mapping needed
  for (const tool of tools) {
    assert.ok(
      VALID_PI_TOOLS.has(tool),
      `review agent source tool must be a Pi builtin (no mapping needed): ${tool}`,
    );
    assert.equal(
      FORBIDDEN_UNDER_PI.includes(tool),
      false,
      `review agent must not list a forbidden tool under Pi: ${tool}`,
    );
  }
});

// Project-local sync replaces source symlinks without mutating neutral templates.

test("#1606 syncPackagedAgents replaces a .pi/agents symlink with a real dir of Pi-valid copies (source untouched)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-project-symlink-"));
  const sourceRoot = path.join(tempDir, "source");
  const targetRoot = path.join(tempDir, "global-agents");
  const projectRoot = path.join(tempDir, "project");
  const projectAgentsDir = path.join(projectRoot, ".pi", "agents");

  await mkdir(sourceRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
  const neutralSource = `---
name: "fixer"
tools: read, search, execute, bash, edit, write
---

fixer body
`;
  await writeFile(path.join(sourceRoot, "fixer.agent.md"), neutralSource);
  await symlink(path.resolve(tempDir, "source"), projectAgentsDir, "dir");

  await syncPackagedAgents({ sourceRoot, targetRoot, projectRoot });

  const stat = await lstat(projectAgentsDir);
  assert.equal(stat.isSymbolicLink(), false, ".pi/agents must no longer be a symlink after sync");
  assert.ok(stat.isDirectory(), ".pi/agents must be a real directory after sync");

  const rendered = await readFile(path.join(projectAgentsDir, "fixer.agent.md"), "utf8");
  const toolsLine = rendered.match(/^tools:\s*(.*)$/m);
  assert.ok(toolsLine, "rendered fixer must have a tools: line");
  const tools = toolsLine[1].split(/[\s,]+/).filter(Boolean);
  assert.deepEqual(tools, ["read", "bash", "edit", "write"]);
  for (const forbidden of FORBIDDEN_UNDER_PI) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(rendered),
      false,
      `project-local fixer must not leak forbidden tool name: ${forbidden}`,
    );
  }

  const sourceAfter = await readFile(path.join(sourceRoot, "fixer.agent.md"), "utf8");
  assert.equal(sourceAfter, neutralSource, "neutral source must remain untouched (no write-through)");
  assert.ok(sourceAfter.includes("search"), "source must keep neutral `search`");
  assert.ok(sourceAfter.includes("execute"), "source must keep neutral `execute`");
});

test("#1606 syncPackagedAgents refreshes a real (non-symlink) .pi/agents dir in place", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-project-realdir-"));
  const sourceRoot = path.join(tempDir, "source");
  const targetRoot = path.join(tempDir, "global-agents");
  const projectRoot = path.join(tempDir, "project");
  const projectAgentsDir = path.join(projectRoot, ".pi", "agents");

  await mkdir(sourceRoot, { recursive: true });
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "fixer.agent.md"),
    `---
name: "fixer"
tools: read, search, execute, bash, edit, write
---

fixer body
`,
  );
  await writeFile(
    path.join(projectAgentsDir, "fixer.agent.md"),
    `---
name: "fixer"
tools: read, search, execute
---

stale
`,
  );

  await syncPackagedAgents({ sourceRoot, targetRoot, projectRoot });

  const rendered = await readFile(path.join(projectAgentsDir, "fixer.agent.md"), "utf8");
  const tools = rendered.match(/^tools:\s*(.*)$/m)[1].split(/[\s,]+/).filter(Boolean);
  assert.deepEqual(tools, ["read", "bash", "edit", "write"]);
  for (const forbidden of FORBIDDEN_UNDER_PI) {
    assert.equal(rendered.includes(forbidden), false, `refreshed fixer must not leak ${forbidden}`);
  }
});

test("#1606 syncPackagedAgents is a no-op for project-local when .pi/agents is absent (consumer repos unaffected)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-project-absent-"));
  const sourceRoot = path.join(tempDir, "source");
  const targetRoot = path.join(tempDir, "global-agents");
  const projectRoot = path.join(tempDir, "project");

  await mkdir(sourceRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "fixer.agent.md"),
    `---
name: "fixer"
tools: read, search, execute, bash, edit, write
---

fixer body
`,
  );

  await syncPackagedAgents({ sourceRoot, targetRoot, projectRoot });

  await access(path.join(targetRoot, "fixer.agent.md"));
  await assert.rejects(
    lstat(path.join(projectRoot, ".pi", "agents")),
    "project-local .pi/agents must not be created when absent",
  );
});

test("#1607 Copilot: a write failure leaves the .pi/agents symlink intact (atomic swap, no unlink-before-prepare)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-project-robustness-"));
  const projectRoot = path.join(tempDir, "project");
  const projectAgentsDir = path.join(projectRoot, ".pi", "agents");
  await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
  const sourceRoot = path.join(tempDir, "source-file");
  await writeFile(sourceRoot, "not a directory\n");
  await symlink(path.join(tempDir, "dummy"), projectAgentsDir, "dir");

  assert.throws(() => syncProjectAgentsDir(projectRoot, sourceRoot));

  const stat = await lstat(projectAgentsDir);
  assert.equal(stat.isSymbolicLink(), true, ".pi/agents symlink must remain after a write failure");
  const piDir = path.join(projectRoot, ".pi");
  const leftovers = (await readdir(piDir)).filter((f) => f.startsWith(".pi-agents.tmp-"));
  assert.deepEqual(leftovers, [], "no temp directory must leak after a write failure");
});

test("project-agent sync tolerates the symlink disappearing before replacement", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pi-project-race-"));
  const sourceRoot = path.join(tempDir, "source");
  const projectRoot = path.join(tempDir, "project");
  const agentsDir = path.join(projectRoot, ".pi", "agents");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(path.dirname(agentsDir), { recursive: true });
  await writeFile(path.join(sourceRoot, "fixer.agent.md"), "fixer\n");
  await symlink(sourceRoot, agentsDir, "dir");
  const lstatSync = fs.lstatSync;
  fs.lstatSync = (target) => {
    const stat = lstatSync(target);
    if (target === agentsDir) fs.unlinkSync(target);
    return stat;
  };
  try { syncProjectAgentsDir(projectRoot, sourceRoot); }
  finally { fs.lstatSync = lstatSync; }
  assert.equal((await lstat(agentsDir)).isDirectory(), true);
});
