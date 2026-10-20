import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildDevLoopHandoffEnvelope, CANONICAL_SPEC_SOURCE } from "@dev-loops/core/loop/handoff-envelope";
import { loadDevLoopConfigStrict } from "@dev-loops/core/config";
import { buildCoordinatorWorkOrder } from "@dev-loops/core/loop/coordinator-work-order";
import { REFINEMENT_ARTIFACT_SPEC_SOURCE } from "@dev-loops/core/loop/pr-gate-coordination";
import { buildPlanFilePromotionMarker } from "@dev-loops/core/loop/plan-file-promote-contract";
import { gitEnvNoDirOverrides } from "../../scripts/loop/_repo-root-resolver.mjs";
import { loadRefinementArtifact } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { DEFAULT_TEST_PR_BODY, initGitFixture, resolverTestEnv, runGitFixture, runNode, writeGhStub } from "../_helpers.mjs";

const root = path.resolve(".");
const cli = path.join(root, "cli/index.mjs");
const builder = path.join(root, "scripts/loop/build-handoff-envelope.mjs");
const emitter = path.join(root, "scripts/loop/emit-coordinator-work-order.mjs");
const puller = path.join(root, "scripts/github/pull-work-order.mjs");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

async function fixture(fn, { directory = "tmp/worktrees/dev-loops/issue-2588" } = {}) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "pr-worktree-binding-")));
  const main = path.join(temp, "main");
  await mkdir(main);
  initGitFixture(main, { branch: "main", remote: "https://github.com/o/r.git" });
  const checkout = path.join(main, directory);
  runGitFixture(main, ["worktree", "add", "-q", "-b", "issue-2588", checkout]);
  const pr = {
    number: 2848, state: "OPEN", isDraft: true, mergedAt: null,
    headRefName: "issue-2588", headRefOid: runGitFixture(main, ["rev-parse", "HEAD"]),
    headRepository: { name: "r" }, headRepositoryOwner: { login: "o" },
    url: "https://github.com/o/r/pull/2848", author: { login: "mfittko" },
    assignees: [{ login: "mfittko" }], closingIssuesReferences: [], body: DEFAULT_TEST_PR_BODY,
  };
  const bin = path.join(temp, "bin");
  await mkdir(bin);
  const stub = await writeGhStub(bin, [{ stdout: JSON.stringify(pr) }], { repeatLastOnOverflow: true });
  const env = { ...stub.env, ...resolverTestEnv() };
  const input = path.join(temp, "startup.json");
  const startup = await runNode(cli, ["loop", "startup", "--pr", "2848", "--no-reconcile"], { cwd: checkout, env });
  assert.equal(startup.code, 0, startup.stderr);
  const resolved = JSON.parse(startup.stdout);
  assert.equal(resolved.selectedStrategy, "copilot_pr_followup");
  assert.equal(resolved.draftStart.reviewGate, "draft_gate");
  await writeFile(input, startup.stdout);
  const build = (extra = {}) => runNode(builder, ["--input", input, "--repo", "o/r"], { cwd: main, env, ...extra });
  const emit = (harness = "codex", extra = {}) => runNode(emitter, ["--input", input, "--repo", "o/r", "--harness", harness, "--entry", "direct"], { cwd: main, env, ...extra });
  const changePr = async (changes) => writeFile(stub.sequencePath, JSON.stringify([{ stdout: JSON.stringify({ ...pr, ...changes }) }]));
  try {
    await fn({ temp, main, checkout, input, env, pr, resolved, build, emit, changePr, bin, stub });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("real startup, envelope, MAIN emission and CLI pull preserve the PR route for every harness", async () => {
  await fixture(async (f) => {
    const result = await f.build();
    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const settings = (await loadDevLoopConfigStrict({ repoRoot: f.main })).config;
    const expected = buildDevLoopHandoffEnvelope(f.resolved, settings, {}, { repoSlug: "o/r", repoRoot: f.main });
    assert.equal(envelope.cwd, f.checkout);
    assert.deepEqual(envelope.target, { kind: "pr", repo: "o/r", pr: 2848 });
    assert.equal(envelope.nextAction, f.resolved.bundle.nextAction);
    assert.match(envelope.nextAction, /existing draft: a valid start target/);
    assert.match(envelope.nextAction, /gate-coordination --repo o\/r --pr 2848/);
    assert.deepEqual(envelope.stopRules, expected.stopRules);
    assert.deepEqual(envelope.requiredReads, expected.requiredReads);
    const authority = await loadRefinementArtifact({ repo: "o/r", prData: f.pr, prDraft: true });
    assert.equal(authority.status, "present");
    assert.equal(authority.specSource, REFINEMENT_ARTIFACT_SPEC_SOURCE.PR_BODY);
    assert.equal(authority.finding, null);
    assert.deepEqual(authority.acItems, ["covered by the test"]);
    assert.deepEqual(authority.dodItems, ["tests pass"]);
    assert.equal(envelope.specSource, CANONICAL_SPEC_SOURCE.PR_BODY);
    const { derivedAt } = envelope.gateState;
    assert.ok(!Number.isNaN(Date.parse(derivedAt)));
    const expectedHandoff = buildCoordinatorWorkOrder({ envelope }).workOrder.handoff;
    for (const harness of ["pi", "claude", "codex"]) {
      const emission = await f.emit(harness);
      assert.equal(emission.code, 0, emission.stderr);
      const out = JSON.parse(emission.stdout);
      const plan = JSON.parse(await readFile(out.planPath, "utf8"));
      assert.deepEqual(plan.workOrder.handoff, expectedHandoff);
      if (harness === "codex") {
        assert.deepEqual(plan.workOrder.codexBootstrap.cwd, { processCwd: f.main, repositoryRoot: f.main, branch: "main" });
        for (const contract of plan.workOrder.codexBootstrap.contracts) {
          assert.equal(contract.digest, createHash("sha256").update(await readFile(contract.absolutePath)).digest("hex"));
        }
      } else assert.equal(Object.hasOwn(plan.workOrder, "codexBootstrap"), false);
      const pulled = await runNode(puller, [out.executionIdentity], { cwd: f.main, env: f.env });
      assert.equal(pulled.code, 0, pulled.stderr);
      assert.equal(pulled.stdout, await readFile(plan.promptPath, "utf8"));
      const wrong = await runNode(puller, ["--ref", out.workOrderRef, "--digest", `sha256:${"0".repeat(64)}`, "--execution", out.executionIdentity], { cwd: f.main, env: f.env });
      assert.notEqual(wrong.code, 0);
    }
    assert.equal(existsSync(path.join(f.main, "tmp/worktrees/dev-loops/pr-2848")), false);
    assert.deepEqual(JSON.parse(await readFile(f.input, "utf8")), f.resolved);
  });
}, 30000);

for (const [label, changes, status, source] of [
  ["invalid live body", { body: "No formal scope." }, "missing", REFINEMENT_ARTIFACT_SPEC_SOURCE.PR_BODY],
  ["unknown ready authority", { isDraft: false }, "unknown", undefined],
  ["promoted plan", { body: `${buildPlanFilePromotionMarker("docs/plans/unit.md")}\n\n${DEFAULT_TEST_PR_BODY}` }, "present", REFINEMENT_ARTIFACT_SPEC_SOURCE.PLAN_FILE],
  ["linked issue", { closingIssuesReferences: [{ number: 900 }] }, "missing", REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE],
]) test(`${label} cannot acquire PR-body authority from the startup snapshot`, async () => {
  await fixture(async (f) => {
    await f.changePr(changes);
    const live = { ...f.pr, ...changes };
    const authority = await loadRefinementArtifact({ repo: "o/r", prData: live,
      prDraft: live.isDraft, prClosed: false, prMerged: false }, { env: f.env });
    assert.equal(authority.status, status);
    assert.equal(authority.specSource, source);
    const built = await f.build();
    assert.equal(built.code, 0, built.stderr);
    const envelope = JSON.parse(built.stdout);
    assert.equal(Object.hasOwn(envelope, "specSource"), false);
    assert.equal(envelope.cwd, f.checkout);
    assert.deepEqual(envelope.target, { kind: "pr", repo: "o/r", pr: 2848 });
    assert.equal(envelope.nextAction, f.resolved.bundle.nextAction);
    assert.deepEqual(JSON.parse(await readFile(f.input, "utf8")), f.resolved);
  });
});

for (const location of ["top", "bundle"]) test(`already bound ${location} authority keeps its precedence`, async () => {
  await fixture(async (f) => {
    const resolved = structuredClone(f.resolved);
    const authority = location === "top" ? resolved : resolved.bundle;
    authority.canonicalSpecSource = CANONICAL_SPEC_SOURCE.PHASE_DOC;
    if (location === "top") resolved.bundle.canonicalSpecSource = CANONICAL_SPEC_SOURCE.PR_BODY;
    await writeFile(f.input, JSON.stringify(resolved));
    const built = await f.build();
    assert.equal(built.code, 0, built.stderr);
    assert.equal(JSON.parse(built.stdout).specSource, CANONICAL_SPEC_SOURCE.PHASE_DOC);
  });
});

for (const directory of ["tmp/worktrees/dev-loops/pr-2848", "../outside-prefix"]) {
  test(`registered PR checkout ${directory} is admitted without a naming convention`, async () => {
    await fixture(async (f) => {
      const result = await f.build();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).cwd, f.checkout);
    }, { directory });
  });
}

test("local committed delivery ahead of the PR and ambient directory overrides do not change binding", async () => {
  await fixture(async (f) => {
    runGitFixture(f.checkout, ["commit", "-q", "--allow-empty", "-m", "local delivery"]);
    const foreign = path.join(f.temp, "foreign");
    await mkdir(foreign);
    initGitFixture(foreign, { branch: "issue-2588", remote: "https://github.com/foreign/r.git" });
    const result = await f.build({ env: { ...f.env, GIT_DIR: path.join(foreign, ".git"), GIT_WORK_TREE: foreign } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).cwd, f.checkout);
    assert.notEqual(runGitFixture(f.checkout, ["rev-parse", "HEAD"]), f.pr.headRefOid);
  });
});

async function refused(f, refusal) {
  const result = await f.emit();
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).refusal, refusal, result.stderr);
  const built = await f.build();
  assert.equal(built.code, 1);
  assert.equal(JSON.parse(built.stderr).refusal, refusal, built.stderr);
  assert.equal(existsSync(path.join(f.main, "tmp/coordinator-work-orders")), false);
  assert.equal(existsSync(path.join(f.main, "tmp/worktrees/dev-loops/pr-2848")), false);
}

for (const kind of ["PR", " pr "]) {
  test(`normalized PR kind ${JSON.stringify(kind)} binds the verified checkout`, async () => {
    await fixture(async (f) => {
      f.resolved.bundle.activeArtifact.kind = kind;
      await writeFile(f.input, JSON.stringify(f.resolved));
      const built = await f.build();
      assert.equal(built.code, 0, built.stderr);
      assert.equal(JSON.parse(built.stdout).cwd, f.checkout);
      const emitted = await f.emit();
      assert.equal(emitted.code, 0, emitted.stderr);
      const plan = JSON.parse(await readFile(JSON.parse(emitted.stdout).planPath, "utf8"));
      assert.equal(plan.workOrder.handoff.cwd, f.checkout);
      assert.equal(existsSync(path.join(f.main, "tmp/worktrees/dev-loops/pr-2848")), false);
    });
  });

  test(`normalized PR kind ${JSON.stringify(kind)} refuses a missing association`, async () => {
    await fixture(async (f) => {
      f.resolved.bundle.activeArtifact.kind = kind;
      await writeFile(f.input, JSON.stringify(f.resolved));
      runGitFixture(f.main, ["worktree", "remove", "--force", f.checkout]);
      await refused(f, "pr_worktree_not_found");
    });
  });
}

for (const [label, changes] of [
  ["fork", { headRepositoryOwner: { login: "foreign" } }],
  ["wrong PR", { number: 999 }],
  ["wrong repository URL", { url: "https://github.com/foreign/r/pull/2848" }],
  ["missing repository", { headRepository: null }],
  ["invalid branch", { headRefName: "bad\nbranch" }],
]) test(`live ${label} facts fail closed`, async () => {
  await fixture(async (f) => { await f.changePr(changes); await refused(f, "pr_worktree_identity_mismatch"); });
});

test("foreign local repository is refused despite the same branch name", async () => {
  await fixture(async (f) => {
    runGitFixture(f.main, ["remote", "set-url", "origin", "https://github.com/foreign/r.git"]);
    await refused(f, "pr_worktree_repository_mismatch");
  });
});

for (const state of ["wrong-branch", "detached", "unregistered-directory"]) test(`${state} never grants association`, async () => {
  await fixture(async (f) => {
    if (state === "wrong-branch") runGitFixture(f.checkout, ["checkout", "-q", "-b", "other"]);
    if (state === "detached") runGitFixture(f.checkout, ["checkout", "-q", "--detach"]);
    if (state === "unregistered-directory") {
      runGitFixture(f.main, ["worktree", "remove", "--force", f.checkout]);
      await mkdir(f.checkout, { recursive: true });
    }
    await refused(f, "pr_worktree_not_found");
  });
});

test("MAIN cannot satisfy an existing PR association", async () => {
  await fixture(async (f) => {
    runGitFixture(f.main, ["worktree", "remove", "--force", f.checkout]);
    runGitFixture(f.main, ["checkout", "-q", "issue-2588"]);
    await refused(f, "pr_worktree_not_found");
  });
});

test("a missing/prunable registered root is refused", async () => {
  await fixture(async (f) => {
    await rename(f.checkout, `${f.checkout}-moved`);
    await refused(f, "pr_worktree_verification_failed");
  });
});

test("a core link escaping the registered checkout retains the isolation refusal", async () => {
  await fixture(async (f) => {
    await mkdir(path.join(f.checkout, "node_modules/@dev-loops"), { recursive: true });
    await mkdir(path.join(f.main, "packages/core"), { recursive: true });
    await mkdir(path.join(f.checkout, "packages/core"), { recursive: true });
    await symlink(path.join(f.main, "packages/core"), path.join(f.checkout, "node_modules/@dev-loops/core"));
    await refused(f, "pr_worktree_not_isolated");
  });
});

// Only malformed/ambiguous Git facts need a stub: all other association checks use real Git.
async function gitListing(f, listing, { fail = false } = {}) {
  const wrapper = path.join(f.bin, "git");
  await writeFile(wrapper, `#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.join(' ') === 'worktree list --porcelain') {
  process.stdout.write(process.env.TEST_WORKTREE_LIST);
  process.exit(process.env.TEST_WORKTREE_FAIL === '1' ? 1 : 0);
}
process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
`);
  await chmod(wrapper, 0o755);
  f.env.TEST_WORKTREE_LIST = listing;
  f.env.TEST_WORKTREE_FAIL = fail ? "1" : "0";
}

test("a linked caller binds despite an unrelated missing registration before it", async () => {
  await fixture(async (f) => {
    await gitListing(f, `worktree ${f.main}\nHEAD ${f.pr.headRefOid}\nbranch refs/heads/main\n\nworktree ${path.join(f.temp, "missing")}\nHEAD ${f.pr.headRefOid}\nbranch refs/heads/unrelated\n\nworktree ${f.checkout}\nHEAD ${f.pr.headRefOid}\nbranch refs/heads/issue-2588\n`);
    const built = await f.build({ cwd: f.checkout });
    assert.equal(built.code, 0, built.stderr);
    assert.equal(JSON.parse(built.stdout).cwd, f.checkout);
  });
});

test("duplicate PR branch registrations refuse before materialization", async () => {
  await fixture(async (f) => {
    const duplicate = path.join(f.main, "tmp/worktrees/dev-loops/duplicate");
    runGitFixture(f.main, ["worktree", "add", "-q", "--force", duplicate, "issue-2588"]);
    await refused(f, "pr_worktree_ambiguous");
  });
});

for (const listing of ["", "garbage\n", "worktree relative\nbranch refs/heads/issue-2588\n", "worktree /missing\n"]) {
  test(`malformed Git registration ${JSON.stringify(listing)} fails closed`, async () => {
    await fixture(async (f) => {
      await gitListing(f, listing);
      await refused(f, "pr_worktree_verification_failed");
    });
  });
}

test("Git listing failure stays typed", async () => {
  await fixture(async (f) => { await gitListing(f, "", { fail: true }); await refused(f, "pr_worktree_verification_failed"); });
});

test("claimed registration is checked against the candidate's actual root/branch/common directory", async () => {
  await fixture(async (f) => {
    const foreign = path.join(f.temp, "foreign");
    await mkdir(foreign);
    initGitFixture(foreign, { branch: "issue-2588", remote: "https://github.com/o/r.git" });
    await gitListing(f, `worktree ${f.main}\nHEAD ${f.pr.headRefOid}\nbranch refs/heads/main\n\nworktree ${foreign}\nHEAD ${f.pr.headRefOid}\nbranch refs/heads/issue-2588\n`);
    await refused(f, "pr_worktree_verification_failed");
  });
});

test("canonical registration paths normalize harmless dot segments and trailing slashes", async () => {
  await fixture(async (f) => {
    const listing = execFileSync(realGit, ["worktree", "list", "--porcelain"], { cwd: f.main, env: gitEnvNoDirOverrides(), encoding: "utf8" });
    await gitListing(f, listing.replace(f.checkout, `${f.checkout}/../issue-2588/`));
    const built = await f.build();
    assert.equal(built.code, 0, built.stderr);
    assert.equal(JSON.parse(built.stdout).cwd, f.checkout);
  });
});

test("live PR read failure refuses before materialization", async () => {
  await fixture(async (f) => {
    await writeFile(f.stub.sequencePath, JSON.stringify([{ code: 1, stderr: "unavailable" }]));
    await refused(f, "pr_worktree_verification_failed");
  });
});

for (const mutation of ["branch", "nested-root"]) test(`claimed registration cannot hide an actual ${mutation} mismatch`, async () => {
  await fixture(async (f) => {
    const listing = execFileSync(realGit, ["worktree", "list", "--porcelain"], { cwd: f.main, encoding: "utf8" });
    if (mutation === "branch") runGitFixture(f.checkout, ["checkout", "-q", "-b", "other"]);
    const nested = path.join(f.checkout, "nested");
    await mkdir(nested);
    await gitListing(f, mutation === "nested-root" ? listing.replace(f.checkout, nested) : listing);
    await refused(f, "pr_worktree_verification_failed");
  });
});

test("a PR reconciliation envelope needs no branch association or live PR read", async () => {
  await fixture(async (f) => {
    const reconcile = { ...f.resolved, bundleKind: "needs_reconcile", selectedStrategy: "none",
      bundle: { ...f.resolved.bundle, bundleKind: "needs_reconcile", routeKind: "needs_reconcile",
      selectedGate: "fail_closed_reconcile", selectedStrategy: null,
      activeArtifact: { kind: "pr", pr: 2848 }, nextAction: "Stop and reconcile missing scope." } };
    await writeFile(f.input, JSON.stringify(reconcile));
    await writeFile(f.stub.sequencePath, JSON.stringify([{ code: 1, stderr: "must not be read" }]));
    const built = await f.build();
    assert.equal(built.code, 0, built.stderr);
    const envelope = JSON.parse(built.stdout);
    assert.equal(envelope.worktreeRequired, false);
    assert.equal(envelope.nextAction, reconcile.bundle.nextAction);
  });
});
