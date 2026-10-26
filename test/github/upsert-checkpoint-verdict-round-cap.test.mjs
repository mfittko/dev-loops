import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { parseUpsertCheckpointVerdictCliArgs, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// GATE-EXEC-ROUND-CAP: the cap reads only the judged ledger, counts completed rounds, and past the cap a new
// act item blocks with round_cap_reached while an all-low/nit act list converges by the low/nit rule.

const HEAD = "abc1234000000000000000000000000000000000";
const priorHeads = ["1", "2", "3"].map((c) => c.repeat(40));

let gitStubDir = null;
let originalPath = null;
let repoRoot = null;
let capOffRoot = null;
before(async () => {
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-round-cap-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\n[ \"$1\" = cat-file ] && exit 1\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-round-cap-repo-"));
  await writeFile(path.join(repoRoot, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
  capOffRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-round-cap-off-"));
  await writeFile(path.join(capOffRoot, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n  draft:\n    maxReviewRounds: 0\n", "utf8");
});
after(async () => {
  if (originalPath !== null) process.env.PATH = originalPath;
  for (const dir of [gitStubDir, repoRoot, capOffRoot]) if (dir) await rm(dir, { recursive: true, force: true });
});

const finding = (severity, judgeDisposition, extra = {}) => ({
  severity, angle: "correctness", summary: `${severity} finding judged ${judgeDisposition}`, judgeDisposition, judgeRationale: "test rationale", ...extra,
});

async function writeLedger(tempDir, { overallVerdict = "findings_present", findings, name = "ledger.json" }) {
  const ledgerPath = path.join(tempDir, name);
  const ledger = {
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: HEAD,
    verdict: "findings_present", overallVerdict, loggedAt: "2026-10-25T00:00:00.000Z", findings,
  };
  if (overallVerdict === null) delete ledger.overallVerdict;
  await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
  return ledgerPath;
}

// Closed prior rounds of the PR under the root's tmp (the main-anchored ledger dir).
async function seedPrior(root, heads, { extraNames = [], unreadable = [] } = {}) {
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", "pr-17");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const head of heads) {
    await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
      repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-11-0${head[0]}T00:00:00.000Z`, findings: [],
    }), "utf8");
  }
  for (const head of unreadable) await writeFile(path.join(dir, `draft_gate-${head}.json`), "{not json", "utf8");
  for (const name of extraNames) await writeFile(path.join(dir, name), "[]", "utf8");
}

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

async function post(extraArgs, { root = repoRoot, noSummary = false } = {}) {
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD,
    "--findings-summary", "round cap test", "--next-action", "follow the verdict", "--inline-reason", "round cap test",
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 0, question: 0, nit: 0 }),
    ...extraArgs,
  ];
  const posted = [];
  try {
    const options = parseUpsertCheckpointVerdictCliArgs(args);
    if (noSummary) options.findingsSummary = undefined;
    const result = await upsertCheckpointVerdict(options, {
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot: root, runChild: makeRunChild(posted),
    });
    return { result, body: posted.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const verdictOf = (out) => /\*\*Verdict:\*\* (\w+)/.exec(out.body ?? "")?.[1];

// Round 4 of a cap of 4 (three closed prior rounds), judged ledger as the only input.
async function pastCap(tempDir, findings, { extraArgs = [], overallVerdict = "findings_present" } = {}) {
  await seedPrior(repoRoot, priorHeads);
  return post(["--findings-ledger", await writeLedger(tempDir, { findings, overallVerdict }), ...extraArgs]);
}

test("the choke point refuses every draft_gate input shape except the judged ledger, one row per shape", async () => {
  await withTempDir(async (tempDir) => {
    const flat = path.join(tempDir, "flat.json");
    await writeFile(flat, JSON.stringify([{ severity: "low", summary: "flat finding", angle: "correctness" }]), "utf8");
    const resurfacing = path.join(tempDir, "resurfacing.json");
    await writeFile(resurfacing, JSON.stringify([{ severity: "low", summary: "again", angle: "correctness", judgeDisposition: "act", resurfaces: "0123456789abcdef" }]), "utf8");
    // A ledger file without overallVerdict (JSON drops the undefined value).
    const noVerdictLedger = await writeLedger(tempDir, { overallVerdict: null, findings: [finding("low", "reject")], name: "no-verdict.json" });
    const judged = await writeLedger(tempDir, { overallVerdict: "clean", findings: [finding("low", "reject")] });
    const rows = [
      ["flat --findings-json", ["--verdict", "findings_present", "--findings-json", flat], /refusing --findings-json/],
      ["--findings-json with resurfaces", ["--verdict", "findings_present", "--findings-json", resurfacing], /refusing --findings-json/],
      ["verdict-only findings_present", ["--verdict", "findings_present"], /refusing a post without --findings-ledger/],
      ["verdict-only blocked", ["--verdict", "blocked"], /refusing a post without --findings-ledger/],
      ["--findings-file", ["--verdict", "findings_present", "--findings-file", flat], /refusing a post without --findings-ledger.*--findings-file/],
      ["ledger without overallVerdict", ["--verdict", "findings_present", "--findings-ledger", noVerdictLedger], /without overallVerdict/],
    ];
    for (const [name, args, pattern] of rows) {
      for (const priorCount of [0, 3]) {
        await seedPrior(repoRoot, priorHeads.slice(0, priorCount));
        const out = await post(args);
        assert.match(out.error ?? "", pattern, `${name} with ${priorCount} prior round(s)`);
        assert.equal(out.body, undefined, `${name} posts nothing`);
      }
    }
    await seedPrior(repoRoot, priorHeads);
    // An inline clean post with no findings flag, or only --findings-summary (the reconcile-draft-gate shape),
    // holds no finding and stays accepted; a fan-out one does not, and an inline clean post carrying
    // --findings-file is refused.
    assert.equal(verdictOf(await post(["--verdict", "clean"], { noSummary: true })), "clean");
    assert.equal(verdictOf(await post(["--verdict", "clean", "--execution-mode", "inline_single_agent"])), "clean");
    assert.match((await post(["--verdict", "clean", "--execution-mode", "fanout_fanin"])).error, /refusing a post without --findings-ledger/);
    assert.match((await post(["--verdict", "clean", "--execution-mode", "inline_single_agent", "--findings-file", flat])).error, /refusing a post without --findings-ledger/);
    const ok = await post(["--findings-ledger", judged]);
    assert.equal(ok.error, undefined);
    assert.equal(verdictOf(ok), "clean", "the valid judged ledger posts");
  }, { prefix: "dev-loops-round-cap-shapes-" });
});

test("with maxReviewRounds 0 the legacy shapes post as before", async () => {
  await withTempDir(async (tempDir) => {
    const out = await post(["--verdict", "findings_present"], { root: capOffRoot });
    assert.equal(out.error, undefined);
    await seedPrior(capOffRoot, priorHeads);
    const high = await writeLedger(tempDir, { findings: [finding("high", "act")] });
    const pastCapOff = await post(["--findings-ledger", high], { root: capOffRoot });
    assert.equal(verdictOf(pastCapOff), "findings_present");
  }, { prefix: "dev-loops-round-cap-off-" });
});

test("the structured findings path posts a defer target and a reason holding an issue id past the issue-id guard", async () => {
  await withTempDir(async (tempDir) => {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify([
      { angle: "correctness", verdict: "findings_present", findings: [
        { severity: "low", summary: "deferred low", judgeDisposition: "defer", judgeReason: "tracked in #123 already", followUpIssueNumber: 77 },
      ] },
    ]), "utf8");
    const out = await post([
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }),
    ], { root: capOffRoot });
    assert.equal(out.error, undefined);
    assert.match(out.body, /judge: _`defer`_ \(follow-up 77\) - tracked in 123 already/);
    assert.doesNotMatch(out.body, /#(?:123|77)/);
  }, { prefix: "dev-loops-round-cap-structured-ids-" });
});

for (const severity of ["high", "medium"]) {
  test(`past the cap a new ${severity} act item composes blocked with round_cap_reached`, async () => {
    await withTempDir(async (tempDir) => {
      const out = await pastCap(tempDir, [finding(severity, "act")]);
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), "blocked");
      assert.match(out.body, /round_cap_reached/);
      const explicit = await pastCap(tempDir, [finding(severity, "act")], { extraArgs: ["--verdict", "findings_present"] });
      assert.match(explicit.error, /--verdict "findings_present"/);
    }, { prefix: "dev-loops-round-cap-new-" });
  });
}

test("below the cap the same new act item keeps findings_present", async () => {
  await withTempDir(async (tempDir) => {
    await seedPrior(repoRoot, priorHeads.slice(0, 2));
    const out = await post(["--findings-ledger", await writeLedger(tempDir, { findings: [finding("high", "act")] })]);
    assert.equal(verdictOf(out), "findings_present");
    assert.doesNotMatch(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-below-" });
});

for (const severity of ["low", "nit"]) {
  test(`past the cap an all-${severity} act list raises no round_cap_reached blocker`, async () => {
    await withTempDir(async (tempDir) => {
      const out = await pastCap(tempDir, [finding(severity, "act"), { ...finding(severity, "act"), summary: "second" }]);
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), "findings_present");
      assert.doesNotMatch(out.body, /round_cap_reached/);
    }, { prefix: "dev-loops-round-cap-lownit-" });
  });
}

test("past the cap a mixed round (one medium, two lows) blocks", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "act"), { ...finding("low", "act"), summary: "a" }, { ...finding("low", "act"), summary: "b" }]);
    assert.equal(verdictOf(out), "blocked");
    assert.match(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-mixed-" });
});

test("past the cap a low defer and a nit reject post clean", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("low", "defer", { followUpDraft: { title: "t", body: "b" } }), finding("nit", "reject")], { overallVerdict: "clean" });
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
  }, { prefix: "dev-loops-round-cap-closed-" });
});

for (const [name, findings] of [
  ["a medium reject", [finding("medium", "reject")]],
  ["a high defer", [finding("high", "defer", { followUpDraft: { title: "t", body: "b" } })]],
  ["a missing disposition", [{ severity: "low", angle: "correctness", summary: "unjudged" }]],
]) {
  test(`past the cap ${name} joins the blocker as severity_disagreement`, async () => {
    await withTempDir(async (tempDir) => {
      const out = await pastCap(tempDir, findings, { overallVerdict: "clean" });
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), "blocked");
      assert.match(out.body, /severity_disagreement/);
    }, { prefix: "dev-loops-round-cap-disagree-" });
  });
}

test("past the cap a reasoned medium reject and a medium defer to another issue post clean with the judge reason shown", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [
      finding("medium", "reject", { judgeReason: "reject-reason-text", summary: "rejected medium" }),
      finding("medium", "defer", { followUpIssueNumber: 99, judgeReason: "defer-reason-text", summary: "deferred medium" }),
    ], { overallVerdict: "clean" });
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
    assert.doesNotMatch(out.body, /severity_disagreement/);
    assert.match(out.body, /judge: reject - reject-reason-text/);
    assert.match(out.body, /judge: defer \(follow-up 99\) - defer-reason-text/);
  }, { prefix: "dev-loops-round-cap-final-medium-" });
});

test("past the cap a medium defer to the PR itself blocks as severity_disagreement", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "defer", { followUpIssueNumber: 17 })], { overallVerdict: "clean" });
    assert.equal(verdictOf(out), "blocked");
    assert.match(out.body, /severity_disagreement/);
  }, { prefix: "dev-loops-round-cap-self-defer-" });
});

test("the count reads the ledger's own gate-findings root, so a relocated --tmp-root still reaches the cap", async () => {
  await withTempDir(async (tempDir) => {
    const root = path.join(tempDir, "relocated");
    await seedPrior(repoRoot, []); // the default root holds no prior ledger
    await seedPrior(root, priorHeads);
    const dir = path.join(root, "tmp", "gate-findings", "owner-repo", "pr-17");
    const ledger = await writeLedger(dir, { findings: [finding("high", "act")], name: `draft_gate-${HEAD}.json` });
    const out = await post(["--findings-ledger", ledger]);
    assert.equal(verdictOf(out), "blocked");
    assert.match(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-relocated-" });
});

test("an inline clean post with a bare-array-written ledger carrying overallVerdict succeeds under the cap", async () => {
  await withTempDir(async (tempDir) => {
    const out = await post(["--verdict", "clean", "--findings-ledger", await writeLedger(tempDir, { overallVerdict: "clean", findings: [] })]);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
  }, { prefix: "dev-loops-round-cap-inline-ledger-" });
});

test("the count includes an unreadable in-range ledger and ignores sidecars", async () => {
  await withTempDir(async (tempDir) => {
    const ledger = await writeLedger(tempDir, { findings: [finding("high", "act")] });
    const sidecars = priorHeads.slice(0, 2).flatMap((h) => [`draft_gate-${h}.act-list.json`, `draft_gate-${h}.judged-ledger.json`]);
    await seedPrior(repoRoot, priorHeads.slice(0, 2), { extraNames: sidecars });
    assert.equal(verdictOf(await post(["--findings-ledger", ledger])), "findings_present", "2 rounds plus sidecars is round 3");
    await seedPrior(repoRoot, priorHeads.slice(0, 2), { unreadable: [priorHeads[2]] });
    assert.equal(verdictOf(await post(["--findings-ledger", ledger])), "blocked", "an unreadable in-range ledger is the third prior round");
  }, { prefix: "dev-loops-round-cap-count-" });
});

// ADR 0189: replay of the PR 2922 round-5 ledger set. All four prior rounds were logged before the cap landed.
test("a round-5 ledger after four pre-cap rounds does not compose round_cap_reached", async () => {
  await withTempDir(async (tempDir) => {
    const dir = path.join(repoRoot, "tmp", "gate-findings", "owner-repo", "pr-17");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const rounds = [
      ["1", "clean", "2026-10-24T10:10:17.964Z"], ["2", "clean", "2026-10-25T21:31:53.080Z"],
      ["3", "findings_present", "2026-10-25T22:04:19.514Z"], ["4", "clean", "2026-10-25T22:32:10.233Z"],
    ];
    for (const [c, verdict, loggedAt] of rounds) {
      await writeFile(path.join(dir, `draft_gate-${c.repeat(40)}.json`), JSON.stringify({
        repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: c.repeat(40), verdict, loggedAt, findings: [],
      }), "utf8");
    }
    const out = await post(["--findings-ledger", await writeLedger(tempDir, { findings: [finding("high", "act")] })]);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "findings_present");
    assert.doesNotMatch(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-replay-" });
});

// ADR 0191 (#2937 S4a): the cap round fixes judge-specified remedies, the next round is the one closure round, a later round is refused.
const withFix = { judgeFix: "the remedy and the test to add" };
const pr2944Shape = () => [
  finding("medium", "act", { ...withFix, resurfaces: "64c4d8f93e0f7ffd" }),
  finding("medium", "act", withFix),
  { ...finding("low", "act", withFix), summary: "low act" },
  { ...finding("nit", "act", withFix), summary: "nit act" },
  { ...finding("medium", "defer", { ...withFix, followUpIssueNumber: 2940 }), summary: "deferred medium" },
];
const extraPriors = ["4", "5"].map((c) => c.repeat(40));

test("at the cap round judge-acted findings with a remedy compose findings_present, with no round_cap_reached", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, pr2944Shape());
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "findings_present");
    assert.doesNotMatch(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-closure-cap-" });
});

test("the closure round with an act item blocks, and a round counted cap+2 blocks too", async () => {
  await withTempDir(async (tempDir) => {
    for (const heads of [[...priorHeads, extraPriors[0]], [...priorHeads, ...extraPriors]]) {
      await seedPrior(repoRoot, heads);
      const out = await post(["--findings-ledger", await writeLedger(tempDir, { findings: pr2944Shape() })]);
      assert.equal(verdictOf(out), "blocked");
      assert.match(out.body, /round_cap_reached/);
    }
  }, { prefix: "dev-loops-round-cap-closure-next-" });
});

test("in the closure round a finding judged defer with a target is final and the round composes clean", async () => {
  await withTempDir(async (tempDir) => {
    await seedPrior(repoRoot, [...priorHeads, extraPriors[0]]);
    const findings = [{ ...finding("medium", "defer", { ...withFix, followUpIssueNumber: 2950 }), summary: "outside the delta" }];
    const out = await post(["--findings-ledger", await writeLedger(tempDir, { findings })]);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
  }, { prefix: "dev-loops-round-cap-closure-defer-" });
});

test("at the cap round an act item without judgeFix still blocks", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "act")]);
    assert.equal(verdictOf(out), "blocked");
  }, { prefix: "dev-loops-round-cap-closure-nofix-" });
});

// ADR 0188 + ADR 0191: the judge-marked failOpen enters through --judge-verdict, is stamped on the ledger finding and read by pastCapBlockers.
async function judgedLedgerPath(raw, disposition) {
  const judgeVerdict = path.join(repoRoot, "judge-verdict.json");
  await writeFile(judgeVerdict, JSON.stringify({
    headSha: HEAD, scopeDrift: { verdict: "within_scope", rationale: "r", driftedAreas: [] },
    dispositions: [{ index: 0, title: "t", detail: "d", fix: "the remedy and the test to add", reason: "r", rationale: "why", failOpen: true, ...disposition }],
  }), "utf8");
  await writeGateFindingsLog({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: HEAD, verdict: "findings_present", findings: JSON.stringify([raw]), judgeVerdict, tmpRoot: path.join(repoRoot, "tmp"),
  }, { repoRoot });
  return path.join(repoRoot, "tmp", "gate-findings", "owner-repo", "pr-17", `draft_gate-${HEAD}.json`);
}
const rawMedium = { severity: "medium", angle: "correctness", summary: "fail-open medium", disposition: "accepted-for-fix" };

test("a judge-marked failOpen medium rejected with a judgeReason past the cap blocks as severity_disagreement", async () => {
  await seedPrior(repoRoot, priorHeads);
  const out = await post(["--findings-ledger", await judgedLedgerPath(rawMedium, { disposition: "reject" })]);
  assert.equal(out.error, undefined);
  assert.equal(verdictOf(out), "blocked");
  assert.match(out.body, /severity_disagreement/);
});

test("a judge-marked failOpen act item with a judgeFix at the cap round goes to the closure fixer without a blocker", async () => {
  await seedPrior(repoRoot, priorHeads);
  const out = await post(["--findings-ledger", await judgedLedgerPath(rawMedium, { disposition: "act" })]);
  assert.equal(out.error, undefined);
  assert.equal(verdictOf(out), "findings_present");
  assert.doesNotMatch(out.body, /round_cap_reached/);
});
