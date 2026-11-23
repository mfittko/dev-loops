import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import {
  computeSpawnTimeout,
  evaluateSpawnTimeout,
  parseAddedLines,
  runCli,
  ESCAPE_MARKER,
} from "../../scripts/loop/check-spawn-timeout.mjs";
import { runGitFixture } from "../_helpers.mjs";

const run = (content, { file = "scripts/loop/thing.mjs", lines, deletedAfter } = {}) => {
  const all = content.split("\n").map((_, i) => i + 1);
  return computeSpawnTimeout({ files: [{ path: file, content, addedLines: lines ?? all, deletedAfter }] });
};

const CALLS = ["runChild", "spawnSync", "execFileSync"];
const ROOTS = ["scripts/loop/thing.mjs", "packages/core/src/thing.mjs"];

for (const call of CALLS) {
  for (const file of ROOTS) {
    test(`blocks ${call} without a timeout in ${file}`, () => {
      const out = run(`const r = ${call}("git", ["status"]);`, { file });
      assert.equal(out.outcome, "block");
      assert.equal(out.findings[0].call, call);
      assert.equal(out.findings[0].line, 1);
    });
  }
}

test("each callee needs the key it reads, outside strings and comments, with an effective value", () => {
  const key = { runChild: "timeoutMs", spawnSync: "timeout", execFileSync: "timeout" };
  const wrong = { runChild: "timeout", spawnSync: "timeoutMs", execFileSync: "timeoutMs" };
  for (const call of CALLS) {
    const opts = (body) => `${call}("c", a, ${call === "runChild" ? "env, undefined, " : ""}${body});`;
    assert.equal(run(opts(`{ ${key[call]}: 5000 }`)).outcome, "pass");
    assert.equal(run(opts(`{ cwd, ${key[call]} }`)).outcome, "pass");
    assert.equal(run(opts(`{ ${wrong[call]}: 5000 }`)).outcome, "block");
    assert.equal(run(opts(`{ ${key[call]}: 0 }`)).outcome, "block");
    assert.equal(run(opts(`{ ${key[call]}: undefined }`)).outcome, "block");
    assert.equal(run(opts(`{ note: "${key[call]}: 5" }`)).outcome, "block");
    assert.equal(run(opts(`{ cwd } /* ${key[call]}: 5 */`)).outcome, "block");
  }
  assert.equal(run('spawnSync("curl", ["--connect-timeout", "5"]);').outcome, "block");
  assert.equal(run('spawnSync("timeout-helper", a);').outcome, "block");
});

test("the timeout must be an option key at the position the callee reads, with a real value", () => {
  assert.equal(run('spawnSync("curl", ["-m", timeout, url]);').outcome, "block");
  assert.equal(run('spawnSync("sleep", [timeout, x]);').outcome, "block");
  assert.equal(run('spawnSync("sleep", a, { cwd: flag ? timeout : fallback });').outcome, "block");
  assert.equal(run('spawnSync("sleep", a, { timeout: null });').outcome, "block");
  assert.equal(run('runChild(c, a, { timeoutMs: null });').outcome, "block");
  assert.equal(run('runChild(c, a, { timeoutMs: 5000 });').outcome, "block");
  assert.equal(run('runChild(c, a, env, undefined, { timeoutMs: flag ? 5 : 9 });').outcome, "pass");
});

test("a regex literal, a trailing comment and a string do not change what counts as a call", () => {
  assert.equal(run('retry(() => { spawnSync("grep", [p.replace(/\\(/, "")]); }, { timeout: 5 });').outcome, "block");
  assert.equal(run('const re = /https?:\\/\\//u; spawnSync("git");').outcome, "block");
  assert.equal(run("const a = 1; // calls spawnSync(cmd)").outcome, "pass");
  assert.equal(run('const msg = "use spawnSync(cmd)";').outcome, "pass");
});

test("a generator method, a multiplication line and an import call still block", () => {
  assert.equal(run('class A {\n  *run() { spawnSync("git"); }\n}').outcome, "block");
  assert.equal(run('const n = a\n  * spawnSync("git").status;').outcome, "block");
  assert.equal(run('import cp from "x"; spawnSync("git");').outcome, "block");
  assert.equal(run('import("x").then(() => spawnSync("git"));').outcome, "block");
});

test("passes a multi-line call that sets timeout or timeoutMs", () => {
  assert.equal(run('execFileSync("git", ["log"], {\n  cwd,\n  timeout: 5000,\n});').outcome, "pass");
  assert.equal(run('runChild("node", args, env, undefined, {\n  timeoutMs: 5000,\n});').outcome, "pass");
});

test("a parenthesis in a string does not extend the span into an enclosing timeout", () => {
  assert.equal(run('retry(() => { spawnSync("grep", ["foo("]); }, { timeout: 5 });').outcome, "block");
  assert.equal(run('log(spawnSync("grep", ["-F", "(", file]), { timeout: 5 });').outcome, "block");
});

test("a call inside a template expression is seen and a nested template keeps its parity", () => {
  assert.equal(run('const sha = `${execFileSync("git", ["rev-parse", "HEAD"])}`;').outcome, "block");
  assert.equal(run('const a = `${x ? `"` : ""}`;\nspawnSync("git");').outcome, "block");
  assert.equal(run('log(spawnSync("grep", [`${x ? `(` : ""}`]), { timeout: 5 });').outcome, "block");
  assert.equal(run('const s = `${spawnSync("git", { timeout: 5 })}`;').outcome, "pass");
});

test("a runChild bound in its own file blocks unless marked", () => {
  const bound = 'function runChild(c, a, e, s) {}\nrunChild("git", [], {}, "", { timeoutMs: 5 });';
  assert.equal(run(bound, { lines: [2] }).outcome, "block");
  assert.match(run(bound, { lines: [2] }).recovery, /bound in its own file/u);
  assert.equal(run('const f = ({ runChild = exec }) => runChild("gh", [], { timeout: 5 });').outcome, "block");
  assert.equal(run(`${bound.replace("runChild(\"git\"", `// ${ESCAPE_MARKER} timeout set in callee\nrunChild("git"`)}`, { lines: [3] }).outcome, "pass");
});

test("an unbalanced or unterminated call blocks", () => {
  assert.equal(run('spawnSync("git", [').outcome, "block");
  assert.equal(run('spawnSync("git, { timeout: 5 });').outcome, "block");
});

test("a reasoned allow marker passes and a bare marker blocks", () => {
  assert.equal(run(`// ${ESCAPE_MARKER} interactive editor\nspawnSync("vim");`).outcome, "pass");
  assert.equal(run(`spawnSync("vim"); // ${ESCAPE_MARKER} interactive editor`).outcome, "pass");
  assert.equal(run(`// ${ESCAPE_MARKER}\nspawnSync("vim");`).outcome, "block");
  assert.equal(run(`/* ${ESCAPE_MARKER} */ spawnSync("c");`).outcome, "block");
  assert.equal(run(`/* ${ESCAPE_MARKER} */\nspawnSync("c");`).outcome, "block");
  assert.equal(run(`/* ${ESCAPE_MARKER} interactive */\nspawnSync("c");`).outcome, "pass");
});

test("a trailing marker on the previous call does not admit the next call", () => {
  const out = run(`spawnSync("vim"); // ${ESCAPE_MARKER} interactive editor\nspawnSync("git", args);`);
  assert.equal(out.outcome, "block");
  assert.deepEqual(out.findings.map((f) => f.line), [2]);
});

test("a marker admits only a call it sits beside or alone above, never a code line before", () => {
  assert.equal(run(`/* note */ spawnSync("vim"); // ${ESCAPE_MARKER} editor\nspawnSync("git", args);`).findings.map((f) => f.line).join(), "2");
  assert.equal(run(`/* ${ESCAPE_MARKER} editor */ spawnSync("vim");\nspawnSync("git", args);`).findings.map((f) => f.line).join(), "2");
  assert.equal(run(`/* ${ESCAPE_MARKER} editor */\nspawnSync("vim");`).outcome, "pass");
});

test("ignores test files, out-of-scope paths, definitions, imports, member calls, comments and untouched lines", () => {
  const call = 'spawnSync("git");';
  assert.equal(run(call, { file: "scripts/loop/thing.test.mjs" }).outcome, "pass");
  assert.equal(run(call, { file: "test/loop/thing.mjs" }).outcome, "pass");
  assert.equal(run(call, { file: "docs/thing.mjs" }).outcome, "pass");
  assert.equal(run("export function runChild(cmd) {}").outcome, "pass");
  assert.equal(run('import { spawnSync } from "node:child_process";').outcome, "pass");
  assert.equal(run("cp.spawnSync(x);").outcome, "pass");
  assert.equal(run(`${call}\nconst x = 1;`, { lines: [2] }).outcome, "pass");
  assert.equal(run("// calls `execFileSync(\"gh\")` here").outcome, "pass");
  assert.equal(run("/**\n * Wraps execFileSync(cmd).\n */").outcome, "pass");
  assert.equal(run(`/* note */ ${call}`).outcome, "block");
});

test("a call in a one-line function body blocks", () => {
  assert.equal(run('function head() { return execFileSync("git", ["rev-parse", "HEAD"]); }').outcome, "block");
  assert.equal(run('export function head(cwd) { return execFileSync("git", ["rev-parse", "HEAD"], { cwd }); }').outcome, "block");
});

test("an edit inside an existing multi-line call is checked, an untouched call is not", () => {
  const call = 'execFileSync("git", ["log"], {\n  cwd,\n});\nconst x = 1;\nspawnSync("a");';
  // The timeout line was deleted between lines 1 and 2.
  assert.equal(run(call, { lines: [], deletedAfter: [1] }).outcome, "block");
  // An inner line was edited.
  assert.equal(run(call, { lines: [2] }).outcome, "block");
  // Only the later call's neighborhood changed: the first call is untouched, the second blocks.
  assert.deepEqual(run(call, { lines: [5] }).findings.map((f) => f.line), [5]);
  assert.equal(run(call, { lines: [], deletedAfter: [3] }).outcome, "pass");
  assert.equal(run(call, { lines: [4] }).outcome, "pass");
});

test("parseAddedLines reads added line numbers and deletions for in-scope files only", () => {
  const diff = [
    "diff --git a/scripts/a.mjs b/scripts/a.mjs",
    "+++ b/scripts/a.mjs",
    "@@ -1,0 +2,2 @@",
    "@@ -9 +12 @@",
    "@@ -20,3 +30,0 @@",
    "diff --git a/docs/b.mjs b/docs/b.mjs",
    "+++ b/docs/b.mjs",
    "@@ -0,0 +1 @@",
  ].join("\n");
  assert.deepEqual([...parseAddedLines(diff)], [["scripts/a.mjs", { added: [2, 3, 12], deletedAfter: [30] }]]);
});

test("parseAddedLines ignores a content line that looks like a file header and refuses a quoted header", () => {
  const diff = [
    "diff --git a/scripts/a.mjs b/scripts/a.mjs",
    "+++ b/scripts/a.mjs",
    "@@ -1,0 +1 @@",
    "+++ i;",
    "@@ -5,0 +9 @@",
    "+++ b/scripts/other.mjs",
  ].join("\n");
  assert.deepEqual([...parseAddedLines(diff)], [["scripts/a.mjs", { added: [1, 9], deletedAfter: [] }]]);
  assert.throws(() => parseAddedLines('diff --git a/x b/x\n+++ "b/scripts/caf\\303\\251.mjs"'), /quoted/u);
  assert.deepEqual([...parseAddedLines('diff --git a/x b/x\n+++ "b/docs/a\\tb.md"\n@@ -0,0 +1 @@')], []);
});

// A feature branch over a base commit; `change` writes the feature files.
async function withRepo(change, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-spawn-timeout-"));
  try {
    runGitFixture(dir, ["init", "-q", "-b", "main"]);
    runGitFixture(dir, ["config", "user.email", "t@t"]);
    runGitFixture(dir, ["config", "user.name", "t"]);
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "scripts/old.mjs"), 'spawnSync("git");\n');
    await writeFile(path.join(dir, "scripts/multi.mjs"), 'execFileSync("git", ["log"], {\n  cwd,\n  timeout: 5000,\n});\n');
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-q", "-m", "base"]);
    runGitFixture(dir, ["checkout", "-q", "-b", "feat"]);
    await change(dir);
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-q", "-m", "feat"]);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const addNew = (dir) => writeFile(path.join(dir, "scripts/new.mjs"), 'const a = 1;\nspawnSync("git");\n');

test("scans only changed files in a git repo", async () => {
  await withRepo(addNew, async (dir) => {
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir, env: isolatedEnv });
    assert.equal(out.outcome, "block");
    assert.deepEqual(out.findings.map((f) => [f.path, f.line]), [["scripts/new.mjs", 2]]);
  });
});

test("git config and env cannot change what the lint scans", async () => {
  await withRepo(addNew, async (dir) => {
    for (const config of [["diff.noprefix", "true"], ["diff.relative", "true"], ["diff.interHunkContext", "3"], ["diff.mnemonicPrefix", "true"]]) runGitFixture(dir, ["config", ...config]);
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir, env: { ...isolatedEnv, GIT_DIFF_OPTS: "-u3" } });
    assert.deepEqual(out.findings.map((f) => [f.path, f.line]), [["scripts/new.mjs", 2]]);
  });
});

test("a removed timeout, a non-ASCII path and a -diff attribute are all scanned", async () => {
  await withRepo(async (dir) => {
    await writeFile(path.join(dir, "scripts/multi.mjs"), 'execFileSync("git", ["log"], {\n  cwd,\n});\n');
    await writeFile(path.join(dir, "scripts/café.mjs"), 'spawnSync("git");\n');
    await writeFile(path.join(dir, ".gitattributes"), "*.mjs -diff\n");
    await writeFile(path.join(dir, "scripts/bin.mjs"), 'spawnSync("git");\n\0');
  }, async (dir) => {
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir, env: isolatedEnv });
    assert.deepEqual(out.findings.map((f) => f.path).sort(), ["scripts/bin.mjs", "scripts/café.mjs", "scripts/multi.mjs"]);
  });
});

test("a later hunk after a content line that looks like a header is scanned", async () => {
  await withRepo(async (dir) => {
    const body = ["const a = 1;", "++ i;", ...Array.from({ length: 8 }, () => "const b = 2;"), 'spawnSync("git");', ""].join("\n");
    await writeFile(path.join(dir, "scripts/hunks.mjs"), body);
  }, async (dir) => {
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir, env: isolatedEnv });
    assert.deepEqual(out.findings.map((f) => [f.path, f.line]), [["scripts/hunks.mjs", 11]]);
  });
});

test("the evaluation reads the committed copy, not the working tree", async () => {
  await withRepo(addNew, async (dir) => {
    await writeFile(path.join(dir, "scripts/new.mjs"), "const a = 1;\n");
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir, env: isolatedEnv });
    assert.equal(out.outcome, "block");
  });
});

test("fails closed on an option-like ref and an unresolvable base, with the git cause", async () => {
  await assert.rejects(evaluateSpawnTimeout({ base: "--output=x" }), /plausible git ref/u);
  await assert.rejects(evaluateSpawnTimeout({ base: "main", head: "a..b" }), /plausible git ref/u);
  await withRepo(addNew, async (dir) => {
    await assert.rejects(evaluateSpawnTimeout({ base: "no-such-ref", repoRoot: dir, env: isolatedEnv }), /no-such-ref/u);
  });
});

test("runCli exits 0 on pass, 1 on block with recovery and error, and refuses a missing --base", async () => {
  const sink = () => { const chunks = []; return { chunks, write: (s) => { chunks.push(s); } }; };
  const exec = async (argv, repoRoot) => {
    const stdout = sink();
    const previous = process.exitCode;
    try {
      const payload = await runCli(argv, { stdout, stderr: sink(), repoRoot, env: isolatedEnv });
      return { code: process.exitCode, payload, out: stdout.chunks.join("") };
    } finally {
      process.exitCode = previous;
    }
  };
  await withRepo(addNew, async (dir) => {
    const block = await exec(["--base", "main"], dir);
    assert.equal(block.code, 1);
    assert.equal(block.payload.error, "spawn_timeout_block");
    assert.ok(block.payload.recovery);
    assert.equal(JSON.parse(block.out).outcome, "block");
    const fields = await exec(["--base", "main", "--fields", "outcome"], dir);
    assert.equal(fields.out.trim(), "block");
  });
  await withRepo(async (dir) => writeFile(path.join(dir, "scripts/ok.mjs"), 'spawnSync("git", [], { timeout: 5 });\n'), async (dir) => {
    const pass = await exec(["--base", "main"], dir);
    assert.equal(pass.code, 0);
    assert.equal(pass.payload.outcome, "pass");
  });
  await assert.rejects(exec([], process.cwd()), /requires --base/u);
});

test("the direct CLI run exits 2 on a usage error, never 0", () => {
  const script = fileURLToPath(new URL("../../scripts/loop/check-spawn-timeout.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: isolatedEnv, timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --base/u);
});
