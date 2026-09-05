import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseJudgePassCliArgs,
  runJudgePass,
  validateCliArgs,
} from "../../scripts/loop/judge-pass.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";

const HEAD = "0123456789abcdef";
const HEAD_8 = HEAD.slice(0, 8);

function ledger(...findings) {
  return findings;
}

function finding(over = {}) {
  return {
    severity: "high",
    angle: "correctness",
    summary: "a defect",
    disposition: "accepted-for-fix",
    ...over,
  };
}

function verdict({ headSha = HEAD, dispositions = [], scopeDrift } = {}) {
  return {
    headSha,
    scopeDrift: scopeDrift ?? { verdict: "within_scope", rationale: "within AC", driftedAreas: [] },
    dispositions:
      dispositions.length > 0
        ? dispositions
        : [
            { index: 0, disposition: "act", rationale: "fixes AC-1" },
          ],
  };
}

test("runJudgePass derives the fixer act list and scopeDrift verdict (#1658)", () => {
  const findings = ledger(
    finding({ summary: "in-scope defect" }),
    finding({ severity: "low", summary: "real but follow-up", disposition: "deferred" }),
    finding({ severity: "medium", summary: "out of non-goal", disposition: "deferred" }),
    finding(),
  );
  const v = verdict({
    dispositions: [
      { index: 0, disposition: "act", rationale: "fixes AC-1", criterion: "AC-1" },
      { index: 1, disposition: "defer", rationale: "belongs in follow-up", followUpDraft: { title: "t", body: "b" } },
      { index: 2, disposition: "reject", rationale: "out of non-goal NG-2", criterion: "NG-2" },
      { index: 3, disposition: "defer", rationale: "duplicate of round 1", followUpDraft: { title: "t", body: "b" } },
    ],
  });
  const result = runJudgePass(findings, v, HEAD);
  assert.equal(result.act.length, 1);
  assert.equal(result.act[0].summary, "in-scope defect");
  assert.equal(result.act[0].judgeDisposition, "act");
  assert.equal(result.act[0].judgeCriterion, "AC-1");
  assert.equal(result.enriched.length, 4);
  assert.equal(result.enriched[1].judgeDisposition, "defer");
  assert.deepEqual(result.enriched[1].followUpDraft, { title: "t", body: "b" });
  assert.equal(result.enriched[2].judgeDisposition, "reject");
  assert.deepEqual(result.counts, { act: 1, defer: 2, reject: 1 });
  assert.equal(result.scopeDrift.verdict, "within_scope");
});

test("runJudgePass leaves the severity-based disposition intact (relevance axis, #1525)", () => {
  const findings = ledger(finding({ disposition: "accepted-for-fix" }), finding({ disposition: "deferred" }));
  const v = verdict({
    dispositions: [
      { index: 0, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } },
      { index: 1, disposition: "act", rationale: "in scope now" },
    ],
  });
  const result = runJudgePass(findings, v, HEAD);
  // The severity-derived disposition is complementary, not replaced.
  assert.equal(result.enriched[0].disposition, "accepted-for-fix");
  assert.equal(result.enriched[0].judgeDisposition, "defer");
  assert.equal(result.enriched[1].disposition, "deferred");
  assert.equal(result.enriched[1].judgeDisposition, "act");
});

test("runJudgePass fails closed on a stale verdict headSha (#1658)", () => {
  const findings = ledger(finding());
  const stale = verdict({ headSha: "deadbeef" });
  assert.throws(
    () => runJudgePass(findings, stale, HEAD),
    /headSha.*does not match current head/i,
  );
});

test("runJudgePass fails closed on a malformed verdict artifact (validateJudgeVerdict)", () => {
  const findings = ledger(finding());
  assert.throws(() => runJudgePass(findings, { headSha: HEAD }, HEAD), /scopeDrift must be an object/);
  assert.throws(() => runJudgePass(findings, [], HEAD), /judge verdict must be a JSON object/);
});

test("runJudgePass fails closed on an out-of-range disposition index", () => {
  const findings = ledger(finding());
  const v = verdict({ dispositions: [{ index: 5, disposition: "act", rationale: "nope" }] });
  assert.throws(() => runJudgePass(findings, v, HEAD), /out of range/);
});

test("runJudgePass fails closed when the verdict does not dispose every finding (#1658)", () => {
  // Disposition covers array position 0 only; position 1 is undisposed and
  // must fail closed rather than silently drop out of the fixer act list.
  // The findings' own vestigial `index` fields are deliberately set to NOT
  // coincide with array position, so a regression that reports the stale
  // `f.index` field instead of the 0-based array position is caught here.
  const findings = ledger(finding({ index: 7 }), finding({ index: 9, summary: "undisposed" }));
  const v = verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "in scope" }] });
  assert.throws(() => runJudgePass(findings, v, HEAD), /does not dispose 1 finding\(s\) \(indexes: 1\)/);
});

test("validateCliArgs accepts a full invocation and canonicalizes the gate", () => {
  const opts = parseJudgePassCliArgs([
    "--repo", "mfittko/dev-loops",
    "--pr", "1658",
    "--gate", "PRE_APPROVAL_GATE",
    "--head-sha", HEAD_8,
    "--findings-file", "tmp/ledger.json",
    "--judge-verdict", "tmp/gate-judge/judge-verdict.json",
    "--out", "tmp/act.json",
  ]);
  assert.equal(opts.gate, "pre_approval_gate");
  assert.equal(opts.headSha, HEAD_8.toLowerCase());
  assert.equal(opts.repo, "mfittko/dev-loops");
});

test("validateCliArgs fails closed on bad gate / head-sha / missing required", () => {
  assert.throws(
    () =>
      parseJudgePassCliArgs([
        "--repo", "mfittko/dev-loops",
        "--pr", "1",
        "--gate", "bogus",
        "--head-sha", HEAD,
        "--findings-file", "a",
        "--judge-verdict", "b",
      ]),
    /--gate must be one of/,
  );
  assert.throws(
    () =>
      parseJudgePassCliArgs([
        "--repo", "mfittko/dev-loops",
        "--pr", "1",
        "--gate", "draft_gate",
        "--head-sha", "not-a-sha",
        "--findings-file", "a",
        "--judge-verdict", "b",
      ]),
    /--head-sha must be a 7-64 char hex SHA/,
  );
  assert.throws(
    () => validateCliArgs({ repo: "mfittko/dev-loops", pr: "1" }),
    /Missing required arguments/,
  );
});

test("validateCliArgs rejects empty-string path flags and pairwise collisions", () => {
  const base = ["--repo", "mfittko/dev-loops", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD];
  assert.throws(
    () => parseJudgePassCliArgs([...base, "--findings-file", "", "--judge-verdict", "b"]),
    /--findings-file requires a non-empty value/,
  );
  assert.throws(
    () => parseJudgePassCliArgs([...base, "--findings-file", "a", "--judge-verdict", ""]),
    /--judge-verdict requires a non-empty value/,
  );
  assert.throws(
    () => parseJudgePassCliArgs([...base, "--findings-file", "a", "--judge-verdict", "b", "--out", "x", "--ledger-out", "x"]),
    /--out and --ledger-out must be different paths/,
  );
  assert.throws(
    () => parseJudgePassCliArgs([...base, "--findings-file", "a", "--judge-verdict", "a"]),
    /--findings-file and --judge-verdict must be different paths/,
  );
});

test("judgePassCli resolves a relative findings-file against repo-root (#1658)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-root-"));
  await writeFile(
    path.join(tmpDir, "ledger.json"),
    JSON.stringify({ overallVerdict: "findings_present", findings: [finding({ summary: "resolve me" })] }),
  );
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "in scope" }] })),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  // Run from a cwd that is NOT tmpDir (<repo-root>); findings/judge/out are all
  // relative and must resolve against tmpDir, not the process cwd.
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops",
      pr: "1658",
      gate: "draft_gate",
      headSha: HEAD,
      findingsFile: "./ledger.json",
      judgeVerdict: "./judge-verdict.json",
      out: "./act.json",
      ledgerOut: "./enriched.json",
    },
    { repoRoot: tmpDir },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.actCount, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(tmpDir, "act.json"), "utf8")).length, 1);
  assert.equal(JSON.parse(await readFile(path.join(tmpDir, "enriched.json"), "utf8")).findings[0].judgeDisposition, "act");
});

// #1807: a `defer` disposition creates (or appends to) the PR's ONE tracked
// follow-up GitHub issue. Stub `createIssue`/`commentIssue` — the same
// dependency-injection seam create-issue.test.mjs/comment-issue.test.mjs stub
// — so this never hits the real API.
function stubIssueDeps({ issueNumber = 9001, existingGithubIssues = [] } = {}) {
  const createCalls = [];
  const commentCalls = [];
  const listCalls = [];
  const createIssue = async (opts) => {
    createCalls.push(opts);
    return { ok: true, issueNumber, url: `https://github.com/${opts.repo}/issues/${issueNumber}` };
  };
  const commentIssue = async (opts) => {
    commentCalls.push(opts);
    return { ok: true, repo: opts.repo, issue: opts.issue, commentUrl: `https://github.com/${opts.repo}/issues/${opts.issue}#issuecomment-1` };
  };
  // #1809: ensureFollowUpIssue now searches GitHub before creating whenever the
  // caller's own local ledger cache doesn't already know a follow-up issue
  // number — stub it to "no match" by default (returning `existingGithubIssues`
  // otherwise) so a test never hits the real API.
  const listIssues = async (opts) => {
    listCalls.push(opts);
    return { ok: true, issues: existingGithubIssues };
  };
  return { createIssue, commentIssue, listIssues, createCalls, commentCalls, listCalls };
}

test("judgePassCli writes the act list and enriched ledger for a wrapped ledger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");
  const verdictPath = path.join(tmpDir, "judge-verdict.json");
  const actPath = path.join(tmpDir, "act.json");
  const outLedgerPath = path.join(tmpDir, "enriched.json");
  await writeFile(
    ledgerPath,
    JSON.stringify({
      overallVerdict: "findings_present",
      findings: [finding({ summary: "fix this" }), finding({ summary: "defer this", severity: "medium" })],
    }),
  );
  await writeFile(
    verdictPath,
    JSON.stringify(
      verdict({
        dispositions: [
          { index: 0, disposition: "act", rationale: "in scope" },
          { index: 1, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } },
        ],
      }),
    ),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { createIssue, commentIssue, listIssues, createCalls, commentCalls } = stubIssueDeps();
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops",
      pr: "1658",
      gate: "draft_gate",
      headSha: HEAD,
      findingsFile: ledgerPath,
      judgeVerdict: verdictPath,
      out: actPath,
      ledgerOut: outLedgerPath,
    },
    { repoRoot: tmpDir, createIssue, commentIssue, listIssues },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.actCount, 1);
  assert.deepEqual(payload.scopeDrift, { verdict: "within_scope", rationale: "within AC", driftedAreas: [] });
  const act = JSON.parse(await readFile(actPath, "utf8"));
  assert.equal(act.length, 1);
  assert.equal(act[0].summary, "fix this");
  const enriched = JSON.parse(await readFile(outLedgerPath, "utf8"));
  assert.equal(enriched.overallVerdict, "findings_present");
  assert.equal(enriched.findings[0].judgeDisposition, "act");
  assert.strictEqual(typeof enriched.findings[0].fingerprint, "string");
  assert.equal(enriched.findings[1].judgeDisposition, "defer");
  assert.equal(enriched.findings[1].followUpIssueNumber, 9001);
  assert.equal(enriched.scopeDrift.verdict, "within_scope");
  // ONE issue created for the round's batch of defers; no comment-append call
  // on a first-ever run (nothing prior to append to).
  assert.equal(createCalls.length, 1);
  assert.equal(commentCalls.length, 0);
  assert.match(createCalls[0].body, /defer this/);
});

// #1807 idempotency: re-running the pass over the SAME --ledger-out path
// (a retry, or the next round re-linking the same PR) must not create a
// duplicate issue for a finding it already linked.
test("judgePassCli defer is idempotent across a re-run: the already-linked finding reuses its issue with no gh call", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-idempotent-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");
  const verdictPath = path.join(tmpDir, "judge-verdict.json");
  const outLedgerPath = path.join(tmpDir, "enriched.json");
  const deferredFinding = finding({ summary: "defer this", severity: "medium" });
  await writeFile(ledgerPath, JSON.stringify({ overallVerdict: "findings_present", findings: [deferredFinding] }));
  await writeFile(
    verdictPath,
    JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } }] })),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const first = stubIssueDeps({ issueNumber: 4242 });
  await judgePassCli(
    { repo: "mfittko/dev-loops", pr: "1658", gate: "draft_gate", headSha: HEAD, findingsFile: ledgerPath, judgeVerdict: verdictPath, ledgerOut: outLedgerPath },
    { repoRoot: tmpDir, createIssue: first.createIssue, commentIssue: first.commentIssue, listIssues: first.listIssues },
  );
  assert.equal(first.createCalls.length, 1);

  // Re-run with the SAME inputs (same fresh findings-file, same verdict) —
  // the prior enriched.json already links fingerprint -> 4242.
  const second = stubIssueDeps({ issueNumber: 9999 });
  await judgePassCli(
    { repo: "mfittko/dev-loops", pr: "1658", gate: "draft_gate", headSha: HEAD, findingsFile: ledgerPath, judgeVerdict: verdictPath, ledgerOut: outLedgerPath },
    { repoRoot: tmpDir, createIssue: second.createIssue, commentIssue: second.commentIssue, listIssues: second.listIssues },
  );
  assert.equal(second.createCalls.length, 0, "no duplicate issue created on re-run");
  assert.equal(second.commentCalls.length, 0, "nothing new to append on a pure retry");
  assert.equal(second.listCalls.length, 0, "a pure retry with a known prior issue number never searches GitHub");
  const enriched = JSON.parse(await readFile(outLedgerPath, "utf8"));
  assert.equal(enriched.findings[0].followUpIssueNumber, 4242, "reuses the FIRST run's issue number");
});

// #1807 AC3: a `reject` disposition records fingerprint/severity/angle in the
// ledger and creates no issue.
test("judgePassCli reject records a fingerprint audit entry and creates no issue", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-reject-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");
  const verdictPath = path.join(tmpDir, "judge-verdict.json");
  const outLedgerPath = path.join(tmpDir, "enriched.json");
  await writeFile(ledgerPath, JSON.stringify({ overallVerdict: "findings_present", findings: [finding({ summary: "out of scope" })] }));
  await writeFile(verdictPath, JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "reject", rationale: "below the defer bar", criterion: "NG-1" }] })));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { createIssue, commentIssue, listIssues, createCalls, commentCalls } = stubIssueDeps();
  await judgePassCli(
    { repo: "mfittko/dev-loops", pr: "1658", gate: "draft_gate", headSha: HEAD, findingsFile: ledgerPath, judgeVerdict: verdictPath, ledgerOut: outLedgerPath },
    { repoRoot: tmpDir, createIssue, commentIssue, listIssues },
  );
  assert.equal(createCalls.length, 0);
  assert.equal(commentCalls.length, 0);
  const enriched = JSON.parse(await readFile(outLedgerPath, "utf8"));
  const [entry] = enriched.findings;
  assert.equal(entry.judgeDisposition, "reject");
  assert.equal(typeof entry.fingerprint, "string");
  assert.equal(entry.severity, "high");
  assert.equal(entry.angle, "correctness");
  assert.equal(entry.followUpIssueNumber, undefined);
});

// #1809: cross-path convergence — close-gate-findings.mjs's severity/round
// defer may have already created this PR's follow-up issue via a thread
// marker judge-pass never sees. judge-pass's OWN --ledger-out cache is empty
// (first-ever run of THIS pass), so it must resolve the existing issue via
// GitHub itself rather than mint a duplicate.
test("judgePassCli: no local prior issue, but GitHub already has this PR's follow-up issue — appends instead of creating a duplicate", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-cross-path-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");
  const verdictPath = path.join(tmpDir, "judge-verdict.json");
  const outLedgerPath = path.join(tmpDir, "enriched.json");
  await writeFile(ledgerPath, JSON.stringify({ overallVerdict: "findings_present", findings: [finding({ summary: "defer this", severity: "low" })] }));
  await writeFile(verdictPath, JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } }] })));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { createIssue, commentIssue, listIssues, createCalls, commentCalls, listCalls } = stubIssueDeps({
    existingGithubIssues: [{ number: 6500, title: "Deferred gate findings for mfittko/dev-loops#1658", state: "open", labels: [] }],
  });
  await judgePassCli(
    { repo: "mfittko/dev-loops", pr: "1658", gate: "draft_gate", headSha: HEAD, findingsFile: ledgerPath, judgeVerdict: verdictPath, ledgerOut: outLedgerPath },
    { repoRoot: tmpDir, createIssue, commentIssue, listIssues },
  );
  assert.equal(createCalls.length, 0, "must not create a duplicate — close-gate-findings already created one");
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issue, 6500);
  assert.equal(listCalls.length, 1, "searches GitHub exactly once since the local cache is empty");
  const enriched = JSON.parse(await readFile(outLedgerPath, "utf8"));
  assert.equal(enriched.findings[0].followUpIssueNumber, 6500);
});

// #1809 finding 4 (coverage gap): the branch where a prior --ledger-out
// already links a follow-up issue AND this round defers a NEW (not
// previously linked) finding — must append to that same issue via
// commentIssue, using the local fast path (no GitHub search needed since the
// issue number is already known).
test("judgePassCli: a NEW deferral in a later round appends to the PR's already-linked follow-up issue (no search, no duplicate)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-append-round-"));
  const ledgerPath = path.join(tmpDir, "ledger.json");
  const verdictPath = path.join(tmpDir, "judge-verdict.json");
  const outLedgerPath = path.join(tmpDir, "enriched.json");
  // Simulate a prior round's own output: one finding already linked to issue 7000.
  const priorFinding = finding({ summary: "already deferred", severity: "low" });
  await writeFile(outLedgerPath, JSON.stringify({
    overallVerdict: "findings_present",
    findings: [{ ...priorFinding, judgeDisposition: "defer", fingerprint: fingerprintFinding(priorFinding), followUpIssueNumber: 7000 }],
  }));
  // This round's fresh findings-file carries a DIFFERENT finding (distinct
  // summary -> distinct fingerprint), disposed defer.
  await writeFile(ledgerPath, JSON.stringify({ overallVerdict: "findings_present", findings: [finding({ summary: "a new finding to defer", severity: "low" })] }));
  await writeFile(verdictPath, JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } }] })));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { createIssue, commentIssue, listIssues, createCalls, commentCalls, listCalls } = stubIssueDeps();
  await judgePassCli(
    { repo: "mfittko/dev-loops", pr: "1658", gate: "draft_gate", headSha: HEAD, findingsFile: ledgerPath, judgeVerdict: verdictPath, ledgerOut: outLedgerPath },
    { repoRoot: tmpDir, createIssue, commentIssue, listIssues },
  );
  assert.equal(createCalls.length, 0, "must not create a second issue for the same PR");
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issue, 7000);
  assert.equal(listCalls.length, 0, "the local ledger already knows the issue number — no GitHub search needed");
  const enriched = JSON.parse(await readFile(outLedgerPath, "utf8"));
  assert.equal(enriched.findings[0].followUpIssueNumber, 7000);
});

// --- Immutable spec-authority enforcement (opt-in via --spec-file) ---

const SPEC_FIXTURE = {
  acceptanceCriteria: ["Remove repetitive A/B contrast scaffolding", "Ship a demo"],
  definitionOfDone: ["npm run verify passes"],
  nonGoals: ["Do not flatten the decks' voice"],
};

async function specDigests(content = "reviewed-impl") {
  const { computeSpecDigest, computeContentDigest, specCriterionIds } = await import(
    "@dev-loops/core/loop/spec-authority"
  );
  return {
    specDigest: computeSpecDigest(SPEC_FIXTURE),
    contentDigest: computeContentDigest(content),
    criterionIds: specCriterionIds(SPEC_FIXTURE),
  };
}

async function writeSpecAuthorityCase(tmpDir, { decisions, findings }) {
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: findings.map((_f, i) => ({ index: i, disposition: "act", rationale: "in scope" })) })),
  );
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({ ...decisions.identity, decisions: decisions.list }));
}

function specAuthorityArgs(tmpDir, contentDigest) {
  return [
    {
      repo: "mfittko/dev-loops",
      pr: "2000",
      gate: "pre_approval_gate",
      headSha: HEAD,
      findingsFile: "./ledger.json",
      judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json",
      contentDigest,
      specAuthorityVerdict: "./spec-authority.json",
    },
    { repoRoot: tmpDir },
  ];
}

test("judgePassCli passes when the whole-spec authority verdict is valid", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-ok-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeSpecAuthorityCase(tmpDir, {
    findings: [finding()],
    decisions: {
      identity: { specDigest, headSha: HEAD, contentDigest },
      list: [
        {
          index: 0,
          outcome: "valid_compliant",
          specDigest,
          headSha: HEAD,
          contentDigest,
          checkedCriteria: criterionIds,
          rationale: "finding valid and remedy compliant with the whole spec",
          authorizedRemediation: "apply voice-preserving dedup",
        },
      ],
    },
  });
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(...specAuthorityArgs(tmpDir, contentDigest));
  assert.equal(payload.ok, true);
  assert.equal(payload.specAuthority.specDigest, specDigest);
  assert.equal(payload.specAuthority.outcomeCounts.valid_compliant, 1);
  assert.equal(payload.specAuthority.humanDecisionRequired, false);
});

test("judgePassCli fails closed when a finding needs a human spec decision", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-human-"));
  const { computeSpecDigest, computeContentDigest, specCriterionIds } = await import(
    "@dev-loops/core/loop/spec-authority"
  );
  const specDigest = computeSpecDigest(SPEC_FIXTURE);
  const contentDigest = computeContentDigest("reviewed-impl");
  const criterionIds = specCriterionIds(SPEC_FIXTURE);
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({
      specDigest,
      headSha: HEAD,
      contentDigest,
      decisions: [
        {
          index: 0,
          outcome: "spec_cannot_decide",
          specDigest,
          headSha: HEAD,
          contentDigest,
          checkedCriteria: criterionIds,
          rationale: "spec is internally contradictory on voice vs dedup",
        },
      ],
    }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops",
      pr: "2000",
      gate: "pre_approval_gate",
      headSha: HEAD,
      findingsFile: "./ledger.json",
      judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json",
      contentDigest,
      specAuthorityVerdict: "./spec-authority.json",
    },
    { repoRoot: tmpDir },
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.humanDecisionRequired, true);
  assert.deepEqual(payload.specAuthority.humanDecisionIndices, [0]);
});

test("judgePassCli fails closed on a supportive-only (partial) criterion citation", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-partial-"));
  const { computeSpecDigest, computeContentDigest } = await import("@dev-loops/core/loop/spec-authority");
  const specDigest = computeSpecDigest(SPEC_FIXTURE);
  const contentDigest = computeContentDigest("reviewed-impl");
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({
      specDigest,
      headSha: HEAD,
      contentDigest,
      decisions: [
        {
          index: 0,
          outcome: "valid_compliant",
          specDigest,
          headSha: HEAD,
          contentDigest,
          checkedCriteria: ["ac:0"],
          rationale: "cited one supportive criterion only",
          authorizedRemediation: "x",
        },
      ],
    }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  await assert.rejects(
    judgePassCli(
      {
        repo: "mfittko/dev-loops",
        pr: "2000",
        gate: "pre_approval_gate",
        headSha: HEAD,
        findingsFile: "./ledger.json",
        judgeVerdict: "./judge-verdict.json",
        specFile: "./spec.json",
        contentDigest,
        specAuthorityVerdict: "./spec-authority.json",
      },
      { repoRoot: tmpDir },
    ),
    /whole spec|uncovered|failed validation/,
  );
});

test("validateCliArgs: --spec-file requires --content-digest and --spec-authority-verdict", () => {
  assert.throws(
    () =>
      validateCliArgs({
        repo: "mfittko/dev-loops",
        pr: "2000",
        gate: "pre_approval_gate",
        headSha: HEAD,
        findingsFile: "./ledger.json",
        judgeVerdict: "./judge-verdict.json",
        specFile: "./spec.json",
      }),
    /--content-digest is required/,
  );
});

test("judgePassCli drops a finding_conflicts finding from the act list even if relevance marked it act", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-conflict-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  // Two findings: index 0 relevance-act + spec finding_conflicts (must be dropped);
  // index 1 relevance-act + spec valid_compliant (must stay).
  const findings = [finding({ summary: "conflicts with a non-goal" }), finding({ summary: "legit defect" })];
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: [
      { index: 0, disposition: "act", rationale: "relevance act" },
      { index: 1, disposition: "act", rationale: "relevance act" },
    ] })),
  );
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "finding_conflicts", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, conflictingCriteria: ["ng:0"], rationale: "conflicts with the preserve-voice non-goal" },
      { index: 1, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "valid and compliant", authorizedRemediation: "fix it" },
    ] }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(...specAuthorityArgs(tmpDir, contentDigest));
  assert.equal(payload.ok, true);
  assert.equal(payload.actCount, 1, "the finding_conflicts finding is removed; only the valid_compliant one acts");
  assert.equal(payload.act[0].summary, "legit defect");
  assert.deepEqual(payload.specAuthority.findingConflictIndices, [0]);
});

test("judgePassCli wires resolveCriterionInvalidation: a spec change stales all prior approvals and persists a durable record", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-invalidate-"));
  const { computeSpecDigest } = await import("@dev-loops/core/loop/spec-authority");
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  const findings = [finding()];
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
    ] }),
  );
  // Prior approvals under a DIFFERENT (superseded) specDigest -> all stale.
  const priorDigest = computeSpecDigest({ ...SPEC_FIXTURE, acceptanceCriteria: [...SPEC_FIXTURE.acceptanceCriteria, "old extra"] });
  await writeFile(path.join(tmpDir, "prior.json"), JSON.stringify({ specDigest: priorDigest, headSha: "f".repeat(40), contentDigest, approvedCriteria: criterionIds }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
      priorApprovals: "./prior.json", approvalsOut: "./approvals.json",
    },
    { repoRoot: tmpDir },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.specAuthority.invalidation.specChanged, true);
  assert.deepEqual(payload.specAuthority.invalidation.stale.sort(), [...criterionIds].sort());
  const persisted = JSON.parse(await readFile(path.join(tmpDir, "approvals.json"), "utf8"));
  assert.equal(persisted.specDigest, specDigest);
  assert.deepEqual(persisted.approvedCriteria, criterionIds);
  assert.equal(persisted.invalidation.specChanged, true);
});

test("validateCliArgs: --prior-approvals requires --spec-file", () => {
  assert.throws(
    () => validateCliArgs({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json", priorApprovals: "./prior.json",
    }),
    /--prior-approvals requires --spec-file/,
  );
});
