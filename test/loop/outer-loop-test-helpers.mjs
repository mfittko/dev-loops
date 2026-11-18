import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runNode as runNodeHelper,
  writeGhStub as writeGhStubHelper,
  writeJson as writeJsonHelper,
} from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/outer-loop.mjs");

export const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);
export const writeJson = writeJsonHelper;

/**
 * Write a fake `git` stub that responds to specific commands.
 * porcelainOutput: what `git status --porcelain` should return (empty string = clean)
 * headRef: what `git rev-parse --abbrev-ref HEAD` should return (e.g. "main" or "HEAD")
 */
export async function writeGitStub(tempDir, { porcelainOutput = "", headRef = "main", headSha = "abc123" } = {}) {
  const gitPath = path.join(tempDir, "git");
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2).join(' ');",
      `if (args.includes('status') && args.includes('porcelain')) {`,
      `  process.stdout.write(${JSON.stringify(porcelainOutput ? porcelainOutput + "\n" : "")});`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('rev-parse') && args.includes('abbrev-ref')) {`,
      `  process.stdout.write(${JSON.stringify(headRef + "\n")});`,
      `  process.exit(0);`,
      `}`,
      `if (args === 'rev-parse HEAD') {`,
      `  process.stdout.write(${JSON.stringify(headSha + "\n")});`,
      `  process.exit(0);`,
      `}`,
      "// Only the default-branch trust-config read runs the real git, found past this stub dir; any other command fails.",
      "const trustRead = [/^symbolic-ref --short refs\\/remotes\\/origin\\/HEAD$/, /^rev-parse --verify --quiet origin\\/[^ ]+\\^\\{commit\\}$/, /^ls-tree --full-tree --name-only origin\\/[^ ]+ -- [^ ]+$/, /^show origin\\/[^ :]+:[^ ]+$/];",
      "if (!trustRead.some((re) => re.test(args))) {",
      "  process.stderr.write(`unexpected git args: ${args}\\n`);",
      "  process.exit(97);",
      "}",
      "const { spawnSync } = require('node:child_process');",
      "const fs = require('node:fs'), p = require('node:path'); const self = fs.realpathSync(__filename);",
      "const keep = (d) => { try { return fs.realpathSync(p.join(d, 'git')) !== self; } catch { return true; } };",
      "const realPath = (process.env.PATH || '').split(p.delimiter).filter(keep).join(p.delimiter);",
      "const r = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, PATH: realPath } });",
      "process.exit(r.status ?? 97);",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);

  return {
    ...process.env,
    PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}

export async function writeGhStub(
  tempDir,
  {
    repo = "owner/myrepo",
    pr = 47,
    headSha = "abc123",
    headRefName = "copilot/example-branch",
  } = {},
) {
  const prViewEntry = {
    assertArgs: ["pr", "view", String(pr), "--repo", repo, "--json"],
    stdout: JSON.stringify({ isDraft: false, state: "OPEN", number: pr, headRefOid: headSha, headRefName, reviews: [], statusCheckRollup: [] }) + "\n",
  };
  const requestedReviewersEntry = {
    assertArgs: ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
    stdout: JSON.stringify({ users: [] }) + "\n",
  };
  const reviewsEntry = {
    assertArgs: ["api", `repos/${repo}/pulls/${pr}/reviews`],
    stdout: "[]\n",
  };
  const graphqlEntry = {
    assertArgs: ["api", "graphql"],
    stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) + "\n",
  };

  const { env } = await writeGhStubHelper(
    tempDir,
    [
      ...Array.from({ length: 6 }, () => prViewEntry),
      ...Array.from({ length: 4 }, () => requestedReviewersEntry),
      ...Array.from({ length: 4 }, () => reviewsEntry),
      ...Array.from({ length: 6 }, () => graphqlEntry),
    ],
    { matchMode: "claims" },
  );

  return env;
}

export const MINIMAL_COPILOT_SNAPSHOT = Object.freeze({
  prExists: true,
  prNumber: 47,
  prDraft: false,
  prMerged: false,
  prClosed: false,
  copilotReviewRequestStatus: "none",
  copilotReviewPresent: false,
  unresolvedThreadCount: 0,
  actionableThreadCount: 0,
  ciStatus: "none",
  agentFixStatus: null,
});
