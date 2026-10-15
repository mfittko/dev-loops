import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { initSizeBudgetFixtureRepo, runIdFreeEnv, runGitFixture } from "../_helpers.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

const source = path.resolve(import.meta.dirname, "../..");
const ready = "scripts/loop/pre-pr-ready-gate.mjs";
const merge = "scripts/github/detect-checkpoint-evidence.mjs";
const human = "scripts/loop/resolve-human-merge-only.mjs";

async function installedFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-installed-")));
  const plugin = path.join(root, "plugin"), consumer = path.join(root, "consumer");
  const pkg = path.join(plugin, "node_modules/dev-loops"), bin = path.join(root, "bin");
  fs.mkdirSync(consumer); fs.mkdirSync(bin);
  fs.cpSync(path.join(source, ".claude/hooks"), path.join(plugin, "hooks"), { recursive: true });
  fs.cpSync(path.join(source, ".claude/bin"), path.join(plugin, "bin"), { recursive: true });
  for (const rel of ["scripts", "lib", "package.json", "packages/core/src", "packages/core/package.json"]) {
    fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
    fs.cpSync(path.join(source, rel), path.join(pkg, rel), { recursive: true });
  }
  fs.mkdirSync(path.join(pkg, "node_modules/@dev-loops"), { recursive: true });
  fs.symlinkSync(path.join(pkg, "packages/core"), path.join(pkg, "node_modules/@dev-loops/core"));
  for (const dep of ["yaml", "zod"]) fs.cpSync(fs.realpathSync(path.join(source, "node_modules", dep)), path.join(pkg, "node_modules", dep), { recursive: true });
  for (const tool of ["node", "git"]) {
    const result = spawnSync("which", [tool], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    fs.symlinkSync(result.stdout.trim(), path.join(bin, tool));
  }
  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(consumer, { devloopsYaml: "version: 1\nautonomy:\n  humanMergeOnly: true\n" });
  runGitFixture(consumer, ["remote", "add", "origin", "https://github.com/owner/consumer.git"]);
  const env = runIdFreeEnv({ PATH: bin, FIXTURE_ROOT: root });
  delete env.DEVLOOPS_PRE_PR_READY_GATE_SCRIPT; delete env.DEVLOOPS_PRE_MERGE_GATE_SCRIPT;
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), body); };
  const run = (verb = "ready", extraEnv = {}) => {
    const result = spawnSync("node", [path.join(plugin, "hooks/pre-tool-use-bash-gate.mjs")], {
      cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8",
      input: JSON.stringify({ cwd: consumer, tool_input: { command: `gh pr ${verb} 42` } }),
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
    return output?.permissionDecisionReason ?? null;
  };
  return { root, plugin, consumer, pkg, bin, env, headSha, baseBranch, write, run };
}

test("installed hook runs the real ready helper in a consumer without JS tooling or Bun", async () => {
  const f = await installedFixture();
  try {
    fs.writeFileSync(path.join(f.bin, "gh"), `#!/usr/bin/env node
import fs from 'node:fs';
const root = process.env.FIXTURE_ROOT, args = process.argv.slice(2), key = args.join(' ');
fs.appendFileSync(root + '/gh-log', JSON.stringify({args, cwd: process.cwd()}) + '\\n');
const state = JSON.parse(fs.readFileSync(root + '/state.json'));
let result;
if (args[1] === 'graphql') result = {data:{repository:{pullRequest:key.includes('reviewThreads') ? {reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}} : state.pr}}};
else if (args[1] === 'user') result = {login:'owner'};
else if (key.includes('/comments')) result = [state.surface === 'comment' ? [state.evidence] : []];
else if (key.includes('/reviews')) result = [state.surface === 'review' ? [state.evidence] : []];
else throw new Error('Unexpected transport: ' + key);
console.log(JSON.stringify(result));
`);
    fs.chmodSync(path.join(f.bin, "gh"), 0o755);
    for (const [surface, kind] of [["review", "clean"], ["comment", "clean"], ["review", "absent"], ["review", "stale"], ["review", "nonclean"]]) {
      const evidence = { id: 1, state: "COMMENTED", user: { login: "owner" }, submitted_at: "2026-10-15T00:00:00Z", created_at: "2026-10-15T00:00:00Z",
        body: renderGateReviewCommentBody({ gate: "draft_gate", headSha: kind === "stale" ? "a".repeat(40) : f.headSha, verdict: kind === "nonclean" ? "findings_present" : "clean", findingsSummary: "No findings", nextAction: "Mark ready" }) };
      fs.writeFileSync(path.join(f.root, "state.json"), JSON.stringify({ surface: kind === "absent" ? "none" : surface, evidence,
        pr: { id: "PR_42", isDraft: true, headRefOid: f.headSha, baseRefName: f.baseBranch, state: "OPEN", body: "Scope", closingIssuesReferences: { nodes: [] } } }));
      const reason = f.run();
      if (kind === "clean") {
        const diagnostic = reason && spawnSync("node", [path.join(f.pkg, ready), "--repo", "owner/consumer", "--pr", "42"], { cwd: f.consumer, env: f.env, encoding: "utf8" }).stderr;
        assert.equal(reason, null, `${reason}\n${diagnostic || ""}`);
      }
      else { assert.match(reason, /no visible clean draft_gate/); assert.doesNotMatch(reason, /could not run/); }
    }
    const calls = fs.readFileSync(path.join(f.root, "gh-log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(({ args }) => args.includes("owner=owner") && args.includes("name=consumer") && args.includes("number=42")));
    assert.ok(calls.every(({ cwd }) => cwd === f.consumer));
    for (const rel of ["scripts", "package.json", "node_modules"]) assert.equal(fs.existsSync(path.join(f.consumer, rel)), false);
    assert.equal(spawnSync("bun", ["--version"], { env: f.env }).error?.code, "ENOENT");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("installed hook keeps all helper targets, consumer config, overrides and source precedence", async () => {
  const f = await installedFixture();
  try {
    const marker = `import fs from 'node:fs'; fs.appendFileSync(process.env.FIXTURE_ROOT+'/selected', JSON.stringify({file:import.meta.url,cwd:process.cwd(),args:process.argv.slice(2),config:fs.readFileSync('.devloops','utf8')})+'\\n');`;
    for (const rel of [ready, merge, human]) f.write(rel, marker + "console.log('false');");
    assert.equal(f.run(), null);
    assert.match(f.run("merge"), /forbidden/);
    const selected = () => fs.readFileSync(path.join(f.root, "selected"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(selected().map(({ file }) => file.replace(`file://${f.pkg}/`, "")), [ready, human, merge]);
    for (const row of selected()) { assert.equal(row.cwd, f.consumer); assert.match(row.config, /humanMergeOnly: true/); assert.deepEqual(row.args, row.file.endsWith(human) ? [] : ["--repo", "owner/consumer", "--pr", "42"]); }
    for (const [verb, name] of [["ready", "DEVLOOPS_PRE_PR_READY_GATE_SCRIPT"], ["merge", "DEVLOOPS_PRE_MERGE_GATE_SCRIPT"]]) {
      const override = path.join(f.root, `${verb}-override.mjs`); fs.writeFileSync(override, marker);
      f.run(verb, { [name]: override });
      assert.equal(selected().at(-1).file, `file://${override}`);
    }
    fs.writeFileSync(path.join(f.consumer, "package.json"), '{"name":"dev-loops","type":"module"}');
    fs.mkdirSync(path.join(f.consumer, "scripts/loop"), { recursive: true });
    fs.writeFileSync(path.join(f.consumer, ready), marker);
    assert.equal(f.run(), null);
    assert.equal(selected().at(-1).file, `file://${f.consumer}/${ready}`);
    fs.rmSync(path.join(f.consumer, "package.json")); fs.rmSync(path.join(f.consumer, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(source, human), path.join(f.pkg, human));
    fs.writeFileSync(path.join(f.pkg, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: false\n");
    assert.match(f.run("merge"), /humanMergeOnly/);
    fs.rmSync(path.join(f.pkg, human));
    assert.match(f.run("merge"), /forbidden/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const kind of ["package", "launcher", "helper", "override", "startup", "unknown-extension", "directory-import", "unreadable-import", "syntax", "signal", "spawn", "evidence", "override-evidence", "json-evidence"]) {
  // Root bypasses the unreadable-file permission fixture.
  test.skipIf(kind === "unreadable-import" && process.getuid?.() === 0)(`installed hook distinguishes ${kind} failure from missing gate evidence`, async () => {
    const f = await installedFixture();
    try {
      const override = path.join(f.root, "override.mjs");
      f.write(ready, "process.exit(1);");
      if (kind === "package") fs.rmSync(f.pkg, { recursive: true });
      if (kind === "launcher") fs.rmSync(path.join(f.plugin, "bin/dev-loops-run"));
      if (kind === "helper") fs.rmSync(path.join(f.pkg, ready));
      if (kind === "startup") f.write(ready, "import './missing-runtime.mjs';");
      if (kind === "unknown-extension") {
        f.write(ready, "import './runtime.unknown';");
        f.write("scripts/loop/runtime.unknown", "export {};\n");
      }
      if (kind === "directory-import") {
        f.write(ready, "import './runtime/';");
        f.write("scripts/loop/runtime/index.mjs", "export {};\n");
      }
      if (kind === "unreadable-import") {
        f.write(ready, "import './unreadable-runtime.mjs';");
        f.write("scripts/loop/unreadable-runtime.mjs", "export {};\n");
        const unreadable = path.join(f.pkg, "scripts/loop/unreadable-runtime.mjs");
        fs.chmodSync(unreadable, 0o000);
        assert.throws(() => fs.readFileSync(unreadable), (error) => ["EACCES", "EPERM"].includes(error.code));
      }
      if (kind === "syntax") f.write(ready, "export {");
      if (kind === "signal") fs.writeFileSync(override, "process.kill(process.pid, 'SIGTERM');");
      if (kind === "override-evidence") fs.writeFileSync(override, "process.exit(1);");
      if (kind === "spawn") f.write(human, "import fs from 'node:fs'; fs.rmSync(process.cwd(), {recursive:true,force:true}); console.log('false');");
      if (kind === "json-evidence") f.write(ready, `console.error(JSON.stringify({ok:false,error:"Cannot find module / ERR_MODULE_NOT_FOUND / Error: EACCES: permission denied, open '/evidence': invalid evidence"}));process.exit(1);`);
      const reason = f.run(kind === "spawn" ? "merge" : "ready", ["override", "signal", "override-evidence"].includes(kind) ? { DEVLOOPS_PRE_PR_READY_GATE_SCRIPT: override } : {});
      if (kind.endsWith("evidence")) { assert.match(reason, /no visible clean draft_gate/); assert.doesNotMatch(reason, /could not run/); }
      else { assert.match(reason, /could not run/); assert.ok(reason.includes(kind === "spawn" ? merge : ready)); assert.ok(reason.includes(f.consumer)); assert.ok(reason.includes(["override", "signal"].includes(kind) ? override : "dev-loops-run")); }
      if (kind === "unknown-extension") assert.match(reason, /TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]: Unknown file extension/);
      if (kind === "directory-import") assert.match(reason, /Error \[ERR_UNSUPPORTED_DIR_IMPORT\]: Directory import/);
      if (kind === "unreadable-import") { assert.match(reason, /^.*Error: (?:EACCES|EPERM):/m); assert.match(reason, /unreadable-runtime\.mjs/); }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
