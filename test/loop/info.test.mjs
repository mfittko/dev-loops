import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper } from "../_helpers.mjs";

const infoScriptPath = path.resolve("scripts/loop/info.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(infoScriptPath, args, options);

// ── Argument parsing ────────────────────────────────────────────────

test("info.mjs --help shows usage", async () => {
  const { code, stdout, stderr } = await runNode(["--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("--issue"));
  assert.ok(stdout.includes("--pr"));
  assert.equal(stderr, "");
});

test("info.mjs requires --issue or --pr", async () => {
  const { code, stdout, stderr } = await runNode([]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("--issue") || stderr.includes("--pr") || stderr.includes("required"));
  assert.equal(stdout, "");
});

test("info.mjs rejects --issue and --pr together", async () => {
  const { code, stdout, stderr } = await runNode(["--issue", "1", "--pr", "2"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("mutually exclusive") || stderr.includes("exactly one"));
});

test("info.mjs rejects negative --issue", async () => {
  const { code, stderr } = await runNode(["--issue", "-5"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.length > 0);
});

test("info.mjs rejects non-numeric --issue", async () => {
  const { code, stderr } = await runNode(["--issue", "abc"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.length > 0);
});

test("info.mjs rejects negative --pr", async () => {
  const { code, stderr } = await runNode(["--pr", "-5"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.length > 0);
});

test("info.mjs rejects unknown args", async () => {
  const { code, stderr } = await runNode(["--issue", "1", "--bogus"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("Unknown argument"));
});

test("info.mjs preserves --repo validation wording", async () => {
  const { code, stderr } = await runNode(["--issue", "1", "--repo", "not-a-slug"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes("Invalid repo slug: --repo must match <owner/name>"));
});

// ── --json flag ──────────────────────────────────────────────────────

test("info.mjs --json with --help still shows usage text", async () => {
  const { code, stdout } = await runNode(["--json", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage:"));
});

// ── Integration: issue mode (with gh stubs + git repo) ───────────────

test("info.mjs --issue produces human-readable output with gh stubs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-issue-"));
  try {
    const repoSlug = "test-owner/test-repo";
    const issueNumber = 42;
    const issueBody = "## Summary\nTest issue\n\n## Acceptance Criteria\n- It works";

    // Initialize temp git repo with origin remote matching repoSlug
    // so the startup resolver can auto-detect the repo slug
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${repoSlug}.git`], { cwd: tmpDir, stdio: "ignore" });

    const ghPath = path.join(tmpDir, "gh");
    const ghScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const repo = "${repoSlug}";`,
      `if (args[0] === "issue" && args[1] === "view") {`,
      `  const issueNum = parseInt(args[2]);`,
      `  if (issueNum === ${issueNumber}) {`,
      `    process.stdout.write(JSON.stringify({`,
      `      number: ${issueNumber},`,
      `      title: "Test issue title",`,
      `      body: ${JSON.stringify(issueBody)},`,
      `      state: "OPEN",`,
      `      labels: [],`,
      `      assignees: [],`,
      `      milestone: null,`,
      `      url: "https://github.com/${repoSlug}/issues/${issueNumber}"`,
      `    }) + "\\n");`,
      `    process.exit(0);`,
      `  }`,
      `  process.exit(1);`,
      `}`,
      `// gh pr view for linked PR detection (won't be called if no linked PR)`,
      `process.exit(1);`,
    ].join("\n");

    await writeFile(ghPath, ghScript);
    await import("fs").then(fs => fs.promises.chmod(ghPath, 0o755));

    const { code, stdout, stderr } = await runNode(["--issue", String(issueNumber), "--repo", repoSlug], {
      env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}`, DEVLOOPS_RUN_ID: "info-test" },
      cwd: tmpDir,
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes(`Issue #${issueNumber}`), `Expected "Issue #${issueNumber}" in:\n${stdout}`);
    assert.ok(stdout.includes("Test issue title"), `Expected title in:\n${stdout}`);
    assert.ok(stdout.includes("OPEN"), `Expected OPEN in:\n${stdout}`);
    // Assert acceptance-criteria fields from startup resolver
    assert.ok(stdout.includes("Strategy:") || stdout.includes("Loop state:") || stdout.includes("Route:"),
      `Expected strategy/route/next-action fields in:\n${stdout}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("info.mjs --issue auto-detects repo slug and passes owner/repo to gh", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-issue-autorepo-"));
  try {
    const repoSlug = "test-owner/test-repo";
    const issueNumber = 42;

    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${repoSlug}.git`], { cwd: tmpDir, stdio: "ignore" });

    const ghPath = path.join(tmpDir, "gh");
    const ghScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const expectedRepo = "${repoSlug}";`,
      "const repoIndex = args.indexOf('--repo');",
      "const repoValue = repoIndex >= 0 ? args[repoIndex + 1] : undefined;",
      "if (repoValue !== expectedRepo) {",
      "  process.stderr.write(`unexpected --repo: ${String(repoValue)}\\n`);",
      "  process.exit(2);",
      "}",
      "if (args[0] === 'issue' && args[1] === 'view') {",
      `  if (parseInt(args[2], 10) === ${issueNumber}) {`,
      "    process.stdout.write(JSON.stringify({",
      `      number: ${issueNumber},`,
      "      title: 'Auto repo issue',",
      "      body: '',",
      "      state: 'OPEN',",
      "      labels: [],",
      "      assignees: [],",
      "      milestone: null,",
      `      url: "https://github.com/${repoSlug}/issues/${issueNumber}"`,
      "    }) + '\\n');",
      "    process.exit(0);",
      "  }",
      "}",
      "process.exit(1);",
    ].join("\n");

    await writeFile(ghPath, ghScript);
    await import("fs").then(fs => fs.promises.chmod(ghPath, 0o755));

    const { code, stdout, stderr } = await runNode(["--issue", String(issueNumber)], {
      env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
      cwd: tmpDir,
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes(`Issue #${issueNumber}`), `Expected Issue #${issueNumber} in:\n${stdout}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Integration: --json output ───────────────────────────────────────

test("info.mjs --issue --json produces valid JSON with gh stubs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-json-"));
  try {
    const repoSlug = "test-owner/test-repo";
    const issueNumber = 1;

    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${repoSlug}.git`], { cwd: tmpDir, stdio: "ignore" });

    const ghPath = path.join(tmpDir, "gh");
    const ghScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const repo = "${repoSlug}";`,
      `if (args[0] === "issue" && args[1] === "view") {`,
      `  process.stdout.write(JSON.stringify({`,
      `    number: ${issueNumber}, title: "JSON test", body: "", state: "OPEN",`,
      `    labels: [], assignees: [], milestone: null,`,
      `    url: "https://github.com/${repoSlug}/issues/${issueNumber}"`,
      `  }) + "\\n");`,
      `  process.exit(0);`,
      `}`,
      `process.exit(1);`,
    ].join("\n");

    await writeFile(ghPath, ghScript);
    await import("fs").then(fs => fs.promises.chmod(ghPath, 0o755));

    const { code, stdout, stderr } = await runNode(["--issue", "1", "--repo", repoSlug, "--json"], {
      env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}`, DEVLOOPS_RUN_ID: "info-test" },
      cwd: tmpDir,
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "issue");
    assert.equal(parsed.issue.number, issueNumber);
    assert.equal(parsed.issue.title, "JSON test");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Integration: PR mode (with gh stubs) ─────────────────────────────

test("info.mjs --pr produces human-readable output with gh stubs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-pr-"));
  try {
    const repoSlug = "test-owner/test-repo";
    const prNumber = 99;
    const prTitle = "Test PR title";

    const ghPath = path.join(tmpDir, "gh");
    const ghScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const repo = "${repoSlug}";`,
      `if (args[0] === "pr" && args[1] === "view") {`,
      `  const prNum = parseInt(args[2]);`,
      `  if (prNum === ${prNumber}) {`,
      `    process.stdout.write(JSON.stringify({`,
      `      number: ${prNumber},`,
      `      title: ${JSON.stringify(prTitle)},`,
      `      body: "",`,
      `      state: "OPEN",`,
      `      isDraft: false,`,
      `      headRefName: "feature-branch",`,
      `      baseRefName: "main",`,
      `      author: { login: "testuser" },`,
      `      mergedAt: null,`,
      `      url: "https://github.com/${repoSlug}/pull/${prNumber}",`,
      `      reviewRequests: []`,
      `    }) + "\\n");`,
      `    process.exit(0);`,
      `  }`,
      `  process.exit(1);`,
      `}`,
      `process.exit(1);`,
    ].join("\n");

    await writeFile(ghPath, ghScript);
    await import("fs").then(fs => fs.promises.chmod(ghPath, 0o755));

    const { code, stdout, stderr } = await runNode(["--pr", String(prNumber), "--repo", repoSlug], {
      env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
      cwd: tmpDir,
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes(`PR #${prNumber}`), `Expected PR #${prNumber} in:\n${stdout}`);
    assert.ok(stdout.includes(prTitle), `Expected title in:\n${stdout}`);
    assert.ok(stdout.includes("feature-branch"), `Expected branch in:\n${stdout}`);
    assert.ok(stdout.includes("OPEN"), `Expected OPEN in:\n${stdout}`);
    assert.ok(stdout.includes("testuser"), `Expected author in:\n${stdout}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("info.mjs --pr auto-detects repo slug and passes owner/repo to gh", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-pr-autorepo-"));
  try {
    const repoSlug = "test-owner/test-repo";
    const prNumber = 99;

    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${repoSlug}.git`], { cwd: tmpDir, stdio: "ignore" });

    const ghPath = path.join(tmpDir, "gh");
    const ghScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const expectedRepo = "${repoSlug}";`,
      "const repoIndex = args.indexOf('--repo');",
      "const repoValue = repoIndex >= 0 ? args[repoIndex + 1] : undefined;",
      "if (repoValue !== expectedRepo) {",
      "  process.stderr.write(`unexpected --repo: ${String(repoValue)}\\n`);",
      "  process.exit(2);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      `  if (parseInt(args[2], 10) === ${prNumber}) {`,
      "    process.stdout.write(JSON.stringify({",
      `      number: ${prNumber},`,
      "      title: 'Auto repo PR',",
      "      body: '',",
      "      state: 'OPEN',",
      "      isDraft: false,",
      "      headRefName: 'feature-branch',",
      "      baseRefName: 'main',",
      "      author: { login: 'testuser' },",
      "      mergedAt: null,",
      `      url: "https://github.com/${repoSlug}/pull/${prNumber}",`,
      "      reviewRequests: []",
      "    }) + '\\n');",
      "    process.exit(0);",
      "  }",
      "}",
      "process.exit(1);",
    ].join("\n");

    await writeFile(ghPath, ghScript);
    await import("fs").then(fs => fs.promises.chmod(ghPath, 0o755));

    const { code, stdout, stderr } = await runNode(["--pr", String(prNumber)], {
      env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
      cwd: tmpDir,
    });

    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
    assert.ok(stdout.includes(`PR #${prNumber}`), `Expected PR #${prNumber} in:\n${stdout}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Repo auto-detection failure ──────────────────────────────────────

test("info.mjs fails gracefully when repo cannot be detected", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "info-test-norepo-"));
  try {
    const { code, stderr } = await runNode(["--issue", "1"], {
      cwd: tmpDir,
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.length > 0, "Expected stderr output on repo detection failure");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
