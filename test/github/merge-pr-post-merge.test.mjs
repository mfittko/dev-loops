import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergePr, main } from "../../scripts/github/merge-pr.mjs";
import { captureStream, initGitFixture } from "../_helpers.mjs";

// Post-merge steps run by merge-pr.mjs against real temp git repos (a bare
// origin, a main checkout, a linked worktree under tmp/worktrees/dev-loops/),
// with a stubbed gh runtime.

const ORIGIN_URL = "https://github.com/mfittko/dev-loops.git";
const MERGE_COMMIT = "aaaa1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const BRANCH = "issue-7";
const OPTIONS = { repo: "mfittko/dev-loops", pr: 7, humanApprovedBy: "mfittko", method: "squash", stableRelease: false, standingAuthorization: true };
const MARKER = "action-ran.txt";

// Host git config (for example a global pushInsteadOf) must not reach fixture git.
const FIXTURE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: FIXTURE_GIT_ENV }).trim();
}

// A bare origin, a main checkout on `main`, and a linked worktree
// tmp/worktrees/dev-loops/issue-7 on branch issue-7. `behind` pushes one more
// commit to origin/main so the main checkout's local main lags it. `actions`
// declares postMerge.actions in the main checkout's .devloops; there is no
// scripts/ dir.
function makeRepo({ behind = true, actions = null } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "merge-post-")));
  const origin = path.join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: FIXTURE_GIT_ENV });
  const mainCheckout = path.join(base, "main");
  mkdirSync(mainCheckout);
  initGitFixture(mainCheckout, { branch: "main", remote: origin });
  git(mainCheckout, ["push", "-q", "-u", "origin", "main"]); // origin still is the bare path here
  // origin names the --repo slug; insteadOf routes it to the local bare repo.
  git(mainCheckout, ["remote", "set-url", "origin", ORIGIN_URL]);
  git(mainCheckout, ["config", `url.${origin}.insteadOf`, ORIGIN_URL]);
  const worktree = path.join(mainCheckout, "tmp/worktrees/dev-loops/issue-7");
  git(mainCheckout, ["worktree", "add", "-q", "-b", BRANCH, worktree]);
  if (behind) {
    git(worktree, ["commit", "-q", "--allow-empty", "-m", "merged work"]);
    git(worktree, ["push", "-q", origin, `${BRANCH}:main`]);
  }
  if (actions) {
    const lines = ["version: 1", "postMerge:", "  actions:"];
    for (const { name, run } of actions) lines.push(`    - name: ${name}`, `      run: ${run}`);
    writeFileSync(path.join(mainCheckout, ".devloops"), `${lines.join("\n")}\n`);
  }
  return { base, mainCheckout, worktree, origin };
}

const localMain = (repo) => git(repo.mainCheckout, ["rev-parse", "refs/heads/main"]);
const originMain = (repo) => git(repo.origin, ["rev-parse", "refs/heads/main"]);
const listed = (repo) => git(repo.mainCheckout, ["worktree", "list", "--porcelain"]);

// The PR head is the worktree's HEAD, so the cleanup's head-SHA match holds.
function makeRuntime(repo, { prView = {}, mergeCode = 0, postMergeState = "MERGED", postMergeSteps } = {}) {
  const head = git(repo.worktree, ["rev-parse", "HEAD"]);
  const view = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    title: "fix: post-merge steps",
    headRefOid: head,
    headRefName: BRANCH,
    url: "https://github.com/mfittko/dev-loops/pull/7",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...prView,
  };
  const runtime = {
    env: process.env,
    cwd: repo.worktree,
    ghJson: async (args) => {
      if (args.join(" ").includes("/pulls/") || args.join(" ").includes("/issues/")) return [];
      if (args.includes("mergeCommit,state")) return { mergeCommit: { oid: MERGE_COMMIT }, state: postMergeState };
      return view;
    },
    runChild: async (cmd, args) => (args[0] === "pr" && args[1] === "merge"
      ? { stdout: "", stderr: mergeCode ? "merge blocked" : "", code: mergeCode }
      : { stdout: "", stderr: "", code: 0 }),
    detectEvidence: async () => ({ ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], currentHeadSha: head }),
    loadConfig: async () => ({ config: { autonomy: { humanMergeOnly: false }, refinement: { maxCopilotRounds: 0 } }, errors: [] }),
  };
  if (postMergeSteps) runtime.postMergeSteps = postMergeSteps;
  return runtime;
}

function withRepo(opts, fn) {
  return async () => {
    const repo = makeRepo(opts);
    try {
      await fn(repo);
    } finally {
      rmSync(repo.base, { recursive: true, force: true });
    }
  };
}

test("AC1: a successful merge removes the linked worktree holding the head branch", withRepo({}, async (repo) => {
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(existsSync(repo.worktree), false, "the worktree dir is gone");
  assert.ok(!listed(repo).includes(repo.worktree), "git worktree list no longer lists it");
  assert.deepEqual(result.postMerge.worktreeCleanup, { ok: true, removed: repo.worktree, reason: "removed" });
}));

test("AC2: a successful merge fast-forwards the main checkout's local main to origin/main", withRepo({}, async (repo) => {
  assert.notEqual(localMain(repo), originMain(repo), "precondition: local main is behind");
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.postMerge.fastForward.status, "fast_forwarded");
  assert.equal(localMain(repo), originMain(repo));
}));

test("AC2: a main checkout on another branch reports not_on_main with its diagnostic and changes no ref", withRepo({}, async (repo) => {
  git(repo.mainCheckout, ["switch", "-q", "-c", "side"]);
  const mainBefore = localMain(repo);
  const sideBefore = git(repo.mainCheckout, ["rev-parse", "refs/heads/side"]);
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  const { fastForward } = result.postMerge;
  assert.equal(fastForward.status, "not_on_main");
  assert.match(fastForward.diagnostic.message, /main_checkout_not_on_main/);
  assert.match(fastForward.diagnostic.message, /is on side, 1 commit\(s\) behind/);
  assert.equal(localMain(repo), mainBefore);
  assert.equal(git(repo.mainCheckout, ["rev-parse", "refs/heads/side"]), sideBefore);
}));

test("AC3: the repo's postMerge.actions run in a checkout without scripts/", withRepo({ actions: [{ name: "touch-marker", run: `touch ${MARKER}` }] }, async (repo) => {
  assert.equal(existsSync(path.join(repo.mainCheckout, "scripts")), false);
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.ok(existsSync(path.join(repo.mainCheckout, MARKER)), "the action ran in the main checkout");
  assert.equal(result.postMerge.actions.ok, true);
  assert.deepEqual(result.postMerge.actions.results, [{ name: "touch-marker", status: "ok", detail: null }]);
}));

test("AC3: a repo with no declared actions produces an empty result and no error", withRepo({}, async (repo) => {
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.deepEqual(result.postMerge.actions, { ok: true, results: [] });
}));

const NOT_MERGED_CASES = [
  { name: "refused merge (precondition failure)", overrides: { prView: { mergeable: "CONFLICTING" } }, error: /Merge preconditions not satisfied/ },
  { name: "failed gh pr merge", overrides: { mergeCode: 1 }, error: /gh pr merge did not succeed/ },
  { name: "non-MERGED postcondition", overrides: { postMergeState: "OPEN" }, error: /not MERGED/ },
];

for (const { name, overrides, error } of NOT_MERGED_CASES) {
  test(`AC5: ${name} never calls a post-merge step`, withRepo({ actions: [{ name: "touch-marker", run: `touch ${MARKER}` }] }, async (repo) => {
    const calls = [];
    const spy = (step) => async () => { calls.push(step); return null; };
    const postMergeSteps = { fastForward: spy("fastForward"), worktreeCleanup: spy("worktreeCleanup"), actions: spy("actions") };
    await assert.rejects(mergePr(OPTIONS, makeRuntime(repo, { ...overrides, postMergeSteps })), error);
    assert.deepEqual(calls, []);
  }));

  test(`AC5: ${name} leaves the worktree, main ref, and actions untouched`, withRepo({ actions: [{ name: "touch-marker", run: `touch ${MARKER}` }] }, async (repo) => {
    const mainBefore = localMain(repo);
    await assert.rejects(mergePr(OPTIONS, makeRuntime(repo, overrides)), error);
    assert.ok(existsSync(repo.worktree));
    assert.ok(listed(repo).includes(repo.worktree));
    assert.equal(localMain(repo), mainBefore);
    assert.equal(existsSync(path.join(repo.mainCheckout, MARKER)), false);
  }));
}

const ACTIONS = [{ name: "touch-marker", run: `touch ${MARKER}` }];

test("AC6: a fast-forward git error is recorded and the other steps still run", withRepo({ actions: ACTIONS }, async (repo) => {
  renameSync(repo.origin, `${repo.origin}.gone`);
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.postMerge.fastForward.status, "skipped");
  assert.ok(result.postMerge.fastForward.reason.length > 0);
  assert.equal(result.postMerge.worktreeCleanup.removed, repo.worktree);
  assert.ok(existsSync(path.join(repo.mainCheckout, MARKER)));
}));

test("AC6: a cleanup git error is recorded and the other steps still run", withRepo({ actions: ACTIONS }, async (repo) => {
  git(repo.mainCheckout, ["worktree", "lock", repo.worktree]);
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.postMerge.worktreeCleanup.removed, null);
  assert.match(result.postMerge.worktreeCleanup.reason, /git error/);
  assert.ok(existsSync(repo.worktree));
  assert.equal(result.postMerge.fastForward.status, "fast_forwarded");
  assert.ok(existsSync(path.join(repo.mainCheckout, MARKER)));
}));

test("AC6: a failing action is recorded and the other steps still run", withRepo({ actions: [{ name: "boom", run: "exit 3" }] }, async (repo) => {
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.postMerge.actions.ok, false);
  assert.equal(result.postMerge.actions.results[0].status, "failed");
  assert.equal(result.postMerge.fastForward.status, "fast_forwarded");
  assert.equal(result.postMerge.worktreeCleanup.removed, repo.worktree);
}));

test("AC6: a thrown step records its reason, later steps still run, and the CLI exits 0", withRepo({}, async (repo) => {
  const boom = (label) => async () => { throw new Error(`${label} exploded`); };
  const postMergeSteps = { fastForward: boom("ff"), worktreeCleanup: boom("cleanup"), actions: boom("actions") };
  const stdout = captureStream();
  const code = await main(
    ["--repo", OPTIONS.repo, "--pr", String(OPTIONS.pr), "--human-approved-by", "mfittko", "--standing-authorization"],
    { ...makeRuntime(repo, { postMergeSteps }), stdout },
  );
  assert.equal(code, 0);
  const result = JSON.parse(stdout.get());
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.deepEqual(result.postMerge, {
    fastForward: { status: "skipped", reason: "ff exploded" },
    worktreeCleanup: { ok: false, removed: null, reason: "cleanup exploded" },
    actions: { ok: false, results: [], reason: "actions exploded" },
  });
}));

test("the steps run in the hooks' order against the main checkout with the head branch", withRepo({}, async (repo) => {
  const calls = [];
  const spy = (step) => async (context) => { calls.push({ step, context }); return null; };
  await mergePr(OPTIONS, makeRuntime(repo, { postMergeSteps: { fastForward: spy("fastForward"), worktreeCleanup: spy("worktreeCleanup"), actions: spy("actions") } }));
  assert.deepEqual(calls.map((c) => c.step), ["fastForward", "worktreeCleanup", "actions"]);
  for (const { context } of calls) {
    assert.equal(realpathSync(context.mainCheckout), repo.mainCheckout, "resolved from the linked worktree cwd");
    assert.equal(context.branch, BRANCH);
    assert.equal(context.pr, OPTIONS.pr);
    assert.equal(context.repo, OPTIONS.repo);
    assert.equal(context.headSha, git(repo.worktree, ["rev-parse", "HEAD"]));
  }
}));

test("the merge is recorded on stderr before any post-merge step runs", withRepo({}, async (repo) => {
  const stderr = captureStream();
  const seen = [];
  const spy = () => async () => { seen.push(stderr.get()); return null; };
  const runtime = makeRuntime(repo, { postMergeSteps: { fastForward: spy(), worktreeCleanup: spy(), actions: spy() } });
  await mergePr(OPTIONS, { ...runtime, stderr });
  assert.equal(seen.length, 3);
  assert.match(seen[0], new RegExp(`merged ${OPTIONS.repo}#${OPTIONS.pr} \\(merge commit ${MERGE_COMMIT}\\)`));
}));

const STEP_NAMES = ["fastForward", "worktreeCleanup", "actions"];
const reasons = (postMerge) => STEP_NAMES.map((name) => postMerge[name].reason);

test("a worktree HEAD past the merged head (unpushed commits) is kept", withRepo({}, async (repo) => {
  const runtime = makeRuntime(repo);
  git(repo.worktree, ["commit", "-q", "--allow-empty", "-m", "unpushed"]);
  const result = await mergePr(OPTIONS, runtime);
  assert.equal(result.postMerge.worktreeCleanup.removed, null);
  assert.match(result.postMerge.worktreeCleanup.reason, /does not match the merged head/);
  assert.ok(existsSync(repo.worktree));
}));

for (const [label, arrange, pattern] of [
  ["an origin naming another repo", (repo) => git(repo.mainCheckout, ["remote", "set-url", "origin", "https://github.com/someone/else.git"]), /has origin someone\/else, not --repo mfittko\/dev-loops/],
  ["no origin remote", (repo) => git(repo.mainCheckout, ["remote", "remove", "origin"]), /no readable origin remote/],
]) {
  test(`${label} skips every step, injected or default, with a reason`, withRepo({ actions: ACTIONS }, async (repo) => {
    arrange(repo);
    const calls = [];
    const result = await mergePr(OPTIONS, makeRuntime(repo, { postMergeSteps: { actions: async () => { calls.push("actions"); return null; } } }));
    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    for (const reason of reasons(result.postMerge)) assert.match(reason, pattern);
    assert.deepEqual(calls, []);
    assert.ok(existsSync(repo.worktree));
    assert.equal(existsSync(path.join(repo.mainCheckout, MARKER)), false);
  }));
}

test("an SSH host-alias origin naming --repo still runs the post-merge steps", withRepo({}, async (repo) => {
  const alias = "git@github-work:mfittko/dev-loops.git";
  git(repo.mainCheckout, ["remote", "set-url", "origin", alias]);
  git(repo.mainCheckout, ["config", `url.${repo.origin}.insteadOf`, alias]);
  const result = await mergePr(OPTIONS, makeRuntime(repo));
  assert.equal(result.postMerge.worktreeCleanup.removed, repo.worktree);
  assert.equal(localMain(repo), originMain(repo));
}));

test("in test mode the default steps refuse a main checkout outside the tmp dir; injected steps still run", withRepo({}, async (repo) => {
  const saved = process.env.TMPDIR;
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "merge-post-elsewhere-")));
  const mainBefore = localMain(repo);
  try {
    process.env.TMPDIR = elsewhere;
    const calls = [];
    const result = await mergePr(OPTIONS, makeRuntime(repo, { postMergeSteps: { actions: async () => { calls.push("actions"); return { ok: true, results: [] }; } } }));
    assert.match(result.postMerge.fastForward.reason, /test mode/);
    assert.match(result.postMerge.worktreeCleanup.reason, /test mode/);
    assert.deepEqual(calls, ["actions"]);
    assert.ok(existsSync(repo.worktree));
    assert.equal(localMain(repo), mainBefore);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(elsewhere, { recursive: true, force: true });
  }
}));

test("the cleanup keeps the worktree the merge runs from", withRepo({}, async (repo) => {
  const saved = process.cwd();
  try {
    process.chdir(repo.worktree);
    const result = await mergePr(OPTIONS, makeRuntime(repo));
    assert.equal(result.postMerge.worktreeCleanup.removed, null);
    assert.match(result.postMerge.worktreeCleanup.reason, /is inside/);
    assert.ok(existsSync(repo.worktree));
  } finally {
    process.chdir(saved);
  }
}));

test("a merged PR without a reported head branch skips the cleanup with a reason", withRepo({}, async (repo) => {
  const result = await mergePr(OPTIONS, makeRuntime(repo, { prView: { headRefName: "" } }));
  assert.deepEqual(result.postMerge.worktreeCleanup, { ok: true, removed: null, reason: "skipped: the merged PR reported no head branch" });
  assert.ok(existsSync(repo.worktree));
}));
