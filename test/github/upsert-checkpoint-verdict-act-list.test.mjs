import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function writeLedger(tempDir, { overallVerdict, verdict = overallVerdict, findings, executionMode }) {
  const ledgerPath = path.join(tempDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: HEAD,
    verdict, overallVerdict, loggedAt: "2026-09-23T00:00:00.000Z", findings, executionMode,
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

test("a ledger without overallVerdict refuses an explicit clean over an open act item", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: undefined, verdict: "findings_present", findings: [finding("medium", "act"), finding("low", "reject")] });
    const explicitClean = await post(ledgerPath, "clean");
    assert.match(explicitClean.error, /--verdict "clean"/);
    assert.match(explicitClean.error, /1 open judge act item\(s\)/);
    assert.match(explicitClean.error, /GATE-COMMENT-VERDICT-VALUES, skills\/docs\/gate-review-comment-contract\.md/);
    assert.match(explicitClean.error, /\[medium\] medium finding judged act/);
    assert.equal((await post(ledgerPath, "findings_present")).error, undefined);
  }, { prefix: "dev-loops-act-list-bare-" });
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

test("--findings-json without a ledger refuses an explicit clean over an open act item", async () => {
  await withTempDir(async (tempDir) => {
    const jsonPath = path.join(tempDir, "findings.json");
    await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [finding("low", "act")] }]), "utf8");
    const args = [
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
      "--findings-json", jsonPath, "--next-action", "follow the verdict", "--inline-reason", "act list test",
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }), "--verdict", "clean",
    ];
    await assert.rejects(
      () => upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
        env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild([]),
      }),
      /--verdict "clean".*1 open judge act item\(s\) in --findings-json.*GATE-COMMENT-VERDICT-VALUES.*\[low\] low finding judged act/s,
    );
  }, { prefix: "dev-loops-act-list-json-" });
});

test("--findings-json without a ledger fails closed on a judgeDisposition outside act/defer/reject", async () => {
  await withTempDir(async (tempDir) => {
    const jsonPath = path.join(tempDir, "findings.json");
    await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [finding("low", "bogus")] }]), "utf8");
    const args = [
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
      "--findings-json", jsonPath, "--next-action", "follow the verdict", "--inline-reason", "act list test",
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }), "--verdict", "clean",
    ];
    await assert.rejects(
      () => upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
        env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild([]),
      }),
      /\[low\] low finding judged bogus" carries judgeDisposition "bogus" outside act\/defer\/reject/,
    );
  }, { prefix: "dev-loops-act-list-json-bogus-" });
});

// A nested finding with an empty summary normalizes to an unparseable marker
// that drops judgeDisposition, so the act-list checks must read the raw entry.
async function postUnparseableJson(tempDir, judgeDisposition) {
  const jsonPath = path.join(tempDir, "findings.json");
  await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [{ severity: "low", summary: "", judgeDisposition }] }]), "utf8");
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
    "--findings-json", jsonPath, "--next-action", "follow the verdict", "--inline-reason", "act list test",
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }), "--verdict", "clean",
  ];
  return upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
    env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild([]),
  });
}

test("--findings-json without a ledger refuses an explicit clean over a nested unparseable finding judged act", async () => {
  await withTempDir(async (tempDir) => {
    await assert.rejects(() => postUnparseableJson(tempDir, "act"), /--verdict "clean".*1 open judge act item\(s\).*\[low\] \(unparseable\)/s);
  }, { prefix: "dev-loops-act-list-json-unparseable-" });
});

test("--findings-json without a ledger fails closed on a nested unparseable finding with a bogus judgeDisposition", async () => {
  await withTempDir(async (tempDir) => {
    await assert.rejects(() => postUnparseableJson(tempDir, "bogus"), /\[low\] \(unparseable\)" carries judgeDisposition "bogus" outside act\/defer\/reject/);
  }, { prefix: "dev-loops-act-list-json-unparseable-bogus-" });
});

// A durable log written before the judge pass carries no judgeDisposition.
const preJudgeFinding = { severity: "medium", angle: "correctness", summary: "pre-judge finding" };

async function postWithJson(ledgerPath, jsonPath, extra = []) {
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
    "--findings-ledger", ledgerPath, "--findings-json", jsonPath, "--findings-summary", "act list test",
    "--next-action", "follow the verdict", "--inline-reason", "act list test",
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 1, low: 0, question: 0, nit: 0 }), ...extra,
  ];
  const posted = [];
  try {
    await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild(posted),
    });
    return { body: posted.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

test("a ledger with an unjudged durable log plus an enriched --findings-json with an act item derives findings_present", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding] });
    const jsonPath = path.join(tempDir, "enriched.json");
    await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [finding("medium", "act")] }]), "utf8");
    const derived = await postWithJson(ledgerPath, jsonPath);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* findings_present/);
    assert.match((await postWithJson(ledgerPath, jsonPath, ["--verdict", "clean"])).error, /--verdict "clean".*1 open judge act item\(s\)/s);
    assert.equal((await postWithJson(ledgerPath, jsonPath, ["--verdict", "findings_present"])).error, undefined);
  }, { prefix: "dev-loops-act-list-enriched-" });
});

test("a fan-out round whose ledger findings carry no judgeDisposition is refused without an enriched source", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding] });
    const args = [
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
      "--findings-ledger", ledgerPath, "--findings-summary", "act list test", "--execution-mode", "fanout_fanin",
      "--next-action", "follow the verdict",
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 1, low: 0, question: 0, nit: 0 }),
    ];
    await assert.rejects(
      () => upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
        env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild([]),
      }),
      /1 finding\(s\) with no judgeDisposition, so the judge act list is unknown/,
    );
  }, { prefix: "dev-loops-act-list-unjudged-" });
});

// The ledger's own executionMode (written by write-gate-findings-log) triggers the refusal without --execution-mode.
const unjudgedLedgerMsg = /1 finding\(s\) with no judgeDisposition, so the judge act list is unknown/;

test("a fan-out ledger with unjudged findings refuses a --findings-json that does not cover the unjudged findings", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding], executionMode: "fanout_fanin" });
    const nonEnriched = path.join(tempDir, "non-enriched.json");
    await writeFile(nonEnriched, JSON.stringify([{ angle: "correctness", findings: [preJudgeFinding] }]), "utf8");
    assert.match((await postWithJson(ledgerPath, nonEnriched)).error, unjudgedLedgerMsg);
    const nonAct = path.join(tempDir, "non-act.json");
    await writeFile(nonAct, JSON.stringify([{ angle: "correctness", findings: [{ ...preJudgeFinding, summary: "other", judgeDisposition: "reject" }] }]), "utf8");
    assert.match((await postWithJson(ledgerPath, nonAct)).error, unjudgedLedgerMsg);
  }, { prefix: "dev-loops-act-list-ledger-mode-refuse-" });
});

test("a fan-out ledger plus a judge-enriched --findings-json with an act item derives findings_present", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding], executionMode: "fanout_fanin" });
    const jsonPath = path.join(tempDir, "enriched.json");
    // Under fanout_fanin the --findings-json is the full per-angle input, covering every mandatory angle.
    await writeFile(jsonPath, JSON.stringify([
      { angle: "correctness", findings: [{ ...preJudgeFinding, judgeDisposition: "act", judgeRationale: "r" }] },
      { angle: "pr-description", verdict: "clean", findings: [] },
      { angle: "holistic", verdict: "clean", findings: [] },
    ]), "utf8");
    const derived = await postWithJson(ledgerPath, jsonPath, ["--execution-mode", "fanout_fanin"]);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* findings_present/);
    const inline = await postWithJson(ledgerPath, jsonPath);
    assert.equal(inline.error, undefined);
    assert.match(inline.body, /\*\*Verdict:\*\* findings_present/);
  }, { prefix: "dev-loops-act-list-ledger-mode-enriched-" });
});

test("a fan-out ledger with no --execution-mode flag refuses unjudged findings", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding], executionMode: "fanout_fanin" });
    assert.match((await post(ledgerPath)).error, unjudgedLedgerMsg);
  }, { prefix: "dev-loops-act-list-ledger-mode-" });
});

test("a fan-out ledger with unjudged findings and a same-summary defer-judged --findings-json (padded ledger summary) posts clean", async () => {
  await withTempDir(async (tempDir) => {
    const padded = { ...preJudgeFinding, summary: "  pre-judge finding  " };
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [padded], executionMode: "fanout_fanin" });
    const jsonPath = path.join(tempDir, "deferred.json");
    await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [{ ...preJudgeFinding, judgeDisposition: "defer", judgeRationale: "r" }] }, { angle: "pr-description", verdict: "clean", findings: [] }, { angle: "holistic", verdict: "clean", findings: [] }]), "utf8");
    const derived = await postWithJson(ledgerPath, jsonPath);
    assert.equal(derived.error, undefined);
    assert.match(derived.body, /\*\*Verdict:\*\* clean/);
  }, { prefix: "dev-loops-act-list-ledger-mode-defer-" });
});

test("a ledger with a drifted executionMode is rejected at read", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding], executionMode: "fanout_fanin " });
    assert.match((await post(ledgerPath)).error, /"executionMode" must be "inline_single_agent" or "fanout_fanin"/);
  }, { prefix: "dev-loops-act-list-ledger-mode-drift-" });
});

test("a review-gate post over an unjudged fan-out ledger is not refused for missing judgeDisposition", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = path.join(tempDir, "review-ledger.json");
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo", pr: 17, gate: "review", headSha: HEAD, verdict: "clean", overallVerdict: "clean",
      loggedAt: "2026-09-23T00:00:00.000Z", findings: [preJudgeFinding], executionMode: "fanout_fanin",
    }), "utf8");
    const args = [
      "--repo", "owner/repo", "--pr", "17", "--gate", "review", "--head-sha", HEAD, "--submit", "comment",
      "--inline-reason", "review gate runs no judge",
      "--findings-ledger", ledgerPath, "--findings-summary", "act list test", "--next-action", "follow the verdict",
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 1, low: 0, question: 0, nit: 0 }),
    ];
    let message = "";
    try {
      await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
        env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild([]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.doesNotMatch(message, unjudgedLedgerMsg);
    assert.doesNotMatch(message, /--inline-reason is required/);
  }, { prefix: "dev-loops-act-list-review-gate-" });
});

test("a fan-out ledger with no --execution-mode is not refused as an inline post under requireFanoutEvidence", async () => {
  await withTempDir(async (tempDir) => {
    const strictRoot = path.join(tempDir, "strict-repo");
    await mkdir(strictRoot);
    await writeFile(path.join(strictRoot, ".devloops"), await readFile(path.resolve(".devloops"), "utf8"), "utf8");
    const ledgerPath = await writeLedger(tempDir, { overallVerdict: "clean", findings: [preJudgeFinding], executionMode: "fanout_fanin" });
    const args = [
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
      "--findings-ledger", ledgerPath, "--findings-summary", "act list test", "--next-action", "follow the verdict",
      "--inline-reason", "parser default needs a reason",
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 1, low: 0, question: 0, nit: 0 }),
    ];
    let message = "";
    try {
      await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
        env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot: strictRoot, runChild: makeRunChild([]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.doesNotMatch(message, /Cannot post a inline_single_agent/);
  }, { prefix: "dev-loops-act-list-real-config-" });
});
