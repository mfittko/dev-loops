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
    { repoRoot: tmpDir },
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
  assert.equal(enriched.findings[1].judgeDisposition, "defer");
  assert.equal(enriched.scopeDrift.verdict, "within_scope");
});
