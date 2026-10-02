import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMMIT_MSG_GUARD_MARKER,
  COMMIT_MSG_WAIVER_MARKER,
  installCommitMsgGuard,
} from "../src/loop/commit-msg-guard.mjs";

// The hook is a real Node script that runs inside real git — asserting on
// rendered text would pass while the guard silently never ran, the same
// reasoning default-branch-guard.test.mjs documents for its own shell hooks.
//
// CLAUDECODE is scrubbed from the base env (this suite runs under Claude
// Code itself) and set explicitly per test, since the attribution-trailer
// requirement is gated on it (issue #1869: a plain human commit is never
// "Claude", so it must not be forced to carry a Claude co-author trailer).
const BASE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
for (const name of ["OMPCODE", "CLAUDECODE", "PI_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "AI_AGENT"]) delete BASE_GIT_ENV[name];

const AGENT_TRAILERS = "\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_test\n";

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...BASE_GIT_ENV, ...env },
  });
}

async function repoFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "commit-msg-guard-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "user.name", "Guard Test"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "seed.txt"]);
  // --no-verify: seed the history before the guard exists.
  git(dir, ["commit", "--quiet", "--no-verify", "-m", "seed"]);
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
  return { dir, gitDir };
}

let fileCounter = 0;
function commitAttempt(dir, message, env = {}) {
  const file = `change-${fileCounter++}.txt`;
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, ["add", file]);
  try {
    git(dir, ["commit", "--quiet", "-m", message], env);
    return { blocked: false, stderr: "" };
  } catch (err) {
    return { blocked: true, stderr: String(err.stderr ?? "") };
  }
}

test("installs the commit-msg hook into an empty hooks dir, executable and marked", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const result = installCommitMsgGuard({ gitDir });
    assert.equal(result.ok, true);
    assert.equal(result.installed, true);
    assert.equal(result.refreshed, false);
    const hookPath = path.join(gitDir, "hooks", "commit-msg");
    const contents = fs.readFileSync(hookPath, "utf8");
    assert.match(contents, new RegExp(`^// ${COMMIT_MSG_GUARD_MARKER}$`, "mu"));
    assert.ok(fs.statSync(hookPath).mode & 0o111, "hook must be executable, or git ignores it entirely");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an agent-authored commit missing the attribution trailers", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir, requireClaudeSession: true });
    const result = commitAttempt(dir, "fix(gate): do the thing", { CLAUDECODE: "1" });
    assert.equal(result.blocked, true);
    assert.match(result.stderr, /missing required trailer: Co-Authored-By/);
    assert.match(result.stderr, /missing required trailer: Claude-Session/);
    // The rejection must echo a CONCRETE expected-format example so the author
    // never has to grep the docs to learn the trailer's shape (issue #1959).
    assert.match(result.stderr, /Claude-Session: https:\/\/claude\.ai\/code\/session_/);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "1", "the refusal must be the only effect");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-agent commit (CLAUDECODE unset) is not forced to carry a Claude trailer", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    const result = commitAttempt(dir, "fix(gate): do the thing", {});
    assert.equal(result.blocked, false, `expected a human commit to pass without trailers: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("omp compatibility markers do not require Claude attribution or skip other commit checks", async () => {
  const env = { OMPCODE: "1", CLAUDECODE: "1" };
  for (const requireClaudeSession of [false, true]) {
    await withHook({ requireClaudeSession }, (dir) => {
      const valid = commitAttempt(dir, "fix(gate): recognize omp authorship", env);
      assert.equal(valid.blocked, false, valid.stderr);
      assert.equal(git(dir, ["log", "-1", "--format=%s"]).trim(), "fix(gate): recognize omp authorship");

      const bareReference = commitAttempt(dir, "fix(gate): renumber item #42", env);
      assert.equal(bareReference.blocked, true);
      assert.match(bareReference.stderr, /bare #<digits> reference/);

      const invalidSubject = commitAttempt(dir, "recognize omp authorship", env);
      assert.equal(invalidSubject.blocked, true);
      assert.match(invalidSubject.stderr, /conventional-commit form/);
      assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "2");
    });
  }
});

test("rejects a bare non-issue #<digits> enumeration", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    const message = `fix(gate): renumber item #42${AGENT_TRAILERS}`;
    const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
    assert.equal(result.blocked, true);
    assert.match(result.stderr, /bare #<digits> reference found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allows a genuine Closes/Fixes/Refs #N reference", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    for (const message of [
      `fix(gate): patch the thing (Closes #42)${AGENT_TRAILERS}`,
      `fix(gate): patch the thing (Fixes #42)${AGENT_TRAILERS}`,
      `fix(gate): patch the thing (Refs #42)${AGENT_TRAILERS}`,
    ]) {
      const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
      assert.equal(result.blocked, false, `expected ${JSON.stringify(message)} to pass: ${result.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allows the colon-form Closes:/Fixes:/Refs: #N trailer, same as the non-colon form", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    for (const message of [
      `fix(gate): patch the thing\n\nCloses: #42${AGENT_TRAILERS}`,
      `fix(gate): patch the thing\n\nFixes: #42${AGENT_TRAILERS}`,
      `fix(gate): patch the thing\n\nRefs: #42${AGENT_TRAILERS}`,
    ]) {
      const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
      assert.equal(result.blocked, false, `expected ${JSON.stringify(message)} to pass: ${result.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a subject not in conventional-commit type(scope): summary form", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    const message = `did a thing${AGENT_TRAILERS}`;
    const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
    assert.equal(result.blocked, true);
    assert.match(result.stderr, /conventional-commit form/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepts every conventional-commit type in the full allowlist, including refactor/revert/perf/style/ci/build", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    for (const type of ["feat", "fix", "chore", "docs", "test", "refactor", "revert", "perf", "style", "ci", "build"]) {
      const message = `${type}(gate): do the thing${AGENT_TRAILERS}`;
      const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
      assert.equal(result.blocked, false, `expected type "${type}" to pass: ${result.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a default git-revert/fixup!/squash! subject is exempt from the conventional-commit subject check", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    for (const subject of [
      'Revert "fix(gate): do the thing"',
      "fixup! fix(gate): do the thing",
      "squash! fix(gate): do the thing",
    ]) {
      // No trailers, no conventional form of its own — the git/tooling-authored
      // shape must exempt it regardless.
      const result = commitAttempt(dir, subject, { CLAUDECODE: "1" });
      assert.equal(result.blocked, false, `expected ${JSON.stringify(subject)} to pass: ${result.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a per-commit waiver marker allows a deliberate exception", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    // No trailers, a bare #99, and a non-conventional subject — every check
    // would independently reject this — yet the waiver line lets it through.
    const message = `did a thing #99\n\n${COMMIT_MSG_WAIVER_MARKER}\n`;
    const result = commitAttempt(dir, message, { CLAUDECODE: "1" });
    assert.equal(result.blocked, false, `expected the waiver to allow it: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing foreign commit-msg hook is preserved, never clobbered", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const hooksDir = path.join(gitDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const foreign = "#!/bin/sh\n# someone else's commit-msg hook\nexit 0\n";
    fs.writeFileSync(path.join(hooksDir, "commit-msg"), foreign, { mode: 0o755 });

    const result = installCommitMsgGuard({ gitDir });
    assert.equal(result.ok, true);
    assert.equal(result.installed, false);
    assert.equal(result.skipped, true);
    assert.equal(fs.readFileSync(path.join(hooksDir, "commit-msg"), "utf8"), foreign, "left byte-identical");

    // And the contract is NOT enforced — the foreign hook owns the slot.
    const message = "not conventional at all";
    const commitResult = commitAttempt(dir, message, { CLAUDECODE: "1" });
    assert.equal(commitResult.blocked, false, "the foreign hook's exit 0 must be what runs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses overridden hook routing without installing an ineffective guard", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    for (const hooksPathOverride of ["", path.join(dir, "custom-hooks")]) {
      const result = installCommitMsgGuard({ gitDir, hooksPathOverride });
      assert.equal(result.ok, false);
      assert.equal(result.installed, false);
      assert.match(result.reason, /core\.hooksPath is set/);
      assert.equal(fs.existsSync(path.join(gitDir, "hooks", "commit-msg")), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses non-absolute and non-git targets without creating hooks", async () => {
  const { dir } = await repoFixture();
  try {
    const relative = installCommitMsgGuard({ gitDir: "relative" });
    assert.equal(relative.ok, false);
    assert.match(relative.reason, /must be an absolute path/);
    const missing = path.join(dir, "not-a-git-dir");
    const nonexistent = installCommitMsgGuard({ gitDir: missing });
    assert.equal(nonexistent.ok, false);
    assert.match(nonexistent.reason, /no HEAD file/);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install is idempotent — a re-run refreshes its own hook rather than duplicating it", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const first = installCommitMsgGuard({ gitDir });
    assert.equal(first.installed, true);
    assert.equal(first.refreshed, false);

    const second = installCommitMsgGuard({ gitDir });
    assert.equal(second.installed, false);
    assert.equal(second.refreshed, true);

    const contents = fs.readFileSync(path.join(gitDir, "hooks", "commit-msg"), "utf8");
    const markerLineMatches = contents.match(new RegExp(`^// ${COMMIT_MSG_GUARD_MARKER}$`, "mgu")) ?? [];
    assert.equal(markerLineMatches.length, 1, "the ownership marker line must appear exactly once, not stacked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a merge commit's message is exempt from the conventional-commit subject check", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir });
    git(dir, ["checkout", "--quiet", "-b", "feature"]);
    fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n");
    git(dir, ["add", "feature.txt"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "fix(gate): feature work"]);
    git(dir, ["checkout", "--quiet", "main"]);
    // The default merge message ("Merge branch 'feature'") is not
    // conventional-commit form and carries no trailers — it must still pass.
    git(dir, ["merge", "--no-ff", "feature"], { CLAUDECODE: "1" });
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses to install into a linked worktree's own gitdir, not the common one", async () => {
  const { dir, gitDir } = await repoFixture();
  const linked = path.join(dir, "..", `${path.basename(dir)}-linked`);
  try {
    git(dir, ["checkout", "--quiet", "-b", "primary-holder"]);
    git(dir, ["worktree", "add", "--quiet", linked, "main"]);
    const linkedGitDir = git(linked, ["rev-parse", "--absolute-git-dir"]).trim();
    assert.notEqual(linkedGitDir, gitDir);

    const result = installCommitMsgGuard({ gitDir: linkedGitDir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /own git directory/);
    assert.equal(fs.existsSync(path.join(linkedGitDir, "hooks", "commit-msg")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #2605: the Claude-Session trailer is an opt-in baked at install time.
// ---------------------------------------------------------------------------

const UUID = "0b9c1f0e-0000-4000-8000-000000000001";
const CO_AUTHOR = "\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n";
const SESSION_LINE = `Claude-Session: https://claude.ai/code/session_${UUID}\n`;
const SUBJECT = "fix(gate): do the thing";

const ENVS = {
  agent: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: UUID, AI_AGENT: "claude-code" },
  operator: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: UUID },
  plain: {},
  pi: { PI_SESSION_ID: "pi-1" },
  piInherited: { PI_SESSION_ID: "pi-1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: UUID },
};

async function withHook(options, run) {
  const { dir, gitDir } = await repoFixture();
  try {
    installCommitMsgGuard({ gitDir, ...options });
    return await run(dir, gitDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [envName, env] of Object.entries(ENVS)) {
  const claude = env.CLAUDECODE === "1";
  for (const [label, options] of [["default", {}], ["false", { requireClaudeSession: false }], ["true", { requireClaudeSession: true }]]) {
    const required = options.requireClaudeSession === true;
    test(`${envName} env, hook rendered ${label}: attribution matrix`, async () => {
      await withHook(options, (dir) => {
        if (!claude) {
          assert.equal(commitAttempt(dir, SUBJECT, env).blocked, false);
          return;
        }
        const noCoAuthor = commitAttempt(dir, SUBJECT, env);
        assert.equal(noCoAuthor.blocked, true);
        assert.match(noCoAuthor.stderr, /missing required trailer: Co-Authored-By/);
        assert.equal(noCoAuthor.stderr.includes("Claude-Session") || noCoAuthor.stderr.includes("claude.ai"), required);
        assert.equal(noCoAuthor.stderr.includes("requireClaudeSession"), false);
        const coAuthorOnly = commitAttempt(dir, `${SUBJECT}${CO_AUTHOR}`, env);
        assert.equal(coAuthorOnly.blocked, required, coAuthorOnly.stderr);
        if (required) assert.match(coAuthorOnly.stderr, /missing required trailer: Claude-Session/);
        assert.equal(commitAttempt(dir, `${SUBJECT}${CO_AUTHOR}${SESSION_LINE}`, env).blocked, false);
      });
    });
  }
}

for (const [label, options] of [["false", { requireClaudeSession: false }], ["true", { requireClaudeSession: true }]]) {
  test(`the other checks do not depend on the key (${label})`, async () => {
    await withHook(options, (dir) => {
      assert.equal(commitAttempt(dir, "fix(gate): see #123 and more").blocked, true);
      assert.equal(commitAttempt(dir, "do the thing").blocked, true);
      assert.equal(commitAttempt(dir, "fixup! fix(gate): earlier").blocked, false);
      assert.equal(commitAttempt(dir, 'Revert "fix(gate): earlier"').blocked, false);
      assert.equal(commitAttempt(dir, `bad subject\n\n${COMMIT_MSG_WAIVER_MARKER}\n`, ENVS.agent).blocked, false);
      git(dir, ["checkout", "--quiet", "-b", "feature"]);
      const file = `feature-${fileCounter++}.txt`;
      fs.writeFileSync(path.join(dir, file), "feature\n");
      git(dir, ["add", file]);
      git(dir, ["commit", "--quiet", "--no-verify", "-m", "fix(gate): feature work"]);
      git(dir, ["checkout", "--quiet", "-"]);
      // The default merge subject is not conventional and carries no trailers.
      git(dir, ["merge", "--no-ff", "feature"], ENVS.agent);
    });
  });
}

test("environment variables and git config cannot change the baked value", async () => {
  const message = `${SUBJECT}${CO_AUTHOR}`;
  await withHook({ requireClaudeSession: true }, (dir) => {
    assert.equal(commitAttempt(dir, message, { ...ENVS.agent, DEVLOOPS_REQUIRE_CLAUDE_SESSION: "0" }).blocked, true);
    const file = `change-${fileCounter++}.txt`;
    fs.writeFileSync(path.join(dir, file), "x\n");
    git(dir, ["add", file]);
    assert.throws(() => git(dir, ["-c", "devloops.requireClaudeSession=false", "commit", "--quiet", "-m", message], ENVS.agent));
  });
  await withHook({ requireClaudeSession: false }, (dir) => {
    for (const value of ["1", "true"]) {
      assert.equal(commitAttempt(dir, message, { ...ENVS.agent, DEVLOOPS_REQUIRE_CLAUDE_SESSION: value }).blocked, false);
    }
    const file = `change-${fileCounter++}.txt`;
    fs.writeFileSync(path.join(dir, file), "x\n");
    git(dir, ["add", file]);
    git(dir, ["-c", "devloops.requireClaudeSession=true", "commit", "--quiet", "-m", message], ENVS.agent);
  });
});

