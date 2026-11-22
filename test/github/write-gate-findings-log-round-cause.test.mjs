import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { buildGateContextPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { withTempDir } from "../_helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ID = { repo: "o/r", pr: 1, gate: "draft_gate" };
const act = JSON.stringify([{ severity: "low", angle: "scope", summary: "x", judgeDisposition: "act" }]);

const writeCtx = async (dir, headSha, ctx) => {
  const file = path.resolve(dir, buildGateContextPath({ ...ID, headSha, tmpRoot: dir }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ctx));
};
const bodyCtx = (sha256, base) => ({ requiredReads: [{ kind: "pr-body", sha256 }], ...(base ? { baseFreshness: { status: "current", base } } : {}) });
const write = (dir, headSha, extra = {}) => writeGateFindingsLog({ ...ID, headSha, verdict: "findings_present", findings: act, tmpRoot: dir, contextTmpRoot: dir, ...extra }, { repoRoot: dir });
const liveLedger = async (dir, headSha) => JSON.parse(await readFile(path.join(dir, "gate-findings", "o-r", "pr-1", `draft_gate-${headSha}.json`), "utf8"));
const git = (dir, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" }).trim();

test("W1 the first write stamps first", async () => {
  await withTempDir(async (dir) => {
    assert.equal((await write(dir, A)).log.roundCause, "first");
  });
});

test("W2 a later head after a round with an act item is developer_findings", async () => {
  await withTempDir(async (dir) => {
    await write(dir, A);
    assert.equal((await write(dir, B)).log.roundCause, "developer_findings");
  });
});

test("W3 a new completed round at the same head is system_rerun and the retained round keeps first", async () => {
  await withTempDir(async (dir) => {
    await writeCtx(dir, A, bodyCtx("1".repeat(64)));
    const first = await write(dir, A);
    const second = await write(dir, A);
    assert.equal(second.log.roundCause, "system_rerun");
    assert.equal(JSON.parse(await readFile(second.retainedRound, "utf8")).roundCause, "first");
    assert.equal(first.log.roundCause, "first");
  });
});

test("W4 a new round at the same head with a changed PR body digest is body_only", async () => {
  await withTempDir(async (dir) => {
    await writeCtx(dir, A, bodyCtx("1".repeat(64)));
    await write(dir, A);
    await writeCtx(dir, A, bodyCtx("2".repeat(64)));
    assert.equal((await write(dir, A)).log.roundCause, "body_only");
  });
});

// main advances after the PR branch forks; head B merges main into the PR head.
async function baseMergeRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "base.txt"), "0\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "m0");
  git(dir, "checkout", "-qb", "pr");
  await writeFile(path.join(dir, "pr.txt"), "pr\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "pr");
  const headA = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  await writeFile(path.join(dir, "base.txt"), "1\n");
  git(dir, "commit", "-qam", "m1");
  git(dir, "update-ref", "refs/remotes/origin/main", "main");
  git(dir, "checkout", "-q", "pr");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge main", "main");
  return { headA, headB: git(dir, "rev-parse", "HEAD") };
}

test("W5 and W6 a base-only merge is base_refresh and a later own commit is developer_findings", async () => {
  await withTempDir(async (dir) => {
    const { headA, headB } = await baseMergeRepo(dir);
    await write(dir, headA);
    await writeCtx(dir, headB, bodyCtx("1".repeat(64), "main"));
    assert.equal((await write(dir, headB)).log.roundCause, "base_refresh");
    await writeFile(path.join(dir, "pr.txt"), "pr2\n");
    git(dir, "commit", "-qam", "own");
    const headC = git(dir, "rev-parse", "HEAD");
    await writeCtx(dir, headC, bodyCtx("1".repeat(64), "main"));
    assert.equal((await write(dir, headC)).log.roundCause, "developer_findings");
  });
});

test("W7 an aborted intermediate write is no round and the judged write derives the same cause", async () => {
  await withTempDir(async (dir) => {
    await write(dir, A);
    const intermediate = await write(dir, B, { findings: JSON.stringify([{ severity: "low", angle: "scope", summary: "x" }]) });
    assert.equal(intermediate.log.roundIdentity.completed, false);
    assert.equal(intermediate.log.roundCause, "developer_findings");
    const judged = await write(dir, B);
    assert.equal(judged.log.roundCause, "developer_findings");
    assert.equal(judged.retainedRound, undefined);
  });
});

test("W8 a repeated judged write of one round keeps the cause of the first write", async () => {
  await withTempDir(async (dir) => {
    await write(dir, A);
    const plan = path.join(dir, "judge-emit-plan.json");
    const execDir = path.join(dir, "j1730000000000-deadbeef");
    await mkdir(execDir, { recursive: true });
    await writeFile(plan, JSON.stringify({ roundId: "j1730000000000-deadbeef", workOrder: { target: { repo: "o/r", pr: 1 }, roundIdentity: { gate: "draft_gate", headSha: B }, headSha: B } }));
    const judgeVerdict = path.join(execDir, "judge-verdict.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: B, scopeDrift: { verdict: "within_scope", rationale: "in scope", driftedAreas: [] },
      dispositions: [{ index: 0, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "x", criterion: "AC-1" }],
    }));
    const unjudged = JSON.stringify([{ severity: "low", angle: "scope", summary: "x" }]);
    const first = await write(dir, B, { findings: unjudged, judgeVerdict });
    const again = await write(dir, B, { findings: unjudged, judgeVerdict });
    assert.equal(first.log.roundCause, "developer_findings");
    assert.equal(again.log.roundCause, first.log.roundCause);
  });
});

test("W9 a rejudge keeps the live roundCause", async () => {
  await withTempDir(async (dir) => {
    await write(dir, A);
    const second = await write(dir, B);
    assert.equal(second.log.roundCause, "developer_findings");
    const rejudged = await write(dir, B, { findings: JSON.stringify([{ severity: "low", angle: "scope", summary: "x", judgeDisposition: "act", remedyKind: "pr_body" }]), rejudgeSameRound: true });
    assert.equal(rejudged.log.roundCause, "developer_findings");
    assert.equal((await liveLedger(dir, B)).roundCause, "developer_findings");
  });
});

test("W10 a blocked prior ledger is ignored", async () => {
  await withTempDir(async (dir) => {
    await write(dir, A, { verdict: "blocked" });
    assert.equal((await write(dir, B)).log.roundCause, "first");
  });
});

const clean = (dir, headSha, extra = {}) => write(dir, headSha, { verdict: "clean", findings: "[]", ...extra });
const ledgerFile = (dir, gate, headSha, round) => path.join(dir, "gate-findings", "o-r", "pr-1", `${gate}-${headSha}${round ? `.round-${round}` : ""}.json`);
const tamper = async (file) => writeFile(file, `${await readFile(file, "utf8")} `);
const retire = async (dir, headSha, extra = {}) => {
  const round = path.join(dir, "retired-gate-rounds", headSha, "r1");
  await mkdir(round, { recursive: true });
  await writeFile(path.join(round, "retirement.json"), JSON.stringify({ gate: "draft_gate", retiredAt: "2026-11-22T00:00:00.000Z", ...extra }));
};

test("W11 a later head after a clean round is other_head_move", async () => {
  await withTempDir(async (dir) => {
    await clean(dir, A);
    assert.equal((await clean(dir, B)).log.roundCause, "other_head_move");
  });
});

test("W12 a rerun after a retirement before any ledger write is system_rerun, and a scoped retirement is body_only", async () => {
  await withTempDir(async (dir) => {
    await clean(dir, A);
    await retire(dir, B);
    assert.equal((await clean(dir, B)).log.roundCause, "system_rerun");
  });
  await withTempDir(async (dir) => {
    await retire(dir, A);
    assert.equal((await clean(dir, A)).log.roundCause, "system_rerun");
  });
  await withTempDir(async (dir) => {
    await clean(dir, A);
    await retire(dir, B, { scopes: ["unit-1"] });
    assert.equal((await clean(dir, B)).log.roundCause, "body_only");
  });
});

test("W13 a rerun after a blocked round at the same head is system_rerun and a blocked round at another head is ignored", async () => {
  await withTempDir(async (dir) => {
    await clean(dir, A);
    await write(dir, B, { verdict: "blocked" });
    assert.equal((await clean(dir, B)).log.roundCause, "system_rerun");
  });
});

test("W14 a seal mismatch on an old ledger of any gate does not block the write and is named in the warning", async () => {
  for (const gate of ["draft_gate", "pre_approval_gate", "review"]) {
    await withTempDir(async (dir) => {
      await clean(dir, A, { gate });
      await tamper(ledgerFile(dir, gate, A));
      const result = await clean(dir, B, { gate });
      assert.equal(result.log.roundCause, "first");
      assert.match(result.warning, new RegExp(`${gate}-${A}\\.json`));
    });
  }
});

test("W15 a seal mismatch on a retained round file does not block the write", async () => {
  await withTempDir(async (dir) => {
    await clean(dir, A);
    await clean(dir, A);
    await tamper(ledgerFile(dir, "draft_gate", A, 1));
    const result = await clean(dir, B);
    assert.match(result.warning, /\.round-1\.json/);
    assert.equal(result.log.roundCause, "other_head_move");
  });
});

test("W16 a repeated judged write of an earlier round keeps its cause after a later head completed", async () => {
  await withTempDir(async (dir) => {
    const plan = path.join(dir, "judge-emit-plan.json");
    const execDir = path.join(dir, "j1730000000000-deadbeef");
    await mkdir(execDir, { recursive: true });
    await writeFile(plan, JSON.stringify({ roundId: "j1730000000000-deadbeef", workOrder: { target: { repo: "o/r", pr: 1 }, roundIdentity: { gate: "draft_gate", headSha: A }, headSha: A } }));
    const judgeVerdict = path.join(execDir, "judge-verdict.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: A, scopeDrift: { verdict: "within_scope", rationale: "in scope", driftedAreas: [] },
      dispositions: [{ index: 0, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "x", criterion: "AC-1" }],
    }));
    const unjudged = JSON.stringify([{ severity: "low", angle: "scope", summary: "x" }]);
    const first = await write(dir, A, { findings: unjudged, judgeVerdict });
    assert.equal(first.log.roundCause, "first");
    await write(dir, B);
    const again = await write(dir, A, { findings: unjudged, judgeVerdict });
    assert.equal(again.log.roundCause, "first");
  });
});
