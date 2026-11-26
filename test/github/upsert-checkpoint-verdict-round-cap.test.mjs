import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { capRoundWaives, parseUpsertCheckpointVerdictCliArgs, renderGateReviewCommentBody, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// GATE-EXEC-ROUND-CAP + GATE-EXEC-SOFT-CAP: the cap reads only the judged ledger and counts completed rounds. Past the cap
// only a high act item without judgeFix, a question act item, or a closed finding with a named human decision blocks;
// medium/low/nit act items and medium defer/reject never block.

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
  await writeFile(path.join(repoRoot, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n  draft:\n    maxReviewRounds: 4\n", "utf8");
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

async function writeLedger(tempDir, { overallVerdict = "findings_present", findings, name = "ledger.json", gate = "draft_gate", head = HEAD }) {
  const ledgerPath = path.join(tempDir, name);
  const ledger = {
    repo: "owner/repo", pr: 17, gate, headSha: head,
    verdict: "findings_present", overallVerdict, loggedAt: "2026-10-25T00:00:00.000Z", findings,
  };
  if (overallVerdict === null) delete ledger.overallVerdict;
  await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
  return ledgerPath;
}

// Closed prior rounds of the PR under the root's tmp (the main-anchored ledger dir).
async function seedPrior(root, heads, { extraNames = [], unreadable = [], withAct = false } = {}) {
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", "pr-17");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const head of heads) {
    await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
      repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-11-0${head[0]}T00:00:00.000Z`, findings: withAct ? [{ severity: "medium", summary: "open act", judgeDisposition: "act", judgeFix: "fix it", file: "a.mjs", line: 1 }] : [],
    }), "utf8");
  }
  for (const head of unreadable) await writeFile(path.join(dir, `draft_gate-${head}.json`), "{not json", "utf8");
  for (const name of extraNames) await writeFile(path.join(dir, name), "[]", "utf8");
}

function makeRunChild(posted, { isDraft = true, state = "OPEN", calls = [], body = DEFAULT_TEST_PR_BODY, conclusion = "SUCCESS", status = "COMPLETED", issueComments = [], head = HEAD } = {}) {
  const prJson = JSON.stringify({
    number: 17, state, isDraft, headRefOid: head, baseRefName: "main", body,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status, conclusion, name: "ci" }],
  }) + "\n";
  return async (cmd, args = [], _env, stdin = "") => {
    calls.push(`${cmd} ${args.join(" ")}`);
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
    if (a.includes("issues/17/comments")) return { code: 0, stdout: JSON.stringify(issueComments.length ? [issueComments] : []) + "\n", stderr: "" };
    if (a.includes("pulls/17/reviews")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("pulls/17/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: head }) + "\n", stderr: "" };
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

test("past the cap a new high act item without judgeFix composes blocked with round_cap_reached", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("high", "act")]);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "blocked");
    assert.match(out.body, /round_cap_reached/);
    const explicit = await pastCap(tempDir, [finding("high", "act")], { extraArgs: ["--verdict", "findings_present"] });
    assert.match(explicit.error, /--verdict "findings_present"/);
  }, { prefix: "dev-loops-round-cap-new-" });
});

test("past the cap a new medium act item without judgeFix keeps findings_present", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "act")]);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "findings_present");
    assert.doesNotMatch(out.body, /round_cap_reached/);
  }, { prefix: "dev-loops-round-cap-new-medium-" });
});

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

test("past the cap a mixed round (one medium, two lows) keeps findings_present", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "act"), { ...finding("low", "act"), summary: "a" }, { ...finding("low", "act"), summary: "b" }]);
    assert.equal(verdictOf(out), "findings_present");
    assert.doesNotMatch(out.body, /round_cap_reached/);
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

test("past the cap a medium reject without a reason and a medium defer to the PR itself post clean", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("medium", "reject"), finding("medium", "defer", { followUpIssueNumber: 17 })], { overallVerdict: "clean" });
    assert.equal(verdictOf(out), "clean");
    assert.doesNotMatch(out.body, /severity_disagreement/);
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

test("round cap+1 posts as the draft scoped final round, and a round after it is refused with round_cap_reached (GATE-EXEC-CAP-BRAKES, ADR 0324)", async () => {
  await withTempDir(async (tempDir) => {
    await seedPrior(repoRoot, [...priorHeads, extraPriors[0]]);
    const scoped = await post(["--findings-ledger", await writeLedger(tempDir, { findings: pr2944Shape() })]);
    assert.equal(scoped.error, undefined, "the scoped round is not refused");
    assert.equal(verdictOf(scoped), "blocked", "every finding of the scoped round goes to the operator");
    await seedPrior(repoRoot, [...priorHeads, ...extraPriors], { withAct: true });
    const out = await post(["--findings-ledger", await writeLedger(tempDir, { findings: pr2944Shape() })]);
    assert.match(out.error ?? "", /round_cap_reached.*round 6 .*cap is 4/);
    assert.equal(out.body, undefined, "nothing is posted");
  }, { prefix: "dev-loops-round-cap-closure-next-" });
});

test("an inline clean draft_gate post with only --findings-summary is refused after the scoped round and accepted at the cap round (ADR 0208)", async () => {
  await seedPrior(repoRoot, [...priorHeads, ...extraPriors], { withAct: true });
  const refused = await post(["--verdict", "clean", "--execution-mode", "inline_single_agent"]);
  assert.match(refused.error ?? "", /round_cap_reached.*round 6 .*cap is 4/);
  assert.equal(refused.body, undefined, "nothing is posted");
  await seedPrior(repoRoot, priorHeads);
  assert.equal(verdictOf(await post(["--verdict", "clean", "--execution-mode", "inline_single_agent"])), "clean");
});

test("at the cap round a high act item without judgeFix blocks, and with judgeFix goes to the fixer", async () => {
  await withTempDir(async (tempDir) => {
    const out = await pastCap(tempDir, [finding("high", "act")]);
    assert.equal(verdictOf(out), "blocked");
    assert.equal(verdictOf(await pastCap(tempDir, [finding("high", "act", withFix)])), "findings_present");
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


test("closureFromHeadOf, shared by the poster and resolveClosureRound, refuses a blank or non-string last head with one message", async () => {
  const { closureFromHeadOf } = await import("../../scripts/github/write-gate-context.mjs");
  const message = /closure round reached but the latest closed prior round's head cannot be recovered/;
  for (const headSha of ["", "  ", 7, undefined]) assert.throws(() => closureFromHeadOf([{ headSha }]), message);
  assert.throws(() => closureFromHeadOf([]), message);
  assert.equal(closureFromHeadOf([{ headSha: ` ${"A".repeat(40)} ` }]), "a".repeat(40));
});

test("the closure round line renders a normalized full SHA and refuses a short, blank or missing head", () => {
  const line = (closureFromHead) => renderGateReviewCommentBody({ gate: "draft_gate", headSha: HEAD, repo: "o/r", verdict: "clean", closureFromHead });
  for (const [input, rendered] of [["a".repeat(40), "a".repeat(40)], ["b".repeat(64), "b".repeat(64)], [` ${"A".repeat(40)} `, "a".repeat(40)]]) {
    assert.match(line(input), new RegExp(`closure round: diff from ${rendered}\\b`));
  }
  for (const input of ["abc1234", "", "  ", null, undefined]) assert.doesNotMatch(line(input), /closure round: diff from/, String(input));
});

// A clean cap round whose post was refused at its own head posts there once the PR head has moved on.
const CAP_HEAD = "4".repeat(40);
async function postCleanCapRound(tempDir, { capHead = CAP_HEAD, sealedVerdict = "clean", ancestor = true, headSha = capHead, prState = {}, extraArgs = [], calls = [], postedOverrides = {}, proven = false, checkBaseFreshness, gate = "draft_gate", sealedHead = capHead, issueComments = [], seal = "valid", mergeBaseCode, retained = false, sealedExtra = {}, bare = false } = {}) {
  await seedPrior(repoRoot, priorHeads);
  const deltaDir = path.join(repoRoot, "tmp", "gate-delta");
  await rm(deltaDir, { recursive: true, force: true });
  if (proven) {
    // The sealed clearing record that makes the cap round count as fixed, so a ready PR reads its draft gate as satisfied.
    const record = JSON.stringify({ reviewBaselineHead: capHead, candidateHead: HEAD, nextStep: "push_to_gate", extension: "docs_tests_only" });
    await mkdir(deltaDir, { recursive: true });
    await writeFile(path.join(deltaDir, `${capHead}.json`), record, "utf8");
    await writeFile(path.join(deltaDir, `${capHead}.json.seal`), createHash("sha256").update(record).digest("hex"), "utf8");
  }
  const dir = path.join(repoRoot, "tmp", "gate-findings", "owner-repo", "pr-17");
  const sealed = { repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: capHead, verdict: sealedVerdict, overallVerdict: sealedVerdict, loggedAt: "2026-11-04T00:00:00.000Z", findings: [], ...sealedExtra };
  const sealedText = JSON.stringify({ ...sealed, headSha: sealedHead });
  const ledgerName = retained ? `draft_gate-${capHead}.round-4.json` : `draft_gate-${capHead}.json`;
  await writeFile(path.join(dir, ledgerName), sealedText, "utf8");
  if (seal !== "none") await writeFile(path.join(dir, `${ledgerName}.seal`), `${createHash("sha256").update(seal === "valid" ? sealedText : "tampered").digest("hex")}\n`, "utf8");
  const ledger = path.join(tempDir, "cap-ledger.json");
  await writeFile(ledger, JSON.stringify({ ...sealed, ...postedOverrides }), "utf8");
  const posted = [];
  const inner = makeRunChild(posted, { ...prState, calls, issueComments });
  const runChild = async (cmd, args = [], ...rest) => (cmd === "git" && args.includes("merge-base") ? { code: mergeBaseCode ?? (ancestor ? 0 : 1), stdout: "", stderr: "" } : inner(cmd, args, ...rest));
  try {
    // `bare` parses only the four flags the cap-round exit names.
    const options = parseUpsertCheckpointVerdictCliArgs(bare ? ["--repo", "owner/repo", "--pr", "17", "--gate", gate, "--post-sealed-cap-round"] : [
      "--repo", "owner/repo", "--pr", "17", "--gate", gate, "--head-sha", headSha, "--findings-ledger", ledger,
      "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 0, question: 0, nit: 0 }), "--findings-summary", "cap round", "--next-action", "follow the verdict", "--inline-reason", "cap round", ...extraArgs,
    ]);
    const result = await upsertCheckpointVerdict(options, { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild, checkBaseFreshness });
    return { body: posted.join("\n"), result, posted };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

test("a clean cap round posts at its own ancestor head with the cap round number", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postCleanCapRound(tempDir);
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
    assert.match(out.body, /round[=: ]+4\b/i);
    assert.ok(out.body.includes(CAP_HEAD.slice(0, 7)));
  }, { prefix: "dev-loops-round-cap-ancestor-" });
});

test("a clean cap round retained at its head posts with the cap round number and needs its own retained seal", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postCleanCapRound(tempDir, { retained: true });
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
    assert.match(out.body, /round=4\b/);
    assert.match((await postCleanCapRound(tempDir, { retained: true, seal: "none" })).error ?? "", /does not match the current PR head/);
  }, { prefix: "dev-loops-round-cap-retained-" });
});

test("a retained-only cap round passes the durable-ledger check with fan-out enforcement on", async () => {
  await withTempDir(async (tempDir) => {
    const devloops = path.join(repoRoot, ".devloops");
    const original = await readFile(devloops, "utf8");
    await writeFile(devloops, "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    const contextDir = path.join(repoRoot, "tmp", "gate-context", "owner-repo", "pr-17");
    await mkdir(contextDir, { recursive: true });
    await writeFile(path.join(contextDir, `draft_gate-${CAP_HEAD}.validation.json`), JSON.stringify({ headSha: CAP_HEAD }), "utf8");
    try {
      const provenance = { distinctReviewers: 2, perAngle: [{ angle: "pr-description", reviewer: "reviewer-a" }, { angle: "holistic", reviewer: "reviewer-b" }] };
      const out = await postCleanCapRound(tempDir, { retained: true, sealedExtra: { provenance }, extraArgs: ["--execution-mode", "fanout_fanin"] });
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), "clean");
    } finally {
      await writeFile(devloops, original, "utf8");
    }
  }, { prefix: "dev-loops-round-cap-retained-enforced-" });
});

test("a clean cap-round post at a stale base posts and runs no freshness check", async () => {
  await withTempDir(async (tempDir) => {
    const heads = [];
    const out = await postCleanCapRound(tempDir, { checkBaseFreshness: async ({ base, head }) => { heads.push(head); return { ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: "R" }; } });
    assert.equal(out.error, undefined);
    assert.deepEqual(heads, []);
  }, { prefix: "dev-loops-round-cap-base-fresh-" });
});

test("a pre_approval_gate stale-head refusal does not name a cap round", async () => {
  await withTempDir(async (tempDir) => {
    const error = (await postCleanCapRound(tempDir, { gate: "pre_approval_gate" })).error ?? "";
    assert.match(error, /does not match the current PR head/);
    assert.doesNotMatch(error, /no clean cap round/);
  }, { prefix: "dev-loops-round-cap-preapproval-stale-" });
});

test("an earlier-head post without a sealed clean cap-round ledger is refused", async () => {
  await withTempDir(async (tempDir) => {
    assert.match((await postCleanCapRound(tempDir, { sealedVerdict: "findings_present" })).error ?? "", /does not match the current PR head/);
    assert.match((await postCleanCapRound(tempDir, { headSha: "3".repeat(40) })).error ?? "", /does not match the current PR head/);
  }, { prefix: "dev-loops-round-cap-ancestor-refuse-" });
});

test("a cap-round head the PR head does not descend from is refused", async () => {
  await withTempDir(async (tempDir) => {
    assert.match((await postCleanCapRound(tempDir, { ancestor: false })).error ?? "", /does not match the current PR head/);
  }, { prefix: "dev-loops-round-cap-ancestor-foreign-" });
});

test("an unsealed clean cap-round ledger is refused", async () => {
  await withTempDir(async (tempDir) => {
    assert.match((await postCleanCapRound(tempDir, { seal: "none" })).error ?? "", /does not match the current PR head/);
  }, { prefix: "dev-loops-round-cap-unsealed-" });
});

test("a seal mismatch on the cap-round ledger reaches the caller as OUT_OF_BAND_WRITE", async () => {
  await withTempDir(async (tempDir) => {
    const error = (await postCleanCapRound(tempDir, { seal: "mismatch" })).error ?? "";
    assert.match(error, /gate_artifact_out_of_band_write/);
    assert.doesNotMatch(error, /does not match the current PR head/);
  }, { prefix: "dev-loops-round-cap-tampered-" });
});

test("a git failure in the ancestry check names the failure and the fetch remedy, not a missing ancestor", async () => {
  await withTempDir(async (tempDir) => {
    const error = (await postCleanCapRound(tempDir, { mergeBaseCode: 128 })).error ?? "";
    assert.match(error, /merge-base --is-ancestor failed \(exit 128\)/);
    assert.match(error, /git fetch origin/);
  }, { prefix: "dev-loops-round-cap-merge-base-128-" });
});

test("a ready PR with a visible clean draft_gate verdict at the cap-round head returns the idempotent noop and posts no review", async () => {
  await withTempDir(async (tempDir) => {
    const visibleClean = { id: 98, user: { login: "gate-bot" }, author_association: "OWNER", body: `### Gate review: \`draft_gate\`\n\n**Reviewed head SHA:** \`${CAP_HEAD}\`\n**Verdict:** clean\n\n**Findings summary:** cap round\n\n**Next action:** follow the verdict`, html_url: "https://github.com/owner/repo/pull/17#issuecomment-98", updated_at: "2026-05-30T17:00:00Z" };
    const out = await postCleanCapRound(tempDir, { prState: { isDraft: false }, proven: true, issueComments: [visibleClean] });
    assert.equal(out.error, undefined);
    assert.equal(out.result.action, "noop");
    assert.equal(out.result.draftGateAlreadySatisfied, true);
    assert.deepEqual(out.posted, []);
  }, { prefix: "dev-loops-round-cap-visible-clean-noop-" });
});

test("a clean cap round posts on a ready PR whose draft gate reads as satisfied, without a draft conversion", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    // A visible prior draft_gate verdict at another head: without the !capRoundHead guard the supersede sweep would run.
    const priorVerdict = { id: 99, user: { login: "gate-bot" }, author_association: "OWNER", body: `### Gate review: \`draft_gate\`\n\n**Reviewed head SHA:** \`${priorHeads[0]}\`\n**Verdict:** findings_present\n\n**Findings summary:** prior round\n\n**Next action:** fix`, html_url: "https://github.com/owner/repo/pull/17#issuecomment-99", updated_at: "2026-05-30T17:00:00Z" };
    const out = await postCleanCapRound(tempDir, { prState: { isDraft: false }, proven: true, calls, issueComments: [priorVerdict] });
    assert.equal(out.error, undefined);
    assert.equal(verdictOf(out), "clean");
    assert.match(out.body, /round[=: ]+4\b/i);
    assert.ok(out.body.includes(CAP_HEAD.slice(0, 7)));
    assert.equal(calls.some((c) => /pr ready|convertPullRequestToDraft/.test(c)), false);
    assert.equal(calls.some((c) => /minimize|reviews\(first:100\)/i.test(c)), false);
  }, { prefix: "dev-loops-round-cap-ready-" });
});

test("a cap-round post on a merged PR is refused", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postCleanCapRound(tempDir, { prState: { state: "MERGED" }, proven: true });
    assert.match(out.error ?? "", /Cannot enter draft_gate/);
  }, { prefix: "dev-loops-round-cap-merged-" });
});

test("a non-clean verdict at an earlier cap-round head is refused", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postCleanCapRound(tempDir, { postedOverrides: { verdict: "findings_present", overallVerdict: "findings_present", findings: [finding("low", "act")] } });
    assert.match(out.error ?? "", /must compose a clean verdict/);
  }, { prefix: "dev-loops-round-cap-nonclean-" });
});

test("capRoundWaives keeps the done and blocked refusals even when the draft re-evaluation allows the gate", () => {
  const coordination = (...allowedNextActions) => ({ allowedNextActions });
  const draftAllows = { forbiddenActions: [] };
  assert.equal(capRoundWaives(coordination("wait_for_ci"), draftAllows, "run_draft_gate"), true);
  assert.equal(capRoundWaives(coordination("report_blocked"), draftAllows, "run_draft_gate"), false);
  assert.equal(capRoundWaives(coordination("report_done"), draftAllows, "run_draft_gate"), false);
  assert.equal(capRoundWaives(coordination("wait_for_ci"), { forbiddenActions: ["run_draft_gate"] }, "run_draft_gate"), false);
});

// readClosedPriorRoundLogs lowercases the recorded head before it matches the filename, so a case variant is the one ledger form that reaches the normalization guard.
test("a cap-round ledger headSha in uppercase posts at the lowercase SHA", async () => {
  await withTempDir(async (tempDir) => {
    const capHead = "abcdef".repeat(6) + "abcd";
    const out = await postCleanCapRound(tempDir, { capHead, sealedHead: capHead.toUpperCase() });
    assert.equal(out.error, undefined);
    assert.ok(out.body.includes(capHead.slice(0, 7)));
    assert.equal(out.body.includes(capHead.slice(0, 7).toUpperCase()), false);
  }, { prefix: "dev-loops-round-cap-uppercase-head-" });
});

test("a cap-round post is refused when coordination forbids the gate for an unrelated reason (CI pending, wait_for_ci)", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postCleanCapRound(tempDir, { prState: { isDraft: false, status: "IN_PROGRESS", conclusion: null }, proven: true });
    assert.match(out.error ?? "", /Cannot enter draft_gate/);
  }, { prefix: "dev-loops-round-cap-unrelated-" });
});

// End-to-end refusal of malformed ledger heads; the readClosedPriorRoundLogs identity check drops them before the normalization guard, so the uppercase test above covers the guard itself.
test("a cap-round ledger headSha that is not the filename SHA never becomes the posted head", async () => {
  for (const ledgerHead of [`${CAP_HEAD}~0`, "", "not-a-sha"]) {
    await withTempDir(async (tempDir) => {
      const out = await postCleanCapRound(tempDir, { sealedHead: ledgerHead });
      assert.match(out.error ?? "", /does not match the current PR head/, JSON.stringify(ledgerHead));
    }, { prefix: "dev-loops-round-cap-badhead-" });
  }
});

// The four-flag command the cap-round exit prints, on a zero-finding and on an all-rejected clean ledger.
const SEALED_PROVENANCE = { distinctReviewers: 2, perAngle: [{ angle: "pr-description", reviewer: "reviewer-a" }, { angle: "holistic", reviewer: "reviewer-b" }] };
for (const [name, findings, summary] of [["zero-finding", [], "0 findings"], ["all-rejected", [finding("low", "reject")], "1 finding"]]) {
  test(`--post-sealed-cap-round with only --repo, --pr, --gate and the flag posts a ${name} clean cap round with a ledger-derived summary`, async () => {
    await withTempDir(async (tempDir) => {
      const out = await postCleanCapRound(tempDir, { prState: { isDraft: false }, proven: true, bare: true, sealedExtra: { provenance: SEALED_PROVENANCE, findings } });
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), "clean");
      assert.match(out.body, /round[=: ]+4\b/i);
      assert.ok(out.body.includes(CAP_HEAD.slice(0, 7)));
      assert.match(out.body, new RegExp(`\\*\\*Findings summary:\\*\\* ${summary} from the findings ledger\\.`));
      assert.doesNotMatch(out.body, /undefined/);
    }, { prefix: "dev-loops-round-cap-post-sealed-" });
  });
}

test("--post-sealed-cap-round refuses a sealed findings_present cap round and posts nothing", async () => {
  await withTempDir(async (tempDir) => {
    const calls = [];
    const out = await postCleanCapRound(tempDir, { bare: true, sealedVerdict: "findings_present", calls, sealedExtra: { provenance: SEALED_PROVENANCE, findings: [finding("low", "act")] } });
    assert.match(out.error ?? "", /no sealed clean draft_gate cap round/);
    assert.equal(calls.some((c) => /-X (POST|PATCH|PUT)/.test(c)), false);
  }, { prefix: "dev-loops-round-cap-post-sealed-act-" });
});

const visibleCleanDraft = { id: 98, user: { login: "gate-bot" }, author_association: "OWNER", body: `### Gate review: \`draft_gate\`\n\n**Reviewed head SHA:** \`${HEAD}\`\n**Verdict:** clean\n\n**Findings summary:** clean\n\n**Next action:** follow the verdict`, html_url: "https://github.com/owner/repo/pull/17#issuecomment-98", updated_at: "2026-05-30T17:00:00Z" };

// GATE-EXEC-CAP-BRAKES: pre_approval_gate has its own cap (default 2). At the cap round a high without a judgeFix or a question blocks;
// a high with a judgeFix goes to the fixer. A scoped final round (count cap+1) sends every act item to the operator.
async function postPreApprovalRound(tempDir, findings, priorHeadCount, { setup } = {}) {
  const sizePath = path.join(tempDir, "size.json");
  await writeFile(sizePath, JSON.stringify({ ok: true, outcome: "pass", wholeLogicLoc: 10, t1SliceLoc: 0, waiver: { requested: false, t1Valid: false, defaultValid: false } }), "utf8");
  const root = path.join(tempDir, "pre-cap-root");
  await mkdir(path.join(root, "tmp", "gate-findings", "owner-repo", "pr-17"), { recursive: true });
  await writeFile(path.join(root, ".devloops"), "version: 1\nrefinement:\n  maxCopilotRounds: 0\ngates:\n  requireFanoutEvidence: false\n", "utf8");
  // `setup` builds a real git history under the root and returns the posted head and the closed prior heads.
  const { head, priors } = setup ? await setup(root) : { head: HEAD, priors: priorHeads.slice(0, priorHeadCount) };
  for (const [i, prior] of priors.entries()) {
    await writeFile(path.join(root, "tmp", "gate-findings", "owner-repo", "pr-17", `pre_approval_gate-${prior}.json`), JSON.stringify({
      repo: "owner/repo", pr: 17, gate: "pre_approval_gate", headSha: prior, verdict: "findings_present", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: [],
    }), "utf8");
  }
  const ledger = await writeLedger(tempDir, { findings, overallVerdict: findings.some((f) => f.judgeDisposition === "act") ? "findings_present" : "clean", gate: "pre_approval_gate", head });
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", head, "--findings-ledger", ledger,
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 0, question: 0, nit: 0 }), "--findings-summary", "pre cap", "--next-action", "follow the verdict", "--inline-reason", "pre cap", "--size-budget-json", sizePath,
  ];
  const posted = [];
  try {
    const result = await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot: root, runChild: makeRunChild(posted, { isDraft: false, head, issueComments: [{ ...visibleCleanDraft, body: visibleCleanDraft.body.replace(HEAD, head) }] }) });
    return { result, body: posted.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// GATE-EXEC-CAP-BRAKES: the poster passes the PR base to the round count, so a round forced by a base merge is the cap round, not the scoped final round.
test("pre_approval_gate cap: a round forced by a base merge is the cap round, so a medium act still goes to the fixer", async () => {
  const setup = async (root) => {
    const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
    const commit = async (file) => { await writeFile(path.join(root, file), file, "utf8"); git("add", file); git("commit", "-q", "-m", file); return git("rev-parse", "HEAD"); };
    git("init", "-q", "-b", "main");
    await commit("a.txt");
    git("checkout", "-q", "-b", "pr");
    const prHead = await commit("b.txt");
    git("checkout", "-q", "main");
    const main = await commit("c.txt");
    git("checkout", "-q", "pr");
    git("merge", "-q", "--no-ff", "-m", "merge main", "main");
    git("update-ref", "refs/remotes/origin/main", main);
    const merged = git("rev-parse", "HEAD");
    return { head: merged, priors: [priorHeads[0], prHead] };
  };
  // The file's PATH stub answers every git call with success and no output; this test needs the real git for the merge-forced check.
  const stubbedPath = process.env.PATH;
  process.env.PATH = originalPath;
  try {
    await withTempDir(async (tempDir) => {
      const out = await postPreApprovalRound(tempDir, [finding("medium", "act", { judgeFix: "add the guard" })], 0, { setup });
      assert.equal(out.error, undefined);
      // Without the PR base the merged head would be round 3 (the scoped final round) and the medium would block.
      assert.equal(verdictOf(out), "findings_present");
    }, { prefix: "dev-loops-pre-cap-forced-" });
  } finally {
    process.env.PATH = stubbedPath;
  }
});

for (const [name, findings, priorCount, expected] of [
  ["round 1 ignores the cap: a high without a judgeFix stays findings_present", [finding("high", "act")], 0, "findings_present"],
  ["the cap round blocks a high act without a judgeFix", [finding("high", "act")], 1, "blocked"],
  ["the cap round blocks a question act", [finding("question", "act")], 1, "blocked"],
  ["the cap round sends a high act with a judgeFix to the fixer", [finding("high", "act", { judgeFix: "add the guard" })], 1, "findings_present"],
  ["the cap round sends a medium act to the fixer", [finding("medium", "act", { judgeFix: "add the guard" })], 1, "findings_present"],
  ["the scoped final round sends a medium act with a judgeFix to the operator", [finding("medium", "act", { judgeFix: "add the guard" })], 2, "blocked"],
  ["the scoped final round sends a high act with a judgeFix to the operator", [finding("high", "act", { judgeFix: "add the guard" })], 2, "blocked"],
  ["a clean scoped final round is the exit: it posts clean", [finding("low", "reject")], 2, "clean"],
]) {
  test(`pre_approval_gate cap: ${name}`, async () => {
    await withTempDir(async (tempDir) => {
      const out = await postPreApprovalRound(tempDir, findings, priorCount);
      assert.equal(out.error, undefined);
      assert.equal(verdictOf(out), expected);
      if (expected === "blocked") assert.match(out.body, /round_cap_reached/);
    }, { prefix: "dev-loops-pre-cap-" });
  });
}
