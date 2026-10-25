import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
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
      repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-10-0${head[0]}T00:00:00.000Z`, findings: [],
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
    // An inline clean post with no findings flag holds no finding and stays accepted (a parsed post always
    // carries --findings-summary, so the accepted form is a programmatic call without it); a fan-out one does not,
    // and an inline clean post carrying --findings-file or --findings-summary is refused.
    assert.equal(verdictOf(await post(["--verdict", "clean"], { noSummary: true })), "clean");
    assert.match((await post(["--verdict", "clean", "--execution-mode", "fanout_fanin"])).error, /refusing a post without --findings-ledger/);
    assert.match((await post(["--verdict", "clean", "--execution-mode", "inline_single_agent", "--findings-file", flat])).error, /refusing a post without --findings-ledger/);
    assert.match((await post(["--verdict", "clean", "--execution-mode", "inline_single_agent"])).error, /refusing a post without --findings-ledger/);
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
