// Fixer work-order pull transport (#2420, ADR 0106): typed sources -> deterministic
// emission -> compact dispatch -> sanctioned pull -> guarded mutation -> checked disposition.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { classifyValidationCommand } from "@dev-loops/core/loop/validation-classify";
import { DISPATCH_POINTER_MAX_BYTES, buildDispatchPointer, pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";
import { assertFixerDispatchPayload, buildFixerDispatchPayload, emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { verifyFixerDisposition } from "../../scripts/github/verify-fixer-disposition.mjs";
import { makeGhMock, runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const EMITTER = path.resolve("scripts/loop/emit-fixer-work-order.mjs");
const PULL = path.resolve("scripts/github/pull-work-order.mjs");
const HOOK = path.resolve(".claude/hooks/pre-tool-use-write-guard.mjs");
const REPO = "o/r";
const PR = 7;
const ACT = [{ severity: "high", angle: "correctness", summary: "null deref", file: "src/a.mjs", line: 3, judgeDisposition: "act" }];
const THREADS = { ok: true, repo: REPO, pr: PR, threads: [{ threadId: "T1", commentId: 1, body: "fix", isResolved: false, isOutdated: false, path: "src/a.mjs", line: 3 }] };

// An inherited GIT_DIR/GIT_WORK_TREE (a git hook of another repo) must not change a decision.
const gitFreeEnv = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitFreeEnv() }).trim();
const refusal = (result) => (assert.equal(result.status, 1, result.stderr), JSON.parse(result.stdout).refusal);
// The fixer runs the dispatch pointer's exact pull line; the Bash gate binds the grant to its agent_id.
const AGENT = "agent-a";
const pullLine = (identity) => /`([^`]+)`/.exec(buildDispatchPointer(identity))[1];
const pull = (unit, cwd, over = {}) => {
  const identity = { workOrderRef: over.ref ?? unit.workOrderRef, workOrderDigest: over.digest ?? unit.workOrderDigest, executionIdentity: over.execution ?? unit.executionIdentity };
  assert.equal(bash(cwd, pullLine(identity), over.agentId ?? AGENT), "allow");
  return spawnSync("node", [PULL, "--ref", identity.workOrderRef, "--digest", identity.workOrderDigest, "--execution", identity.executionIdentity], { cwd, encoding: "utf8", env: gitFreeEnv() });
};
let clock = 1_790_000_000_000;
const nextExecution = () => `f${clock++}-0000abcd`;

// A main checkout on `main` (commit C0) with the PR branch issue-1 at head C1 in a
// linked worktree, plus typed source files under the main checkout's tmp/.
async function withFixture(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    await writeFile(path.join(root, ".gitignore"), "tmp/\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-q", "-m", "c0");
    git(root, "branch", "issue-1");
    const wt = path.join(root, "tmp", "worktrees", "wt");
    git(root, "worktree", "add", "-q", wt, "issue-1");
    git(wt, "commit", "-q", "--allow-empty", "-m", "c1");
    const head = git(wt, "rev-parse", "HEAD");
    const src = path.join(root, "tmp", "src");
    await mkdir(src, { recursive: true });
    const files = { actList: path.join(src, "act.json"), threads: path.join(src, "threads.json"), delta: path.join(src, "delta.json") };
    await writeFile(files.actList, JSON.stringify(ACT));
    await writeFile(files.threads, JSON.stringify(THREADS));
    await writeFile(files.delta, JSON.stringify({ nextStep: "fix_and_rereview", items: [{ ref: 0, status: "not_resolved" }] }));
    const emit = (over = {}) => emitFixerWorkOrder({
      repo: REPO, pr: PR, headSha: head, phase: "full", actListFile: files.actList, gate: "draft_gate", cwd: wt,
      fetchPr: async () => ({ headRefName: "issue-1", headRefOid: head }), executionIdentity: nextExecution(), ...over,
    });
    await fn({ root, wt, head, files, emit });
  }, { prefix: "dev-loops-fixer-" });
}

// ---------------------------------------------------------------------------
// F1 — the briefing is derived by tooling from typed sources
// ---------------------------------------------------------------------------

test("F1: real act-list, threads and delta inputs resolve into the work order under the main checkout", async () => {
  await withFixture(async ({ root, head, files, emit }) => {
    const act = await emit({ deltaResult: files.delta });
    assert.ok(act.planPath.startsWith(path.join(root, "tmp", "gate-fixer", "o-r", `pr-${PR}`)), act.planPath);
    assert.deepEqual(act.workOrder.requiredReads.map((read) => read.kind), ["act-list", "delta-result"]);
    assert.equal(act.workOrder.source, "act-list");
    assert.equal(act.workOrder.gate, "draft_gate");
    assert.deepEqual(act.workOrder.mutationAuthority, { repo: REPO, pr: PR, branch: "issue-1", allowedPaths: ["."] });
    assert.equal(act.workOrder.headSha, head);
    const threads = await emit({ actListFile: undefined, gate: undefined, threadsFile: files.threads, allowedPaths: ["src/", "test/a.test.mjs"] });
    assert.deepEqual(threads.workOrder.requiredReads.map((read) => read.kind), ["threads"]);
    assert.equal(threads.workOrder.gate, undefined);
    assert.deepEqual(threads.workOrder.mutationAuthority.allowedPaths, ["src", "test/a.test.mjs"]);
  });
});

test("F1: free-form brief, payload override and summary-file substitution exit 2", () => {
  for (const flag of ["--brief", "--payload", "--summary-file"]) {
    const result = spawnSync("node", [EMITTER, "--repo", REPO, "--pr", "7", "--head-sha", "a".repeat(40), "--phase", "full", "--threads-file", "t.json", flag, "x"], { encoding: "utf8", env: runIdFreeEnv() });
    assert.equal(result.status, 2, `${flag}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Unknown option/);
  }
});

test("F1: missing or conflicting source and authority refuse before dispatch", async () => {
  await withFixture(async ({ wt, head, files, emit }) => {
    await assert.rejects(emit({ actListFile: path.join(wt, "missing.json") }), /required fixer source act-list is missing/);
    await assert.rejects(emit({ actListFile: undefined }), /exactly one of --act-list-file and --threads-file/);
    await assert.rejects(emit({ threadsFile: files.threads }), /exactly one of/);
    await assert.rejects(emit({ gate: undefined }), /needs --gate/);
    await assert.rejects(emit({ actListFile: files.threads }), /not a non-empty judge-pass --out array/);
    for (const bad of [[], [{ title: "please refactor the parser", body: "prose" }], [{ ...ACT[0], judgeDisposition: "defer" }], [{ ...ACT[0], severity: "critical" }], [{ ...ACT[0], summary: " " }]]) {
      await writeFile(files.actList, JSON.stringify(bad));
      await assert.rejects(emit(), /not a non-empty judge-pass --out array/, JSON.stringify(bad));
    }
    await writeFile(files.actList, JSON.stringify(ACT));
    await writeFile(path.join(wt, ".devloops.json"), JSON.stringify({ autonomy: { humanMergeOnly: "nope" } }));
    await assert.rejects(emit(), /dev-loops config is invalid/);
    await rm(path.join(wt, ".devloops.json"));
    await assert.rejects(emit({ actListFile: undefined, gate: undefined, threadsFile: files.threads, repo: "o/other" }), /not list-review-threads output/);
    await assert.rejects(emit({ fetchPr: async () => ({ headRefName: "issue-1", headRefOid: "b".repeat(40) }) }), /conflicting authority/);
    await assert.rejects(emit({ fetchPr: async () => ({ headRefOid: head }) }), /mutation authority is missing/);
    for (const bad of ["/abs", "../up", "a/../../b"]) await assert.rejects(emit({ allowedPaths: [bad] }), /--allowed-path/);
    await assert.rejects(emit({ phase: "push" }), /--phase must be one of/);
    const cli = spawnSync("node", [EMITTER, "--harness", "claude", "--repo", REPO, "--pr", "7", "--head-sha", head, "--phase", "full", "--threads-file", path.join(wt, "missing.json")], { cwd: wt, encoding: "utf8", env: runIdFreeEnv() });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).ok, false);
  });
});

test("F1/F4: changing act list, threads, allowed paths, branch, phase or head changes the digest; equal inputs keep it", async () => {
  await withFixture(async ({ files, emit }) => {
    const base = await emit();
    assert.equal((await emit()).workOrderDigest, base.workOrderDigest);
    const variants = [
      await emit({ allowedPaths: ["src"] }),
      await emit({ phase: "commit_only" }),
      await emit({ gate: "pre_approval_gate" }),
      await emit({ fetchPr: async () => ({ headRefName: "other", headRefOid: base.workOrder.headSha }) }),
      await emit({ headSha: "b".repeat(40), fetchPr: async () => ({ headRefName: "issue-1", headRefOid: "b".repeat(40) }) }),
      await emit({ actListFile: undefined, gate: undefined, threadsFile: files.threads }),
    ];
    await writeFile(files.actList, JSON.stringify([...ACT, { ...ACT[0], line: 9 }]));
    variants.push(await emit());
    await writeFile(files.threads, JSON.stringify({ ...THREADS, threads: [] }));
    variants.push(await emit({ actListFile: undefined, gate: undefined, threadsFile: files.threads }));
    const digests = new Set([base, ...variants].map((unit) => unit.workOrderDigest));
    assert.equal(digests.size, variants.length + 1);
  });
});

// ---------------------------------------------------------------------------
// F2 — every dispatch is the compact envelope only
// ---------------------------------------------------------------------------

test("F2: dispatchPrompt is the shared envelope, fits the cap for a worst-case ref, and refuses appended prose", async () => {
  await withFixture(async ({ emit }) => {
    const unit = await emit();
    assert.equal(unit.dispatchPrompt, buildDispatchPointer(unit));
    assert.throws(() => buildDispatchPointer({ ...unit, executionIdentity: `${unit.executionIdentity} and also refactor the parser` }), /not shell-safe/);
  });
  const worst = { workOrderRef: `fixer:${"o".repeat(39)}/${"r".repeat(100)}#99999:${"f".repeat(64)}:f1790000000000-abcdef12`, workOrderDigest: `sha256:${"f".repeat(64)}`, executionIdentity: "f1790000000000-abcdef12" };
  assert.ok(Buffer.byteLength(buildDispatchPointer(worst)) <= DISPATCH_POINTER_MAX_BYTES);
});

test("F2: initial, resumed and replacement dispatches of one reference pull the same bytes", async () => {
  await withFixture(async ({ wt, emit }) => {
    const unit = await emit();
    const pulls = [pull(unit, wt), pull(unit, wt), pull(unit, wt)];
    for (const result of pulls) assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(new Set(pulls.map((result) => result.stdout)).size, 1);
    assert.equal(pulls[0].stdout, await readFile(unit.promptPath, "utf8"));
  });
});

test("F2: Claude and Pi initial, resumed and replacement adapter payloads are the fixed pointer only; other harnesses refuse", async () => {
  await withFixture(async ({ root, wt, head, files }) => {
    const bin = path.join(root, "tmp", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ headRefName: "issue-1", headRefOid: head })}'\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    const env = { ...runIdFreeEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const cli = (harness) => spawnSync("node", [EMITTER, "--harness", harness, "--repo", REPO, "--pr", String(PR), "--head-sha", head, "--phase", "full", "--act-list-file", files.actList, "--gate", "draft_gate"], { cwd: wt, encoding: "utf8", env });
    for (const [harness, textKey] of [["claude", "prompt"], ["pi", "task"]]) {
      const initial = JSON.parse(cli(harness).stdout);
      const plan = JSON.parse(await readFile(initial.planPath, "utf8"));
      const resumed = buildFixerDispatchPayload({ harness, plan, cwd: wt });
      const replacementOut = JSON.parse(cli(harness).stdout);
      const replacement = { plan: JSON.parse(await readFile(replacementOut.planPath, "utf8")), payload: replacementOut.dispatchPayload };
      for (const [payload, unit] of [[initial.dispatchPayload, plan], [resumed, plan], [replacement.payload, replacement.plan]]) {
        assert.deepEqual(Object.keys(payload).sort(), (harness === "claude" ? ["subagent_type", "description"] : ["agent"]).concat(textKey).sort());
        // A consumer checkout resolves the plugin-namespaced agent; the hooks normalize it to `fixer`.
        if (harness === "claude") assert.deepEqual([payload.subagent_type, payload.description], ["dev-loops:fixer", "fixer work order"]);
        assert.equal(payload[textKey], buildDispatchPointer(unit));
        assert.ok(Buffer.byteLength(payload[textKey]) <= DISPATCH_POINTER_MAX_BYTES);
        assertFixerDispatchPayload({ harness, payload, plan: unit, cwd: wt });
      }
      assert.deepEqual(initial.dispatchPayload, resumed);
      for (const bad of [{ ...resumed, [textKey]: `${resumed[textKey]} Also refactor the parser.` }, { ...resumed, [textKey]: `Context: x. ${resumed[textKey]}` }, { ...resumed, extra: "prose" }, ...(harness === "claude" ? [{ ...resumed, description: "fix the parser" }, { ...resumed, subagent_type: "fixer" }] : [])]) {
        assert.throws(() => assertFixerDispatchPayload({ harness, payload: bad, plan, cwd: wt }), (err) => err.refusal === "dispatch_payload_mismatch");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const codex = cli("codex");
    assert.equal(codex.status, 1, codex.stderr);
    assert.equal(JSON.parse(codex.stdout).refusal, "unsupported_adapter");
    assert.throws(() => buildFixerDispatchPayload({ harness: "codex", plan: {} }), (err) => err.refusal === "unsupported_adapter");
    // The dev-loops source checkout resolves its repo-local agent.
    assert.equal(buildFixerDispatchPayload({ harness: "claude", plan: {}, cwd: process.cwd() }).subagent_type, "fixer");
  });
});

// ---------------------------------------------------------------------------
// F3 — the pull returns only the intended fixer work order
// ---------------------------------------------------------------------------

test("F3: the pull writes a fixer receipt under the main checkout", async () => {
  await withFixture(async ({ root, wt, head, emit }) => {
    const unit = await emit();
    assert.equal(pull(unit, wt).status, 0);
    const receipt = JSON.parse(await readFile(pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef), "utf8"));
    assert.equal(receipt.role, "fixer");
    assert.deepEqual(receipt.subject, { repo: REPO, pr: PR, headSha: head, branch: "issue-1", phase: "full", planPath: unit.planPath });
  });
});

test("F3: wrong digest, execution, role or target and a malformed payload refuse by name", async () => {
  await withFixture(async ({ wt, emit }) => {
    const unit = await emit();
    assert.equal(refusal(pull(unit, wt, { digest: "0".repeat(64) })), "dispatch_reference_mismatch");
    assert.equal(refusal(pull(unit, wt, { ref: unit.workOrderRef.replace(`#${PR}:`, `#${PR + 1}:`) })), "dispatch_reference_mismatch");
    assert.equal(refusal(pull(unit, wt, { execution: "f1-ffffffff" })), "dispatch_identity_mismatch");
    assert.equal(refusal(pull(unit, wt, { ref: unit.workOrderRef.replace(/^fixer:/, "review:") })), "dispatch_reference_mismatch");
    const plan = JSON.parse(await readFile(unit.planPath, "utf8"));
    await writeFile(unit.planPath, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, mutationAuthority: { ...plan.workOrder.mutationAuthority, allowedPaths: ["src"] } } }));
    assert.equal(refusal(pull(unit, wt)), "semantic_identity_mismatch");
    const { workOrderDigest } = await import("../../scripts/github/_work-order-protocol.mjs");
    const invalid = { ...plan.workOrder, mutationAuthority: { ...plan.workOrder.mutationAuthority, allowedPaths: [] } };
    await writeFile(unit.planPath, JSON.stringify({ ...plan, workOrder: invalid, workOrderDigest: workOrderDigest(invalid) }));
    assert.equal(refusal(pull(unit, wt, { digest: workOrderDigest(invalid) })), "invalid_work_order");
  });
});

test("F3: a superseded ref, a changed act list, a retired gate round and a rewritten branch are stale", async () => {
  await withFixture(async ({ root, wt, head, files, emit }) => {
    const first = await emit();
    const second = await emit();
    assert.equal(refusal(pull(first, wt)), "stale_dispatch");
    assert.equal(pull(second, wt).status, 0);

    await writeFile(files.actList, JSON.stringify([]));
    assert.equal(refusal(pull(second, wt)), "stale_dispatch");
    await writeFile(files.actList, JSON.stringify(ACT));

    const retired = path.join(root, "tmp", "retired-gate-rounds", head, "r1");
    await mkdir(retired, { recursive: true });
    await writeFile(path.join(retired, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: new Date(clock).toISOString() }));
    assert.match(pull(second, wt).stdout, /stale_dispatch.*retired/);
    await rm(path.join(root, "tmp", "retired-gate-rounds"), { recursive: true });
    assert.equal(pull(second, wt).status, 0);

    git(wt, "reset", "-q", "--hard", "HEAD~1");
    assert.match(pull(second, wt).stdout, /stale_dispatch.*no longer contains head/);
  });
});

test("F3: a threads-sourced work order pulls, and a rewritten threads file is stale for the pull and the write hook", async () => {
  await withFixture(async ({ root, wt, files, emit }) => {
    const unit = await emit({ actListFile: undefined, gate: undefined, threadsFile: files.threads });
    assert.equal(pull(unit, wt).status, 0);
    const receipt = JSON.parse(await readFile(pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef), "utf8"));
    assert.equal(receipt.role, "fixer");
    const target = path.join(wt, "src", "x.mjs");
    assert.equal(hook(wt, target), "allow");
    await writeFile(files.threads, JSON.stringify({ ...THREADS, threads: [] }));
    assert.equal(refusal(pull(unit, wt)), "stale_dispatch");
    assert.equal(hook(wt, target), "deny", "a changed threads file grants nothing");
  });
});

test("F3: delta mode emits at the PR head; after a local fix commit a second commit_only emission there is not stale", async () => {
  await withFixture(async ({ wt, emit }) => {
    assert.equal(pull(await emit({ phase: "commit_only" }), wt).status, 0);
    git(wt, "commit", "-q", "--allow-empty", "-m", "local fix");
    const second = await emit({ phase: "commit_only" });
    const result = pull(second, wt);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

// ---------------------------------------------------------------------------
// F4 — portable identity, immutable reference
// ---------------------------------------------------------------------------

test("F4: two checkout roots emit equal digests with independently valid materializations", async () => {
  await withFixture(async ({ root, wt, head, files, emit }) => {
    const clone = path.join(path.dirname(root), "clone");
    git(path.dirname(root), "clone", "-q", root, clone);
    git(clone, "branch", "-q", "issue-1", `origin/issue-1`);
    const cloneAct = path.join(clone, "tmp", "act.json");
    await mkdir(path.dirname(cloneAct), { recursive: true });
    await writeFile(cloneAct, await readFile(files.actList));
    const a = await emit();
    const b = await emit({ cwd: clone, actListFile: cloneAct });
    assert.equal(a.workOrderDigest, b.workOrderDigest);
    assert.notEqual(a.materializationHash, b.materializationHash);
    assert.ok(b.promptPath.startsWith(clone));
    assert.equal(pull(a, wt).status, 0);
    assert.equal(pull(b, clone).status, 0);
    assert.equal(head, git(clone, "rev-parse", "issue-1"));
  });
});

test("F4: a conflicting rewrite under the same reference is refused", async () => {
  await withFixture(async ({ files, emit }) => {
    const unit = await emit();
    await emit({ executionIdentity: unit.executionIdentity });
    await writeFile(files.actList, JSON.stringify([{ ...ACT[0], line: 9 }]));
    await assert.rejects(emit({ executionIdentity: unit.executionIdentity }), /already exists with different content/);
  });
});

// ---------------------------------------------------------------------------
// F5 — the write hook binds fixer mutation to a current pull's authority
// ---------------------------------------------------------------------------

const hook = (cwd, file, agentId = AGENT, env = gitFreeEnv()) => {
  const result = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd, agent_type: "fixer", ...(agentId ? { agent_id: agentId } : {}) }), encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : "allow";
};

test("F5: the write hook denies without a pull, with a foreign or superseded receipt and outside authority", async () => {
  await withFixture(async ({ root, wt, emit }) => {
    const target = path.join(wt, "src", "x.mjs");
    assert.equal(hook(wt, target), "deny");
    const unit = await emit({ allowedPaths: ["src"] });
    assert.equal(hook(wt, target), "deny", "an emitted but unpulled work order grants nothing");
    const foreign = pullReceiptPath(path.join(root, "tmp"), "review:o/r#7:x");
    await mkdir(path.dirname(foreign), { recursive: true });
    await writeFile(foreign, JSON.stringify({ role: "review", workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest, executionIdentity: unit.executionIdentity, subject: { planPath: unit.planPath } }));
    assert.equal(hook(wt, target), "deny", "a review receipt grants nothing");
    assert.equal(pull(unit, wt).status, 0);
    assert.equal(hook(wt, target), "allow");
    assert.equal(hook(wt, unit.workOrder.outputRefs[0]), "allow");
    assert.equal(hook(wt, path.join(wt, "README.md")), "deny");
    assert.equal(hook(wt, path.join(root, "src", "x.mjs")), "deny", "the main checkout is on another branch");
    assert.equal(hook(wt, path.join(root, "tmp", "work-order-receipts", "forged.json")), "deny");
    await emit({ allowedPaths: ["src"] });
    assert.equal(hook(wt, target), "deny", "a superseded receipt grants nothing");
  });
});

test("F5: a cwd in another repo cannot make an in-repo target look like scratch; a plan outside tmp/gate-fixer grants nothing", async () => {
  await withFixture(async ({ root, wt, emit }) => {
    const other = path.join(path.dirname(root), "other");
    await mkdir(other);
    git(other, "init", "-q", "-b", "main");
    // An inherited GIT_DIR of another repo must not list that repo's checkouts (the target would look like scratch).
    const foreign = { ...gitFreeEnv(), GIT_DIR: path.join(other, ".git") };
    const denied = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(wt, "src", "x.mjs") }, cwd: wt, agent_type: "fixer", agent_id: AGENT }), encoding: "utf8", env: foreign });
    assert.match(denied.stdout, /Fixer mutation boundary.*no current fixer work-order pull/, "a foreign GIT_DIR never turns an unpulled write into scratch");
    const unit = await emit({ allowedPaths: ["src"] });
    assert.equal(pull(unit, wt).status, 0);
    assert.equal(hook(wt, path.join(wt, "src", "x.mjs"), AGENT, foreign), "allow", "the grant resolves in the real repo");
    assert.equal(bash(wt, `git -C ${root} commit -m x`, AGENT, foreign), "deny", "the main checkout's branch is still resolved");
    assert.equal(hook(other, path.join(wt, "src", "x.mjs")), "allow");
    assert.equal(hook(other, path.join(wt, "README.md")), "deny");
    const receiptPath = pullReceiptPath(path.join(root, "tmp"), unit.workOrderRef);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const movedPlan = path.join(root, "tmp", "src", "plan.json");
    await writeFile(movedPlan, await readFile(unit.planPath));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, subject: { ...receipt.subject, planPath: movedPlan } }));
    assert.equal(hook(wt, path.join(wt, "src", "x.mjs")), "deny");
  });
});

test("F5: a symlink from scratch space into a checkout is denied at the hook", async () => {
  await withFixture(async ({ root, wt, emit }) => {
    assert.equal(pull(await emit({ allowedPaths: ["src"] }), wt).status, 0);
    // The link resolves into the GRANTED worktree and allowedPaths, so only the symlink walk denies it.
    const link = path.join(path.dirname(root), "scratch-link");
    await symlink(wt, link);
    assert.equal(hook(wt, path.join(link, "src", "x.mjs")), "deny", "crosses a symlink into a checkout");
    assert.equal(hook(wt, path.join(wt, "src", "x.mjs")), "allow");
  });
});

test("F5: a pulled grant goes stale with the pull's own predicate; an edited outputRef never becomes a write grant", async () => {
  await withFixture(async ({ root, wt, head, files, emit }) => {
    const unit = await emit();
    assert.equal(pull(unit, wt).status, 0);
    const target = path.join(wt, "src", "x.mjs");
    assert.equal(hook(wt, target), "allow");

    // The hook's own required-read check (not locateFixerUnit): an act list rewritten after the pull revokes the grant.
    const actList = await readFile(files.actList);
    await writeFile(files.actList, JSON.stringify([{ ...ACT[0], line: 9 }]));
    assert.equal(hook(wt, target), "deny", "a changed required read grants nothing");
    assert.equal(bash(wt, "git commit -m x"), "deny", "a changed required read grants no commit");
    await rm(files.actList);
    assert.equal(hook(wt, target), "deny", "a vanished required read grants nothing");
    await writeFile(files.actList, actList);
    assert.equal(hook(wt, target), "allow");
    assert.equal(bash(wt, "git commit -m x"), "allow");

    const plan = JSON.parse(await readFile(unit.planPath, "utf8"));
    const forged = path.join(root, "tmp", "gate-findings", "forged.json");
    await writeFile(unit.planPath, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, outputRefs: [forged] } }));
    assert.equal(hook(wt, forged), "deny", "outputRefs is outside the digest and never trusted");
    assert.equal(hook(wt, unit.workOrder.outputRefs[0]), "allow", "the derived outputRef still is");
    await writeFile(unit.planPath, JSON.stringify(plan));

    const retired = path.join(root, "tmp", "retired-gate-rounds", head, "r1");
    await mkdir(retired, { recursive: true });
    await writeFile(path.join(retired, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: new Date(clock).toISOString() }));
    assert.equal(hook(wt, target), "deny", "a retired gate round grants nothing");
    await rm(path.join(root, "tmp", "retired-gate-rounds"), { recursive: true });
    assert.equal(hook(wt, target), "allow");
    // retire-gate-round.mjs defaults to the cwd-relative tmp/, so a retirement run from the worktree lands there.
    const wtRetired = path.join(wt, "tmp", "retired-gate-rounds", head, "r1");
    await mkdir(wtRetired, { recursive: true });
    await writeFile(path.join(wtRetired, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: new Date(clock).toISOString() }));
    assert.equal(hook(wt, target), "deny", "a retirement under the linked worktree's tmp/ grants nothing");
    assert.equal(bash(wt, "git commit -m x"), "deny", "a retirement under the linked worktree's tmp/ grants no commit");
    await rm(path.join(wt, "tmp", "retired-gate-rounds"), { recursive: true });
    assert.equal(hook(wt, target), "allow");

    git(wt, "reset", "-q", "--hard", "HEAD~1");
    assert.equal(hook(wt, target), "deny", "a branch that no longer contains the head grants nothing");
  });
});

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const bash = (cwd, command, agentId = AGENT, env = gitFreeEnv()) => {
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, agent_type: "fixer", ...(agentId ? { agent_id: agentId } : {}) }), encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : "allow";
};

test("F5: a grant binds to the agent_id that ran the pull; a replacement re-pull takes it over; no agent_id gets nothing", async () => {
  await withFixture(async ({ wt, emit }) => {
    const unit = await emit();
    const target = path.join(wt, "src", "x.mjs");
    assert.equal(pull(unit, wt).status, 0);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "x\n");
    assert.equal(hook(wt, target), "allow");
    assert.equal(bash(wt, "git add -A && git commit -m fix"), "allow");
    for (const agentId of ["agent-b", null]) {
      assert.equal(hook(wt, target, agentId), "deny", `${agentId} never pulled`);
      assert.equal(bash(wt, "git add -A && git commit -m fix", agentId), "deny", `${agentId} never pulled`);
    }
    // A pull line with the right ref and execution but a wrong digest is refused and takes nothing over.
    assert.equal(pull(unit, wt, { agentId: "agent-b", digest: `sha256:${"0".repeat(64)}` }).status, 1);
    assert.equal(hook(wt, target, "agent-b"), "deny", "a refused pull binds nothing");
    assert.equal(hook(wt, target), "allow", "a refused pull never revokes the pulling fixer's grant");
    // The same with the right ref and digest but a wrong execution.
    assert.equal(pull(unit, wt, { agentId: "agent-b", execution: "f1-0000dead" }).status, 1);
    assert.equal(hook(wt, target, "agent-b"), "deny", "a refused pull binds nothing");
    assert.equal(hook(wt, target), "allow", "a wrong-execution pull never revokes the pulling fixer's grant");
    assert.equal(pull(unit, wt, { agentId: "agent-b" }).status, 0);
    assert.equal(hook(wt, target, "agent-b"), "allow");
    assert.equal(bash(wt, "git add -A && git commit -m fix", "agent-b"), "allow");
    assert.equal(hook(wt, target), "deny", "the replaced agent lost the grant");
    assert.equal(bash(wt, "git add -A && git commit -m fix"), "deny", "the replaced agent lost the grant");
  });
});

test("F5: the Bash gate binds fixer git commit/push to the pulled branch and leaves other commands alone", async () => {
  await withFixture(async ({ root, wt, emit }) => {
    const unit = await emit();
    for (const command of ["git commit -m fix", "git status && git push origin issue-1", "sh -c 'git -C . push'"]) {
      assert.equal(bash(wt, command), "deny", `${command} without a pull`);
    }
    assert.equal(bash(wt, "npm test && git log --oneline -1"), "allow");
    assert.equal(pull(unit, wt).status, 0);
    for (const command of ["git commit -m fix", "git add -A && git commit -m fix && git push origin issue-1", "git push -u origin HEAD", "git commit -F msg.txt", "git push origin issue-1 2>&1"]) {
      assert.equal(bash(wt, command), "allow", command);
    }
    for (const command of [
      "git push", "git push origin main", "git push origin HEAD:main", "git push origin :issue-1", "git push --all", "git push --follow-tags origin issue-1", `cd ${root} && git commit -m x`, `git -C ${root} commit -m x`,
      `git -C ${root} cherry-pick HEAD`, `env -C ${root} git commit -m x`, "git -c push.default=matching push", "\\git commit -m x",
    ]) {
      assert.equal(bash(wt, command), "deny", command);
    }
  });
});

test("F5: a narrowed grant denies committing an out-of-authority file, commit_only denies push, an edited plan grants nothing", async () => {
  await withFixture(async ({ wt, emit }) => {
    await mkdir(path.join(wt, "src"));
    await writeFile(path.join(wt, "src", "a.mjs"), "a\n");
    await writeFile(path.join(wt, "README.md"), "r\n");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "files");
    const head = git(wt, "rev-parse", "HEAD");
    const narrowed = (phase) => emit({ phase, headSha: head, allowedPaths: ["src"], fetchPr: async () => ({ headRefName: "issue-1", headRefOid: head }) });
    const unit = await narrowed("commit_only");
    assert.equal(pull(unit, wt).status, 0);
    await writeFile(path.join(wt, "README.md"), "changed via Bash\n");
    assert.equal(bash(wt, "git commit -am fix"), "deny", "README.md is outside --allowed-path src");
    git(wt, "checkout", "--", "README.md");
    // A staged rename lists its out-of-authority source even under the default diff.renames.
    git(wt, "mv", "README.md", "src/readme.md");
    assert.equal(bash(wt, "git commit -m mv"), "deny", "the rename deletes README.md outside --allowed-path src");
    git(wt, "mv", "src/readme.md", "README.md");
    await writeFile(path.join(wt, "src", "a.mjs"), "fixed\n");
    assert.equal(bash(wt, "git commit -am fix"), "allow");
    assert.equal(bash(wt, "git push origin issue-1"), "deny", "a commit_only pull never pushes");
    const full = await narrowed("full");
    assert.equal(pull(full, wt).status, 0);
    assert.equal(hook(wt, path.join(wt, "src", "a.mjs")), "allow");
    const plan = JSON.parse(await readFile(full.planPath, "utf8"));
    plan.workOrder.mutationAuthority.allowedPaths = ["."];
    await writeFile(full.planPath, JSON.stringify(plan));
    assert.equal(hook(wt, path.join(wt, "src", "a.mjs")), "deny", "the edited plan no longer reproduces its workOrderDigest");
    assert.equal(hook(wt, path.join(wt, "README.md")), "deny");
  });
});

// ---------------------------------------------------------------------------
// F7 — end to end with only the #2416 transport registered
// ---------------------------------------------------------------------------

test("F7: emit, pull, mutate in authority and verify the disposition; missing materialization refuses and re-emission supersedes the old reference", async () => {
  await withFixture(async ({ root, wt, head, emit }) => {
    const unit = await emit();
    assert.equal(pull(unit, wt).status, 0);
    const target = path.join(wt, "src", "fix.mjs");
    assert.equal(hook(wt, target), "allow");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export const fixed = true;\n");
    const [outputRef] = unit.workOrder.outputRefs;
    assert.equal(hook(wt, outputRef), "allow");
    await mkdir(path.dirname(outputRef), { recursive: true });
    await writeFile(outputRef, JSON.stringify({ headSha: head, dispositions: [] }));
    const { runChild } = makeGhMock([{ assertArgs: ["pr", "view"], stdout: `${JSON.stringify({ headRefOid: head })}\n` }, { assertArgs: ["api", "graphql"], stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })}\n` }]);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: head, fixerPlan: unit.planPath }, { env: runIdFreeEnv(), runChild, repoRoot: wt });
    assert.equal(result.complete, true);
    assert.ok(result.checkpointPath.startsWith(path.join(root, "tmp")));

    await rm(unit.promptPath);
    assert.equal(refusal(pull(unit, wt)), "local_materialization_integrity_failure");
    const reemitted = await emit();
    assert.notEqual(reemitted.workOrderRef, unit.workOrderRef);
    assert.equal(refusal(pull(unit, wt)), "stale_dispatch");
    assert.equal(pull(reemitted, wt).status, 0);

    const source = await readFile(EMITTER, "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter((spec) => /reconcil|recover|regenerat/i.test(spec)), []);
  });
});

// ---------------------------------------------------------------------------
// F8 — validation ownership is unchanged
// ---------------------------------------------------------------------------

test("F8: the work order routes validation through the canonical policy and carries no full-run command", async () => {
  await withFixture(async ({ emit }) => {
    for (const phase of ["commit_only", "full"]) {
      const unit = await emit({ phase });
      assert.match(unit.workOrder.executionRules.validation, /VALIDATE-TARGETED-FIRST/);
      assert.match(unit.workOrder.executionRules.validation, /dev-loops gate resolve-validation/);
      const strings = [];
      const walk = (value) => (typeof value === "string" ? strings.push(value) : value && typeof value === "object" && Object.values(value).forEach(walk));
      walk(unit.workOrder);
      strings.push(...(await readFile(unit.promptPath, "utf8")).split("\n"));
      for (const text of strings) assert.notEqual(classifyValidationCommand(text), "full-repository", text);
    }
  });
});
