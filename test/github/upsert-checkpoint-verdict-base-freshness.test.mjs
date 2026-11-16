import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
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

function makeRunChild(posted, { isDraft = true, mutations = [] } = {}) {
  const prJson = JSON.stringify({
    number: 17, state: "OPEN", isDraft, headRefOid: HEAD, baseRefName: "main", body: DEFAULT_TEST_PR_BODY,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    const a = args.join(" ");
    if (a.includes("convertPullRequestToDraft") || a.includes("pr ready")) mutations.push(a);
    if (a.includes("pulls/17/reviews") && a.includes("-X POST")) {
      posted.push(String(stdin ?? ""));
      return { code: 0, stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n', stderr: "" };
    }
    if (a.includes("requested_reviewers")) return { code: 0, stdout: '{"users":[],"teams":[]}\n', stderr: "" };
    if (a.includes("api") && a.includes("user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("convertPullRequestToDraft")) return { code: 0, stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_1","isDraft":true}}}}' + "\n", stderr: "" };
    if (a.includes("graphql") && a.includes("isDraft")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_1","isDraft":false}}}}' + "\n", stderr: "" };
    if (a.includes("graphql")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("issues/17/comments") || a.includes("pulls/17/reviews") || a.includes("pulls/17/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson, stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

async function postClean(tempDir, checkBaseFreshness, { verdict = "clean", isDraft = true, omitVerdict = false } = {}) {
  const clean = verdict === "clean";
  const ledgerPath = path.join(tempDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: HEAD, verdict, overallVerdict: verdict,
    loggedAt: "2026-11-16T00:00:00.000Z",
    findings: [clean
      ? { severity: "low", angle: "correctness", summary: "low finding", judgeDisposition: "reject", judgeRationale: "test" }
      : { severity: "medium", angle: "correctness", summary: "medium finding", judgeDisposition: "act", judgeRationale: "test" }],
  }), "utf8");
  const options = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", HEAD, ...(omitVerdict ? [] : ["--verdict", verdict]),
    "--findings-summary", "base freshness test", "--findings-ledger", ledgerPath,
    "--next-action", "mark ready for review", "--inline-reason", "base freshness test",
    "--findings-severity-counts", JSON.stringify(clean ? { high: 0, medium: 0, low: 1, question: 0, nit: 0 } : { high: 0, medium: 1, low: 0, question: 0, nit: 0 }),
  ]);
  const posted = [];
  const calls = [];
  const mutations = [];
  const check = async (input) => { calls.push(input); return checkBaseFreshness(input); };
  try {
    const result = await upsertCheckpointVerdict(options, { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild(posted, { isDraft, mutations }), checkBaseFreshness: check });
    return { result, posted, calls, mutations };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), posted, calls, mutations };
  }
}

const REMEDY = "Merge origin/main into the branch via scripts/loop/resolve-pr-conflicts.mjs. Never rebase a pushed branch. Never force-push. Push the merge, re-derive spec identity, and re-validate at the new head.";

test("a clean draft_gate verdict at a stale-base head refuses, names the remedy and posts nothing", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer base commit"], foreignFiles: [], remedy: REMEDY }));
    assert.match(out.error, new RegExp(`^base_stale_integrate_first: head ${HEAD} does not contain origin/main; newer commits: 1234567 newer base commit\\.`));
    assert.ok(out.error.includes(REMEDY));
    assert.deepEqual(out.calls.map(({ base, head, trusted }) => ({ base, head, trusted })), [{ base: "main", head: HEAD, trusted: true }]);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-stale-" });
});

test("a current base or a fetch failure posts the clean verdict unchanged", async () => {
  for (const verdict of [{ ok: true, status: "base_current", base: "main" }, { ok: false, error: "base_fetch_failed", base: "main", message: "offline" }]) {
    await withTempDir(async (tempDir) => {
      const out = await postClean(tempDir, async () => verdict);
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

test("a clean draft_gate post on a ready PR refuses at a stale base before any draft conversion", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: REMEDY }), { isDraft: false });
    assert.match(out.error, /^base_stale_integrate_first:/);
    assert.equal(out.calls.length, 1);
    assert.deepEqual(out.mutations, []);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-ready-" });
});

test("a clean draft_gate post on a ready PR at a current base reaches the draft transition", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async () => ({ ok: true, status: "base_current", base: "main" }), { isDraft: false });
    assert.ok(out.mutations.some((m) => m.includes("convertPullRequestToDraft")), `expected a draft conversion, got ${JSON.stringify(out.mutations)} / ${out.error}`);
  }, { prefix: "dev-loops-base-freshness-ready-current-" });
});

test("a ready-PR draft_gate post with no --verdict and a clean ledger refuses at a stale base before any draft conversion", async () => {
  await withTempDir(async (tempDir) => {
    const out = await postClean(tempDir, async ({ base }) => ({ ok: false, error: "base_stale_integrate_first", base, newerCommits: ["1234567 newer"], foreignFiles: [], remedy: REMEDY }), { isDraft: false, omitVerdict: true });
    assert.match(out.error, /^base_stale_integrate_first:/);
    assert.equal(out.calls.length, 1);
    assert.deepEqual(out.mutations, []);
    assert.equal(out.posted.length, 0);
  }, { prefix: "dev-loops-base-freshness-ready-noverdict-" });
});
