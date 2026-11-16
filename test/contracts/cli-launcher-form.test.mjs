// #3105 slice 11 (AC18, AC24): emitted CLI calls use the launcher form under Claude Code, and
// Pi and Codex text stays byte-identical (#1086 cross-harness non-regression).
import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("no agent-facing doc names a `cd <checkout> &&` prefix before dev-loops-run", () => {
  const CD_RE = /\bcd\s+\S+\s+&&\s+dev-loops-run\b/;
  const files = ["AGENTS.md"];
  for (const dir of ["skills", "agents", ".claude"]) {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(repoRoot, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".md")) files.push(rel);
      }
    };
    if (fs.existsSync(path.join(repoRoot, dir))) walk(dir);
  }
  const hits = files.filter((f) => CD_RE.test(fs.readFileSync(path.join(repoRoot, f), "utf8")));
  assert.deepEqual(hits, []);
});
