import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { parseResolveValidationArgs, resolveValidation } from "../../scripts/loop/resolve-validation.mjs";
import { buildValidationResultsPath } from "../../scripts/github/write-gate-context.mjs";
import { runNode } from "../_helpers.mjs";

// Hermetic: the default PR title reader would otherwise shell out to gh.
process.env.DEVLOOPS_SKIP_PR_TITLE_READ = "1";

const LEGACY = fileURLToPath(new URL("../../scripts/loop/run-gate-validation.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/index.mjs", import.meta.url));
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

async function fixture(extraScripts = {}, pinnedBunVersion = bunVersion) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "resolve-validation-"));
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "fixture", packageManager: `bun@${pinnedBunVersion}`,
    scripts: { verify: "bun scripts/verify.mjs", test: "bun run verify", passing: "bun scripts/docs/validate-rule-ownership.mjs", "test:scripts": "bun scripts/docs/validate-links.mjs", "test:all": "bun scripts/run-bun-test.mjs --all", "test:docs": "bun scripts/docs/validate-decision-records.mjs", "test:workflows": "bun scripts/github/lint-workflows.mjs", ...extraScripts },
  }));
  await mkdir(path.join(repoRoot, "scripts"));
  await mkdir(path.join(repoRoot, "scripts", "docs"));
  await mkdir(path.join(repoRoot, "scripts", "github"));
  await writeFile(path.join(repoRoot, ".gitignore"), "tmp/\n");
  await writeFile(path.join(repoRoot, ".devloops"), "version: 1\nvalidation:\n  mode: local\n");
  for (const name of ["verify", "passing", "suite", "all", "docs", "workflows"]) {
    await writeFile(path.join(repoRoot, "scripts", `${name}.mjs`), `console.log('${name}-ran')`);
  }
  await writeFile(path.join(repoRoot, "scripts", "fail.mjs"), "console.error('fixture failure'); process.exit(2);\n");
  for (const name of ["docs/validate-rule-ownership", "docs/validate-links", "docs/validate-decision-records", "github/lint-workflows", "run-bun-test"]) {
    await writeFile(path.join(repoRoot, "scripts", `${name}.mjs`), `console.log('${name}-ran')`);
  }
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "package.json", ".gitignore", ".devloops", "scripts"], { cwd: repoRoot });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: repoRoot });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  return { repoRoot, headSha };
}

const args = (headSha, profile = "full-repository") => ["--profile", profile, "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha];

test("full validation resolves through gate CLI and preserves the legacy artifact", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha)], { cwd: repoRoot });
    assert.equal(out.code, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.status, "complete");
    assert.equal(result.profile, "full-repository");
    assert.equal(result.headSha, headSha);
    assert.equal(result.toolchain, `bun@${bunVersion}`);
    assert.equal(result.artifact.suites[0].command, "bun run verify");
    assert.deepEqual(JSON.parse(await readFile(path.join(repoRoot, result.artifactPath), "utf8")), result.artifact);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("failed full suite returns an unsuccessful public result and retains failure artifact", async () => {
  const { repoRoot } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "scripts", "verify.mjs"), "console.error('fixture failure'); process.exit(2);\n");
    execFileSync("git", ["add", "scripts/verify.mjs"], { cwd: repoRoot });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "failing verifier"], { cwd: repoRoot });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha)], { cwd: repoRoot });
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.artifact.allPassed, false);
    assert.equal(result.artifact.suites[0].exitCode, 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(repoRoot, result.artifactPath), "utf8")), result.artifact);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

async function assertTypedIncompleteArtifact(repoRoot, headSha, profile, reasonPattern) {
  const artifactPath = buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot: "tmp" });
  const artifact = JSON.parse(await readFile(path.join(repoRoot, artifactPath), "utf8"));
  assert.equal(artifact.status, "incomplete");
  assert.equal(artifact.ok, false);
  assert.equal(artifact.allPassed, false);
  assert.equal(artifact.repo, "owner/repo");
  assert.equal(artifact.pr, 1);
  assert.equal(artifact.gate, "draft_gate");
  assert.equal(artifact.headSha, headSha);
  assert.equal(artifact.profile, profile);
  assert.match(artifact.reason, reasonPattern);
  assert.ok(!Number.isNaN(Date.parse(artifact.generatedAt)));
  assert.deepEqual(artifact.suites, []);
  return artifactPath;
}

test("wrong installed Bun version returns incomplete and writes a typed incomplete artifact", async () => {
  const { repoRoot, headSha } = await fixture({}, "0.0.0");
  try {
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha)], { cwd: repoRoot });
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /differs from bun@0\.0\.0/);
    assert.equal(result.artifact, undefined);
    const artifactPath = await assertTypedIncompleteArtifact(repoRoot, headSha, "full-repository", /differs from bun@0\.0\.0/);
    assert.equal(result.artifactPath, artifactPath);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a repo without a pinned Bun writes a typed incomplete artifact at the requested head", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    delete packageJson.packageManager;
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify(packageJson));
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "unpin bun"], { cwd: repoRoot });
    const unpinnedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const result = await resolveValidation(parseResolveValidationArgs([...args(unpinnedHead, "targeted"), "--suite", "test:scripts"]), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.equal(result.ok, false);
    await assertTypedIncompleteArtifact(repoRoot, unpinnedHead, "targeted", /does not pin an exact Bun version/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("legacy runner cannot launch full aliases or the component-suite composition", async () => {
  const { repoRoot, headSha } = await fixture({ "test:quick": "bun run verify" });
  try {
    for (const suite of ["verify", "test"]) {
      const out = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", suite], { cwd: repoRoot });
      assert.equal(out.code, 1, suite);
      assert.match(out.stderr, /resolve-validation/);
    }
    const composed = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", "test:all", "--suite", "test:docs", "--suite", "test:workflows"], { cwd: repoRoot });
    assert.equal(composed.code, 1);
    assert.match(composed.stderr, /resolve-validation/);
    const alias = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", "test:quick"], { cwd: repoRoot });
    assert.equal(alias.code, 1);
    assert.match(alias.stderr, /resolve-validation/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("targeted resolver rejects a full alias before it runs", async () => {
  const { repoRoot, headSha } = await fixture({ "test:quick": "bun run verify" });
  try {
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha, "targeted"), "--suite", "test:quick"], { cwd: repoRoot });
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /full-repository/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("both validation entrypoints reject a full alias with trailing arguments", async () => {
  const { repoRoot, headSha } = await fixture({ "test:full": "bun run verify", "test:quick": "bun run test:full --silent" });
  try {
    const legacy = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", "test:quick"], { cwd: repoRoot });
    assert.equal(legacy.code, 1);
    assert.match(legacy.stderr, /Cannot classify package script/);
    assert.doesNotMatch(legacy.stdout, /verify-ran/);

    const targeted = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha, "targeted"), "--suite", "test:quick"], { cwd: repoRoot });
    assert.equal(targeted.code, 1);
    const result = JSON.parse(targeted.stdout);
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /Cannot classify package script/);
    assert.equal(result.artifact, undefined);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("head and toolchain failures are typed incomplete", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const options = parseResolveValidationArgs(args(headSha));
    const wrongHead = await resolveValidation({ ...options, headSha: "a".repeat(40) }, { repoRoot });
    assert.equal(wrongHead.status, "incomplete");
    assert.equal(wrongHead.ok, false);
    const missingBun = await resolveValidation(options, { repoRoot, env: { PATH: "/nonexistent" } });
    assert.equal(missingBun.status, "incomplete");
    assert.equal(missingBun.ok, false);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a worktree HEAD that differs from the requested head leaves no artifact", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const requestedHead = "a".repeat(40);
    const artifactPath = path.join(repoRoot, buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: requestedHead, tmpRoot: "tmp" }));
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, '{"allPassed":true}\n');
    const result = await resolveValidation({ ...parseResolveValidationArgs(args(headSha)), headSha: requestedHead }, { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /differs from requested head/);
    await assert.rejects(readFile(artifactPath), /ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a head check that cannot confirm the requested head leaves no artifact", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "resolve-validation-unborn-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    const requestedHead = "a".repeat(40);
    const artifactPath = path.join(repoRoot, buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: requestedHead, tmpRoot: "tmp" }));
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, '{"allPassed":true}\n');
    const result = await resolveValidation({ ...parseResolveValidationArgs(args(requestedHead)), headSha: requestedHead }, { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.equal(result.ok, false);
    assert.equal(result.artifactPath, undefined);
    await assert.rejects(readFile(artifactPath), /ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("an exception after the head check confirms a clean requested head writes a typed incomplete artifact", async () => {
  const { repoRoot } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "package.json"), "{ not json");
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "invalid package.json"], { cwd: repoRoot });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const result = await resolveValidation({ ...parseResolveValidationArgs(args(headSha)), headSha }, { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.equal(result.ok, false);
    await assertTypedIncompleteArtifact(repoRoot, headSha, "full-repository", /JSON/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a suite that moves HEAD before a later step throws leaves no artifact", async () => {
  const { repoRoot } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "scripts", "verify.mjs"), "import { execFileSync } from 'node:child_process'; import { rmSync } from 'node:fs'; execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']); rmSync('tmp', { recursive: true, force: true });\n");
    execFileSync("git", ["add", "scripts/verify.mjs"], { cwd: repoRoot });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head mover that removes the log dir"], { cwd: repoRoot });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /ENOENT/);
    assert.equal(result.artifactPath, undefined);
    const artifactPath = path.join(repoRoot, buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot: "tmp" }));
    await assert.rejects(readFile(artifactPath), /ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a HEAD move during the complete artifact write removes the artifact", async () => {
  const { repoRoot, headSha } = await fixture();
  const shimDir = await mkdtemp(path.join(os.tmpdir(), "resolve-validation-git-shim-"));
  try {
    // The third `git rev-parse HEAD` is the post-write check: report a moved HEAD there.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const counter = path.join(shimDir, "count");
    await writeFile(path.join(shimDir, "git"), [
      "#!/bin/sh",
      `if [ "$1" = rev-parse ] && [ "$2" = HEAD ]; then`,
      `  n=$(( $(cat '${counter}' 2>/dev/null || echo 0) + 1 )); echo $n > '${counter}'`,
      `  if [ $n -ge 3 ]; then echo ${"b".repeat(40)}; exit 0; fi`,
      "fi",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const env = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };
    const result = await resolveValidation(parseResolveValidationArgs([...args(headSha, "targeted"), "--suite", "test:scripts"]), { repoRoot, env });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /moved during the artifact write/);
    assert.equal(result.artifactPath, undefined);
    const artifactPath = path.join(repoRoot, buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot: "tmp" }));
    await assert.rejects(readFile(artifactPath), /ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  }
});

test("targeted profile rejects a full suite and allows an exact targeted script", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const options = parseResolveValidationArgs([...args(headSha, "targeted"), "--suite", "test:scripts"]);
    const result = await resolveValidation(options, { repoRoot });
    assert.equal(result.status, "complete");
    assert.equal(result.artifact.suites[0].name, "test:scripts");
    const rejected = await resolveValidation({ ...options, suites: ["verify"] }, { repoRoot });
    assert.equal(rejected.status, "incomplete");
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("incomplete resolution replaces earlier same-head passing evidence with a typed incomplete artifact", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const options = parseResolveValidationArgs(args(headSha));
    const complete = await resolveValidation(options, { repoRoot });
    assert.equal(complete.status, "complete");
    const stalePath = path.join(repoRoot, complete.artifactPath);
    assert.equal(JSON.parse(await readFile(stalePath, "utf8")).allPassed, true);
    const incomplete = await resolveValidation({ ...options, profile: "targeted" }, { repoRoot });
    assert.equal(incomplete.status, "incomplete");
    await assertTypedIncompleteArtifact(repoRoot, headSha, "targeted", /targeted profile cannot run full-repository/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("targeted gate refuses a dot-segment alias to full verification", async () => {
  const { repoRoot, headSha } = await fixture({ "test:quick": "bun scripts/../scripts/verify.mjs" });
  try {
    const options = parseResolveValidationArgs([...args(headSha, "targeted"), "--suite", "test:quick"]);
    const result = await resolveValidation(options, { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /targeted profile cannot run full-repository/);
    assert.equal(result.artifact, undefined);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("targeted profile without an explicit suite is incomplete and runs nothing", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    const complete = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha)], { cwd: repoRoot });
    assert.equal(complete.code, 0, complete.stderr);
    const stalePath = path.join(repoRoot, JSON.parse(complete.stdout).artifactPath);
    assert.equal(JSON.parse(await readFile(stalePath, "utf8")).allPassed, true);
    const out = await runNode(CLI, ["gate", "resolve-validation",
      "--profile", "targeted", "--repo", " owner/repo ", "--pr", "01",
      "--gate", "draft_gate", "--gate", "DRAFT_GATE", "--head-sha", headSha.toUpperCase(),
      "--tmp-root", " tmp ",
    ], { cwd: repoRoot });
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /explicit --suite/);
    assert.equal(result.artifact, undefined);
    await assert.rejects(readFile(stalePath), /ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("parse failure cannot remove a validation artifact outside the repo", async () => {
  const { repoRoot, headSha } = await fixture();
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "external-validation-"));
  try {
    // Relative escape and absolute relocated root: both resolve outside the checkout.
    for (const tmpRoot of [path.relative(repoRoot, externalRoot), externalRoot]) {
      const artifactPath = path.resolve(repoRoot, buildValidationResultsPath({
        repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot,
      }));
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, '{"allPassed":true}\n');
      const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha, "targeted"), "--tmp-root", tmpRoot], { cwd: repoRoot });
      assert.equal(out.code, 1);
      assert.equal(JSON.parse(out.stdout).status, "incomplete");
      assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).allPassed, true);
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("dirty worktree cannot claim validation at the committed head", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "package.json"), `${await readFile(path.join(repoRoot, "package.json"), "utf8")}\n`);
    const result = await resolveValidation(parseResolveValidationArgs([...args(headSha, "targeted"), "--suite", "test:scripts"]), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /clean worktree/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("suite changes to tracked files leave typed incomplete evidence and no complete artifact", async () => {
  const { repoRoot } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "scripts", "verify.mjs"), "import { appendFileSync } from 'node:fs'; appendFileSync('package.json', '\\n');\n");
    execFileSync("git", ["add", "scripts/verify.mjs"], { cwd: repoRoot });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "mutator"], { cwd: repoRoot });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha)], { cwd: repoRoot });
    assert.equal(out.code, 1);
    const result = JSON.parse(out.stdout);
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /changed the worktree/);
    assert.equal(result.artifact, undefined);
    await assertTypedIncompleteArtifact(repoRoot, headSha, "full-repository", /changed the worktree/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a suite that moves HEAD leaves no artifact", async () => {
  const { repoRoot } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "scripts", "verify.mjs"), "import { execFileSync } from 'node:child_process'; execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']);\n");
    execFileSync("git", ["add", "scripts/verify.mjs"], { cwd: repoRoot });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head mover"], { cwd: repoRoot });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /changed the worktree: worktree HEAD .* differs from requested head/);
    const artifactPath = path.join(repoRoot, buildValidationResultsPath({ repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot: "tmp" }));
    await assert.rejects(readFile(artifactPath), /ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

// A repo with no package.json (Rust, Rails, config-only) and a given .devloops.
async function bareFixture(devloops) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "resolve-validation-bare-"));
  await writeFile(path.join(repoRoot, ".gitignore"), "tmp/\n");
  await writeFile(path.join(repoRoot, ".devloops"), devloops);
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", ".gitignore", ".devloops"], { cwd: repoRoot });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: repoRoot });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  return { repoRoot, headSha };
}

const rollup = (conclusion) => [{ name: "ci", status: "COMPLETED", conclusion }];
const ciReader = (headSha, conclusion) => async () => ({ headSha, rollup: conclusion === null ? [] : rollup(conclusion) });

test("ci-only without package.json records a complete ci-authoritative artifact and runs no suite", async () => {
  for (const devloops of ["version: 1\n", "version: 1\nvalidation:\n  mode: ci-only\n"]) {
    const { repoRoot, headSha } = await bareFixture(devloops);
    try {
      const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot, readCi: ciReader(headSha, "SUCCESS") });
      assert.equal(result.status, "complete");
      assert.equal(result.ok, true);
      assert.equal(result.artifact.authority, "ci-authoritative");
      assert.equal(result.artifact.allPassed, true);
      assert.deepEqual(result.artifact.suites, []);
      assert.equal(result.artifact.headSha, headSha);
      assert.doesNotMatch(JSON.stringify(result), /package\.json|ENOENT/);
      assert.deepEqual(JSON.parse(await readFile(path.join(repoRoot, result.artifactPath), "utf8")), result.artifact);
    } finally { await rm(repoRoot, { recursive: true, force: true }); }
  }
});

test("ci-only fails closed on red, pending, missing and wrong-head CI", async () => {
  const { repoRoot, headSha } = await bareFixture("version: 1\n");
  try {
    const other = "b".repeat(40);
    const cases = [
      [ciReader(headSha, "FAILURE"), "failed", /failure/],
      [ciReader(headSha, null), "incomplete", /none/],
      [async () => ({ headSha, rollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }] }), "incomplete", /pending/],
      [ciReader(other, "SUCCESS"), "incomplete", /differs/],
      [async () => { throw new Error("gh unavailable"); }, "incomplete", /gh unavailable/],
    ];
    for (const [readCi, status, reason] of cases) {
      const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot, readCi });
      assert.equal(result.status, status);
      assert.equal(result.ok, false);
      const artifact = JSON.parse(await readFile(path.join(repoRoot, result.artifactPath), "utf8"));
      assert.equal(artifact.allPassed, false);
      assert.equal(artifact.authority, undefined);
      assert.match(artifact.reason ?? artifact.ci?.reason ?? JSON.stringify(artifact), reason);
    }
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("local mode runs the declared non-Node full command without package.json", async () => {
  const { repoRoot, headSha } = await bareFixture("version: 1\nvalidation:\n  mode: local\n  fullCommand: echo cargo-test-ran\n");
  try {
    const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot, readCi: () => { throw new Error("local mode must not read CI"); } });
    assert.equal(result.status, "complete");
    assert.equal(result.artifact.allPassed, true);
    assert.equal(result.artifact.authority, undefined);
    assert.equal(result.artifact.suites[0].command, "echo cargo-test-ran");
    assert.equal(result.artifact.suites[0].exitCode, 0);
    assert.match(result.artifact.suites[0].outputTail, /cargo-test-ran/);
    assert.doesNotMatch(JSON.stringify(result), /package\.json|ENOENT/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("a failing declared command is failed evidence, and local mode without a command keeps the package.json path", async () => {
  const failing = await bareFixture("version: 1\nvalidation:\n  mode: local\n  fullCommand: exit 3\n");
  try {
    const result = await resolveValidation(parseResolveValidationArgs(args(failing.headSha)), { repoRoot: failing.repoRoot });
    assert.equal(result.status, "failed");
    assert.equal(result.artifact.suites[0].exitCode, 3);
  } finally { await rm(failing.repoRoot, { recursive: true, force: true }); }
  const bare = await bareFixture("version: 1\nvalidation:\n  mode: local\n");
  try {
    const result = await resolveValidation(parseResolveValidationArgs(args(bare.headSha)), { repoRoot: bare.repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /package\.json/);
  } finally { await rm(bare.repoRoot, { recursive: true, force: true }); }
});

test("a malformed validation config fails closed and the CLI accepts no command argument", async () => {
  const { repoRoot, headSha } = await bareFixture("version: 1\nvalidation:\n  mode: local\n  fullCommand: \"\"\n");
  try {
    const result = await resolveValidation(parseResolveValidationArgs(args(headSha)), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /fullCommand|validation/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
  assert.throws(() => parseResolveValidationArgs([...args("a".repeat(40)), "--command", "rm -rf /"]), /Unknown argument/);
  assert.throws(() => parseResolveValidationArgs([...args("a".repeat(40)), "--full-command", "rm -rf /"]), /Unknown argument/);
});
