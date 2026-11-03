// Claude PreToolUse Bash gate (`ADR-TRIPWIRE-STANDING-WAIVER`): the hook owns an allow-by-default
// non-match path — a command shape its quick pre-check list does not name reaches `emitAllow()` and exits
// before the shared `decideBashGate` ever runs. A deny the decider implements is therefore
// UNREACHABLE on Claude, and fails open, until the pre-check nominates its shape.
//
// This suite drives the REAL hook script (the harness `test/loop/fixer-pull-line-hook.test.mjs`
// mirrors) for the two actor-independent denies the pre-check used to leave unnamed:
//   - `ADR-TRIPWIRE-STANDING-WAIVER`: raw `gh pr edit` body writes and `gh api` body writes to
//     `pulls/<n>`/`issues/<n>` — including either shape behind a `timeout`/`sudo`/`nice`/`time`/
//     path-prefix wrapper, whose own options must not hide the command head from the pre-check
//     (the hook reads the wrapper-unwrapped head beside the raw one, `unwrappedCommandHeads`) — and
//   - the `timeout N <sanctioned command>` wrapper.
// Both apply to EVERY Claude actor, so each is asserted for the operator/main-agent payload
// (Claude exposes `agent_type` only inside a subagent, so its absence IS the main agent) and for
// every worker role.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
// Strip `GIT_DIR`/`GIT_WORK_TREE` (the hook resolves the repo root itself) and this repo's own
// `DEVLOOPS_COORDINATOR_READONLY`, which its `.claude/settings.json` sets for its own sessions, so
// the actor matrix below is the only thing that scopes a deny.
const env = () => {
  const base = runIdFreeEnv({ GIT_DIR: undefined, GIT_WORK_TREE: undefined });
  delete base.DEVLOOPS_COORDINATOR_READONLY;
  return base;
};

const bash = (cwd, command, agentType) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: env() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withRepo(fn, { managed = true, remote = null } = {}) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, env: env() });
    if (managed) fs.writeFileSync(path.join(root, ".devloops"), "version: 1\n", "utf8");
    await fn(root);
  }, { prefix: "dev-loops-bash-gate-hook-" });
}
const withManagedRepo = (fn) => withRepo(fn, { managed: true });

// `undefined` is the operator/main agent; the rest are the roles Claude reports in a subagent.
// `judge` is deliberately absent: its own read-only boundary denies every command before any rule
// below runs, with a different message, so the rule-message assertion could never hold for it.
const ACTORS = [undefined, "developer", "docs", "fixer", "quality", "refiner", "review", "dev-loop", "gate-coordinator"];

const denyForEveryActor = (root, command, reason) => {
  for (const agentType of ACTORS) {
    const actor = agentType === undefined ? "operator/main agent" : agentType;
    const { decision, reason: actual } = bash(root, command, agentType);
    assert.equal(decision, "deny", `${command} as ${actor} must be denied`);
    assert.match(actual, reason, `${command} as ${actor} must carry that rule's own deny message`);
  }
};

test("raw gh pr edit and gh api PR/issue body writes are denied for every Claude actor", async () => {
  await withManagedRepo(async (root) => {
    // Every `gh pr edit` body form the hook header names is pinned here — the short `-b`/`-F`
    // flags as well as the long ones — together with the two API forms beyond a plain body
    // field (an `--input` payload and a `gh api graphql` `updatePullRequest`), so the header
    // cannot drift from what the nominated predicate denies.
    for (const command of [
      "gh pr edit 5 --body-file waiver.md",
      "gh pr edit 5 --body 'text with an adr-tripwire:allow line'",
      "gh pr edit 5 -b 'text with an adr-tripwire:allow line'",
      "gh pr edit 5 -F waiver.md",
      "gh api -X PATCH repos/o/r/pulls/5 -f body=x",
      "gh api -X PATCH repos/o/r/issues/5 --field body=x",
      "gh api -X PATCH repos/o/r/pulls/5 --input body.json",
      "gh api graphql -f query=mutation{updatePullRequest}",
      // A wrapper prefix must not hide the shape from the pre-check: the shared `SHELL_EXEC_PREFIX`
      // tolerates env-assignment / `command` / `env` / path prefixes but no wrapper, so the hook
      // reads the wrapper-unwrapped head beside the raw one. Without that, the nominate-then-decide
      // path fails open on the wrapped form of a shape the pre-check already names. The wrapper
      // options are spelled out per wrapper, because a `timeout` duration and a `nice -n N` level
      // are the only wrapper arguments that are not flags.
      "timeout 300 gh pr edit 5 --body-file waiver.md",
      "timeout 300 gh api -X PATCH repos/o/r/pulls/5 -f body=x",
      "timeout -k 5 60 gh api -X PATCH repos/o/r/issues/5 --input body.json",
      "FOO=1 timeout 60 gh pr edit 5 --body x",
      "/usr/bin/timeout 60 gh api repos/o/r/pulls/5 --field body=x",
      "sudo gh pr edit 5 --body 'text with an adr-tripwire:allow line'",
      "sudo -n gh api -X PATCH repos/o/r/pulls/5 -f body=x",
      // A wrapper flag's own value sits exactly where a boolean flag leaves the command, so
      // `sudo -u root gh …` must be read through the one head past the unwrapped one.
      "sudo -u root gh api -X PATCH repos/o/r/pulls/5 -f body=x",
      "nice -n 5 gh pr edit 5 --body x",
      "time -p gh api -X PATCH repos/o/r/issues/5 --field body=x",
    ]) {
      denyForEveryActor(root, command, /ADR-TRIPWIRE-STANDING-WAIVER/);
    }
    // Naming the shapes must not turn the pre-check into a blanket deny: a read that merely
    // mentions a body, the sanctioned launcher writer, and the wrapper prefix in front of either
    // still pass through. (A wrapped *sanctioned* command is a separate deny, owned by the
    // `timeout N <sanctioned command>` rule, so it is asserted in the suite below.)
    for (const command of [
      "grep -n body README.md",
      "dev-loops-run cli/index.mjs pr edit --body-file waiver.md",
      "timeout 30 gh pr edit 5 --add-label needs-review",
      "timeout 30 gh api repos/o/r/pulls/5",
      "nice -n 5 gh pr edit 5 --add-label needs-review",
      "time -p gh pr view 5 --json body",
    ]) {
      assert.equal(bash(root, command, undefined).decision, "allow", command);
    }
  });
});

test("timeout-wrapped sanctioned commands are denied for every Claude actor", async () => {
  await withManagedRepo(async (root) => {
    const command = "timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo acme/widgets --pr 5";
    denyForEveryActor(root, command, /Do not wrap sanctioned dev-loops commands in `timeout N`/);
    // The bare form still reaches the decider: the wrapper is the deny, not the sanctioned script.
    assert.equal(bash(root, "dev-loops-run scripts/github/merge-pr.mjs --repo acme/widgets --pr 5", undefined).decision, "allow");
  });
});

test("both denies stay scoped to a managed repo, and the resolved-slug API form is covered", async () => {
  const bodyWrite = "gh api -X PATCH repos/acme/widgets/pulls/5 -f body=x";
  const timeoutWrap = "timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo acme/widgets --pr 5";
  // Neither deny is a local command boundary: outside a dev-loops-managed repo the pre-check must
  // keep allowing them, or this change would widen the gate beyond its rule scope.
  await withRepo(async (root) => {
    for (const command of [bodyWrite, timeoutWrap]) {
      assert.equal(bash(root, command, undefined).decision, "allow", command);
    }
  }, { managed: false });
  // With the cwd repo's identity resolved, the API half matches through the resolved slug rather
  // than the null-slug wildcard the remote-less fixtures exercise.
  await withRepo(
    async (root) => {
      denyForEveryActor(root, bodyWrite, /ADR-TRIPWIRE-STANDING-WAIVER/);
    },
    { remote: "git@github.com:acme/widgets.git" },
  );
});
