import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { buildFanoutEnforcement, EVIDENCE_STATE } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { initGitFixture, runIdFreeEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

// GATE-EXEC-LOW-NIT-CONVERGENCE: the server-side gate-evidence check (--skip-fanout-ledger-check) must pass a
// converged PR from GitHub-visible state alone. The temp dir holds no ledger, context, plan or config, so every
// answer below comes from the stubbed PR comments.

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");
const A = "a".repeat(40);
const FIX = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

const gateComment = ({ id, gate, head, converged, at }) => ({
  id,
  body: [
    `Gate review: ${gate}`,
    `Reviewed head SHA: ${head}`,
    "Verdict: clean",
    ...(converged ? [`Converged: ${converged}`] : []),
    "Execution mode: fanout_fanin",
    "Findings summary: no issues found",
    `Next action: ${gate === "draft_gate" ? "mark ready for review" : "await final human approval"}`,
    ...(gate === "pre_approval_gate" ? ["Size-budget outcome: pass", "Size-budget T1 slice: not touched", "Size-budget waiver: none"] : []),
  ].join("\n"),
  updated_at: at,
  html_url: `https://github.com/owner/repo/pull/17#issuecomment-${id}`,
});

const CONVERGED = `fixer ${FIX} delta ${DIGEST}`;
const draftAtA = (converged = CONVERGED) => gateComment({ id: 70, gate: "draft_gate", head: A, converged, at: "2026-10-20T10:00:00Z" });
const preApprovalAtFix = () => gateComment({ id: 71, gate: "pre_approval_gate", head: FIX, at: "2026-10-20T11:00:00Z" });

async function run(comments) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-converged-"));
  try {
    const { env } = await writeGhStubHelper(tempDir, [
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: `{"headRefOid":"${FIX}"}\n` },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: `${JSON.stringify([comments])}\n` },
      { assertArgs: ["api", "graphql"], stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })}\n` },
    ], { repeatLastOnOverflow: true });
    const result = await runNodeHelper(scriptPath, ["--repo", "owner/repo", "--pr", "17", "--skip-fanout-ledger-check"], {
      env: runIdFreeEnv({ ...env, DEVLOOPS_RUN_ID: "" }),
      cwd: tempDir,
    });
    return { code: result.code, payload: JSON.parse(result.code === 0 ? result.stdout : result.stderr.trim().split("\n").at(-1)) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("a converged PR passes the gate-evidence check from GitHub-visible state alone (no ledger, context or plan)", async () => {
  const { code, payload } = await run([draftAtA(), preApprovalAtFix()]);
  assert.equal(code, 0, JSON.stringify(payload));
  assert.deepEqual(payload.preMergeGateCheck.failures, []);
  assert.equal(payload.evidenceState, EVIDENCE_STATE.SATISFIED);
  assert.equal(payload.draftGate.headSha, A);
  assert.deepEqual(payload.draftGate.converged, { fixerCommit: FIX, deltaDigest: DIGEST });
  assert.equal(payload.draftGateMarker.headSha, FIX);
  assert.equal(payload.draftGateMarker.convergedFromHeadSha, A);
});

test("a converged PR without a clean current-head pre_approval_gate still fails", async () => {
  const { code, payload } = await run([draftAtA()]);
  assert.equal(code, 1);
  assert.ok(payload.preMergeGateCheck.failures.includes("missing visible clean current-head pre_approval_gate comment"));
});

test("a malformed converged marker fails closed", async () => {
  for (const converged of [`fixer ${FIX} delta sha256:short`, `fixer ${FIX}`, "nonsense"]) {
    const { code, payload } = await run([draftAtA(converged), preApprovalAtFix()]);
    assert.equal(code, 1, converged);
    assert.ok(payload.preMergeGateCheck.failures.some((f) => /malformed Converged marker/.test(f)), converged);
  }
});

test("without a converged marker the draft_gate at A is not the draft_gate marker of the fixed head", async () => {
  const { payload } = await run([draftAtA(null), preApprovalAtFix()]);
  assert.equal(payload.draftGateMarker.visible, false);
});

test("a converged marker naming another fixer commit is not the draft_gate marker of the fixed head", async () => {
  const { payload } = await run([draftAtA(`fixer ${"e".repeat(40)} delta ${DIGEST}`), preApprovalAtFix()]);
  assert.equal(payload.draftGateMarker.visible, false);
});

// The light-mode scope re-derivation runs against the converged marker's own head B (the fixer commit), not the ledger head A.
test("a fixer commit that touches a risk path cannot ride a converged inline marker", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-scope-"));
  try {
    initGitFixture(repo, { branch: "main" });
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "pr");
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs", "a.md"), "a\n", "utf8");
    git("add", "."); git("commit", "-q", "-m", "A");
    const headA = git("rev-parse", "HEAD");
    await mkdir(path.join(repo, "scripts", "loop"), { recursive: true });
    await writeFile(path.join(repo, "scripts", "loop", "check-size-budget.mjs"), "export {};\n", "utf8");
    git("add", "."); git("commit", "-q", "-m", "B");
    const headB = git("rev-parse", "HEAD");
    const config = { gates: { requireFanoutEvidence: true, draft: { required: true }, preApproval: { required: false } }, localImplementation: { lightMode: { enabled: true } } };
    const gateFor = async (scopeHead) => (await buildFanoutEnforcement({
      repo: "owner/repo", pr: "17", currentHeadSha: headB, config, cwd: repo, baseRef: "main",
      draftGateMarker: { visible: true, headSha: scopeHead, ...(scopeHead === headB ? { convergedFromHeadSha: headA } : {}), executionMode: "inline_single_agent" },
      preApprovalGateMarker: { visible: false },
    })).gates.find((g) => g.name === "draft_gate");
    const gateB = await gateFor(headB);
    assert.equal(gateB.scopeUnderThreshold, false);
    assert.ok(gateB.ledgerPath.includes(headA) && !gateB.ledgerPath.includes(headB), `ledger keyed on head A, got ${gateB.ledgerPath}`);
    assert.equal((await gateFor(headA)).scopeUnderThreshold, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
