// OPS-EDITOR-TOOL-WRITES (issue 2683): this suite drives the REAL Bash gate hook script with stdin JSON in a temp repo,
// so the hook's own resolution of each shell write target (cwd join, gitignore status, fail closed) is covered,
// not only the pure decider. The existing Write-guard hook suites cover the shared repo-mutation function from the other side.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => {
  const base = runIdFreeEnv({ GIT_DIR: undefined, GIT_WORK_TREE: undefined });
  delete base.DEVLOOPS_COORDINATOR_READONLY;
  return base;
};

const bash = (cwd, command, agentType, extraEnv) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: { ...env(), ...extraEnv } });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(path.join(root, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    fs.writeFileSync(path.join(root, ".devloops"), "version: 1\n", "utf8");
    fs.writeFileSync(path.join(root, ".gitignore"), "tmp/\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "a.mjs"), "a\n", "utf8");
    await fn(root);
  }, { prefix: "dev-loops-shell-write-hook-" });
}

const COORDINATOR = { DEVLOOPS_COORDINATOR_READONLY: "1" };

test("the hook denies a coordinator heredoc write to a repo file and allows a tmp heredoc whose body holds write commands (rows 4, 15)", async () => {
  await withRepo(async (root) => {
    const denied = bash(root, "cat >> src/a.mjs <<EOF\nline\nEOF", "dev-loop", COORDINATOR);
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /COORDINATOR_DELEGATION_BOUNDARY/);
    assert.equal(bash(root, "cat > tmp/x.md <<'EOF'\nsed -i s/a/b/ src/a.mjs\necho x > src/a.mjs\nEOF", "dev-loop", COORDINATOR).decision, "allow");
  });
});

test("the hook joins a target to its literal cd directory (row 9)", async () => {
  await withRepo(async (root) => {
    assert.equal(bash(root, `cd ${root} && sed -i 's/a/b/' src/a.mjs`, "dev-loop", COORDINATOR).decision, "deny");
    assert.equal(bash(root, `cd ${root}/src && echo x > a.mjs`, "dev-loop", COORDINATOR).decision, "deny");
    assert.equal(bash(root, `cd ${root} && echo x > tmp/x.md`, "dev-loop", COORDINATOR).decision, "allow");
  });
});

test("the hook fails closed on an unresolvable target and allows a command with no write target (rows 10, 16)", async () => {
  await withRepo(async (root) => {
    const denied = bash(root, "echo x > $out", "dev-loop", COORDINATOR);
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /rerun with a literal path/);
    assert.equal(bash(root, "cd \"$W\" && echo x > a.md", "dev-loop", COORDINATOR).decision, "deny");
    assert.equal(bash(root, "cd \"$W\" && dev-loops-run scripts/loop/x.mjs --construct", "dev-loop", COORDINATOR).decision, "allow");
  });
});

test("the hook allows ignored and out-of-repo targets (row 12)", async () => {
  await withRepo(async (root) => {
    for (const command of ["printf x > tmp/x.md", "sed -i 's/a/b/' tmp/x.md", "cmd > /dev/null 2>&1", "cmd 2>&1", "cp /dev/null /dev/null", "sed -n '1,5p' src/a.mjs"]) {
      assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "allow", command);
    }
  });
});

test("the hook denies a fixer shell write with no pull grant and the switch unset (row 1)", async () => {
  await withRepo(async (root) => {
    const denied = bash(root, "sed -i '' 's/a/b/' src/a.mjs", "fixer");
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /OPS-EDITOR-TOOL-WRITES/);
    assert.equal(bash(root, "sed -i '' 's/a/b/' src/a.mjs", "dev-loops:developer").decision, "deny");
    assert.equal(bash(root, "sed -i '' 's/a/b/' src/a.mjs", undefined).decision, "allow");
    assert.equal(bash(root, "sed -i '' 's/a/b/' src/a.mjs", "dev-loop").decision, "allow");
  });
});

test("the hook lets a worker remove or rename to a new path and denies a copy over an existing file (rows 6, 7, 8)", async () => {
  await withRepo(async (root) => {
    assert.equal(bash(root, "rm -f src/a.mjs", "developer").decision, "allow");
    assert.equal(bash(root, "mv src/a.mjs src/b.mjs", "developer").decision, "allow");
    assert.equal(bash(root, "cp -f x src/a.mjs", "developer").decision, "deny");
    assert.equal(bash(root, "rm -f src/a.mjs", "dev-loop", COORDINATOR).decision, "deny");
  });
});

test("the hook denies a worker copy or rename into an existing directory when the file exists there, and any copy under .git", async () => {
  await withRepo(async (root) => {
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "other", "a.mjs"), "o\n", "utf8");
    fs.writeFileSync(path.join(root, "other", "n.mjs"), "o\n", "utf8");
    for (const command of ["cp other/a.mjs src/", "mv other/a.mjs src/", "cp other/n.mjs other/a.mjs src/", "cp x .git/hooks/pre-commit", "mv x .git/hooks/pre-commit", "cp x .git/"]) {
      for (const role of ["developer", "fixer"]) assert.equal(bash(root, command, role).decision, "deny", `${role}: ${command}`);
    }
    for (const command of ["cp other/n.mjs src/", "mv other/n.mjs src/", "cp other/n.mjs tmp/"]) assert.equal(bash(root, command, "developer").decision, "allow", command);
  });
});

test("the hook denies a coordinator remove or rename of an existing directory", async () => {
  await withRepo(async (root) => {
    for (const command of ["rm -rf src", "mv src other"]) assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "deny", command);
    for (const command of ["rm -rf nothing-here", "rm -rf tmp"]) assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "allow", command);
    assert.equal(bash(root, "rm -rf src", "developer").decision, "allow");
  });
});

test("the hook denies a coordinator script under the repo tmp root by absolute path, behind flag values and after a cd, and allows other scripts", async () => {
  await withRepo(async (root) => {
    for (const command of [`node ${root}/tmp/x.mjs`, "node --import tsx tmp/x.mjs", "cd tmp && node x.mjs", `cd ${root}/tmp && node x.mjs`]) {
      assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "deny", command);
    }
    for (const command of ["node /private/tmp/x.mjs", "node scripts/x.mjs", `node ${root}/scripts/x.mjs`]) {
      assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "allow", command);
    }
  });
});

test("the hook denies a no-space redirect, xargs and find -exec shell writes", async () => {
  await withRepo(async (root) => {
    for (const command of ["echo x>src/a.mjs", "echo x 2>/dev/null>src/a.mjs", "git ls-files | xargs sed -i 's/a/b/'", "find src -exec sed -i 's/a/b/' {} +", "timeout 5 sed -i 's/a/b/' src/a.mjs"]) {
      assert.equal(bash(root, command, "developer").decision, "deny", command);
      assert.equal(bash(root, command, "dev-loop", COORDINATOR).decision, "deny", command);
    }
  });
});
