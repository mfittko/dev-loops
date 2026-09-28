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
  for (const name of ["verify", "passing", "suite", "all", "docs", "workflows"]) {
    await writeFile(path.join(repoRoot, "scripts", `${name}.mjs`), `console.log('${name}-ran')`);
  }
  await writeFile(path.join(repoRoot, "scripts", "fail.mjs"), "console.error('fixture failure'); process.exit(2);\n");
  for (const name of ["docs/validate-rule-ownership", "docs/validate-links", "docs/validate-decision-records", "github/lint-workflows", "run-bun-test"]) {
    await writeFile(path.join(repoRoot, "scripts", `${name}.mjs`), `console.log('${name}-ran')`);
  }
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "package.json", ".gitignore", "scripts"], { cwd: repoRoot });
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

test("head and toolchain failures are typed incomplete, with no artifact", async () => {
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
    const tmpRoot = path.relative(repoRoot, externalRoot);
    const artifactPath = path.resolve(repoRoot, buildValidationResultsPath({
      repo: "owner/repo", pr: 1, gate: "draft_gate", headSha, tmpRoot,
    }));
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, '{"allPassed":true}\n');
    const out = await runNode(CLI, ["gate", "resolve-validation", ...args(headSha, "targeted"), "--tmp-root", tmpRoot], { cwd: repoRoot });
    assert.equal(out.code, 1);
    assert.equal(JSON.parse(out.stdout).status, "incomplete");
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).allPassed, true);
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
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});
