import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  parseJudgePassCliArgs,
  runJudgePass,
  validateCliArgs,
} from "../../scripts/loop/judge-pass.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { dedupeActListByCluster } from "@dev-loops/core/loop/finding-cluster";

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

// issue 2156: duplicate root-cause findings (same file:line:recommendation at
// this head) are clustered so the judge's disposition on one member projects
// onto every other member reporting the same root cause.
function locatedFinding(over = {}) {
  return finding({ file: "src/x.mjs", line: 10, recommendation: "add a null guard", ...over });
}

test("runJudgePass projects the representative's judge disposition onto every duplicate-root-cause member (#2156)", () => {
  const findings = ledger(
    locatedFinding({ angle: "correctness", summary: "null deref (angle A)" }),
    locatedFinding({ angle: "security", summary: "null deref (angle B)" }),
    finding({ summary: "distinct finding" }),
  );
  const v = verdict({
    dispositions: [
      { index: 0, disposition: "act", rationale: "fixes AC-1", criterion: "AC-1" },
      { index: 1, disposition: "reject", rationale: "duplicate, judge saw it independently" },
      { index: 2, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } },
    ],
  });
  const result = runJudgePass(findings, v, HEAD);
  // Both cluster members carry the REPRESENTATIVE's (index 0) disposition.
  assert.equal(result.enriched[0].judgeDisposition, "act");
  assert.equal(result.enriched[1].judgeDisposition, "act");
  assert.equal(result.enriched[1].judgeRationale, "fixes AC-1");
  assert.equal(result.enriched[1].judgeCriterion, "AC-1");
  assert.equal(result.enriched[2].judgeDisposition, "defer");
  assert.equal(result.counts.act, 2, "the raw tally counts every acted finding, one per reviewer report");
  assert.equal(result.act.length, 2);
});

// FIX 1 (#2156, Copilot round 2): applied.findings' recommendation/file text
// may already have been TRUNCATED by the ledger pipeline (consolidate-fanin
// truncates AFTER it clusters on lossless pre-truncation text and stamps
// `clusterId`). runJudgePass must consume that stamp, not recompute the
// cluster key from the (possibly truncated) ledger text.
test("runJudgePass consumes the stamped clusterId rather than recomputing from (truncated) recommendation text (#2156 FIX 1)", () => {
  const findings = ledger(
    // Same stamped clusterId (0), but DIFFERENT recommendation text — as if
    // truncation diverged their tails after the lossless cluster was formed.
    // A recompute would treat these as two separate root causes; consuming
    // the stamp still collapses them into one cluster.
    locatedFinding({ angle: "correctness", summary: "null deref (angle A)", recommendation: "add a null guard AAA", clusterId: 0 }),
    locatedFinding({ angle: "security", summary: "null deref (angle B)", recommendation: "add a null guard BBB", clusterId: 0 }),
    // IDENTICAL recommendation text but DISTINCT stamped clusterIds — a
    // recompute would wrongly merge these; consuming the stamp keeps them
    // separate clusters.
    locatedFinding({ angle: "performance", summary: "distinct root cause C", recommendation: "shared truncated tail", clusterId: 2 }),
    locatedFinding({ angle: "style", summary: "distinct root cause D", recommendation: "shared truncated tail", clusterId: 3 }),
  );
  const v = verdict({
    dispositions: [
      { index: 0, disposition: "act", rationale: "fixes AC-1", criterion: "AC-1" },
      { index: 1, disposition: "act", rationale: "fixes AC-1 too" },
      { index: 2, disposition: "act", rationale: "fixes AC-2" },
      { index: 3, disposition: "act", rationale: "fixes AC-2 too" },
    ],
  });
  const result = runJudgePass(findings, v, HEAD);
  // Three clusters: {0,1} (shared stamp, different text), {2}, {3} (distinct
  // stamps, identical text) — grouped strictly by the stamped clusterId.
  assert.equal(result.clusters.length, 3);
  const clusterOf = (index) => result.clusters.find((c) => c.memberIndices.includes(index));
  assert.deepEqual(clusterOf(0).memberIndices, [0, 1]);
  assert.deepEqual(clusterOf(2).memberIndices, [2]);
  assert.deepEqual(clusterOf(3).memberIndices, [3]);
  // Raw tally still counts every acted finding, one per reviewer report.
  assert.equal(result.act.length, 4);
  const deduped = dedupeActListByCluster(result.act, result.clusters, result.enriched);
  // Same stamped clusterId (0/1) collapses to ONE remediation; distinct
  // stamped clusterIds (2, 3) stay TWO — regardless of the (truncated)
  // recommendation text.
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].summary, "null deref (angle A)");
  assert.equal(deduped[1].summary, "distinct root cause C");
  assert.equal(deduped[2].summary, "distinct root cause D");
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

test("judgePassCli --out is deduped to one remediation per acted cluster; --ledger-out keeps every acted finding (#2156)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-dedup-"));
  await writeFile(
    path.join(tmpDir, "ledger.json"),
    JSON.stringify({
      overallVerdict: "findings_present",
      findings: [
        locatedFinding({ angle: "correctness", summary: "null deref (angle A)" }),
        locatedFinding({ angle: "security", summary: "null deref (angle B)" }),
        finding({ summary: "distinct finding" }),
        finding({ severity: "low", summary: "out of scope for this PR", disposition: "deferred" }),
      ],
    }),
  );
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(
      verdict({
        dispositions: [
          { index: 0, disposition: "act", rationale: "fixes AC-1", criterion: "AC-1" },
          { index: 1, disposition: "reject", rationale: "duplicate" },
          { index: 2, disposition: "act", rationale: "also in scope" },
          { index: 3, disposition: "defer", rationale: "valid but out of scope", followUpDraft: { title: "t", body: "b" } },
        ],
      }),
    ),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  // Index 3 defers with a followUpDraft, which drives applyDeferralComment; stub
  // the gh deps (as the sibling tests do) so it never hits the real GitHub
  // API.
  const { deps } = stubDeferralDeps();
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops",
      pr: "1",
      gate: "draft_gate",
      headSha: HEAD,
      findingsFile: "./ledger.json",
      judgeVerdict: "./judge-verdict.json",
      out: "./act.json",
      ledgerOut: "./enriched.json",
    },
    { repoRoot: tmpDir, ...deps },
  );
  assert.equal(payload.ok, true);
  // Raw tally: both duplicate-cluster members (0, 1 via projection) plus the
  // distinct finding (2) were all acted on — one entry per reviewer report.
  assert.equal(payload.actCount, 3);
  const writtenAct = JSON.parse(await readFile(path.join(tmpDir, "act.json"), "utf8"));
  // Deduped fixer act list: exactly one entry per acted root cause.
  assert.equal(writtenAct.length, 2);
  assert.equal(writtenAct[0].summary, "null deref (angle A)");
  assert.equal(writtenAct[1].summary, "distinct finding");
  const enrichedLedger = JSON.parse(await readFile(path.join(tmpDir, "enriched.json"), "utf8"));
  // The durable ledger is NOT deduped — every acted finding is still present.
  assert.equal(enrichedLedger.findings.filter((f) => f.judgeDisposition === "act").length, 3);
});

// #2246: a "clean" consolidator verdict means no BLOCKING-severity finding
// remains open (this repo blocks clean only on "high"). Under
// GATE-EXEC-BLOCKING-ONLY-FIX the fix cycle still acts on non-blocking findings
// (mediums in the fix window, triaged lows), so a clean verdict routinely
// carries non-blocking act findings and MUST NOT fail closed — it must produce
// the fixer act list and the enriched ledger like any other round. This
// reproduces the PR 2243 draft_gate round (consolidator clean, judge acts on
// mediums/lows only).
test("judgePassCli accepts a clean verdict whose acts are all non-blocking, producing the act list and ledger (#2246)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-clean-nonblocking-"));
  await writeFile(
    path.join(tmpDir, "ledger.json"),
    JSON.stringify({
      overallVerdict: "clean",
      findings: [
        finding({ severity: "medium", summary: "medium worth fixing now" }),
        finding({ severity: "low", summary: "cheap polish" }),
      ],
    }),
  );
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: [
      { index: 0, disposition: "act", rationale: "in the medium fix window" },
      { index: 1, disposition: "act", rationale: "fix while touching this code" },
    ] })),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops",
      pr: "2243",
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
  assert.equal(payload.actCount, 2);
  assert.equal(JSON.parse(await readFile(path.join(tmpDir, "act.json"), "utf8")).length, 2);
  assert.equal(
    JSON.parse(await readFile(path.join(tmpDir, "enriched.json"), "utf8")).findings.filter((f) => f.judgeDisposition === "act").length,
    2,
  );
});

// #2246: the fail-closed half of the same rule — a clean verdict with an act on
// a BLOCKING severity (high, in this repo's block set) is genuinely invalid: an
// acted high is unresolved blocking work, so the round cannot be clean.
test("judgePassCli fails closed when a clean verdict carries an act on a blocking severity (#2246)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-clean-blocking-act-"));
  await writeFile(
    path.join(tmpDir, "ledger.json"),
    JSON.stringify({ overallVerdict: "clean", findings: [finding({ severity: "high", summary: "blocking defect" })] }),
  );
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "must fix now" }] })),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  await assert.rejects(
    judgePassCli(
      {
        repo: "mfittko/dev-loops",
        pr: "1",
        gate: "draft_gate",
        headSha: HEAD,
        findingsFile: "./ledger.json",
        judgeVerdict: "./judge-verdict.json",
        out: "./act.json",
        ledgerOut: "./enriched.json",
      },
      { repoRoot: tmpDir },
    ),
    /clean verdict is invalid with .* at a blocking severity/,
  );
});

// #2246: end-to-end proof that judge-pass reads the gate's CONFIGURED
// blockCleanOnFindingSeverities and maps the gate name to the right config key
// (draft_gate->draft, else->preApproval). A repo that widens its block set to
// include `medium` must fail closed on a clean verdict with a medium act — the
// guard-level unit test covers the widened set in isolation, this covers the
// resolveBlockingSeverities config->gateKey->guard wiring the CLI actually runs.
test("judgePassCli reads a configured widened block set and fails a clean+medium-act round closed, per gate key (#2246)", async () => {
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  // gate -> the .devloops config section resolveBlockingSeverities must select.
  // The informational `review` gate has no config section of its own and reuses
  // pre_approval_gate's blocking severities (matching consolidate-fanin.mjs).
  for (const [gate, section] of [["draft_gate", "draft"], ["pre_approval_gate", "preApproval"], ["review", "preApproval"]]) {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `judge-pass-configured-block-${section}-`));
    await writeFile(
      path.join(tmpDir, ".devloops"),
      `version: 1\ngates:\n  ${section}:\n    blockCleanOnFindingSeverities: [high, medium]\n`,
    );
    await writeFile(
      path.join(tmpDir, "ledger.json"),
      JSON.stringify({ overallVerdict: "clean", findings: [finding({ severity: "medium", summary: "now-blocking medium" })] }),
    );
    await writeFile(
      path.join(tmpDir, "judge-verdict.json"),
      JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "must fix now" }] })),
    );
    await assert.rejects(
      judgePassCli(
        {
          repo: "mfittko/dev-loops",
          pr: "1",
          gate,
          headSha: HEAD,
          findingsFile: "./ledger.json",
          judgeVerdict: "./judge-verdict.json",
          out: "./act.json",
          ledgerOut: "./enriched.json",
        },
        { repoRoot: tmpDir },
      ),
      /clean verdict is invalid with .* at a blocking severity \(medium\)/,
      `gate ${gate} must resolve gates.${section}.blockCleanOnFindingSeverities`,
    );
  }
});

// #2246: resolveBlockingSeverities fails CLOSED on a malformed .devloops rather
// than silently degrading to the ["high"] default — a broken config must not
// let a would-be-blocking act slip through as clean.
test("judgePassCli fails closed when the gate config cannot be loaded (#2246)", async () => {
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-bad-config-"));
  // A schema-invalid blockCleanOnFindingSeverities (unknown severity) makes
  // loadDevLoopConfig return a non-empty errors[]; resolveBlockingSeverities
  // must throw rather than fall back.
  await writeFile(
    path.join(tmpDir, ".devloops"),
    "version: 1\ngates:\n  draft:\n    blockCleanOnFindingSeverities: [bogus-severity]\n",
  );
  await writeFile(
    path.join(tmpDir, "ledger.json"),
    JSON.stringify({ overallVerdict: "clean", findings: [finding({ severity: "low", summary: "x" })] }),
  );
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "y" }] })),
  );
  await assert.rejects(
    judgePassCli(
      {
        repo: "mfittko/dev-loops",
        pr: "1",
        gate: "draft_gate",
        headSha: HEAD,
        findingsFile: "./ledger.json",
        judgeVerdict: "./judge-verdict.json",
      },
      { repoRoot: tmpDir },
    ),
    /could not be fully loaded\/validated/,
  );
});

// FIX D (#2156): the clean+act invariant must fail BEFORE any durable side
// effect — neither the approvals record nor a deferral comment may be
// written for a round that is about to be rejected. Combines a clean
// ledger + nonzero act count (as above) with BOTH side-effect seams engaged
// (--approvals-out via --spec-file, and a deferred finding that would
// otherwise drive applyDeferralComment) to prove the ordering, not just the
// throw.
test("judgePassCli: rejecting a clean+act round posts no deferral comment and writes no approvals record (#2156)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-clean-act-no-side-effects-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  const findings = [finding(), finding({ severity: "low", summary: "would-be follow-up", disposition: "deferred" })];
  // A "clean" overallVerdict paired with an act-disposed finding (index 0) —
  // the invalid combination. Index 1 defers with a followUpDraft, which
  // would (pre-fix) reach applyDeferralComment before the assertion threw.
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "clean", findings }));
  await writeFile(
    path.join(tmpDir, "judge-verdict.json"),
    JSON.stringify(verdict({
      dispositions: [
        { index: 0, disposition: "act", rationale: "actually needs fixing now" },
        { index: 1, disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } },
      ],
    })),
  );
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
      { index: 1, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
    ] }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { deps, runCalls, commentCalls } = stubDeferralDeps();
  const approvalsPath = path.join(tmpDir, "approvals.json");
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
        approvalsOut: "./approvals.json",
      },
      { repoRoot: tmpDir, ...deps },
    ),
    /clean verdict is invalid with .* at a blocking severity/,
  );
  assert.equal(runCalls.length, 0, "no gh call before the round is rejected");
  assert.equal(commentCalls.length, 0, "no deferral comment posted before the round is rejected");
  assert.equal(existsSync(approvalsPath), false, "no approvals record written before the round is rejected");
});

// A `defer` disposition goes as ONE batched comment on the deferral comment
// target. `run` answers only the two reads (the closing-reference lookup and
// the target's comment list); any other gh call — `gh issue create` included —
// throws, so no test here can create an issue. `commentIssue` is stubbed so
// nothing hits the real API. `closing` lists the PR's closing issue numbers;
// `listed` holds the target's existing comment bodies.
function stubDeferralDeps({ closing = [], listed = [] } = {}) {
  const runCalls = [];
  const commentCalls = [];
  const run = async (_cmd, args) => {
    runCalls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ closingIssuesReferences: closing.map((number) => ({ number, repository: { name: "dev-loops", owner: { login: "mfittko" } } })) }), stderr: "" };
    }
    if (args[0] === "api" && args.some((arg) => /\/issues\/\d+\/comments/.test(arg))) {
      return { code: 0, stdout: JSON.stringify([listed.map((body) => ({ body }))]), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const commentIssue = async (opts) => {
    commentCalls.push(opts);
    return { ok: true, repo: opts.repo, issue: opts.issue, commentUrl: `https://github.com/${opts.repo}/issues/${opts.issue}#issuecomment-1` };
  };
  return { deps: { run, commentIssue }, runCalls, commentCalls };
}

async function runDeferRound({ findings, dispositions, deps, config, pr = "1658" }) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-defer-"));
  if (config) await writeFile(path.join(tmpDir, ".devloops.json"), JSON.stringify(config));
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions })));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(
    { repo: "mfittko/dev-loops", pr, gate: "draft_gate", headSha: HEAD, findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json", out: "./act.json", ledgerOut: "./enriched.json" },
    { repoRoot: tmpDir, ...deps },
  );
  const enriched = JSON.parse(await readFile(path.join(tmpDir, "enriched.json"), "utf8"));
  return { payload, enriched, tmpDir };
}

const DEFER = { disposition: "defer", rationale: "follow-up", followUpDraft: { title: "t", body: "b" } };

function assertNoIssueCreate(runCalls) {
  assert.equal(runCalls.some((args) => args.includes("create")), false, "no gh issue-create call");
}

test("judgePassCli: GitHub tracker + one closing reference — one batched comment on that issue, followUpIssueNumber is the issue", async () => {
  const { deps, runCalls, commentCalls } = stubDeferralDeps({ closing: [2425] });
  const { payload, enriched } = await runDeferRound({
    findings: [finding({ summary: "fix this" }), finding({ summary: "defer this", severity: "medium" }), finding({ summary: "defer that too", severity: "low" })],
    dispositions: [{ index: 0, disposition: "act", rationale: "in scope" }, { index: 1, ...DEFER }, { index: 2, ...DEFER }],
    deps,
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.actCount, 1);
  assert.deepEqual(payload.scopeDrift, { verdict: "within_scope", rationale: "within AC", driftedAreas: [] });
  assert.equal(enriched.scopeDrift.verdict, "within_scope");
  assert.equal(commentCalls.length, 1, "ONE batched comment for the round's defers");
  assert.equal(commentCalls[0].issue, 2425);
  assert.match(commentCalls[0].body, /defer this/);
  assert.match(commentCalls[0].body, /defer that too/);
  assert.equal(enriched.findings[0].judgeDisposition, "act");
  assert.strictEqual(typeof enriched.findings[0].fingerprint, "string");
  assert.equal(enriched.findings[1].followUpIssueNumber, 2425);
  assert.equal(enriched.findings[2].followUpIssueNumber, 2425);
  assertNoIssueCreate(runCalls);
});

for (const [label, closing] of [["no closing reference", []], ["more than one closing reference", [2425, 2426]]]) {
  test(`judgePassCli: ${label} — the comment goes to the PR, followUpIssueNumber is the PR number`, async () => {
    const { deps, runCalls, commentCalls } = stubDeferralDeps({ closing });
    const { enriched } = await runDeferRound({ findings: [finding({ summary: "defer this", severity: "low" })], dispositions: [{ index: 0, ...DEFER }], deps });
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].issue, 1658);
    assert.equal(enriched.findings[0].followUpIssueNumber, 1658);
    assertNoIssueCreate(runCalls);
  });
}

test("judgePassCli: tracker.provider other than github — the comment goes to the PR, with no closing-reference lookup", async () => {
  const { deps, runCalls, commentCalls } = stubDeferralDeps({ closing: [2425] });
  const { enriched } = await runDeferRound({
    findings: [finding({ summary: "defer this", severity: "low" })],
    dispositions: [{ index: 0, ...DEFER }],
    deps,
    config: { version: 1, tracker: { provider: "jira" } },
  });
  assert.equal(runCalls.some((args) => args[0] === "pr"), false, "no closing-reference lookup for a non-GitHub tracker");
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issue, 1658);
  assert.equal(enriched.findings[0].followUpIssueNumber, 1658);
  assertNoIssueCreate(runCalls);
});

test("judgePassCli: a re-run does not re-append a fingerprint the target already lists", async () => {
  const deferred = finding({ summary: "defer this", severity: "medium" });
  const fp = fingerprintFinding(deferred);
  const { deps, runCalls, commentCalls } = stubDeferralDeps({ closing: [2425], listed: [`<!-- dev-loops:deferred-summary -->\nGate findings deferred:\n\n- \`${fp}\` **medium** (\`correctness\`): defer this`] });
  const { enriched } = await runDeferRound({ findings: [deferred], dispositions: [{ index: 0, ...DEFER }], deps });
  assert.equal(commentCalls.length, 0, "nothing new to append on a pure retry");
  assert.equal(enriched.findings[0].followUpIssueNumber, 2425, "still records the target");
  assertNoIssueCreate(runCalls);
});

// #1807 AC3: a `reject` disposition records fingerprint/severity/angle in the
// ledger and makes no gh call at all.
test("judgePassCli reject records a fingerprint audit entry and posts no comment", async () => {
  const { deps, runCalls, commentCalls } = stubDeferralDeps();
  const { enriched } = await runDeferRound({
    findings: [finding({ summary: "out of scope" })],
    dispositions: [{ index: 0, disposition: "reject", rationale: "below the defer bar", criterion: "NG-1" }],
    deps,
  });
  assert.equal(runCalls.length, 0);
  assert.equal(commentCalls.length, 0);
  const [entry] = enriched.findings;
  assert.equal(entry.judgeDisposition, "reject");
  assert.equal(typeof entry.fingerprint, "string");
  assert.equal(entry.severity, "high");
  assert.equal(entry.angle, "correctness");
  assert.equal(entry.followUpIssueNumber, undefined);
});

// VALIDATE-COVERAGE-ADMISSION rehearsal: when the judge applies the
// coverage-admission rule, an already-covered coverage permutation is `reject`
// (dropped from the act list before fixer dispatch), a missing public-boundary
// behavior is `act`, and a demonstrated fail-open uncertainty defect is retained
// as `act`. This exercises the existing disposition pipeline — no new dispatch
// code — and mirrors the review-side accept/reject/retain outcome for the same
// three coverage findings.
test("runJudgePass coverage-admission rehearsal: reject an already-covered permutation, accept a missing public-boundary behavior, retain a fail-open defect", () => {
  const findings = ledger(
    finding({ angle: "coverage", summary: "add a permutation of an already-covered helper path" }),
    finding({ angle: "coverage", summary: "no test for the CLI argument-parsing boundary (public seam)" }),
    finding({ severity: "high", angle: "correctness", summary: "resolver accepts unverifiable input (fail-open)" }),
  );
  const v = verdict({
    dispositions: [
      { index: 0, disposition: "reject", rationale: "equivalent permutation of covered behavior; fails VALIDATE-COVERAGE-ADMISSION", criterion: "VALIDATE-COVERAGE-ADMISSION" },
      { index: 1, disposition: "act", rationale: "distinct argument-parsing boundary, cheapest authoritative seam", criterion: "VALIDATE-COVERAGE-ADMISSION" },
      { index: 2, disposition: "act", rationale: "demonstrated fail-open uncertainty defect remains actionable" },
    ],
  });
  const result = runJudgePass(findings, v, HEAD);
  // The rejected already-covered permutation is absent from the act list; the
  // missing-public-boundary behavior and the fail-open defect are retained.
  assert.deepEqual(result.act.map((f) => f.summary), [
    "no test for the CLI argument-parsing boundary (public seam)",
    "resolver accepts unverifiable input (fail-open)",
  ]);
  assert.equal(result.enriched[0].judgeDisposition, "reject");
  assert.deepEqual(result.counts, { act: 2, defer: 0, reject: 1 });
});

// A repeated coverage demand stays `reject` across rounds absent new evidence,
// and the comparison rides the EXISTING finding fingerprint (the prior-round
// ledger), not a new durable rejection registry. Genuinely new evidence naming
// a distinct boundary is reconsidered and acted on.
test("runJudgePass two-round rehearsal: an unchanged coverage demand stays reject while new distinct-boundary evidence is acted on", () => {
  const coverageDemand = finding({ angle: "coverage", summary: "coverage is only 88%, add more tests" });

  // Round 1: the demand is rejected (percentage-only, non-actionable).
  const round1 = runJudgePass(
    ledger(coverageDemand),
    verdict({ dispositions: [{ index: 0, disposition: "reject", rationale: "percentage-only demand; fails VALIDATE-COVERAGE-ADMISSION", criterion: "VALIDATE-COVERAGE-ADMISSION" }] }),
    HEAD,
  );
  assert.equal(round1.act.length, 0);

  // Round 2: the SAME demand recurs alongside a genuinely new boundary finding.
  const newBoundaryFinding = finding({ angle: "coverage", summary: "serialization boundary emits malformed JSON on NaN — uncovered" });
  const round2 = runJudgePass(
    ledger(coverageDemand, newBoundaryFinding),
    verdict({
      dispositions: [
        { index: 0, disposition: "reject", rationale: "no new evidence since the prior-round rejection; still percentage-only", criterion: "VALIDATE-COVERAGE-ADMISSION" },
        { index: 1, disposition: "act", rationale: "distinct serialization boundary, names the protected behavior", criterion: "VALIDATE-COVERAGE-ADMISSION" },
      ],
    }),
    HEAD,
  );
  // Round 2 re-rejects the unchanged demand (no new evidence) and acts only on
  // the genuinely new distinct-boundary finding.
  assert.equal(round2.enriched[0].judgeDisposition, "reject");
  assert.deepEqual(round2.act.map((f) => f.summary), ["serialization boundary emits malformed JSON on NaN — uncovered"]);
  // The recurring demand is matched across rounds by its EXISTING finding
  // fingerprint (files[0] + normalized summary), not a new rejection registry:
  // the round-1 rejected entry and the round-2 recurrence share one fingerprint,
  // and judge enrichment (adding judgeDisposition) does not perturb it — so the
  // prior-round ledger alone lets the judge recognize the repeat.
  assert.equal(fingerprintFinding(round1.enriched[0]), fingerprintFinding(round2.enriched[0]));
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
  // The single finding still relevance-acts, so the round is NOT clean and
  // approves nothing (no premature approval when open work remains).
  assert.deepEqual(persisted.approvedCriteria, []);
  assert.equal(persisted.invalidation.specChanged, true);
});

test("judgePassCli approves the whole criterion set only on a clean round (no act findings)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-clean-approve-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  const findings = [finding()];
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  // Relevance-reject the only finding so the act list is empty -> clean round.
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "reject", rationale: "out of scope NG" }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
    ] }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(
    {
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
      approvalsOut: "./approvals.json",
    },
    { repoRoot: tmpDir },
  );
  assert.equal(payload.actCount, 0);
  const persisted = JSON.parse(await readFile(path.join(tmpDir, "approvals.json"), "utf8"));
  assert.deepEqual(persisted.approvedCriteria, criterionIds);
});

test("judgePassCli rejects a finding_conflicts finding even when its relevance disposition is defer (no follow-up)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-conflict-defer-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  const findings = [finding({ severity: "low", summary: "would-be follow-up" })];
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "defer", rationale: "belongs in follow-up", followUpDraft: { title: "t", body: "b" } }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "finding_conflicts", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, conflictingCriteria: ["ng:0"], rationale: "conflicts with a non-goal" },
    ] }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  // Stub deferral deps: a finding_conflicts finding must NOT reach the deferral comment.
  const { deps, runCalls, commentCalls } = stubDeferralDeps();
  const [opts] = specAuthorityArgs(tmpDir, contentDigest);
  const payload = await judgePassCli(opts, { repoRoot: tmpDir, ...deps });
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.reject, 1);
  assert.equal(payload.counts.defer, 0, "the defer was overridden to reject by finding_conflicts");
  assert.equal(runCalls.length, 0, "no gh call for a spec-rejected finding");
  assert.equal(commentCalls.length, 0, "no deferral comment for a spec-rejected finding");
});

test("judgePassCli flags a remediation_conflicts finding as remediationRejected but keeps it actionable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-remedy-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  const findings = [finding({ summary: "valid repetition finding" })];
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "real defect" }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(
    path.join(tmpDir, "spec-authority.json"),
    JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "remediation_conflicts", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, conflictingCriteria: ["ng:0"], rationale: "proposed remedy flattens voice; route to a compliant alternative" },
    ] }),
  );
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli(...specAuthorityArgs(tmpDir, contentDigest));
  assert.equal(payload.actCount, 1, "the finding stays actionable");
  assert.equal(payload.act[0].remediationRejected, true);
});

test("judgePassCli fails closed on a malformed --prior-approvals record", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-badprior-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
    { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
  ] }));
  await writeFile(path.join(tmpDir, "prior.json"), JSON.stringify({ specDigest, approvedCriteria: "not-an-array" }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  await assert.rejects(
    judgePassCli({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json", priorApprovals: "./prior.json",
    }, { repoRoot: tmpDir }),
    /prior-approvals record is malformed/,
  );
});

test("validateCliArgs: --content-digest and --approvals-out each require --spec-file", () => {
  const base = { repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD, findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json" };
  assert.throws(() => validateCliArgs({ ...base, contentDigest: "sha256:" + "a".repeat(64) }), /--content-digest requires --spec-file/);
  assert.throws(() => validateCliArgs({ ...base, approvalsOut: "./a.json" }), /--approvals-out requires --spec-file/);
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

test("judgePassCli fails closed when the verdict's specDigest mismatches the computed spec (CLI stale-verdict seam)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-staleverdict-"));
  const { computeSpecDigest } = await import("@dev-loops/core/loop/spec-authority");
  const { contentDigest, criterionIds } = await specDigests();
  const wrong = computeSpecDigest({ ...SPEC_FIXTURE, nonGoals: ["totally different non-goal"] });
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  // Verdict is internally consistent but pins a DIFFERENT (wrong) specDigest.
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({ specDigest: wrong, headSha: HEAD, contentDigest, decisions: [
    { index: 0, outcome: "valid_compliant", specDigest: wrong, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
  ] }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  await assert.rejects(judgePassCli(...specAuthorityArgs(tmpDir, contentDigest)), /does not match the current spec digest/);
});

test("judgePassCli --carry-forward-proof carries an unaffected criterion at the same specDigest", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-spec-carry-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "reject", rationale: "out" }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
    { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
  ] }));
  // Prior approvals at the SAME specDigest; proof carries ac:0, others stale.
  await writeFile(path.join(tmpDir, "prior.json"), JSON.stringify({ specDigest, headSha: "f".repeat(40), contentDigest, approvedCriteria: criterionIds }));
  await writeFile(path.join(tmpDir, "proof.json"), JSON.stringify({ "ac:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true } }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    priorApprovals: "./prior.json", carryForwardProof: "./proof.json", approvalsOut: "./approvals.json",
  }, { repoRoot: tmpDir });
  assert.equal(payload.specAuthority.invalidation.specChanged, false);
  assert.deepEqual(payload.specAuthority.invalidation.carried, ["ac:0"]);
  assert.ok(payload.specAuthority.invalidation.stale.length >= 1);
});

test("validateCliArgs: --carry-forward-proof requires --prior-approvals", () => {
  assert.throws(
    () => validateCliArgs({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest: "sha256:" + "a".repeat(64), specAuthorityVerdict: "./sa.json",
      carryForwardProof: "./proof.json",
    }),
    /--carry-forward-proof requires --prior-approvals/,
  );
});

// --- AC7: resolveAffectedCriteria wiring (issue 2008 / ADR-0061) ---

test("validateCliArgs: --changed-paths and --coverage-map must be supplied together", () => {
  const base = {
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest: "sha256:" + "a".repeat(64), specAuthorityVerdict: "./sa.json",
    priorApprovals: "./prior.json",
  };
  assert.throws(
    () => validateCliArgs({ ...base, changedPaths: "./changed.json" }),
    /--changed-paths and --coverage-map must be supplied together/,
  );
  assert.throws(
    () => validateCliArgs({ ...base, coverageMap: "./coverage.json" }),
    /--changed-paths and --coverage-map must be supplied together/,
  );
});

test("validateCliArgs: --changed-paths/--coverage-map require --prior-approvals", () => {
  assert.throws(
    () => validateCliArgs({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest: "sha256:" + "a".repeat(64), specAuthorityVerdict: "./sa.json",
      changedPaths: "./changed.json", coverageMap: "./coverage.json",
    }),
    /require --prior-approvals/,
  );
});

test("validateCliArgs: --changed-paths/--coverage-map each require --spec-file", () => {
  const base = { repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD, findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json" };
  assert.throws(() => validateCliArgs({ ...base, changedPaths: "./changed.json" }), /--changed-paths requires --spec-file/);
  assert.throws(() => validateCliArgs({ ...base, coverageMap: "./coverage.json" }), /--coverage-map requires --spec-file/);
});

async function writeAffectedCriteriaFixture(tmpDir, { affected, coverage }) {
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "reject", rationale: "out" }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({ specDigest, headSha: HEAD, contentDigest, decisions: [
    { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
  ] }));
  await writeFile(path.join(tmpDir, "prior.json"), JSON.stringify({ specDigest, headSha: "f".repeat(40), contentDigest, approvedCriteria: criterionIds }));
  await writeFile(path.join(tmpDir, "changed.json"), JSON.stringify(affected));
  await writeFile(path.join(tmpDir, "coverage.json"), JSON.stringify(coverage));
  return { specDigest, contentDigest, criterionIds };
}

test("judgePassCli AC7: changed-paths + coverage-map narrows affectedCriteria to only the touched criterion", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac7-narrow-"));
  const { contentDigest, criterionIds } = await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs"],
    coverage: { "ac:0": ["src/dedup.mjs"], "ac:1": ["src/demo.mjs"], "dod:0": ["package.json"], "ng:0": ["src/voice.mjs"] },
  });
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
  }, { repoRoot: tmpDir });
  assert.equal(payload.ok, true);
  // Only ac:0 is affected/stale; the rest of the criterion set is unaffected —
  // but resolveCriterionInvalidation still requires positive carry-forward
  // proof to CARRY (none supplied here), so those stay stale too, just for a
  // DIFFERENT (unproven, not "affected") reason.
  assert.deepEqual(payload.specAuthority.invalidation.stale.sort(), [...criterionIds].sort());
  assert.equal(payload.specAuthority.invalidation.reasons["ac:0"], "fixer push changed content covered by this criterion — approval stale, fresh review required");
  assert.match(payload.specAuthority.invalidation.reasons["ac:1"], /unaffected but carry-forward not positively proven/);
});

test("judgePassCli AC7: narrowed affectedCriteria + carry-forward-proof carries an unaffected criterion forward", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac7-carry-"));
  const { contentDigest } = await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs"],
    coverage: { "ac:0": ["src/dedup.mjs"], "ac:1": ["src/demo.mjs"], "dod:0": ["package.json"], "ng:0": ["src/voice.mjs"] },
  });
  await writeFile(path.join(tmpDir, "proof.json"), JSON.stringify({
    "ac:1": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
    "dod:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
    "ng:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
  }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
    carryForwardProof: "./proof.json",
  }, { repoRoot: tmpDir });
  assert.deepEqual(payload.specAuthority.invalidation.stale, ["ac:0"]);
  assert.deepEqual(payload.specAuthority.invalidation.carried.sort(), ["ac:1", "dod:0", "ng:0"]);
  assert.deepEqual(payload.specAuthority.criterionCoverage, { "ac:0": ["src/dedup.mjs"], "ac:1": ["src/demo.mjs"], "dod:0": ["package.json"], "ng:0": ["src/voice.mjs"] });
});

test("judgePassCli AC7: an unmatched changed path is uncertain -> fails closed to all-stale over the full prior-approved set", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac7-uncertain-"));
  const { contentDigest, criterionIds } = await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs", "docs/unrelated.md"],
    coverage: { "ac:0": ["src/dedup.mjs"] },
  });
  // Even with proof for every OTHER criterion, uncertainty forces every
  // prior-approved criterion into affectedCriteria, so none can carry.
  await writeFile(path.join(tmpDir, "proof.json"), JSON.stringify({
    "ac:1": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
    "dod:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
    "ng:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
  }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
    carryForwardProof: "./proof.json",
  }, { repoRoot: tmpDir });
  assert.deepEqual(payload.specAuthority.invalidation.stale.sort(), [...criterionIds].sort());
  assert.deepEqual(payload.specAuthority.invalidation.carried, []);
});

// F4 (issue 2008 draft-gate review): a malformed --changed-paths or
// --coverage-map artifact must fail closed (thrown error), never silently
// degrade to an empty/no-op affected-criteria resolution.
test("judgePassCli AC7: a malformed --changed-paths file fails closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac7-bad-changed-"));
  await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs"],
    coverage: { "ac:0": ["src/dedup.mjs"] },
  });
  await writeFile(path.join(tmpDir, "changed.json"), "not json");
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { contentDigest } = await specDigests();
  await assert.rejects(
    judgePassCli({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
      priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
    }, { repoRoot: tmpDir }),
    /--changed-paths ".*" must contain valid JSON/,
  );
});

test("judgePassCli AC7: a malformed --coverage-map file fails closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac7-bad-coverage-"));
  await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs"],
    coverage: { "ac:0": ["src/dedup.mjs"] },
  });
  await writeFile(path.join(tmpDir, "coverage.json"), "{ not valid json");
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const { contentDigest } = await specDigests();
  await assert.rejects(
    judgePassCli({
      repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
      findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
      specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
      priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
    }, { repoRoot: tmpDir }),
    /--coverage-map ".*" must contain valid JSON/,
  );
});

// --- AC6: durable approval-record extensions (issue 2008 / ADR-0061) ---

test("judgePassCli AC6: approvals record persists humanDecision/authorizedRemediations/criterionCoverage", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac6-"));
  const { specDigest, contentDigest, criterionIds } = await writeAffectedCriteriaFixture(tmpDir, {
    affected: ["src/dedup.mjs"],
    coverage: { "ac:0": ["src/dedup.mjs"] },
  });
  // Round is clean (relevance-rejected the only finding) so approvedCriteria
  // is the full set, exercising the "clean round" persistence path.
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    priorApprovals: "./prior.json", changedPaths: "./changed.json", coverageMap: "./coverage.json",
    approvalsOut: "./approvals.json",
  }, { repoRoot: tmpDir });
  assert.equal(payload.ok, true);
  const persisted = JSON.parse(await readFile(path.join(tmpDir, "approvals.json"), "utf8"));
  assert.deepEqual(persisted.humanDecision, { required: false, indices: [], reason: null });
  assert.deepEqual(persisted.authorizedRemediations, [
    { index: 0, checkedCriteria: criterionIds, authorizedRemediation: "x" },
  ]);
  assert.deepEqual(persisted.criterionCoverage, { "ac:0": ["src/dedup.mjs"] });
  assert.equal(persisted.specDigest, specDigest);
});

test("judgePassCli AC6: humanDecision surfaces required+reason on a spec_cannot_decide round", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac6-human-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict()));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({
    specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "spec_cannot_decide", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "spec is internally contradictory" },
    ],
  }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  const payload = await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
  }, { repoRoot: tmpDir });
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.specAuthority.humanDecision, {
    required: true,
    indices: [0],
    reason: "spec is internally contradictory",
  });
});

// --- AC1: spec-authority identity stamped onto --ledger-out / --out ---

test("judgePassCli AC1: --ledger-out carries the specAuthority stamp when engaged; --out always stays a bare act-list array", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac1-stamp-"));
  const { specDigest, contentDigest, criterionIds } = await specDigests();
  await writeFile(path.join(tmpDir, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "in scope" }] })));
  await writeFile(path.join(tmpDir, "spec.json"), JSON.stringify(SPEC_FIXTURE));
  await writeFile(path.join(tmpDir, "spec-authority.json"), JSON.stringify({
    specDigest, headSha: HEAD, contentDigest, decisions: [
      { index: 0, outcome: "valid_compliant", specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds, rationale: "ok", authorizedRemediation: "x" },
    ],
  }));
  const { judgePassCli } = await import("../../scripts/loop/judge-pass.mjs");
  await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "pre_approval_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    specFile: "./spec.json", contentDigest, specAuthorityVerdict: "./spec-authority.json",
    out: "./act.json", ledgerOut: "./enriched.json",
  }, { repoRoot: tmpDir });
  const act = JSON.parse(await readFile(path.join(tmpDir, "act.json"), "utf8"));
  const enriched = JSON.parse(await readFile(path.join(tmpDir, "enriched.json"), "utf8"));
  // --out is ALWAYS the bare act-list array the fix pass consumes — never a
  // wrapped object — even when spec-authority is engaged (issue 2008 draft-
  // gate review finding F1): the durable revision-identity record lives on
  // --ledger-out only.
  assert.ok(Array.isArray(act), "--out is a bare array even when spec-authority is engaged");
  assert.equal(act.length, 1);
  assert.deepEqual(enriched.specAuthority, { specDigest, headSha: HEAD, contentDigest, checkedCriteria: criterionIds });
  assert.equal(enriched.overallVerdict, "findings_present");

  // No --spec-file: byte-identical to the pre-existing (bare array / unstamped) shape.
  const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), "judge-pass-ac1-noop-"));
  await writeFile(path.join(tmpDir2, "ledger.json"), JSON.stringify({ overallVerdict: "findings_present", findings: [finding()] }));
  await writeFile(path.join(tmpDir2, "judge-verdict.json"), JSON.stringify(verdict({ dispositions: [{ index: 0, disposition: "act", rationale: "in scope" }] })));
  await judgePassCli({
    repo: "mfittko/dev-loops", pr: "2000", gate: "draft_gate", headSha: HEAD,
    findingsFile: "./ledger.json", judgeVerdict: "./judge-verdict.json",
    out: "./act.json", ledgerOut: "./enriched.json",
  }, { repoRoot: tmpDir2 });
  const actNoop = JSON.parse(await readFile(path.join(tmpDir2, "act.json"), "utf8"));
  const enrichedNoop = JSON.parse(await readFile(path.join(tmpDir2, "enriched.json"), "utf8"));
  assert.ok(Array.isArray(actNoop), "--out stays a bare array when spec-authority is not engaged");
  assert.equal("specAuthority" in enrichedNoop, false);
});
