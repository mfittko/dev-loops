// Emitted CLI calls use the launcher form under Claude Code (ADR 0118), and
// Pi and Codex text stays byte-identical (cross-harness regression contract).
import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BARE_DEV_LOOPS_NS_SOURCE } from "../../packages/core/src/claude/asset-generation.mjs";
import { cliError, renderCliText } from "../../packages/core/src/loop/cli-command.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const REMEDY = "run `dev-loops pr restore-ready --repo o/r --pr 7` then `dev-loops gate upsert-verdict --gate x`; see `dev-loops queue` and dev-loops gate.";
const CLAUDE = { CLAUDECODE: "1" };

test("Claude harness renders the launcher form with --repo-root", () => {
  const out = renderCliText(REMEDY, { env: CLAUDE, root: "/wt" });
  assert.ok(out.includes("`dev-loops-run --repo-root /wt cli/index.mjs pr restore-ready --repo o/r --pr 7`"));
  assert.ok(out.includes("dev-loops-run --repo-root /wt cli/index.mjs gate upsert-verdict --gate x"));
  assert.ok(out.includes("see `dev-loops queue` and dev-loops gate."), "prose stays untouched");
  assert.equal(renderCliText("dev-loops pr x", { env: CLAUDE }), "dev-loops-run --repo-root <checkout> cli/index.mjs pr x");
});

test("Pi and Codex text stays byte-identical", () => {
  for (const env of [{}, { CODEX_THREAD_ID: "t-1" }, { CLAUDECODE: "0" }]) {
    assert.equal(renderCliText(REMEDY, { env }), REMEDY);
  }
});

test("cliError renders the message per harness", () => {
  const saved = process.env.CLAUDECODE;
  try {
    process.env.CLAUDECODE = "1";
    assert.match(cliError("run dev-loops pr restore-ready now").message, /dev-loops-run --repo-root <checkout> cli\/index\.mjs pr restore-ready/);
    delete process.env.CLAUDECODE;
    assert.equal(cliError("run dev-loops pr restore-ready now").message, "run dev-loops pr restore-ready now");
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  }
});

const listFiles = (dirs, ext) => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(repoRoot, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(ext)) files.push(rel);
    }
  };
  for (const dir of dirs) if (fs.existsSync(path.join(repoRoot, dir))) walk(dir);
  return files;
};
const hitsOf = (files, re) => files.filter((f) => re.test(fs.readFileSync(path.join(repoRoot, f), "utf8")));

test("Claude-rendered text names no bare `dev-loops <ns>` call", () => {
  assert.doesNotMatch(renderCliText(REMEDY, { env: CLAUDE }), new RegExp(BARE_DEV_LOOPS_NS_SOURCE));
});

test("no agent-facing doc or emitter names a `cd <checkout> &&` prefix before dev-loops-run", () => {
  const CD_RE = /\bcd\s+\S+\s+&&\s+dev-loops-run\b/;
  const files = ["AGENTS.md", ...listFiles(["skills", "agents", ".claude"], ".md"), ...listFiles(["scripts", "packages/core/src"], ".mjs")];
  assert.deepEqual(hitsOf(files, CD_RE), []);
});

test("no AGENTS.md, skill, agent or Claude asset doc names the bare `dev-loops <ns>` form", () => {
  assert.deepEqual(hitsOf(["AGENTS.md", ...listFiles(["skills", "agents", ".claude"], ".md")], new RegExp(BARE_DEV_LOOPS_NS_SOURCE)), []);
});
