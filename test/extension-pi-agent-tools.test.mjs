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
  // developer/docs/fixer/quality/refiner/review vocabulary: read, search, execute, bash, edit, write
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
