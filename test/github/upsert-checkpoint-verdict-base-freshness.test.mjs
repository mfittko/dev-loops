import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { buildGateContextPath } from "../../scripts/github/write-gate-context.mjs";
import { parseUpsertCheckpointVerdictCliArgs, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// Issue 2885 slice 2b: a clean draft_gate verdict refuses at a head that lacks origin/<base>.

const HEAD = "abc1234000000000000000000000000000000000";
let gitStubDir = null;
let originalPath = null;
let repoRoot = null;
before(async () => {
  // Shadow git on PATH so the cascade's execFileSync git reads stay hermetic.
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-base-freshness-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\n[ \"$1\" = cat-file ] && exit 1\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-base-freshness-repo-"));
  const real = await readFile(path.resolve(".devloops"), "utf8");
  const patched = real.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false").replace("\n  draft:\n", "\n  draft:\n    maxReviewRounds: 0\n");
  await writeFile(path.join(repoRoot, ".devloops"), patched, "utf8");
});
after(async () => {
  if (originalPath !== null) process.env.PATH = originalPath;
  if (gitStubDir) await rm(gitStubDir, { recursive: true, force: true });
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

const CLEAN_DRAFT_REVIEW = [{ id: 55, state: "COMMENTED", submitted_at: "2026-10-20T10:00:00Z", body: ["### Gate review: `draft_gate`", "", `**Reviewed head SHA:** \`${HEAD}\``, "**Verdict:** clean", "**Findings summary:** none", "**Next action:** mark ready"].join("\n"), html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-55", user: { login: "gate-bot" }, commit_id: HEAD }];

function makeRunChild(posted, { isDraft: initialDraft = true, mutations = [], reviews = [] } = {}) {
  let isDraft = initialDraft;
  const prJson = () => JSON.stringify({
    number: 17, state: "OPEN", isDraft, headRefOid: HEAD, baseRefName: "main", body: DEFAULT_TEST_PR_BODY,
    closingIssuesReferences: [], reviews: reviews.length ? [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-05-31T20:00:00Z", commit: { oid: HEAD } }] : [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    const a = args.join(" ");
    if (a.includes("convertPullRequestToDraft") || a.includes("pr ready")) { mutations.push(a); isDraft = a.includes("convertPullRequestToDraft"); }
    if (a.includes("pulls/17/reviews") && a.includes("-X POST")) {
      posted.push(String(stdin ?? ""));
      return { code: 0, stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n', stderr: "" };
    }
    if (a.includes("requested_reviewers")) return { code: 0, stdout: '{"users":[],"teams":[]}\n', stderr: "" };
    if (a.includes("api") && a.includes("user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("convertPullRequestToDraft")) return { code: 0, stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_1","isDraft":true}}}}' + "\n", stderr: "" };
    if (a.includes("graphql") && a.includes("isDraft")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_1","isDraft":false}}}}' + "\n", stderr: "" };
    if (a.includes("graphql")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("pulls/17/reviews") && reviews.length) return { code: 0, stdout: JSON.stringify(reviews) + "\n", stderr: "" };
    if (a.includes("issues/17/comments") || a.includes("pulls/17/reviews") || a.includes("pulls/17/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson(), stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

async function postClean(tempDir, checkBaseFreshness, { verdict = "clean", isDraft = true, omitVerdict = false, rejectedMedium = false, partlyJudged = false, actInFindingsJson = false, rejectedInFindingsJson = false, gate = "draft_gate", noLedger = false, ledgerRootLayout = false } = {}) {
  const clean = verdict === "clean";
  const ledgerPath = ledgerRootLayout ? path.join(tempDir, "gate-findings", "owner-repo", "pr-17", "ledger.json") : path.join(tempDir, "ledger.json");
  if (ledgerRootLayout) await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate, headSha: HEAD, verdict, overallVerdict: rejectedMedium ? "findings_present" : verdict,
    loggedAt: "2026-11-16T00:00:00.000Z",
    findings: partlyJudged ? [{ severity: "low", angle: "correctness", summary: "act finding", judgeDisposition: "act", judgeRationale: "test" }, { severity: "low", angle: "holistic", summary: "unjudged finding" }] : [rejectedMedium ? { severity: "medium", angle: "correctness", summary: "medium finding", judgeDisposition: "reject", judgeRationale: "test" } : clean
      ? { severity: "low", angle: "correctness", summary: "low finding", judgeDisposition: "reject", judgeRationale: "test" }
      : { severity: "medium", angle: "correctness", summary: "medium finding", judgeDisposition: "act", judgeRationale: "test" }],
  }), "utf8");
  const sizePath = path.join(tempDir, "size.json");
  await writeFile(sizePath, JSON.stringify({ ok: true, outcome: "pass", wholeLogicLoc: 10, t1SliceLoc: 0, waiver: { requested: false, t1Valid: false, defaultValid: false } }), "utf8");
  const jsonPath = path.join(tempDir, "findings.json");
  if (actInFindingsJson || rejectedInFindingsJson) await writeFile(jsonPath, JSON.stringify([{ angle: "correctness", findings: [{ severity: "low", angle: "correctness", summary: "json finding", judgeDisposition: actInFindingsJson ? "act" : "reject", judgeRationale: "test" }] }]), "utf8");
  const options = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo", "--pr", "17", "--gate", gate, "--head-sha", HEAD, ...(omitVerdict ? [] : ["--verdict", verdict]),
    "--findings-summary", "base freshness test", ...(noLedger ? [] : ["--findings-ledger", ledgerPath]),...(actInFindingsJson || rejectedInFindingsJson ? ["--findings-json", jsonPath] : []),
    "--next-action", "mark ready for review", "--inline-reason", "base freshness test", ...(gate === "pre_approval_gate" ? ["--size-budget-json", sizePath] : []),
    "--findings-severity-counts", JSON.stringify(clean ? { high: 0, medium: 0, low: 1, question: 0, nit: 0 } : { high: 0, medium: 1, low: 0, question: 0, nit: 0 }),
  ]);
  const posted = [];
  const calls = [];
  const mutations = [];
  const check = async (input) => { calls.push(input); return checkBaseFreshness(input); };
  try {
    const result = await upsertCheckpointVerdict(options, { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild(posted, { isDraft, mutations, reviews: gate === "pre_approval_gate" ? CLEAN_DRAFT_REVIEW : [] }), checkBaseFreshness: check });
    return { result, posted, calls, mutations };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), posted, calls, mutations };
  }
}

const REMEDY = "Merge origin/main into the branch via scripts/loop/resolve-pr-conflicts.mjs. Never rebase a pushed branch. Never force-push. Push the merge, re-derive spec identity, and re-validate at the new head.";

test("a clean draft_gate verdict at a stale-base head posts and runs no freshness check", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer base commit"], foreignFiles: [], remedy: REMEDY }));
    assert.equal(out.error, undefined);
    assert.equal(out.calls.length, 0);
    assert.match(out.posted.join("\n"), /\*\*Verdict:\*\* clean/);
  }, { prefix: "dev-loops-base-freshness-stale-draft-" });
});

test("a clean pre_approval_gate verdict at a stale-base head refuses, names the remedy and posts nothing", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer base commit"], foreignFiles: [], remedy: REMEDY }), { gate: "pre_approval_gate", isDraft: false });
    assert.match(out.error, new RegExp(`^base_stale_integrate_first: head ${HEAD} does not contain origin/main; newer commits: 1234567 newer base commit\\.`));
    assert.ok(out.error.includes(REMEDY));
    assert.deepEqual(out.calls.map(({ base, head, trusted }) => ({ base, head, trusted })), [{ base: "main", head: HEAD, trusted: true }]);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-stale-" });
});

test("a current base or a fetch failure posts the clean verdict unchanged", async () => {
  for (const verdict of [{ ok: true, status: "base_current", base: "main" }, { ok: false, error: "base_fetch_failed", base: "main", message: "offline" }]) {
    await withTempDir(async (tempDir) => {
      const out = await postClean(tempDir, async () => verdict, { gate: "pre_approval_gate", isDraft: false });
      assert.equal(out.error, undefined);
      assert.equal(out.calls.length, 1);
      assert.match(out.posted.join("\n"), /\*\*Verdict:\*\* clean/);
    }, { prefix: "dev-loops-base-freshness-current-" });
  }
});

test("a findings_present draft_gate post skips the stale-base check and posts", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: REMEDY }), { verdict: "findings_present" });
    assert.equal(out.error, undefined);
    assert.equal(out.calls.length, 0);
    assert.match(out.posted.join("\n"), /\*\*Verdict:\*\* findings_present/);
  }, { prefix: "dev-loops-base-freshness-findings-" });
});

test("a clean draft_gate post on a ready PR at a stale base posts with no stale line", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: REMEDY }), { isDraft: false });
    assert.equal(out.error, undefined);
    assert.equal(out.calls.length, 0);
    assert.match(out.posted.join("\n"), /\*\*Verdict:\*\* clean/);
    assert.doesNotMatch(out.posted.join("\n"), /Base freshness/);
  }, { prefix: "dev-loops-base-freshness-ready-" });
});

test("a clean draft_gate post on a ready PR at a current base reaches the draft transition", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async () => ({ ok: true, status: "base_current", base: "main" }), { isDraft: false });
    assert.ok(out.mutations.some((m) => m.includes("convertPullRequestToDraft")), `expected a draft conversion, got ${JSON.stringify(out.mutations)} / ${out.error}`);
  }, { prefix: "dev-loops-base-freshness-ready-current-" });
});

const STALE = async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: REMEDY });

test("a clean pre_approval_gate post at a stale base refuses and posts nothing", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, STALE, { gate: "pre_approval_gate", isDraft: false });
    assert.match(out.error, /^base_stale_integrate_first:/);
    assert.equal(out.calls.length, 1);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-preapproval-" });
});

test("a clean review-gate post skips the stale-base check", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, STALE, { gate: "review" });
    assert.equal(out.calls.length, 0);
  }, { prefix: "dev-loops-base-freshness-review-" });
});

// Issue 3346: a base_current context at the head proves only the base moved during the round.
for (const [gate, isDraft] of [["pre_approval_gate", false]]) {
  test(`a clean ${gate} post at a stale base posts with a visible stale line when the round started at a current base`, async () => {
    const contextPath = path.join(repoRoot, buildGateContextPath({ repo: "owner/repo", pr: 17, gate, headSha: HEAD }));
    await mkdir(path.dirname(contextPath), { recursive: true });
    await writeFile(contextPath, JSON.stringify({ baseFreshness: { status: "base_current", base: "main" } }), "utf8");
    try {
      await withTempDir(async (tempDir) => {
        const out = await postClean(tempDir, STALE, { gate, isDraft });
        assert.equal(out.error, undefined);
        assert.match(out.posted.join("\n"), /\*\*Verdict:\*\* clean[\s\S]*\*\*Base freshness:\*\* stale; origin\/main moved during the round \(1 newer commit\(s\)\)\. Merge it via scripts\/loop\/resolve-pr-conflicts\.mjs/);
      }, { prefix: "dev-loops-base-freshness-proof-" });
    } finally {
      await rm(contextPath, { force: true });
    }
  });
}

async function withContext(gate, baseFreshness, run) {
  const contextPath = path.join(repoRoot, buildGateContextPath({ repo: "owner/repo", pr: 17, gate, headSha: HEAD }));
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(contextPath, JSON.stringify({ baseFreshness }), "utf8");
  try {
    await withTempDir(run, { prefix: "dev-loops-base-freshness-proof-extra-" });
  } finally {
    await rm(contextPath, { force: true });
  }
}

// A context outside the reviewed worktree (here the ledger root) belongs to an earlier round and is no proof.
test("a base_current context found only under the ledger root is no proof and the stale post still refuses", async () => {
  await withTempDir(async (tempDir) => {
    const contextPath = buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "pre_approval_gate", headSha: HEAD, tmpRoot: tempDir });
    await mkdir(path.dirname(contextPath), { recursive: true });
    await writeFile(contextPath, JSON.stringify({ baseFreshness: { status: "base_current", base: "main" } }), "utf8");
    const out = await postClean(tempDir, STALE, { gate: "pre_approval_gate", isDraft: false, ledgerRootLayout: true });
    assert.match(out.error, /^base_stale_integrate_first:/);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-ledger-root-" });
});

test("a ledger-less clean post at a stale base refuses with the base_stale_integrate_first prefix", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, STALE, { gate: "pre_approval_gate", isDraft: false, noLedger: true });
    assert.match(out.error, /^base_stale_integrate_first:/);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-no-ledger-" });
});

for (const baseFreshness of [{ status: "base_stale_integrate_first" }, { status: "base_current", base: "release" }]) {
  test(`a context recording ${JSON.stringify(baseFreshness)} is no proof and the stale post still refuses`, async () => {
    await withContext("pre_approval_gate", baseFreshness, async (tempDir) => {
      const out = await postClean(tempDir, STALE, { gate: "pre_approval_gate", isDraft: false });
      assert.match(out.error, /^base_stale_integrate_first:/);
      assert.equal(out.posted.length, 0);
    });
  });
}
