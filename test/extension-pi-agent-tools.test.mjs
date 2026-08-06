import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOL_NAME_MAP_PI,
  mapAgentToolsForPi,
  renderPiAgent,
  syncPackagedAgents,
  BUILTIN_TOOL_SET,
} from "../extension/sync-packaged-agents.ts";

// #1583 — the harness-neutral tool names that Pi must NOT see in a rendered
// ~/.agents/*.agent.md (they have no Pi builtin equivalent and cause the
// "requested unavailable child tools" failure).
const FORBIDDEN_UNDER_PI = ["search", "execute", "agent", "todo"];

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

test("BUILTIN_TOOL_SET contains only valid Pi builtin names", () => {
  for (const name of BUILTIN_TOOL_SET) {
    assert.equal(FORBIDDEN_UNDER_PI.includes(name), false, `Pi builtin set must not list a forbidden name: ${name}`);
  }
  // The mapped values are the canonical Pi builtins reachable from the agent vocabulary.
  assert.ok(BUILTIN_TOOL_SET.has("read"));
  assert.ok(BUILTIN_TOOL_SET.has("bash"));
  assert.ok(BUILTIN_TOOL_SET.has("edit"));
  assert.ok(BUILTIN_TOOL_SET.has("write"));
  assert.ok(BUILTIN_TOOL_SET.has("subagent"));
  assert.ok(BUILTIN_TOOL_SET.has("review_loop"));
});

test("mapAgentToolsForPi dedupes and drops todo, preserving first-seen order", () => {
  // dev-loop agent vocabulary: read, search, execute, bash, agent, todo, subagent
  assert.deepEqual(
    mapAgentToolsForPi(["read", "search", "execute", "bash", "agent", "todo", "subagent"]),
    ["read", "bash", "subagent"],
  );
  // developer/docs/fixer/quality/refiner/review vocabulary: read, search, execute, bash, edit, write
  assert.deepEqual(
    mapAgentToolsForPi(["read", "search", "execute", "bash", "edit", "write"]),
    ["read", "bash", "edit", "write"],
  );
  assert.deepEqual(mapAgentToolsForPi(["todo"]), []);
  assert.deepEqual(mapAgentToolsForPi([]), []);
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
  // forbidden names are absent
  for (const forbidden of FORBIDDEN_UNDER_PI) {
    assert.match(rendered, new RegExp(`^tools:`, "m"));
    assert.equal(new RegExp(`\\b${forbidden}\\b`, "m").test(rendered.replace(/^tools:.*$/m, "")), false, `rendered body must not leak forbidden tool name: ${forbidden}`);
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
        BUILTIN_TOOL_SET.has(tool),
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
        BUILTIN_TOOL_SET.has(tool),
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

