// Claude PreToolUse Bash gate: this suite drives the REAL hook script (the harness
// `test/loop/fixer-pull-line-hook.test.mjs` mirrors). The hook holds no command list of its own: the
// shared `decideBashGate` and the token rules in the hook decide every command, and a deny the decider
// implements must be reachable from the hook.
// Covered here:
//   - `ADR-TRIPWIRE-STANDING-WAIVER`: raw `gh pr edit` body writes and `gh api` body writes to
//     `pulls/<n>`/`issues/<n>`, including either shape behind any process wrapper, which the
//     whole-command token rule (`gh`, `pr`, `edit|create` and a body flag, or `gh`, `api` and a body
//     field or `--input`) reads without a wrapper parser;
//   - the `timeout N <sanctioned command>` wrapper;
//   - `OPERATOR-OWNED-LINE`: raw comment and review writes, denied with the comment reason;
//   - one fixture per deny branch of `decideBashGate`, asserting the hook returns the decider's result.
// Each deny applies to EVERY Claude actor, so it is asserted for the operator/main-agent payload
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

const bash = (cwd, command, agentType, extraEnv) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: { ...env(), ...extraEnv } });
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

// Each command has its own timeout budget while retaining the complete actor matrix.
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
  // A wrapper prefix must not hide the shape. The hook has no wrapper parser:
  // the whole-command token rule reads every token, so any wrapper spelling reaches the deny.
  "timeout 300 gh pr edit 5 --body-file waiver.md",
  // An unplaceable wrapper option or duration changes nothing: the token rule ignores the wrapper.
  "env -P /usr/bin gh pr edit 5 --body x",
  "exec -a n gh pr edit 5 --body x",
  "sudo -r x gh pr edit 5 --body x",
  "sudo -t x gh pr edit 5 --body x",
  "xargs -d , gh pr edit 5 --body x",
  "timeout inf gh pr edit 5 --body x",
  "env -S 'gh pr edit 5 --body x'",
  "env -S 'timeout 30 gh pr edit 5 --body x'",
  "env -S 'sudo -n gh pr edit 5 --body x'",
  "GH pr edit 5 --body x",
  "sudo GH api -X PATCH repos/o/r/pulls/5 -f body=x",
  "env -S 'A=1' timeout 30 gh pr edit 5 --body x",
  "env -S timeout 30 gh pr edit 5 --body x",
  "env -S'gh pr edit 5 --body x'",
  "env --split-string='gh pr edit 5 --body x'",
  "env -S'gh api -X PATCH repos/o/r/pulls/5 -f body=x'",
  "env --split-string='gh api -X PATCH repos/o/r/pulls/5 -f body=x'",
  "env --split-string='gh api -X PATCH repos/o/r/issues/5 --field body=x'",
  "env -S 'gh api -X PATCH repos/o/r/pulls/5 -f body=x'",
  "setsid gh pr edit 5 --body x",
  "stdbuf -oL gh pr edit 5 --body x",
  "ionice -c3 gh pr edit 5 --body x",
  "timeout 300 gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "timeout -k 5 60 gh api -X PATCH repos/o/r/issues/5 --input body.json",
  "FOO=1 timeout 60 gh pr edit 5 --body x",
  "/usr/bin/timeout 60 gh api repos/o/r/pulls/5 --field body=x",
  "sudo gh pr edit 5 --body 'text with an adr-tripwire:allow line'",
  "sudo -n gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  // Separate option values must be consumed before later wrapper options are read.
  "sudo -u root gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "sudo -u root -n gh pr edit 5 --body-file waiver.md",
  "sudo -u root -n gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  ...["&&", "||", ";", "|", "&", "\n"].flatMap((separator) => [
    `cd . ${separator} timeout 30 gh pr edit 5 --body x`,
    `cd . ${separator} sudo -u root -n gh api -X PATCH repos/o/r/pulls/5 -f body=x`,
  ]),
  "nice -n 5 gh pr edit 5 --body x",
  // Whole-command deny: any order, any body-flag spelling, print and quoted forms included.
  "gh -R o/r pr edit 5 --body x",
  "gh pr -R o/r edit 5 --body x",
  "{gh,x} pr edit 5 --body x",
  "gh pr {edit,view} 5 --body x",
  "gh pr edit 5 --{body,x} y",
  "${G:-gh} pr edit 5 --body x",
  "${G-gh} pr edit 5 --body x",
  "gh pr edit 5 -bx",
  "gh pr edit 5 -b=x",
  "gh pr edit 5 -Fwaiver.md",
  "gh pr edit 5 -db x",
  "echo gh pr edit 5 --body x | sh",
  "echo gh pr edit 5 --body x",
  "printf '%s' 'cd . && timeout 30 gh pr edit 5 --body x'",
  "sudo -n echo gh pr edit 5 --body x",
  "setsid -f gh pr edit 5 --body x",
  "stdbuf -oL gh pr create --body x",
  "ionice -c3 gh pr edit 5 -F waiver.md",
  "setsid gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "stdbuf -oL gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "stdbuf -o L gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "ionice -c 3 gh api -X PATCH repos/o/r/issues/5 --field body=x",
  "setsid -f gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "env -i gh pr edit 5 --body-file f",
  "time -p gh api -X PATCH repos/o/r/issues/5 --field body=x",
  "x=$(gh pr edit 5 --body x)",
  "echo $(gh pr edit 5 --body x)",
  "`echo gh` pr edit 5 --body x",
  "/usr/bin/gh pr -R o/r edit 5 --body x",
  // The gh api token rule: any wrapper, any order, any body field spelling.
  "sudo -i gh pr edit 5 --body x",
  "caffeinate gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "doas gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "chrt 1 gh api -X PATCH repos/o/r/pulls/5 --input f.json",
  "env -iSgh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "env -iS'gh api -X PATCH repos/o/r/pulls/5 -f body=x'",
  "env -P /usr/bin gh api -X PATCH repos/o/r/pulls/5 -f body=x",
  "gh api -X PATCH repos/o/r/pulls/5 -F body=@f.md",
  "gh api -X PATCH repos/o/r/pulls/5 --raw-field body=x",
  "gh api -X PATCH repos/o/r/pulls/5 -fbody=x",
  "gh api -f body=x -X PATCH repos/o/r/pulls/5",
  // The graphql body-write token rule: gh, api, graphql and updatePullRequest/updateIssue/body.
  "sudo gh api graphql -f query=mutation{updatePullRequest}",
  "gh api graphql -f query='mutation{updatePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
  "gh api graphql -f query=mutation{updateIssue}",
  "caffeinate gh api graphql -f query='mutation{u:updatePullRequest(input:{pullRequestId:\"x\",body:\"y\"}){clientMutationId}}'",
  "sudo gh api graphql -f query='mutation{a:updateIssue(input:{id:\"x\",body:\"y\"}){clientMutationId}}'",
  // A comma-less group nested in a comma group still expands.
  "gh pr edit 5 --bo{dy,x{y}} hello",
  "gh pr edit 5 --{body,x{y}} hello",
]) {
  test(`PR/issue body write is denied for every Claude actor: ${command}`, async () => {
    await withManagedRepo(async (root) => {
      denyForEveryActor(root, command, /ADR-TRIPWIRE-STANDING-WAIVER/);
    });
  });
}

test("non-body writes and reads remain allowed", async () => {
  await withManagedRepo(async (root) => {
    // Naming the shapes must not turn the token rules into a blanket deny: a read that merely
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
      "gh pr view 5",
      "env -S'gh pr view 5'",
      "setsid gh pr view 5",
      "gh pr list",
      "gh issue view 5",
      "timeout inf echo hi",
      "command -v gh",
      "command -v jq",
      "command -v jq >/dev/null && echo ok",
      "command -v bun && bun --version",
      "command -v bun >/dev/null && bun run x",
      "nice -5 make",
      "env - ls",
      "echo {a}",
      "exec -a x true",
      "env -P /usr/bin echo hi",
      "env -x gh pr view 5",
      "sudo -i ls",
      "nice -10 ls",
      "xargs -d x echo hi",
      "echo {a} {x,y}",
      "gh api repos/o/r/pulls/5",
      "gh api graphql -f query='query{viewer{login}}'",
      "gh api graphql -F query=@q.graphql",
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
  // Neither deny is a local command boundary: outside a dev-loops-managed repo the hook must
  // keep allowing them, or this change would widen the gate beyond its rule scope.
  await withRepo(async (root) => {
    for (const command of [bodyWrite, timeoutWrap, "gh pr edit 5 --body x"]) {
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

test("the token-rule deny names both sanctioned launcher routes", async () => {
  await withManagedRepo(async (root) => {
    const { decision, reason } = bash(root, "stdbuf -oL gh pr create --body x", undefined);
    assert.equal(decision, "deny");
    assert.match(reason, /ADR-TRIPWIRE-STANDING-WAIVER/);
    assert.match(reason, /cli\/index\.mjs pr create/);
    assert.match(reason, /cli\/index\.mjs pr edit/);
  });
});

test("the sanctioned writer is denied when its title holds the word gh (known false positive)", async () => {
  await withManagedRepo(async (root) => {
    const { decision, reason } = bash(root, "dev-loops-run cli/index.mjs pr create --title 'fix(gh): x' --body-file f.md", undefined);
    assert.equal(decision, "deny");
    assert.match(reason, /ADR-TRIPWIRE-STANDING-WAIVER/);
    assert.match(reason, /rephrase the title/);
  });
});

test("an unclosed brace followed by a long comma run is decided fast and denies", async () => {
  await withManagedRepo(async (root) => {
    const started = Date.now();
    const { decision } = bash(root, `echo 'x{${",".repeat(400000)}'; gh pr edit 5 --body x`, undefined);
    assert.equal(decision, "deny");
    assert.ok(Date.now() - started < 10000, "the brace scan must be linear");
  });
});

test("a 64-way prefix with a huge final group denies before allocating the alternatives", async () => {
  await withManagedRepo(async (root) => {
    const started = Date.now();
    const { decision } = bash(root, `echo ${"{a,b}".repeat(6)}{${",".repeat(2500000)}}; gh pr edit 5 --body x`, undefined);
    assert.equal(decision, "deny");
    assert.ok(Date.now() - started < 10000, "the cap must hold before allocation");
  });
});

test("a word with many brace groups is decided fast and fails closed", async () => {
  await withManagedRepo(async (root) => {
    const groups = "{a,b,c}".repeat(25);
    const json = `[${Array.from({ length: 30 }, () => '{"a":1,"b":2}').join(",")}]`;
    for (const command of [
      `echo '${groups}'; gh pr edit 5 --body x`,
      `echo ${"{a,b}".repeat(30)}; git stash`,
      `gh api repos/o/r/issues/5/comments -f body='${json}'`,
    ]) {
      const started = Date.now();
      const { decision, reason } = bash(root, command, undefined);
      assert.equal(decision, "deny", command);
      if (command.startsWith("gh api")) assert.match(reason, /launcher command read it/, "an over-cap deny names a usable exit");
      assert.ok(Date.now() - started < 10000, `${command.slice(0, 40)} must decide quickly`);
    }
  });
});

test("a quoted body-write word inside a command substitution still denies", async () => {
  await withManagedRepo(async (root) => {
    for (const command of [
      'echo $(gh pr "edit" 5 --body x)',
      'echo $(gh api repos/o/r/pulls/5 -f "body=x")',
      'echo "$(echo $(gh pr "edit" 5 --body x))"',
      'echo $(gh pr ed"it" 5 --body x)',
      'echo `gh pr edit 5 --body x`',
      'gh api repos/o/r/issues/5 -f "body=x"',
      "timeout 5 gh pr $'\\x65dit' 5 --body x",
      "echo $(gh pr $'\\145dit' 5 --body x)",
      "echo `gh pr $'\\x65dit' 5 --body x`",
      "echo `gh pr $'\\\\x65dit' 5 --body x`",
      "sudo gh api -X PATCH repos/o/r/pulls/5 --{field,raw-field}=body=x",
    ]) {
      assert.equal(bash(root, command, undefined).decision, "deny", command);
    }
  });
});

// Raw comment and review writes (`OPERATOR-OWNED-LINE`): the sanctioned writers refuse an
// operator-owned line, a raw write does not, so the token rule denies the write for every actor.
const MERGE_APPROVAL = "approve merge 0123456789abcdef0123456789abcdef01234567";
const COMMENT_ACTORS = [undefined, "developer", "dev-loop", "fixer"];
const COMMENT_WRITES = [
  ...["--body", "-b", "--body-file", "-F"].flatMap((flag) => [`gh pr comment 5 ${flag} '${MERGE_APPROVAL}'`, `gh issue comment 5 ${flag} '${MERGE_APPROVAL}'`]),
  `sh -c "gh pr comment 5 --body '${MERGE_APPROVAL}'"`,
  `bash -c 'gh issue comment 5 -b "${MERGE_APPROVAL}"'`,
  `echo $(gh pr comment 5 --body '${MERGE_APPROVAL}')`,
  `for n in 5 6; do gh pr comment $n --body '${MERGE_APPROVAL}'; done`,
  `timeout 60 gh pr comment 5 --body '${MERGE_APPROVAL}'`,
  `env GH_TOKEN=x gh pr comment 5 -F note.md`,
  "gh pr review 5 --comment -b 'x'",
  "gh pr review 5 --comment --body-file note.md",
  `sh -c "gh pr review 5 --comment -b '${MERGE_APPROVAL}'"`,
  "gh issue close 5 --comment x",
  "gh issue reopen 5 -c x",
  "gh pr close 5 -c x",
  "gh pr reopen 5 --comment x",
  "gh issue close 5 -cx",
  "gh pr reopen 5 -c'text'",
  "gh pr close 5 -dc x",
  `sh -c "gh issue close 5 -c x"`,
  // GH_EDITOR can supply the body through the editor flag.
  'GH_EDITOR="cp body.md" gh pr comment 5 -e',
  "gh issue comment 5 --editor",
  "gh issue comment 5 --edit-last",
  `gh api graphql -f query='mutation { addComment(input: {subjectId: "X", body: "${MERGE_APPROVAL}"}) { clientMutationId } }'`,
  `sh -c "gh api graphql -f query='mutation { addComment(input: {subjectId: \\"X\\", body: \\"x\\"}) { clientMutationId } }'"`,
  "gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: \"X\"}) { clientMutationId } }'",
  // The REST forms stay denied (by the body-write token rule).
  `sh -c "gh api repos/o/r/issues/5/comments -f body=x"`,
  `sh -c "gh api -X PATCH repos/o/r/issues/comments/9 -f body=x"`,
  `sh -c "gh api repos/o/r/issues/5/comments --input f.json"`,
];
for (const command of COMMENT_WRITES) {
  test(`raw comment or review write is denied for the main agent and subagents: ${command}`, async () => {
    await withManagedRepo(async (root) => {
      for (const agentType of COMMENT_ACTORS) {
        const { decision, reason } = bash(root, command, agentType);
        assert.equal(decision, "deny", `${command} as ${agentType ?? "main agent"}`);
        if (!command.includes("repos/o/r")) assert.match(reason, /OPERATOR-OWNED-LINE[\s\S]*comment-issue\.mjs/, `${command} as ${agentType ?? "main agent"}`);
      }
    });
  });
}

test("sanctioned comment writers and reads stay allowed; an unmanaged repo is unchanged", async () => {
  await withManagedRepo(async (root) => {
    for (const command of [
      "dev-loops-run scripts/github/comment-issue.mjs --repo o/r --issue 5 --body-file x.md",
      "node scripts/github/edit-comment.mjs --repo o/r --comment-id 9 --body-file x.md",
      "gh pr view 5 --json comments",
      "gh issue close 5",
      'sh -c "gh issue close 5"',
      "gh issue close 5 --reason completed",
      "git status",
    ]) {
      for (const agentType of [undefined, "developer"]) assert.equal(bash(root, command, agentType).decision, "allow", command);
    }
  });
  await withRepo(async (root) => {
    assert.equal(bash(root, "gh pr comment 5 --body x", undefined).decision, "allow");
  }, { managed: false });
});

test("a payload without a command string reaches the single allow", async () => {
  await withManagedRepo(async (root) => {
    const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: {}, cwd: root }), encoding: "utf8", env: env() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : "allow", "allow");
  });
});

test("the hook entry point holds no second predicate list", () => {
  const source = fs.readFileSync(BASH_HOOK, "utf8");
  const classifierNames = [...source.replace(/\/\*\*[\s\S]*?\*\//, "").matchAll(/\bcommandContains\w+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(classifierNames)], ["commandContainsGhPrMerge"]);
  const allows = [...source.matchAll(/emitAllow\(\)/g)];
  assert.equal(allows.length, 1);
  assert.ok(source.trimEnd().endsWith("emitAllow();"));
  assert.ok(allows[0].index > source.indexOf("decideBashGate(bashGateFacts)"));
});

// Every deny branch of `decideBashGate` must be reachable from the hook: the hook's reason equals the
// decider's reason for the same facts.
const DENY_BRANCHES = {
  judge: ["ls", "judge"],
  "fixer pull line": ["cd x && dev-loops-run scripts/github/pull-work-order.mjs f1-0123abcd", "fixer"],
  "coordinator verify": ["bun test", "dev-loop", { DEVLOOPS_COORDINATOR_READONLY: "1" }],
  "coordinator verify (gate-coordinator)": ["bun test", "gate-coordinator", { DEVLOOPS_COORDINATOR_READONLY: "1" }],
  "inline interpreter": ["python3 -c 'print(1)'"],
  "detached wait": ["nohup sleep 5 &"],
  "timeout wrapper": ["timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo o/r --pr 5"],
  "sub-issue write": ["gh api -X POST repos/o/r/issues/5/sub_issues -F sub_issue_id=9"],
  "reply/resolve bypass": ["gh api -X POST repos/o/r/pulls/5/comments/9/replies -f body=x"],
  "copilot request bypass": ["gh api -X POST repos/o/r/pulls/5/requested_reviewers -f 'reviewers[]=copilot'"],
  "raw body write": ["gh pr edit 5 --body-file x.md"],
  "git stash": ["git stash"],
  "subagent raw external write": ["gh issue create --title x", "developer"],
  "gh pr create": ["gh pr create --title x"],
  "gh pr ready": ["gh pr ready 5"],
  "gh pr ready without a number": ["gh pr ready"],
  "gh pr merge without a number": ["gh pr merge", undefined, undefined, { humanMergeOnly: false }],
  "raw merge bypass": ["gh pr merge 5 --squash", undefined, undefined, { humanMergeOnly: false }],
  "graphql resolveReviewThread": ["gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"x\"}){clientMutationId}}'"],
  "human-merge-only merge": ["gh pr merge 5 --squash"],
  "unresolve owner allowlist": ["dev-loops-run scripts/github/unresolve-review-thread.mjs --pr 5", "developer"],
};
for (const [branch, [command, agentType, extraEnv, { humanMergeOnly = branch === "human-merge-only merge" } = {}]] of Object.entries(DENY_BRANCHES)) {
  test(`decideBashGate deny branch is reachable from the hook: ${branch}`, async () => {
    const { decideBashGate } = await import(path.resolve(".claude/hooks/_hook-decisions.mjs"));
    await withManagedRepo(async (root) => {
      if (/merge/.test(command) && !humanMergeOnly) fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: false\n", "utf8");
      const expected = decideBashGate({
        command, agentType: agentType ?? null, inManagedContext: true,
        enforceCoordinator: extraEnv?.DEVLOOPS_COORDINATOR_READONLY === "1", humanMergeOnly,
      });
      assert.equal(expected.decision, "deny", `decider must deny ${command}`);
      assert.deepEqual(bash(root, command, agentType, extraEnv), expected);
    });
  });
}
