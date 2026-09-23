import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { parseUpsertCheckpointVerdictCliArgs, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// A judge act list drives the review verdict read from the findings ledger:
// a non-empty act list keeps the round from clean, whatever the severities.

const HEAD = "abc1234000000000000000000000000000000000";

let gitStubDir = null;
let originalPath = null;
let repoRoot = null;
before(async () => {
  // Shadow git on PATH so the cascade's execFileSync git reads stay hermetic.
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-act-list-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  // The repo's own .devloops with fan-out evidence off, so these tests cover
  // only the verdict composition.
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-act-list-repo-"));
  const real = await readFile(path.resolve(".devloops"), "utf8");
  const patched = real.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false");
  assert.notEqual(patched, real);
  await writeFile(path.join(repoRoot, ".devloops"), patched, "utf8");
});
after(async () => {
  if (originalPath !== null) process.env.PATH = originalPath;
  if (gitStubDir) await rm(gitStubDir, { recursive: true, force: true });
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

const finding = (severity, judgeDisposition) => ({
  severity,
  angle: "correctness",
  summary: `${severity} finding judged ${judgeDisposition}`,
  judgeDisposition,
  judgeRationale: "test rationale",
});

async function writeLedger(tempDir, { overallVerdict, findings }) {
  const ledgerPath = path.join(tempDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: HEAD,
    verdict: overallVerdict, overallVerdict, loggedAt: "2026-09-23T00:00:00.000Z", findings,
  }), "utf8");
  return ledgerPath;
}

// Answers every gh call the draft_gate ledger path makes and records posted review bodies.
function makeRunChild(posted) {
  const prJson = JSON.stringify({
    number: 17, state: "OPEN", isDraft: true, headRefOid: HEAD, body: DEFAULT_TEST_PR_BODY,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    const a = args.join(" ");
    if (a.includes("pulls/17/reviews") && a.includes("-X POST")) {
      posted.push(String(stdin ?? ""));
      return { code: 0, stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n', stderr: "" };
    }
    if (a.includes("requested_reviewers")) return { code: 0, stdout: '{"users":[],"teams":[]}\n', stderr: "" };
    if (a.includes("api") && a.includes("user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("graphql") && a.includes("reviewThreads")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("graphql")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("issues/17/comments")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("pulls/17/reviews")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("pulls/17/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson, stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

async function post(ledgerPath, verdict, high = 0) {
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
    "--findings-summary", "act list test", "--findings-ledger", ledgerPath,
    "--next-action", "follow the verdict", "--inline-reason", "act list test",
    "--findings-severity-counts", JSON.stringify({ high, medium: high ? 0 : 1, low: high ? 0 : 1, question: 0, nit: 0 }),
  ];
  if (verdict) args.push("--verdict", verdict);
  const posted = [];
  try {
    const result = await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild(posted),
    });
    return { result, body: posted.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

test("medium and low findings with one judged act derive findings_present and refuse an explicit clean", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [finding("medium", "act"), finding("low", "reject")] });
    const derived = await post(ledgerPath);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* findings_present/);
    const explicitClean = await post(ledgerPath, "clean");
    assert.match(explicitClean.error, /--verdict "clean"/);
    assert.match(explicitClean.error, /"findings_present"/);
    assert.match(explicitClean.error, /severity overallVerdict "clean" is composed with 1 open judge act item\(s\) \(ADR 0089\)/);
    const explicitFindings = await post(ledgerPath, "findings_present");
    assert.equal(explicitFindings.error, undefined);
  }, { prefix: "dev-loops-act-list-act-" });
});

test("medium and low findings all rejected or deferred derive clean", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [finding("medium", "reject"), finding("low", "defer")] });
    const derived = await post(ledgerPath);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* clean/);
    assert.equal((await post(ledgerPath, "clean")).error, undefined);
  }, { prefix: "dev-loops-act-list-clean-" });
});

test("a high finding judged reject still keeps the round from clean", async () => {
  await withTempDir(async (tempDir) => {
    // The consolidator's blockCleanOnFindingSeverities floor made this findings_present.
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "findings_present", findings: [finding("high", "reject")] });
    const derived = await post(ledgerPath, undefined, 1);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* findings_present/);
    assert.match((await post(ledgerPath, "clean", 1)).error, /--verdict "clean"/);
  }, { prefix: "dev-loops-act-list-high-" });
});
