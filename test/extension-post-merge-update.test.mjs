import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

import registerExtension from "../extension/index.ts";
import {
  POST_MERGE_UPDATE_COMMAND,
  TARGET_REPO_SLUG,
  createPostMergeUpdateHook,
  isMergeCapableCommand,
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  extractRepoFlagFromGhPrReady,
  normalizeGitHubRepoSlug,
} from "../extension/post-merge-update.ts";
import { buildWorktreeCleanupCommand, buildPostMergeActionsCommand } from "../packages/core/src/loop/main-checkout-ff.mjs";

// Mirrors the private `shellQuotePath` in packages/core/src/loop/main-checkout-ff.mjs so
// these tests can assert the exact step commands `syncMainCheckout` submits, without
// re-exporting an internal quoting helper from the shared module.
function quotePath(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
function fetchCommand(mainCheckout) {
  return `git -C ${quotePath(mainCheckout)} fetch origin main`;
}
function revParseSymbolicFullNameCommand(mainCheckout) {
  return `git -C ${quotePath(mainCheckout)} rev-parse --symbolic-full-name HEAD`;
}
function mergeFfOnlyCommand(mainCheckout) {
  return `git -C ${quotePath(mainCheckout)} merge --ff-only origin/main`;
}
function revParseShortHeadCommand(mainCheckout) {
  return `git -C ${quotePath(mainCheckout)} rev-parse --short HEAD`;
}
function revListBehindCountCommand(mainCheckout) {
  return `git -C ${quotePath(mainCheckout)} rev-list --count HEAD..origin/main`;
}

function createUiCalls() {
  const notifications = [];
  return {
    notifications,
    ctx: {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify(message, level = "info") {
          notifications.push({ message, level });
        },
        setStatus() {},
        setWidget() {},
      },
    },
  };
}

function createPiDouble() {
  const events = new Map();
  const registeredCommands = new Map();
  return {
    on(event, handler) {
      events.set(event, handler);
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    events,
    registeredCommands,
  };
}

test("normalizeGitHubRepoSlug recognizes GitHub remote variants", () => {
  assert.equal(normalizeGitHubRepoSlug("git@github.com:mfittko/dev-loops.git"), TARGET_REPO_SLUG);
  assert.equal(normalizeGitHubRepoSlug("https://github.com/mfittko/dev-loops.git"), TARGET_REPO_SLUG);
  assert.equal(normalizeGitHubRepoSlug("git@github.com:Mfittko/Dev-Loops.git"), TARGET_REPO_SLUG);
  assert.equal(normalizeGitHubRepoSlug("ssh://git@github.com/mfittko/dev-loops.git"), TARGET_REPO_SLUG);
  assert.equal(normalizeGitHubRepoSlug("git:github.com/mfittko/dev-loops"), TARGET_REPO_SLUG);
  assert.equal(normalizeGitHubRepoSlug("https://gitlab.com/mfittko/dev-loops.git"), null);
});

test("isMergeCapableCommand only matches bounded merge commands", () => {
  assert.equal(isMergeCapableCommand("gh pr merge 373 --squash --delete-branch"), true);
  assert.equal(isMergeCapableCommand("git merge origin/main"), true);
  assert.equal(isMergeCapableCommand("npm test && gh pr merge 373"), true);
  assert.equal(isMergeCapableCommand("gh pr merge --help"), false);
  assert.equal(isMergeCapableCommand("gh pr merge -h"), false);
  assert.equal(isMergeCapableCommand("git merge --help"), false);
  assert.equal(isMergeCapableCommand("git merge -h"), false);
  assert.equal(isMergeCapableCommand("git merge --abort"), false);
  assert.equal(isMergeCapableCommand("git merge --continue"), false);
  assert.equal(isMergeCapableCommand("git merge --quit"), false);
  assert.equal(isMergeCapableCommand("git merge-base HEAD origin/main"), false);
  assert.equal(isMergeCapableCommand("git merge-tree HEAD origin/main"), false);
  assert.equal(isMergeCapableCommand("git status"), false);
  assert.equal(isMergeCapableCommand("echo gh pr merge"), false);
});

test("successful bash-tool gh pr merge queues and flushes one post-merge update on agent_end", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  deadbeef [main]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/main\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "updated", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  assert.equal(hook.getState().pendingPostMergeUpdate, true);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(calls, [
    { command: POST_MERGE_UPDATE_COMMAND, cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: fetchCommand("/repo"), cwd: "/repo" },
    { command: revParseSymbolicFullNameCommand("/repo"), cwd: "/repo" },
    { command: mergeFfOnlyCommand("/repo"), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildWorktreeCleanupCommand("/repo", 373), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildPostMergeActionsCommand("/repo", 373), cwd: "/repo" },
  ]);
  assert.deepEqual(notifications, [
    { message: `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: `Post-merge update completed: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: "Post-merge main-checkout fast-forward running for /repo", level: "info" },
    { message: "Post-merge main-checkout fast-forward completed: local main advanced to origin/main", level: "info" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
    { message: "Post-merge actions: updated", level: "info" },
  ]);
  assert.equal(hook.getState().pendingPostMergeUpdate, false);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(calls.length, 9);
});

test("successful user_bash git merge queues and flushes one update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git merge origin/main") {
        return { code: 0, stdout: "Already up to date.", stderr: "", killed: false };
      }
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  deadbeef [main]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/main\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "updated", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "git merge origin/main", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "Already up to date.",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(hook.getState().pendingPostMergeUpdate, true);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(calls, [
    { command: "git merge origin/main", cwd: "/repo" },
    { command: POST_MERGE_UPDATE_COMMAND, cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: fetchCommand("/repo"), cwd: "/repo" },
    { command: revParseSymbolicFullNameCommand("/repo"), cwd: "/repo" },
    { command: mergeFfOnlyCommand("/repo"), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildPostMergeActionsCommand("/repo", undefined), cwd: "/repo" },
  ]);
});

test("failed merge commands do not trigger the post-merge update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 1, stdout: "", stderr: "merge failed", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "git merge conflict-branch", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "merge failed",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(hook.getState().pendingPostMergeUpdate, false);

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373" },
    isError: true,
  }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(calls, [{ command: "git merge conflict-branch", cwd: "/repo" }]);
});

test("non-merge commands and non-target repos never trigger the update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "other/repo" }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "git status" }, isError: false }, ctx);
  const result = await hook.onUserBash({ command: "git merge feature", cwd: "/repo" }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.equal(result, undefined);
  assert.deepEqual(calls, []);
  assert.equal(hook.getState().pendingPostMergeUpdate, false);
});

// --- postMerge.actions: runs for the repo that merged, regardless of slug (#1457) ---

test("postMerge.actions runs for a consumer repo via the agent bash tool, while pi-update stays gated to dev-loops", async () => {
  const calls = [];
  const runnerResult = { ok: true, results: [{ name: "sync-checkout", status: "ok", detail: null }] };
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "other/repo" }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "not a worktree listing", stderr: "", killed: false };
      }
      return { code: 0, stdout: JSON.stringify(runnerResult), stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 55 --squash --delete-branch" },
    isError: false,
  }, ctx);

  assert.equal(hook.getState().pendingPostMergeUpdate, false, "pi-update stays gated to the dev-loops repo");
  assert.equal(hook.getState().pendingPostMergeActionsRoot, "/repo");

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(calls, [
    { command: "git worktree list", cwd: "/repo" },
    { command: buildPostMergeActionsCommand("/repo", 55), cwd: "/repo" },
  ]);
  assert.deepEqual(notifications, [
    { message: `Post-merge actions: ${JSON.stringify(runnerResult)}`, level: "info" },
  ]);
  assert.equal(hook.getState().pendingPostMergeActionsRoot, null);
});

test("postMerge.actions stays silent when the runner produces no output (no postMerge.actions declared)", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "other/repo" }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 55" }, isError: false }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(notifications, []);
});

test("postMerge.actions runner failure is a warning, never throws out of onAgentEnd", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "other/repo" }),
    runCommand: async ({ command }) => {
      if (command === "git worktree list") return { code: 0, stdout: "", stderr: "", killed: false };
      throw new Error("runner spawn failed");
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 55" }, isError: false }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(notifications, [
    { message: "Post-merge actions skipped (warning only): runner spawn failed", level: "warning" },
  ]);
});


test("repo-resolution failures are swallowed so the hook stays best-effort", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async () => {
      throw new Error("git unavailable");
    },
    runCommand: async () => ({ code: 0, stdout: "ok", stderr: "", killed: false }),
  });
  const { ctx } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
  const result = await hook.onUserBash({ command: "git merge origin/main", cwd: "/repo" }, ctx);

  assert.equal(result, undefined);
  assert.equal(hook.getState().pendingPostMergeUpdate, false);
});

test("malformed or foreign-harness events pass through safely without throwing", async () => {
  let resolveCalls = 0;
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => {
      resolveCalls += 1;
      return { repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true };
    },
    runCommand: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  });
  const { ctx } = createUiCalls();

  // onUserBash: missing/typed-wrong command and null event must return undefined (pass through).
  assert.equal(await hook.onUserBash({}, ctx), undefined);
  assert.equal(await hook.onUserBash({ command: 123 }, ctx), undefined);
  assert.equal(await hook.onUserBash(null, ctx), undefined);

  // onToolResult: null/empty events must not throw and must not queue an update.
  await hook.onToolResult(null, ctx);
  await hook.onToolResult({}, ctx);

  assert.equal(resolveCalls, 0, "malformed events must not even reach repo resolution");
  assert.equal(hook.getState().pendingPostMergeUpdate, false);
});

test("multiple merge signals in one turn still run only one update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  deadbeef [main]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/main\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
  await hook.onToolResult({ toolName: "bash", input: { command: "git merge origin/main" }, isError: false }, ctx);
  assert.equal(hook.getState().pendingPostMergeUpdate, true);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(calls, [
    { command: POST_MERGE_UPDATE_COMMAND, cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: fetchCommand("/repo"), cwd: "/repo" },
    { command: revParseSymbolicFullNameCommand("/repo"), cwd: "/repo" },
    { command: mergeFfOnlyCommand("/repo"), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildWorktreeCleanupCommand("/repo", 373), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildPostMergeActionsCommand("/repo", 373), cwd: "/repo" },
  ]);
});

test("update failure is warning-only and leaves the session healthy", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async () => ({ code: 1, stdout: "", stderr: "permission denied", killed: false }),
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.equal(hook.getState().pendingPostMergeUpdate, false);
  assert.equal(hook.getState().updateInFlight, false);
  assert.deepEqual(notifications, [
    { message: `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: "Post-merge update failed (warning only): permission denied", level: "warning" },
    { message: "Post-merge main-checkout fast-forward running for /repo", level: "info" },
    { message: "Post-merge main-checkout fast-forward skipped (warning only): permission denied", level: "warning" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
    { message: "Post-merge worktree cleanup skipped (warning only): permission denied", level: "warning" },
  ]);
});


test("killed post-merge updates surface a clear warning message", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(notifications, [
    { message: `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: "Post-merge update failed (warning only): command was killed before completing", level: "warning" },
    { message: "Post-merge main-checkout fast-forward running for /repo", level: "info" },
    { message: "Post-merge main-checkout fast-forward skipped (warning only): command was killed before completing", level: "warning" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
    { message: "Post-merge worktree cleanup skipped (warning only): command was killed before completing", level: "warning" },
  ]);
});

test("onAgentEnd fast-forwards the resolved main checkout to origin/main (#1596)", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/main/checkout  deadbeef [main]\n/repo  cafebabe [feature]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/main/checkout")) {
        return { code: 0, stdout: "refs/heads/main\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  const worktreeCall = calls.find((c) => c.command === "git worktree list");
  assert.deepEqual(worktreeCall, { command: "git worktree list", cwd: "/repo" });

  const ffCall = calls.find((c) => c.command === mergeFfOnlyCommand("/main/checkout"));
  assert.deepEqual(ffCall, { command: mergeFfOnlyCommand("/main/checkout"), cwd: "/main/checkout" });

  assert.ok(
    notifications.some((n) => n.message.includes("Post-merge main-checkout fast-forward completed")),
    "expected a completed ff notification",
  );
  assert.equal(hook.getState().pendingPostMergeUpdate, false);
  assert.equal(hook.getState().updateInFlight, false);
});

test("a non-fast-forwardable main checkout warns and does not block", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/main/checkout  deadbeef [main]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/main/checkout")) {
        return { code: 0, stdout: "refs/heads/main\n", stderr: "", killed: false };
      }
      if (command === mergeFfOnlyCommand("/main/checkout")) {
        return { code: 1, stdout: "", stderr: "Not possible to fast-forward", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.equal(hook.getState().pendingPostMergeUpdate, false);
  assert.equal(hook.getState().updateInFlight, false);
  assert.equal(
    notifications.some((n) => n.level === "error"),
    false,
    "a diverged main checkout must never emit an error-level notification",
  );
  assert.ok(
    notifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    "expected a warning notification for the non-fast-forwardable checkout",
  );
});

// --- main_checkout_not_on_main: detached/other-branch action-required signal ---

test("a detached main checkout surfaces an error-level notification and never merges/switches/resets", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  deadbeef (detached HEAD)\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "HEAD\n", stderr: "", killed: false };
      }
      if (command === revParseShortHeadCommand("/repo")) {
        return { code: 0, stdout: "abc1234\n", stderr: "", killed: false };
      }
      if (command === revListBehindCountCommand("/repo")) {
        return { code: 0, stdout: "6\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  const errorNotifications = notifications.filter((n) => n.level === "error");
  assert.equal(errorNotifications.length, 1, JSON.stringify(notifications));
  const message = errorNotifications[0].message;
  assert.ok(message.includes("main_checkout_not_on_main"), message);
  assert.ok(message.includes("/repo"), message);
  assert.ok(message.includes("detached@abc1234"), message);
  assert.ok(message.includes("6 commit(s) behind"), message);
  assert.equal(
    notifications.some((n) => n.message.includes("skipped (warning only)")),
    false,
    "the action-required signal must never also emit the generic skip warning",
  );

  for (const { command } of calls.filter((c) => c.command.startsWith("git -C "))) {
    assert.ok(!/\bmerge\b/.test(command), `must not merge: ${command}`);
    assert.ok(!/\bswitch\b/.test(command), `must not switch: ${command}`);
    assert.ok(!/\bcheckout\b/.test(command), `must not checkout: ${command}`);
    assert.ok(!/\breset\b/.test(command), `must not reset: ${command}`);
  }
});

test("an other-branch main checkout surfaces an error-level notification naming the branch and a zero behind count", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  cafebabe [feature/x]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/feature/x\n", stderr: "", killed: false };
      }
      if (command === revListBehindCountCommand("/repo")) {
        return { code: 0, stdout: "0\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  const errorNotifications = notifications.filter((n) => n.level === "error");
  assert.equal(errorNotifications.length, 1, JSON.stringify(notifications));
  const message = errorNotifications[0].message;
  assert.ok(message.includes("feature/x"), message);
  assert.ok(message.includes("0 commit(s) behind"), message);
  assert.equal(
    notifications.some((n) => n.message.includes("skipped (warning only)")),
    false,
    "the action-required signal must never also emit the generic skip warning",
  );

  for (const { command } of calls.filter((c) => c.command.startsWith("git -C "))) {
    assert.ok(!/\bmerge\b/.test(command), `must not merge: ${command}`);
    assert.ok(!/\bswitch\b/.test(command), `must not switch: ${command}`);
    assert.ok(!/\bcheckout\b/.test(command), `must not checkout: ${command}`);
    assert.ok(!/\breset\b/.test(command), `must not reset: ${command}`);
  }
});

test("a not-on-main main checkout falls back to stderr when no UI is available", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command }) => {
      if (command === "git worktree list") {
        return { code: 0, stdout: "/repo  cafebabe [feature/x]\n", stderr: "", killed: false };
      }
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/feature/x\n", stderr: "", killed: false };
      }
      if (command === revListBehindCountCommand("/repo")) {
        return { code: 0, stdout: "2\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });

  let notifyCalled = false;
  const ctx = {
    hasUI: false,
    cwd: "/repo",
    ui: {
      notify() {
        notifyCalled = true;
      },
      setStatus() {},
      setWidget() {},
    },
  };

  const originalWrite = process.stderr.write;
  const stderrChunks = [];
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  try {
    await hook.onToolResult({
      toolName: "bash",
      input: { command: "gh pr merge 373 --squash --delete-branch" },
      isError: false,
    }, ctx);

    await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(notifyCalled, false, "ctx.ui.notify must never be called when hasUI is false");
  const combined = stderrChunks.join("");
  assert.ok(combined.includes("main_checkout_not_on_main"), combined);
  assert.ok(combined.includes("feature/x"), combined);
});

test("fetch failure, rev-parse failure, unreadable ref, and behind-count failure stay warning-only (no error-level notification)", async () => {
  async function runScenario(handler) {
    const notifications = [];
    const hook = createPostMergeUpdateHook({
      resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
      runCommand: async ({ command }) => {
        if (command === "git worktree list") {
          return { code: 0, stdout: "/repo  cafebabe [feature/x]\n", stderr: "", killed: false };
        }
        return handler(command);
      },
    });
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify(message, level = "info") {
          notifications.push({ message, level });
        },
        setStatus() {},
        setWidget() {},
      },
    };
    await hook.onToolResult({
      toolName: "bash",
      input: { command: "gh pr merge 373 --squash --delete-branch" },
      isError: false,
    }, ctx);
    await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
    return notifications;
  }

  const fetchFailNotifications = await runScenario((command) => {
    if (command === fetchCommand("/repo")) {
      return { code: 1, stdout: "", stderr: "could not resolve host", killed: false };
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  });
  assert.equal(fetchFailNotifications.some((n) => n.level === "error"), false);
  assert.ok(
    fetchFailNotifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    JSON.stringify(fetchFailNotifications),
  );

  const revParseFailNotifications = await runScenario((command) => {
    if (command === revParseSymbolicFullNameCommand("/repo")) {
      return { code: 1, stdout: "", stderr: "not a git repository", killed: false };
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  });
  assert.equal(revParseFailNotifications.some((n) => n.level === "error"), false);
  assert.ok(
    revParseFailNotifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    JSON.stringify(revParseFailNotifications),
  );

  // rev-parse exits 0 but its output is not a `refs/heads/...` ref — classified
  // "unreadable" (see classifyMainCheckoutRef), never surfaced as not_on_main.
  const unreadableRefNotifications = await runScenario((command) => {
    if (command === revParseSymbolicFullNameCommand("/repo")) {
      return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  });
  assert.equal(unreadableRefNotifications.some((n) => n.level === "error"), false);
  assert.ok(
    unreadableRefNotifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    JSON.stringify(unreadableRefNotifications),
  );

  const behindCountFailNotifications = await runScenario((command) => {
    if (command === revParseSymbolicFullNameCommand("/repo")) {
      return { code: 0, stdout: "refs/heads/feature/x\n", stderr: "", killed: false };
    }
    if (command === revListBehindCountCommand("/repo")) {
      return { code: 1, stdout: "", stderr: "bad revision", killed: false };
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  });
  assert.equal(behindCountFailNotifications.some((n) => n.level === "error"), false);
  assert.ok(
    behindCountFailNotifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    JSON.stringify(behindCountFailNotifications),
  );
});

test("an unresolved main worktree on another branch stays on the generic warning and never emits main_checkout_not_on_main", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        // Unparseable output (failed/killed listing would behave the same): the main
        // checkout cannot be resolved, so the sync falls back to `pendingRoot` (a
        // linked feature worktree, e.g. `/repo`) instead of the true main checkout.
        return { code: 0, stdout: "not a worktree listing", stderr: "", killed: false };
      }
      // The fallback checkout is on another branch, so syncMainCheckout would
      // otherwise classify it as `not_on_main` — asserted downgraded to the generic
      // warning below, since `/repo` is not proven to be the real main checkout.
      if (command === revParseSymbolicFullNameCommand("/repo")) {
        return { code: 0, stdout: "refs/heads/feature/x\n", stderr: "", killed: false };
      }
      if (command === revListBehindCountCommand("/repo")) {
        return { code: 0, stdout: "3\n", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({
    toolName: "bash",
    input: { command: "gh pr merge 373 --squash --delete-branch" },
    isError: false,
  }, ctx);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.equal(
    notifications.some((n) => n.level === "error"),
    false,
    "an unresolved worktree must never emit an error-level notification",
  );
  assert.equal(
    notifications.some((n) => n.message.includes("main_checkout_not_on_main")),
    false,
    "an unresolved worktree must never emit the action-required signal",
  );
  assert.ok(
    notifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    "expected the generic warning-level skip notification",
  );

  for (const { command } of calls.filter((c) => c.command.startsWith("git -C "))) {
    assert.ok(!/\bmerge\b/.test(command), `must not merge: ${command}`);
    assert.ok(!/\bswitch\b/.test(command), `must not switch: ${command}`);
    assert.ok(!/\bcheckout\b/.test(command), `must not checkout: ${command}`);
    assert.ok(!/\breset\b/.test(command), `must not reset: ${command}`);
  }
});

test("session_start resets post-merge hook state and extension registers lifecycle listeners", async () => {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dev-loops-post-merge-home-"));
  process.env.HOME = tempHome;

  try {
    const pi = createPiDouble();
    const hook = createPostMergeUpdateHook({
      resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    });
    registerExtension(pi, { postMergeUpdateHook: hook });

    assert.equal(typeof pi.events.get("session_start"), "function");
    assert.equal(typeof pi.events.get("tool_result"), "function");
    assert.equal(typeof pi.events.get("user_bash"), "function");
    assert.equal(typeof pi.events.get("agent_end"), "function");
    assert.equal(pi.registeredCommands.has("dev-loops"), true);

    const { ctx } = createUiCalls();
    await pi.events.get("tool_result")({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
    assert.equal(hook.getState().pendingPostMergeUpdate, true);

    await pi.events.get("session_start")({}, ctx);
    assert.equal(hook.getState().pendingPostMergeUpdate, false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

// --- gh pr ready gate guard tests ---

test("isGhPrReadyCommand matches gh pr ready variants", () => {
  assert.equal(isGhPrReadyCommand("gh pr ready"), true);
  assert.equal(isGhPrReadyCommand("gh pr ready 42"), true);
  assert.equal(isGhPrReadyCommand("gh pr ready 42 --repo mfittko/dev-loops"), true);
  assert.equal(isGhPrReadyCommand("gh pr ready --help"), false);
  assert.equal(isGhPrReadyCommand("gh pr ready -h"), false);
  assert.equal(isGhPrReadyCommand("gh pr ready 42 --help"), false);
  assert.equal(isGhPrReadyCommand("gh pr ready 42 -h"), false);
  assert.equal(isGhPrReadyCommand("gh pr ready --undo 42 --help"), false);
  assert.equal(isGhPrReadyCommand("gh pr merge 42"), false);
  assert.equal(isGhPrReadyCommand("git merge origin/main"), false);
  assert.equal(isGhPrReadyCommand("echo gh pr ready"), false);
  // Pi extension: first-segment-only (correct for post-execute detection — if false short-
  // circuits &&, gh pr ready never ran). The Claude Code PreToolUse gate uses
  // commandContainsGhPrReady which scans all segments for pre-emptive blocking.
  assert.equal(isGhPrReadyCommand("false && gh pr ready 42"), false);
  assert.equal(isGhPrReadyCommand("echo ok; gh pr ready 42"), false);
  assert.equal(isGhPrReadyCommand("gh pr ready 42 && echo ok"), true);
});

test("extractPrNumberFromGhPrReady extracts the PR number", () => {
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready 42"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready 123"), 123);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready 42 --repo mfittko/dev-loops"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready --repo mfittko/dev-loops 42"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready -r other/repo 42"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready --REPO other/repo 42"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready 42abc"), null);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready abc42"), null);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready"), null);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready --help"), null);
  assert.equal(extractPrNumberFromGhPrReady("gh pr merge 42"), null);
  assert.equal(extractPrNumberFromGhPrReady("false && gh pr ready 42"), null); // first-segment only
});

test("extractRepoFlagFromGhPrReady extracts -R/--repo", () => {
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 -R other/repo"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 --repo other/repo"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready --repo=other/repo 42"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 -R other/repo --undo"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42"), null);
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready"), null);
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 --undo"), null);
  assert.equal(extractRepoFlagFromGhPrReady("gh pr merge 42 -R other/repo"), null);
  assert.equal(extractRepoFlagFromGhPrReady("false && gh pr ready 42 -R other/repo"), null);
});

test("extractRepoFlagFromGhPrReady handles -R with --repo in same segment", () => {
  // Both -R and --repo present: prefer the one that appears first with a value
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 -R first/repo --repo second/repo"), "first/repo");
  // Only --repo with = syntax
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 --repo=eq/repo"), "eq/repo");
  // -R with = syntax
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 -R=other/repo"), "other/repo");
  // Case variations in flag
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 42 -r other/repo"), "other/repo");
});

test("gh pr ready later in a shell chain passes through", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "false && gh pr ready 42", cwd: "/repo" }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("gh pr ready passes through when -R targets non-target repo", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  // User is in target repo checkout but targets a different repo via -R
  const result = await hook.onUserBash({ command: "gh pr ready 42 -R other/repo", cwd: "/repo" }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("gh pr ready passes through when --repo targets non-target repo", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42 --repo other/repo", cwd: "/repo" }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("gh pr ready still intercepts when -R targets same repo (case-insensitive)", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      // Gate script passes
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        return { code: 0, stdout: JSON.stringify({ ok: true, draftGateSatisfied: true }), stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  // Exact match
  let result = await hook.onUserBash({ command: `gh pr ready 42 -R ${TARGET_REPO_SLUG}`, cwd: "/repo" }, ctx);
  assert.notEqual(result, undefined);

  // Case-insensitive match
  const calls2 = [];
  const hook2 = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls2.push({ command, cwd });
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        return { code: 0, stdout: JSON.stringify({ ok: true, draftGateSatisfied: true }), stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const upperSlug = TARGET_REPO_SLUG.toUpperCase();
  const result2 = await hook2.onUserBash({ command: `gh pr ready 42 -R ${upperSlug}`, cwd: "/repo" }, ctx);
  assert.notEqual(result2, undefined);
});

test("gh pr ready blocks when draft-gate script fails", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "No visible clean draft_gate checkpoint verdict comment found on PR #42 for head abc1234." }), killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "gh pr ready blocked: No visible clean draft_gate checkpoint verdict comment found on PR #42 for head abc1234.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs"));
});

test("gh pr ready allows when draft-gate script passes", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        return { code: 0, stdout: JSON.stringify({ ok: true, draftGateSatisfied: true }), stderr: "", killed: false };
      }
      if (command === "gh pr ready 42") {
        return { code: 0, stdout: "✓ Pull request #42 is now ready for review", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "✓ Pull request #42 is now ready for review",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs"));
  assert.equal(calls[1].command, "gh pr ready 42");
});

test("gh pr ready without PR number blocks immediately", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "gh pr ready blocked: could not determine PR number from command. Include the PR number explicitly.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 0);
});

test("gh pr ready in non-target repo passes through", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "other/repo" }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

test("gh pr ready guard failures from script errors surface gracefully", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      throw new Error("script not found");
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "gh pr ready blocked: draft-gate evidence check failed (could not run guard script).",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
});

test("gh pr ready intercept does not affect gh pr merge or other commands", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "gh pr merge 373 --squash --delete-branch") {
        return { code: 0, stdout: "Merged", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr merge 373 --squash --delete-branch", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "Merged",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh pr merge 373 --squash --delete-branch");
});

// --- managed-repo identity resolved dynamically (fail closed, #2194) ---
// Ports the Claude Bash-hook guard's dynamic `inManagedRepo` resolution
// (`deriveInManagedRepo`) to this Pi harness's `gh pr ready`/`gh pr merge` guards, so a
// dev-loops-managed CONSUMER repo (non-dev-loops slug) is no longer a fail-open blind spot.

test("AC1: gh pr ready is gated and gh pr merge is intercepted in a managed consumer repo (non-dev-loops slug)", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets", inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "no clean draft_gate evidence" }), killed: false };
      }
      if (command === "gh pr merge 42 --squash --delete-branch") {
        return { code: 0, stdout: "Merged", stderr: "", killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const readyResult = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(readyResult, {
    result: {
      output: "gh pr ready blocked: no clean draft_gate evidence",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.ok(calls[0].command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs"));

  calls.length = 0;
  const mergeResult = await hook.onUserBash({ command: "gh pr merge 42 --squash --delete-branch", cwd: "/repo" }, ctx);
  assert.deepEqual(mergeResult, {
    result: { output: "Merged", exitCode: 0, cancelled: false, truncated: false },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh pr merge 42 --squash --delete-branch");
  assert.equal(hook.getState().pendingPostMergeActionsRoot, "/repo", "merge was intercepted and queued");
});

test("AC2 (fail-closed): gh pr ready stays gated in a managed repo whose identity is unresolvable", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: null, inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "no clean draft_gate evidence" }), killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "gh pr ready blocked: no clean draft_gate evidence",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 1, "guard ran the gate script rather than passing through");

  // `gh pr merge` has its own explicit-repo/managed-context path (separate from the `gh pr ready`
  // branch above) and could independently regress to pass-through for an unresolvable identity.
  // Same fixture (repoSlug: null, inManagedContext: true): the merge guard must still intercept.
  calls.length = 0;
  const mergeResult = await hook.onUserBash({ command: "gh pr merge 42", cwd: "/repo" }, ctx);
  assert.notEqual(mergeResult, undefined, "merge guard intercepted rather than passing through under unresolvable identity");
  assert.equal(calls.length, 1, "merge guard ran through runCommand rather than passing through");
  assert.equal(calls[0].command, "gh pr merge 42");
});

test("AC2b (defense-in-depth): gh pr ready refuses to interpolate a non-clean repoSlug into the gate command", async () => {
  // `normalizeGitHubRepoSlug` already guarantees a clean slug or null, but a test double / future
  // resolver bypassing it must not reach the shell-command interpolation site either.
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets;id", inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.deepEqual(result, {
    result: {
      output: "gh pr ready blocked: resolved repo identity is not a valid owner/name — refusing to run the draft-gate check.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  assert.equal(calls.length, 0, "guard refused to run any command with a non-clean slug");
});

test("AC3a: an explicit --repo proven foreign to the managed slug passes through", async () => {
  const readyCalls = [];
  const readyHook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets", inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      readyCalls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const readyResult = await readyHook.onUserBash({ command: "gh pr ready 42 --repo other/repo", cwd: "/repo" }, ctx);
  assert.equal(readyResult, undefined);
  assert.equal(readyCalls.length, 0);

  const mergeCalls = [];
  const mergeHook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets", inManagedContext: true }),
    runCommand: async ({ command, cwd }) => {
      mergeCalls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const mergeResult = await mergeHook.onUserBash({ command: "gh pr merge 42 --repo other/repo", cwd: "/repo" }, ctx);
  assert.equal(mergeResult, undefined);
  assert.equal(mergeCalls.length, 0);
});

// --- real .devloops-presence bridge (defaultResolveRepoContext), no resolveRepoContext stub ---
// The AC1-AC4 tests above all inject a fake `resolveRepoContext`, so the real bridge that
// computes `inManagedContext` via `fs.existsSync(path.join(repoRoot, '.devloops'))` is never
// exercised. These two tests drive `createPostMergeUpdateHook({ exec })` with only `exec`
// stubbed (git plumbing), so `defaultResolveRepoContext` runs for real against a temp dir.

function createFakeGitExec(repoRoot, { remoteUrl = "git@github.com:acme/widgets.git" } = {}) {
  const calls = [];
  const exec = async (command, options = {}) => {
    calls.push({ command, cwd: options.cwd });
    if (command === "git rev-parse --show-toplevel") {
      return { code: 0, stdout: `${repoRoot}\n`, stderr: "", killed: false };
    }
    if (command === "git config --get remote.origin.url") {
      return { code: 0, stdout: `${remoteUrl}\n`, stderr: "", killed: false };
    }
    if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
      return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "no clean draft_gate evidence" }), killed: false };
    }
    return { code: 0, stdout: "ok", stderr: "", killed: false };
  };
  return { exec, calls };
}

test("real .devloops-presence bridge activates the gh pr ready guard when .devloops exists (no resolveRepoContext stub)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-managed-bridge-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "{}\n");
    const { exec, calls } = createFakeGitExec(tempDir);
    const hook = createPostMergeUpdateHook({ exec });
    const { ctx } = createUiCalls();

    const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: tempDir }, ctx);

    assert.ok(
      calls.some((c) => c.command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")),
      "the real .devloops-presence bridge must resolve inManagedContext true and run the draft-gate guard",
    );
    assert.deepEqual(result, {
      result: {
        output: "gh pr ready blocked: no clean draft_gate evidence",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("real .devloops-presence bridge stays off (gh pr ready passes through) when no .devloops file exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-unmanaged-bridge-"));
  try {
    const { exec, calls } = createFakeGitExec(tempDir);
    const hook = createPostMergeUpdateHook({ exec });
    const { ctx } = createUiCalls();

    const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: tempDir }, ctx);

    assert.equal(result, undefined, "no .devloops file means inManagedContext false, pass through");
    assert.equal(
      calls.some((c) => c.command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")),
      false,
      "the guard must not run the draft-gate script when the bridge resolves inManagedContext false",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("defaultResolveRepoContext fails closed when the remote-url lookup rejects in a managed context", async () => {
  // Regression (#2194 Copilot round-2): a rejected/thrown `exec` (timeout, spawn failure) on
  // `git config --get remote.origin.url` must not bubble past `defaultResolveRepoContext` — that
  // would make `resolveRepoContextSafe` return `null` for the WHOLE context (repoRoot included),
  // which fails OPEN (onUserBash passes the command through) even though repoRoot and
  // inManagedContext were already resolved. It must instead return
  // `{ repoRoot, repoSlug: null, inManagedContext }` so the guard still applies.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-remote-lookup-reject-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "{}\n");
    const gateCalls = [];
    const exec = async (command, options = {}) => {
      if (command === "git rev-parse --show-toplevel") {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "", killed: false };
      }
      if (command === "git config --get remote.origin.url") {
        throw new Error("spawn ETIMEDOUT");
      }
      if (command.startsWith("node scripts/loop/pre-pr-ready-gate.mjs")) {
        gateCalls.push({ command, cwd: options.cwd });
        return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "no clean draft_gate evidence" }), killed: false };
      }
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    };
    const hook = createPostMergeUpdateHook({ exec });
    const { ctx } = createUiCalls();

    const result = await hook.onUserBash({ command: "gh pr ready 42", cwd: tempDir }, ctx);

    assert.equal(
      gateCalls.length,
      1,
      "a rejected remote-url lookup in a managed context must still run the draft-gate guard (fail closed), not pass through",
    );
    assert.deepEqual(result, {
      result: {
        output: "gh pr ready blocked: no clean draft_gate evidence",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AC3b: a non-managed cwd (no .devloops config) always passes gh pr ready/merge through", async () => {
  const readyCalls = [];
  const readyHook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets", inManagedContext: false }),
    runCommand: async ({ command, cwd }) => {
      readyCalls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const { ctx } = createUiCalls();

  const readyResult = await readyHook.onUserBash({ command: "gh pr ready 42", cwd: "/repo" }, ctx);
  assert.equal(readyResult, undefined);
  assert.equal(readyCalls.length, 0);

  const mergeCalls = [];
  const mergeHook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: "acme/widgets", inManagedContext: false }),
    runCommand: async ({ command, cwd }) => {
      mergeCalls.push({ command, cwd });
      return { code: 0, stdout: "ok", stderr: "", killed: false };
    },
  });
  const mergeResult = await mergeHook.onUserBash({ command: "gh pr merge 42", cwd: "/repo" }, ctx);
  assert.equal(mergeResult, undefined);
  assert.equal(mergeCalls.length, 0);
});
