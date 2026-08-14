import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

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
import { buildMainCheckoutFastForwardCommand, buildWorktreeCleanupCommand } from "../packages/core/src/loop/main-checkout-ff.mjs";

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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
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
    { command: buildMainCheckoutFastForwardCommand("/repo"), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildWorktreeCleanupCommand("/repo", 373), cwd: "/repo" },
  ]);
  assert.deepEqual(notifications, [
    { message: `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: `Post-merge update completed: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: `Post-merge main-checkout fast-forward running: ${buildMainCheckoutFastForwardCommand("/repo")}`, level: "info" },
    { message: "Post-merge main-checkout fast-forward completed: local main advanced to origin/main", level: "info" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
  ]);
  assert.equal(hook.getState().pendingPostMergeUpdate, false);

  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(calls.length, 5);
});

test("successful user_bash git merge queues and flushes one update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git merge origin/main") {
        return { code: 0, stdout: "Already up to date.", stderr: "", killed: false };
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
    { command: buildMainCheckoutFastForwardCommand("/repo"), cwd: "/repo" },
  ]);
});

test("failed merge commands do not trigger the post-merge update", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
      return { repoRoot: cwd, repoSlug: TARGET_REPO_SLUG };
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
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
    { command: buildMainCheckoutFastForwardCommand("/repo"), cwd: "/repo" },
    { command: "git worktree list", cwd: "/repo" },
    { command: buildWorktreeCleanupCommand("/repo", 373), cwd: "/repo" },
  ]);
});

test("update failure is warning-only and leaves the session healthy", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    { message: `Post-merge main-checkout fast-forward running: ${buildMainCheckoutFastForwardCommand("/repo")}`, level: "info" },
    { message: "Post-merge main-checkout fast-forward skipped (warning only): permission denied", level: "warning" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
    { message: "Post-merge worktree cleanup skipped (warning only): permission denied", level: "warning" },
  ]);
});


test("killed post-merge updates surface a clear warning message", async () => {
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
  });
  const { ctx, notifications } = createUiCalls();

  await hook.onToolResult({ toolName: "bash", input: { command: "gh pr merge 373" }, isError: false }, ctx);
  await hook.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(notifications, [
    { message: `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, level: "info" },
    { message: "Post-merge update failed (warning only): command was killed before completing", level: "warning" },
    { message: `Post-merge main-checkout fast-forward running: ${buildMainCheckoutFastForwardCommand("/repo")}`, level: "info" },
    { message: "Post-merge main-checkout fast-forward skipped (warning only): command was killed before completing", level: "warning" },
    { message: "Post-merge worktree cleanup running for PR #373", level: "info" },
  ]);
});

test("onAgentEnd fast-forwards the resolved main checkout to origin/main (#1596)", async () => {
  const calls = [];
  const hook = createPostMergeUpdateHook({
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/main/checkout  deadbeef [main]\n/repo  cafebabe [feature]\n", stderr: "", killed: false };
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

  const ffCall = calls.find((c) => c.command === buildMainCheckoutFastForwardCommand("/main/checkout"));
  assert.deepEqual(ffCall, { command: buildMainCheckoutFastForwardCommand("/main/checkout"), cwd: "/main/checkout" });

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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
    runCommand: async ({ command, cwd }) => {
      calls.push({ command, cwd });
      if (command === "git worktree list") {
        return { code: 0, stdout: "/main/checkout  deadbeef [main]\n", stderr: "", killed: false };
      }
      if (command === buildMainCheckoutFastForwardCommand("/main/checkout")) {
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
  assert.ok(
    notifications.some((n) => n.level === "warning" && n.message.includes("skipped (warning only)")),
    "expected a warning notification for the non-fast-forwardable checkout",
  );
});

test("session_start resets post-merge hook state and extension registers lifecycle listeners", async () => {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dev-loops-post-merge-home-"));
  process.env.HOME = tempHome;

  try {
    const pi = createPiDouble();
    const hook = createPostMergeUpdateHook({
      resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
    resolveRepoContext: async (cwd) => ({ repoRoot: cwd, repoSlug: TARGET_REPO_SLUG }),
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
