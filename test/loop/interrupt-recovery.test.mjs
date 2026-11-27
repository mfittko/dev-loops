// Interrupt-recovery suite (#3421): kill a stubbed draft_gate round and a stubbed fix pass after each step, then
// recover through a fresh coordinator path (`loop gate-coordination` plus the step's recovery) and compare the final
// on-disk state with an uninterrupted run. Steps whose recovery fails today are KNOWN_FAILURES keyed by open issue:
// the suite passes now, and a known failure that starts recovering fails the suite until its entry is removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "bun:test";
import { summarizeGateReviewCommentMarkers } from "@dev-loops/core/github/copilot-helpers";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { buildGateContextPath, buildGateFaninLedgerPath, buildGateReviewsDir, repoSlugFor } from "../../scripts/github/_gate-artifact-paths.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { addLocalOrigin, runGitFixture, runIdFreeEnv } from "../_helpers.mjs";

const CHILD = path.resolve("test/loop/_interrupt-child.mjs");
const COORDINATION = path.resolve("scripts/loop/detect-pr-gate-coordination-state.mjs");
const CONSOLIDATE = path.resolve("scripts/loop/consolidate-fanin.mjs");
const GATE_HEAD = "abcdef0123456789abcdef0123456789abcdef01"; // the head _interrupt-child.mjs writes its gate artifacts under
const GATE_KEY = { repo: "owner/repo", pr: 266, gate: "draft_gate", headSha: GATE_HEAD };
const EMITTER_STEPS = { round: ["context", "sentinel", "artifact-tmp", "artifact", "fanin"], fixer: ["lock", "plan-tmp", "plan", "release"] };

// `${unit}:${killedAfter}` -> [open issue, the refusal that keeps this recovery failing]. Remove an entry when its issue closes.
// Every round step recovers: a rebuilt context retires the stale round at the same head (issue 3416).
const EEXIST = /EEXIST/;
const KNOWN_FAILURES = new Map([
  ["fixer:lock", [3417, EEXIST]], ["fixer:plan-tmp", [3417, EEXIST]], ["fixer:plan", [3417, EEXIST]], // a dead emitter's lock stays
]);

const roots = [];
afterAll(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

// An attested gh stub that answers by argument shape, so every coordinator run sees the same PR.
const GH_STUB = `#!/bin/sh
case "$*" in
"pr view"*headRefOid) echo '{"headRefOid":"${GATE_HEAD}"}';;
"pr view"*) echo '{"number":266,"state":"OPEN","isDraft":true,"headRefOid":"${GATE_HEAD}","statusCheckRollup":[],"reviews":[]}';;
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
  DEV_LOOPS_GH_STUB: "1", DEVLOOPS_WORKTREE_BYPASS: "1", DEVLOOPS_OWNERSHIP_BYPASS: "1", DEVLOOPS_RUN_ID: "", GATE_HEAD, ...extra,
});
const runChild = (unit, root, extra) => spawnSync("node", [CHILD, unit, root], { cwd: root, encoding: "utf8", env: env(root, extra) });
const coordinate = (root) => spawnSync("node", [COORDINATION, "--repo", "owner/repo", "--pr", "266"], { cwd: root, encoding: "utf8", env: env(root) });

// File names for every file (sentinels, plans and temporary files carry pids and times), plus the content of the
// deterministic ones: the per-angle coverage.json and the fan-in ledger's verdict and findings.
async function snapshot(root) {
  const walk = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((e) => e.name === "bin" || e.name === ".git" ? [] : e.isDirectory() ? [] : [e.name]).sort();
  const content = async (file, name) => {
    if (name === "coverage.json") return ` ${JSON.stringify(JSON.parse(await readFile(file, "utf8")))}`;
    if (name.endsWith(".fanin-ledger.json")) { const { overallVerdict, findings } = JSON.parse(await readFile(file, "utf8")); return ` ${JSON.stringify({ overallVerdict, findings })}`; }
    return "";
  };
  const out = [];
  // The key _interrupt-child.mjs writes its round artifacts under: the checkout's real head.
  const key = { ...GATE_KEY, headSha: runGitFixture(root, ["rev-parse", "HEAD"]).trim(), tmpRoot: path.join(root, "tmp") };
  const rel = (p) => path.relative(root, p);
  const dirs = [...new Set(["tmp", rel(path.dirname(buildGateContextPath(key))), rel(buildGateReviewsDir(key)), rel(path.dirname(buildGateFaninLedgerPath(key))), `tmp/gate-fixer/${repoSlugFor("owner/repo")}/pr-266`])];
  for (const dir of dirs) {
    if (!existsSync(path.join(root, dir))) continue;
    for (const n of await walk(path.join(root, dir))) out.push(`${dir}/${n.replace(/\.tmp-f[0-9]+-[0-9a-f]{8}$/, ".tmp-<id>")}${await content(path.join(root, dir, n), n)}`.replace(/[0-9a-f]{40}/g, "<head>"));
  }
  return out;
}

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
  test("the round baseline snapshot holds the per-angle artifact and the fan-in ledger", () => {
    assert.ok(baselines.round.state.some((e) => e.includes("/coverage.json ")), "coverage.json missing from the round snapshot");
    assert.ok(baselines.round.state.some((e) => e.includes(".fanin-ledger.json ")), "fan-in ledger missing from the round snapshot");
  });
  test("the coordination comparison is sensitive: the finished fixer plan changes the coordinator output", async () => {
    assert.notEqual(baselines.fixer.coordination, coordinate(await makeRoot()).stdout);
  });
  // The coordinator does not read round state at the shared head (its output equals an empty root's), so the round
  // unit's evidence is the on-disk snapshot (names plus deterministic content); its coordination check only proves
  // the coordinator keeps answering. The fixer unit above is the coordinator-sensitive one.
  for (const [unit, steps] of Object.entries(EMITTER_STEPS)) {
    for (const step of steps) {
      const [known, refusal] = KNOWN_FAILURES.get(`${unit}:${step}`) ?? [];
      test(`${unit}: killed after ${step} recovers to the uninterrupted state${known ? ` (known failure, issue ${known})` : ""}`, async () => {
        const run = await recoverAfter(unit, step);
        const reasons = [];
        if (run.redo.status !== 0) reasons.push(`recovery exited ${run.redo.status}: ${(run.redo.stdout + run.redo.stderr).trim().slice(0, 300)}`);
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

// The child's `context` step calls the shared retirement helper directly (it never runs write-gate-context.mjs), so these
// tests cover the helper step; the write-gate-context.test.mjs 3416 tests cover the builder path (issue 3416).
// A changed briefing prefix retires a finished round (the killed harness left a findings artifact newer than the
// sentinel), so the fresh reviewer passes the sentinel without the same-head retry.
test("the shared retirement helper step retires a finished round, so a re-fanned reviewer passes the sentinel", async () => {
  const root = await makeRoot();
  const killed = runChild("round", root, { INTERRUPT_AFTER: "artifact" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const redo = runChild("round", root, { PREFIX_HASH: "b".repeat(64) });
  assert.equal(redo.status, 0, redo.stdout + redo.stderr);
});

// A reviewer killed after its sentinel leaves no findings artifact: its round looks live, so the helper refuses with a recovery.
test("the shared retirement helper step refuses a round whose reviewer may still be running", async () => {
  const root = await makeRoot();
  const killed = runChild("round", root, { INTERRUPT_AFTER: "sentinel" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const before = await snapshot(root);
  const redo = runChild("round", root, { PREFIX_HASH: "b".repeat(64) });
  assert.equal(redo.status, 5, redo.stdout + redo.stderr);
  assert.match(redo.stderr, /reviewer sentinel\(s\) have no findings artifact newer than them/);
  assert.match(redo.stderr, /retire-gate-round\.mjs/);
  assert.deepEqual(await snapshot(root), before);
});

// A round that already recorded its verdict (fan-in ledger) is never retired by the retirement helper: it refuses.
test("the retirement step over a round with a posted verdict refuses and keeps the round", async () => {
  const root = await makeRoot();
  const done = runChild("round", root);
  assert.equal(done.status, 0, done.stderr);
  const before = await snapshot(root);
  const redo = runChild("round", root, { INTERRUPT_AFTER: "context", PREFIX_HASH: "b".repeat(64) });
  assert.equal(redo.status, 5, redo.stdout + redo.stderr);
  assert.match(redo.stderr, /a verdict is already recorded/);
  assert.deepEqual(await snapshot(root), before);
});

// A fix pass killed before the plan reaches disk leaves the next fan-in a plan path that does not exist: fan-in must
// accept the flag and refuse the unreadable file. The happy-path file read is covered in consolidate-fanin.test.mjs.
test("fan-in refuses an unreadable carry-forward plan file", async () => {
  const root = await makeRoot();
  const run = spawnSync("node", [CONSOLIDATE, "--findings-dir", "tmp", "--carry-forward-plan-file", path.join(root, "tmp", "plan.json")], { cwd: root, encoding: "utf8", env: env(root) });
  const out = run.stdout + run.stderr;
  assert.notEqual(run.status, 0, out);
  assert.doesNotMatch(out, /Unknown argument/, "the flag is accepted");
  assert.match(out, /--carry-forward-plan-file could not be read/, out.trim().slice(0, 300));
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

test("issue 3419: a CI-fix emission over an unfinished thread plan succeeds, because the full phase holds no sequence marker", async () => {
  const ciEmission = await emitOverUnfinishedPlan(); // the first (thread) emission must succeed; its failure fails the test
  const unit = await ciEmission();
  assert.equal(unit.workOrder.phase, "full");
  assert.equal(unit.workOrder.source, "ci-failure");
});
