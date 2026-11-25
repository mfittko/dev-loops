// PRE-PUSH-DELTA-PUSH-AUTHORITY in harness-neutral tooling: resolve-pr-conflicts.mjs runs this check before a base merge, so
// Pi and Claude Code share it; agent type plays no part.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { clearSequenceMarker, findActiveSequence, recoveryHint, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { installDefaultBranchGuard } from "@dev-loops/core/loop/default-branch-guard";
import { checkFixPushAuthority, parsePushedShas } from "../../scripts/loop/check-fix-push-authority.mjs";
import { DELTA_CLEARING_NEXT_STEPS, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { closeGateSequence, fixerGraceMs } from "../../scripts/loop/close-gate-sequence.mjs";
import { withTempDir } from "../_helpers.mjs";

const FIXER_GRACE_MS = fixerGraceMs();

// GIT_CONFIG_* isolate the tests from the developer's global and system git config (a url.insteadOf rewrite changes `git remote get-url origin`).
const isolatedGitConfig = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, ...isolatedGitConfig };

async function withRepo(fn) {
  // The in-process checkFixPushAuthority git calls read process.env, so isolate it for the test and restore it.
  const saved = Object.fromEntries(Object.keys(isolatedGitConfig).map((k) => [k, process.env[k]]));
  Object.assign(process.env, isolatedGitConfig);
  try { await withRepoIsolated(fn); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

async function withRepoIsolated(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, env, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    await fn(root, git("rev-parse", "HEAD").trim(), git);
  }, { prefix: "dev-loops-fix-push-authority-" });
}

test("no marker allows the push", async () => {
  await withRepo((root) => assert.deepEqual(checkFixPushAuthority(root), { ok: true }));
});

test("an active ungranted marker refuses, a granted marker allows, a descendant head stays covered", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    assert.equal(checkFixPushAuthority(root).ok, false);
    git("commit", "-q", "--allow-empty", "-m", "fix");
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, fullGranted: true });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
  });
});

test("the CLI exits 1 while a sequence is ungranted", async () => {
  await withRepo((root, head) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    const run = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
  });
});

test("pushed shas come from git's stdin lines; deletions are skipped and a malformed line throws", () => {
  const a = "a".repeat(40);
  assert.deepEqual(parsePushedShas(`refs/heads/b ${a} refs/heads/b ${"0".repeat(40)}\nrefs/heads/c ${"0".repeat(40)} refs/heads/c ${a}\n`), [a]);
  assert.deepEqual(parsePushedShas(""), []);
  assert.throws(() => parsePushedShas("not a push line"), /malformed pre-push line/);
  assert.throws(() => parsePushedShas(`refs/heads/b zzz refs/heads/b ${a}`), /malformed pre-push line/);
});

test("the guarded sha is refused when pushed from a checkout whose HEAD is elsewhere", async () => {
  await withRepo(async (root, head, git) => {
    git("branch", "fix");
    git("checkout", "-q", "--orphan", "other");
    git("commit", "-q", "--allow-empty", "-m", "elsewhere");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true }, "HEAD is not under the baseline");
    assert.equal(checkFixPushAuthority(root, [head]).ok, false);
    const lines = `refs/heads/fix ${head} refs/heads/fix ${"0".repeat(40)}\n`;
    const run = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8", input: lines });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
    assert.match(run.stderr, /ensure-worktree/);
    const malformed = spawnSync("node", [path.resolve("scripts/loop/check-fix-push-authority.mjs")], { cwd: root, env, encoding: "utf8", input: "garbage\n" });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /fail closed/);
  });
});

test("only the PR branch's remote ref ends the sequence; a stacked remote ref of another branch does not", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a" });
    git("commit", "-q", "--allow-empty", "-m", "stacked");
    const stacked = git("rev-parse", "HEAD").trim();
    git("update-ref", "refs/remotes/origin/issue-b", stacked);
    assert.equal(checkFixPushAuthority(root, [stacked]).ok, false, "a stacked origin/issue-b does not end the sequence of issue-a");
    git("update-ref", "refs/remotes/origin/issue-a", stacked);
    assert.deepEqual(checkFixPushAuthority(root, [stacked]), { ok: true }, "the PR branch's own remote ref advanced");
  });
});

test("the refusal names the no-commit close command with the baseline head, and never marker deletion (ADR 0218)", async () => {
  await withRepo(async (root, head) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a" });
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, new RegExp(`check-pre-push-delta\\.mjs \\(--act-list <act-list> --findings-log <findings-log> \\| --threads-file <threads-file> --repo <owner/name> --pr <n>\\) --baseline ${head} .*--fixer-plan <fixer-plan> --site-coverage <handback>.*no_commit`));
    assert.doesNotMatch(refused.reason, /delete the marker|delet/i);
    assert.match(refused.reason, /dev-loops-run cli\/index\.mjs gate close-sequence --head <baseline sha> --repo <owner\/name> --pr <number>/);
    assert.doesNotMatch(refused.reason, /close-gate-sequence\.mjs/);
    clearSequenceMarker(path.join(root, "tmp"), head);
    assert.deepEqual(checkFixPushAuthority(root), { ok: true }, "a cleared marker (a commit_only round without a fix commit) guards nothing");
  });
});

test("the refusal for a marker that names no branch does not name the no-commit close or deletion, and points to the rule", async () => {
  await withRepo(async (root, head) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    for (const mutate of [() => {}, () => writeFileSync(file, "{not json")]) {
      mutate();
      const refused = checkFixPushAuthority(root);
      assert.equal(refused.ok, false);
      assert.doesNotMatch(refused.reason, /check-pre-push-delta|delet/i);
      assert.match(refused.reason, /names no branch.*PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery/);
    }
  });
});

test("a marker that names no branch is not ended by a remote ref (fail closed)", async () => {
  await withRepo(async (root, head, git) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    git("commit", "-q", "--allow-empty", "-m", "next");
    git("update-ref", "refs/remotes/origin/any", git("rev-parse", "HEAD").trim());
    assert.equal(checkFixPushAuthority(root).ok, false);
    writeFileSync(file, "{not json");
    assert.equal(checkFixPushAuthority(root).ok, false, "a malformed marker keeps guarding");
  });
});

test("a merge-base failure other than 'not an ancestor' refuses instead of dropping the marker", async () => {
  await withRepo((root, head) => {
    const file = writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    const refused = checkFixPushAuthority(root, ["b".repeat(40)]);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(file), refused.reason);
  });
});

test("a force-push of a non-descendant sha to the marked branch is refused; another branch is not", async () => {
  await withRepo(async (root, head, git) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a" });
    git("checkout", "-q", "--orphan", "rewritten");
    git("commit", "-q", "--allow-empty", "-m", "rewrite");
    const rewritten = git("rev-parse", "HEAD").trim();
    assert.equal(checkFixPushAuthority(root, [{ sha: rewritten, remoteRef: "refs/heads/issue-a" }]).ok, false);
    assert.deepEqual(checkFixPushAuthority(root, [{ sha: rewritten, remoteRef: "refs/heads/issue-b" }]), { ok: true });
  });
});

// END-TO-END REGRESSION (#2999): the lockout was a refusal with no agent remedy; close-sequence is the remedy.
test("END-TO-END REGRESSION abandoned sequence lockout: refused, close-sequence, then the same push is allowed", async () => {
  const feat = async (oid) => ({ pr: { headRefOid: oid, headRefName: "feat" } });
  for (const scenario of ["head moved", "work order never pulled"]) {
    await withRepo(async (root, head) => {
      const tmpRoot = path.join(root, "tmp");
      const execution = { executionIdentity: "f1-abcd1234", workOrderRef: "fixer:o/r#7:head:f1-abcd1234", outputRef: path.join(root, "out.json") };
      writeSequenceMarker({ tmpRoot, baselineHead: head, branch: "feat", execution });
      const refused = checkFixPushAuthority(root);
      assert.equal(refused.ok, false, `${scenario}: the pre-fix lockout`);
      const moved = scenario === "head moved";
      const closed = await closeGateSequence({ tmpRoot, head, repo: "o/r", pr: 7, actor: "t", fetchPr: () => feat(moved ? "b".repeat(40) : head), now: () => Date.now() + (moved ? 0 : FIXER_GRACE_MS + 1000) });
      assert.equal(closed.ok, true, `${scenario}: ${closed.reason}`);
      assert.deepEqual(checkFixPushAuthority(root), { ok: true }, `${scenario}: the same push is allowed after the close`);
    });
  }
});

test("recoveryHint renders the close command only for a 40 or 64 char lowercase hex baseline head", () => {
  for (const ok of ["a".repeat(40), "0123456789abcdef".repeat(4)]) assert.match(recoveryHint(ok, "/m", "issue-a"), new RegExp(`check-pre-push-delta\\.mjs .*--baseline ${ok} `));
  for (const bad of ["A".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(40) + "; rm -rf /", "$(id)", "a".repeat(63), ""]) {
    const hint = recoveryHint(bad, "/m", "issue-a");
    assert.doesNotMatch(hint, /check-pre-push-delta/, bad);
    assert.match(hint, /PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery/);
    assert.match(hint, /sequence marker is \/m/);
  }
});

// #3252: a marker is scoped to the repo its execution work order ref names.
const ABSENT = `${"0".repeat(39)}1`;
const executionFor = (repo, baseline) => ({ executionIdentity: "f1-abcdef12", workOrderRef: `fixer:${repo}#1:${baseline}:f1-abcdef12`, outputRef: "out.json" });

test("another repo's marker with a baseline absent from this checkout does not block the push", async () => {
  await withRepo(async (root, _head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
  });
});

test("a same-repo marker with a baseline absent from this checkout still fails closed", async () => {
  await withRepo(async (root, _head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-a", execution: executionFor("O/A", ABSENT) });
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(`${ABSENT}.sequence`));
  });
});

test("the refusal names only the pushing repo's marker", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    const tmpRoot = path.join(root, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    writeSequenceMarker({ tmpRoot, baselineHead: head, branch: "issue-a", execution: executionFor("o/a", head) });
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(`${head}.sequence`));
    assert.ok(!refused.reason.includes(`${ABSENT}.sequence`));
  });
});

test("the foreign marker is skipped whatever the listing order (stubbed order, strict isAncestor)", async () => {
  await withRepo(async (root, head) => {
    const tmpRoot = path.join(root, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    writeSequenceMarker({ tmpRoot, baselineHead: head, branch: "issue-a", execution: executionFor("o/a", head) });
    const found = findActiveSequence({
      tmpRoot, head, repo: "o/a", baselinePresent: (b) => b !== ABSENT,
      listBaselines: () => [ABSENT, head],
      isAncestor: (a) => { if (a === ABSENT) throw new Error("foreign baseline must not be tested"); return true; },
      remoteAdvanced: () => false,
    });
    assert.equal(found.baselineHead, head);
  });
});

test("a fork checkout (origin slug differs) with the baseline present still refuses", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/me/a.git");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, branch: "issue-a", execution: executionFor("o/a", head) });
    assert.equal(checkFixPushAuthority(root).ok, false);
  });
});

test("a foreign-repo marker with an absent baseline refuses when the checkout has no detectable origin", async () => {
  await withRepo(async (root) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    assert.equal(checkFixPushAuthority(root).ok, false);
  });
});

for (const bad of ["garbage1", "own er/name", "a/b/c"]) {
  test(`a malformed repo segment ${JSON.stringify(bad)} with an absent baseline refuses`, async () => {
    await withRepo(async (root, _head, git) => {
      git("remote", "add", "origin", "https://github.com/o/a.git");
      writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-b", execution: executionFor(bad, ABSENT) });
      assert.equal(checkFixPushAuthority(root).ok, false);
    });
  });
}

// Hook-style pushes: remoteRef is set and the push URL is the CLI's second argument (git's pre-push argument order).
test("hook-style push to the marker's branch name: another repo's marker with an absent baseline does not block it; the marker's own repo does", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-x", execution: executionFor("o/b", ABSENT) });
    const push = [{ sha: head, remoteRef: "refs/heads/issue-x" }];
    assert.deepEqual(checkFixPushAuthority(root, push), { ok: true }, "origin repo o/a differs from marker repo o/b");
    assert.deepEqual(checkFixPushAuthority(root, push, "https://github.com/o/a.git"), { ok: true }, "push URL repo o/a differs from marker repo o/b");
    const refused = checkFixPushAuthority(root, push, "git@github.com:o/b.git");
    assert.equal(refused.ok, false, "the push URL names the marker's repo, so the existing rules keep refusing");
    assert.ok(refused.reason.includes(`${ABSENT}.sequence`));
    assert.deepEqual(checkFixPushAuthority(root, [{ sha: head, remoteRef: "refs/heads/issue-c" }], "git@github.com:o/b.git"), { ok: true }, "another branch of the marker's repo is skipped by the branch rule");
  });
});

test("the push URL repo wins over origin; a non-GitHub push URL falls back to origin", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/o/b.git"); // origin is the marker's repo
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-x", execution: executionFor("o/b", ABSENT) });
    const push = [{ sha: head, remoteRef: "refs/heads/issue-x" }];
    assert.deepEqual(checkFixPushAuthority(root, push, "https://github.com/o/a.git"), { ok: true });
    assert.equal(checkFixPushAuthority(root, push, "https://gitlab.example/o/a.git").ok, false, "origin o/b equals the marker repo");
    assert.equal(checkFixPushAuthority(root, push).ok, false);
  });
});

test("the CLI reads the push URL from the hook's second argument", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/o/b.git");
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: ABSENT, branch: "issue-x", execution: executionFor("o/b", ABSENT) });
    const input = `refs/heads/issue-x ${head} refs/heads/issue-x ${"0".repeat(40)}\n`;
    const cli = path.resolve("scripts/loop/check-fix-push-authority.mjs");
    assert.equal(spawnSync("node", [cli, "origin", "https://github.com/o/a.git"], { cwd: root, env, encoding: "utf8", input }).status, 0);
    assert.equal(spawnSync("node", [cli, "origin", "https://github.com/o/b.git"], { cwd: root, env, encoding: "utf8", input }).status, 1);
  });
});

test("a failed baseline probe refuses instead of reading the baseline as absent (fail closed)", async () => {
  await withRepo(async (root, head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    const tmpRoot = path.join(root, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    const probeFails = { tmpRoot, head, repo: "o/a", baselinePresent: () => { throw new Error("git failure"); }, listBaselines: () => [ABSENT], isAncestor: () => false, remoteAdvanced: () => false };
    assert.equal(findActiveSequence(probeFails)?.baselineHead, ABSENT, "the ungranted marker is returned so the refusal names it");
    // The real probe returns false only for exit status 1 (missing object): the absent baseline is skipped.
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
  });
});

test("a failed baseline probe skips a fullGranted marker and a marker of another branch", async () => {
  await withRepo(async (root, head) => {
    const tmpRoot = path.join(root, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: ABSENT, branch: "issue-b", fullGranted: true, execution: executionFor("o/b", ABSENT) });
    const input = { tmpRoot, head, repo: "o/a", baselinePresent: () => { throw new Error("git failure"); }, listBaselines: () => [ABSENT], isAncestor: () => false, remoteAdvanced: () => false };
    assert.equal(findActiveSequence(input), null, "granted marker");
    writeSequenceMarker({ tmpRoot, baselineHead: ABSENT, branch: "issue-b", execution: executionFor("o/b", ABSENT) });
    assert.equal(findActiveSequence({ ...input, remoteRef: "refs/heads/issue-a" }), null, "the branch rule skips the marker before the probe runs");
  });
});

test("the real probe failing (64-hex baseline in a SHA-1 checkout) refuses under an ungranted marker with its path and allows a granted one", async () => {
  await withRepo(async (root, _head, git) => {
    git("remote", "add", "origin", "https://github.com/o/a.git");
    const tmpRoot = path.join(root, "tmp");
    const sha256Baseline = "a".repeat(64);
    writeSequenceMarker({ tmpRoot, baselineHead: sha256Baseline, branch: "issue-b", execution: executionFor("o/b", sha256Baseline) });
    const refused = checkFixPushAuthority(root);
    assert.equal(refused.ok, false);
    assert.ok(refused.reason.includes(`${sha256Baseline}.sequence`));
    writeSequenceMarker({ tmpRoot, baselineHead: sha256Baseline, branch: "issue-b", fullGranted: true, execution: executionFor("o/b", sha256Baseline) });
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
  });
});

// ADR 0323: the deadlock state of issue 3579 has an exit. The pre-push hook refuses no push, the push ends the sequence, and the next full gate round reviews the fix commit.
test("DEADLOCK 3579: an open sequence with a non-clearing sealed delta no longer blocks the push; the push ends the sequence", async () => {
  await withRepo(async (root, baseline, git) => {
    const remote = path.join(path.dirname(root), "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "-b", "feat");
    const tmpRoot = path.join(root, "tmp");
    writeSequenceMarker({ tmpRoot, baselineHead: baseline, branch: "feat" });
    writeSealedGateDeltaRecord(tmpRoot, baseline, {
      reviewBaselineHead: baseline, candidateHead: baseline, actSetId: "a", invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview",
      items: [{ id: "deferred-1", status: "not_resolved" }],
    });
    writeFileSync(path.join(root, "fix.txt"), "fix\n");
    git("add", "fix.txt");
    git("commit", "-q", "-m", "fix");
    const guard = installDefaultBranchGuard({ gitDir: path.join(root, ".git"), defaultBranches: "main" });
    assert.equal(guard.ok, true);
    const push = spawnSync("git", ["push", "origin", "feat"], { cwd: root, env, encoding: "utf8" });
    assert.equal(push.status, 0, push.stderr);
    assert.deepEqual(checkFixPushAuthority(root), { ok: true });
    assert.match(git("diff", "--name-only", "origin/main...HEAD"), /fix\.txt/);
    assert.ok(!DELTA_CLEARING_NEXT_STEPS.includes("fix_and_rereview"));
  });
});
