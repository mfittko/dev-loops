// Interrupt-recovery suite (#3421): kill a stubbed draft_gate round and a stubbed fix pass after each step, then
// recover through a fresh coordinator path (`loop gate-coordination` plus the step's recovery) and compare the final
// on-disk state with an uninterrupted run. Steps whose recovery fails today are KNOWN_FAILURES keyed by open issue:
// the suite passes now, and a known failure that starts recovering fails the suite until its entry is removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "bun:test";
import { summarizeGateReviewCommentMarkers } from "@dev-loops/core/github/copilot-helpers";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { repoSlugFor } from "../../scripts/github/_gate-artifact-paths.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { addLocalOrigin, runGitFixture, runIdFreeEnv } from "../_helpers.mjs";

const CHILD = path.resolve("test/loop/_interrupt-child.mjs");
const COORDINATION = path.resolve("scripts/loop/detect-pr-gate-coordination-state.mjs");
const CONSOLIDATE = path.resolve("scripts/loop/consolidate-fanin.mjs");
const EMITTER_STEPS = { round: ["context", "sentinel", "artifact-tmp", "artifact", "fanin"], fixer: ["lock", "plan-tmp", "plan", "release"] };

// `${unit}:${killedAfter}` -> [open issue, the refusal that keeps this recovery failing]. Remove an entry when its issue closes.
// A reviewer killed after its sentinel recovers today through the documented `--same-head-retry`; issue 3416 tracks the
// rebuilt-context case (see the 3416 test below), so no round step is listed here.
const EEXIST = /EEXIST/;
const KNOWN_FAILURES = new Map([
  ["fixer:lock", [3417, EEXIST]], ["fixer:plan-tmp", [3417, EEXIST]], ["fixer:plan", [3417, EEXIST]], // a dead emitter's lock stays
]);

const roots = [];
afterAll(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

// An attested gh stub that answers by argument shape, so every coordinator run sees the same PR.
const GH_STUB = `#!/bin/sh
case "$*" in
"pr view"*headRefOid) echo '{"headRefOid":"def56789abcdef"}';;
"pr view"*) echo '{"number":266,"state":"OPEN","isDraft":true,"headRefOid":"def56789abcdef","statusCheckRollup":[],"reviews":[]}';;
*requested_reviewers*) echo '{"users":[],"teams":[]}';;
*graphql*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}';;
*comments*|*reviews*) echo '[[]]';;
*) echo '';;
esac
`;

async function makeRoot() {
  const root = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "interrupt-recovery-"))), "repo");
  roots.push(path.dirname(root));
  await mkdir(path.join(root, "tmp", "bin"), { recursive: true });
  runGitFixture(root, ["init", "-q", "-b", "main"]);
  runGitFixture(root, ["-c", "user.email=t@e.x", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "c0"]);
  addLocalOrigin(root);
  await writeFile(path.join(root, "tmp", "bin", "gh"), GH_STUB);
  await chmod(path.join(root, "tmp", "bin", "gh"), 0o755);
  return root;
}

const env = (root, extra = {}) => runIdFreeEnv({
  PATH: `${path.join(root, "tmp", "bin")}${path.delimiter}${process.env.PATH}`,
  DEV_LOOPS_GH_STUB: "1", DEVLOOPS_WORKTREE_BYPASS: "1", DEVLOOPS_OWNERSHIP_BYPASS: "1", DEVLOOPS_RUN_ID: "", ...extra,
});
const runChild = (unit, root, extra) => spawnSync("node", [CHILD, unit, root], { cwd: root, encoding: "utf8", env: env(root, extra) });
const coordinate = (root) => spawnSync("node", [COORDINATION, "--repo", "owner/repo", "--pr", "266", "--fields", "lifecycleState,gateBoundary,nextAction"], { cwd: root, encoding: "utf8", env: env(root) });

// File names only: sentinels, plans and temporary files carry pids and times.
async function snapshot(root) {
  const walk = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((e) => e.name === "bin" || e.name === ".git" ? [] : e.isDirectory() ? [] : [e.name]).sort();
  const out = [];
  for (const dir of ["tmp", "tmp/gate-context", "tmp/findings", `tmp/gate-fixer/${repoSlugFor("owner/repo")}/pr-266`]) if (existsSync(path.join(root, dir))) out.push(...(await walk(path.join(root, dir))).map((n) => `${dir}/${n.replace(/[0-9a-f]{40}/, "<head>").replace(/\.tmp-f[0-9]+-[0-9a-f]{8}$/, ".tmp-<id>")}`));
  return out;
}

// Issue 3420 adds a `recovery` field to refusals; surface it when present, never require it.
const recoveryHint = (stdout) => { try { const hint = JSON.parse(stdout).recovery; return hint ? ` [recovery: ${JSON.stringify(hint)}]` : ""; } catch { return ""; } };

// The step's recovery: a fresh worker redoes the unit (a reviewer with the sanctioned --same-head-retry). A kill after the
// last step leaves a finished unit, so that case only checks the finished state equals the baseline; it runs no recovery.
async function recoverAfter(unit, killedAfter) {
  const root = await makeRoot();
  const steps = EMITTER_STEPS[unit];
  const killed = runChild(unit, root, { INTERRUPT_AFTER: killedAfter });
  assert.equal(killed.signal, "SIGKILL", `${unit} child was not killed after ${killedAfter}: ${killed.stderr}`);
  const before = coordinate(root); // the fresh coordinator path must keep working on the interrupted state
  assert.equal(before.status, 0, before.stderr);
  assert.notEqual(before.stdout.trim(), "", "gate-coordination must answer on the interrupted state");
  const redo = killedAfter === steps.at(-1) ? { status: 0, stdout: "", stderr: "" } : runChild(unit, root, unit === "round" ? { SAME_HEAD_RETRY: "1" } : {});
  const after = coordinate(root);
  return { redo, coordination: after.stdout, state: await snapshot(root), before: before.stdout };
}

describe("interrupt a stubbed draft_gate round and fix pass after each step", async () => {
  const baselines = {};
  for (const unit of Object.keys(EMITTER_STEPS)) {
    const root = await makeRoot();
    const done = runChild(unit, root);
    assert.equal(done.status, 0, done.stderr);
    baselines[unit] = { coordination: coordinate(root).stdout, state: await snapshot(root) };
  }
  for (const [unit, steps] of Object.entries(EMITTER_STEPS)) {
    for (const step of steps) {
      const [known, refusal] = KNOWN_FAILURES.get(`${unit}:${step}`) ?? [];
      test(`${unit}: killed after ${step} recovers to the uninterrupted state${known ? ` (known failure, issue ${known})` : ""}`, async () => {
        const run = await recoverAfter(unit, step);
        const reasons = [];
        if (run.redo.status !== 0) reasons.push(`recovery exited ${run.redo.status}: ${(run.redo.stdout + run.redo.stderr).trim().slice(0, 300)}${recoveryHint(run.redo.stdout)}`);
        if (JSON.stringify(run.state) !== JSON.stringify(baselines[unit].state)) reasons.push(`state ${JSON.stringify(run.state)} differs from ${JSON.stringify(baselines[unit].state)}`);
        if (run.coordination !== baselines[unit].coordination) reasons.push("gate-coordination output differs from the uninterrupted run");
        if (known) {
          assert.notEqual(reasons.length, 0, `recovery now works: remove ${unit}:${step} from KNOWN_FAILURES (issue ${known}) so the suite turns strict`);
          assert.match(run.redo.stdout + run.redo.stderr, refusal, `${unit}:${step} now fails for a different reason; re-check issue ${known}`);
        } else assert.deepEqual(reasons, []);
      });
    }
  }
});

// A coordinator that rebuilds the gate context at the same head changes the briefing prefix hash, so the killed
// reviewer's sentinel refuses the fresh reviewer even with the sanctioned retry. Issue 3416 retires the stale round.
test("known failure (issue 3416): a reviewer re-fanned after a context rebuild at the same head is refused", async () => {
  const root = await makeRoot();
  const killed = runChild("round", root, { INTERRUPT_AFTER: "sentinel" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const redo = runChild("round", root, { PREFIX_HASH: "b".repeat(64), SAME_HEAD_RETRY: "1" });
  assert.notEqual(redo.status, 0, "recovery now works: remove the 3416 known failure so the suite turns strict");
  assert.match(redo.stdout + redo.stderr, /DIFFERENT prefix hash/, "the refusal changed; re-check issue 3416");
});

// A fix pass killed after the plan is on disk leaves the carry-forward plan file for the next fan-in: the coordinator
// must hand it over by path (a long inline plan trips the Bash hook).
test("known failure (issue 3415): fan-in reads the carry-forward plan from a file", async () => {
  const root = await makeRoot();
  const run = spawnSync("node", [CONSOLIDATE, "--findings-dir", "tmp", "--carry-forward-plan-file", "tmp/plan.json"], { cwd: root, encoding: "utf8", env: env(root) });
  const recovers = !/Unknown argument/.test(run.stdout + run.stderr);
  assert.equal(recovers, false, "recovery now works: remove the 3415 known failure so the suite turns strict");
});

// A fix pass whose CI turns red after the push is interrupted at the verifier step: the CI-fix emission that follows
// must keep the thread reply and resolve obligations of the unfinished thread-route plan. The fixture is the
// smallest real emitter run: a commit_only thread plan, then a ci-failure emission at the same head.
async function emitOverUnfinishedPlan() {
  const root = await makeRoot();
  const wt = path.join(root, "tmp", "worktrees", "wt");
  runGitFixture(root, ["branch", "issue-1"]);
  runGitFixture(root, ["worktree", "add", "-q", wt, "issue-1"]);
  const head = runGitFixture(wt, ["rev-parse", "HEAD"]).trim();
  const src = path.join(root, "tmp", "src");
  await mkdir(src, { recursive: true });
  const act = { severity: "high", angle: "correctness", summary: "null deref", file: "src/a.mjs", line: 3, judgeDisposition: "act", siteQuery: "git grep -n deref -- src" };
  act.fingerprint = fingerprintFinding(act);
  const threads = path.join(src, "threads.json");
  await writeFile(threads, JSON.stringify({ ok: true, repo: "o/r", pr: 7, threads: [{ trusted: true, threadId: "T1", commentId: 1, body: "fix", isResolved: false, isOutdated: false, path: "src/a.mjs", line: 3 }] }));
  await mkdir(path.join(root, "tmp", "gate-delta"), { recursive: true });
  await writeFile(path.join(root, "tmp", "gate-delta", `${head}.json`), JSON.stringify({
    reviewBaselineHead: head, candidateHead: head, actSetId: startDeltaSequence({ reviewBaselineHead: head, actList: [act] }).actSetId, invocation: 1,
    outcome: "locally_clear", nextStep: "push", items: [{ ref: "T1", status: "resolved" }],
  }));
  const reviews = ["draft_gate", "pre_approval_gate"].map((gate, id) => ({ id: id + 1, surface: "review", state: "COMMENTED", submitted_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z",
    body: [`Gate review: ${gate}`, `Reviewed head SHA: ${head}`, "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join("\n") }));
  const common = { repo: "o/r", pr: 7, headSha: head, cwd: wt, fetchPr: async () => ({ headRefName: "issue-1", headRefOid: head }), fetchVerdictMarkers: async ({ headSha }) => summarizeGateReviewCommentMarkers(reviews, { headSha }) };
  await emitFixerWorkOrder({ ...common, phase: "commit_only", threadsFile: threads, executionIdentity: "f1790000000000-0000abcd" });
  const ci = path.join(src, "ci.json");
  await writeFile(ci, JSON.stringify({ ok: true, status: "failure", ciStatus: "failure", settled: true, headSha: head, failedChecks: [{ name: "build (24)", conclusion: "failure" }] }));
  return () => emitFixerWorkOrder({ ...common, phase: "full", ciFile: ci, executionIdentity: "f1790000000001-0000abcd" });
}

test("known failure (issue 3419): a CI-fix emission over an unfinished thread plan keeps its thread obligations", async () => {
  // Today the emitter refuses while the plan is unfinished; the fix either carries the thread read or completes the plan.
  const ciEmission = await emitOverUnfinishedPlan(); // the first (thread) emission must succeed; its failure fails the test
  const outcome = await ciEmission().then((unit) => ({ unit }), (error) => ({ error }));
  assert.ok(outcome.error, "recovery now works (the emission succeeded): remove the 3419 known failure so the suite turns strict");
  assert.match(String(outcome.error.message), /sequence is active/, `the refusal changed; re-check issue 3419: ${outcome.error.message}`);
});
