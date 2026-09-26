import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { parseResolveValidationArgs, resolveValidation } from "../../scripts/loop/resolve-validation.mjs";
import { runNode } from "../_helpers.mjs";

const LEGACY = fileURLToPath(new URL("../../scripts/loop/run-gate-validation.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/index.mjs", import.meta.url));
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

async function fixture() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "resolve-validation-"));
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "fixture", packageManager: `bun@${bunVersion}`,
    scripts: { verify: "node -e \"console.log('full-ran')\"", test: "node -e \"console.log('test-ran')\"", passing: "node -e \"console.log('targeted-ran')\"", "test:scripts": "node -e \"console.log('scripts-ran')\"", "test:all": "node -e \"console.log('all-ran')\"", "test:docs": "node -e \"console.log('docs-ran')\"", "test:workflows": "node -e \"console.log('workflows-ran')\"" },
  }));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["add", "package.json"], { cwd: repoRoot });
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

test("legacy runner cannot launch full aliases or the component-suite composition", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    for (const suite of ["verify", "test"]) {
      const out = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", suite], { cwd: repoRoot });
      assert.equal(out.code, 1, suite);
      assert.match(out.stderr, /resolve-validation/);
    }
    const composed = await runNode(LEGACY, ["--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha, "--suite", "test:all", "--suite", "test:docs", "--suite", "test:workflows"], { cwd: repoRoot });
    assert.equal(composed.code, 1);
    assert.match(composed.stderr, /resolve-validation/);
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

test("dirty worktree cannot claim validation at the committed head", async () => {
  const { repoRoot, headSha } = await fixture();
  try {
    await writeFile(path.join(repoRoot, "package.json"), `${await readFile(path.join(repoRoot, "package.json"), "utf8")}\n`);
    const result = await resolveValidation(parseResolveValidationArgs([...args(headSha, "targeted"), "--suite", "test:scripts"]), { repoRoot });
    assert.equal(result.status, "incomplete");
    assert.match(result.reason, /clean worktree/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});
