import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { DEFAULT_TEST_PR_BODY, initGitFixture, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { parseUpsertCheckpointVerdictCliArgs, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { buildGateContextPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { prBodySha256 } from "../../scripts/github/write-gate-context.mjs";

// The body-only converged post (GATE-EXEC-NO-DEAD-END): a draft_gate round whose act items are all PR-body items
// updates the comment at A to clean with the Converged field while the PR head is the fixer commit. Everything
// else keeps today's refusal.

let A = "a".repeat(40);
let FIX = "b".repeat(40);

let gitStubDir = null;
let originalPath = null;
let repoRoot = null;
let capOnRoot = null;
before(async () => {
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\n[ \"$1\" = cat-file ] && exit 1\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-repo-"));
  const real = await readFile(path.resolve(".devloops"), "utf8");
  const patched = real.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false").replace("\n  draft:\n", "\n  draft:\n    maxReviewRounds: 0\n");
  assert.notEqual(patched, real);
  await writeFile(path.join(repoRoot, ".devloops"), patched, "utf8");
  // Cap on at the default of 4 (GATE-EXEC-ROUND-CAP), pinned so the repo's own .devloops cannot change the rows.
  capOnRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-capon-"));
  await writeFile(path.join(capOnRoot, ".devloops"), real.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false").replace("\n  draft:\n", "\n  draft:\n    maxReviewRounds: 4\n"), "utf8");
});
after(async () => {
  if (capOnRoot) await rm(capOnRoot, { recursive: true, force: true });
  if (originalPath !== null) process.env.PATH = originalPath;
  if (gitStubDir) await rm(gitStubDir, { recursive: true, force: true });
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
});

// A PR-body finding names no file; a code finding (finding) names one and is never a PR-body item.
const bodyFinding = (severity, n = 1) => ({ severity, angle: "correctness", summary: `${severity} finding ${n}`, judgeDisposition: "act", judgeRationale: "test rationale" });
const finding = (severity, n = 1) => ({ ...bodyFinding(severity, n), file: `f${n}.mjs`, line: n });

const existingBody = () => [
  "### Gate review: `draft_gate`",
  "",
  `**Reviewed head SHA:** \`${A}\``,
  "**Verdict:** findings_present",
  "**Findings summary:** low findings",
  "**Next action:** stay draft and fix",
].join("\n");

// Answers every gh call; the PR head is the fixer commit and the draft_gate review lives at A.
function makeRunChild({ puts, existingReview = true, currentHead = FIX, body = existingBody(), prState = "OPEN", liveBody = DEFAULT_TEST_PR_BODY, ownShas = "" }) {
  const prJson = JSON.stringify({
    number: 17, state: prState, isDraft: true, headRefOid: currentHead, baseRefName: "main", body: liveBody,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  const reviews = existingReview
    ? [{ id: 55, state: "COMMENTED", submitted_at: "2026-10-20T10:00:00Z", body, html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-55", user: { login: "gate-bot" }, commit_id: A }]
    : [];
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: ownShas, stderr: "" };
    const a = args.join(" ");
    if (a.includes("pulls/17/reviews/55") && a.includes("PUT")) {
      puts.push(String(stdin ?? ""));
      return { code: 0, stdout: '{"id":55,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-55"}\n', stderr: "" };
    }
    if (a.includes("pulls/17/reviews") && a.includes("-X POST")) throw new Error("a converged post must update the review at A, never create one");
    if (a.includes("requested_reviewers")) return { code: 0, stdout: '{"users":[],"teams":[]}\n', stderr: "" };
    if (a.includes("api") && a.includes("user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("graphql") && a.includes("reviewThreads")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("graphql")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("issues/17/comments")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("pulls/17/reviews")) return { code: 0, stdout: `${JSON.stringify(reviews)}\n`, stderr: "" };
    if (a.includes("pulls/17/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("baseRefOid,labels")) return { code: 0, stdout: '{"baseRefOid":"main","labels":[]}\n', stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: currentHead }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson, stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

async function post(tempDir, { findings, converged, extraArgs = [], runChildOptions = {}, verdict, overallVerdict = "clean", root = repoRoot, ledgerPath = path.join(tempDir, "ledger.json"), checkBaseFreshness }) {
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, verdict: "clean", overallVerdict,
    loggedAt: "2026-10-20T00:00:00.000Z", findings,
  }), "utf8");
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", A,
    "--findings-summary", "converged test", "--findings-ledger", ledgerPath,
    "--next-action", "mark ready for review", "--inline-reason", "converged test",
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }),
    ...(verdict ? ["--verdict", verdict] : []),
    ...extraArgs,
  ];
  if (converged !== undefined) {
    const convergedPath = path.join(tempDir, "converged.json");
    await writeFile(convergedPath, typeof converged === "string" ? converged : JSON.stringify(converged), "utf8");
    args.push("--converged-json", convergedPath);
  }
  const puts = [];
  try {
    const result = await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot: root, runChild: makeRunChild({ puts, ...runChildOptions }), checkBaseFreshness,
      countPrOwnCommits: async (...countArgs) => {
        runChildOptions.countCalls?.push(countArgs);
        if (runChildOptions.countThrows) throw new Error(typeof runChildOptions.countThrows === "string" ? runChildOptions.countThrows : "git fetch failed");
        return String(runChildOptions.ownShas ?? "").split("\n").filter(Boolean).length;
      },
    });
    return { result, body: puts.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), puts };
  }
}

// GATE-EXEC-ROUND-CAP choke point with the cap on (default 4): closed prior rounds in the cap-on root; the posted round at A is round `prior + 1`.
async function withPriorRounds(prior, fn, tmpRoot = path.join(capOnRoot, "tmp")) {
  const dir = path.join(tmpRoot, "gate-findings", "owner-repo", "pr-17");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (let c = 1; c <= prior; c += 1) {
    const head = String(c).repeat(40);
    await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
      repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-11-0${c}T00:00:00.000Z`, findings: [],
    }), "utf8");
  }
  try {
    await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("3105: a judged log with a medium act item derives findings_present with no --verdict", async () => {
  await withTempDir(async (tempDir) => {
    const judgeVerdict = path.join(tempDir, "judge-verdict.json");
    await writeFile(judgeVerdict, JSON.stringify({
      headSha: A,
      scopeDrift: { verdict: "within_scope", rationale: "in scope", driftedAreas: [] },
      dispositions: [{ index: 0, disposition: "act", title: "t", detail: "d", fix: "f", reason: "r", rationale: "fixes AC-1", criterion: "AC-1" }],
    }), "utf8");
    const written = await writeGateFindingsLog({
      repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, verdict: "clean", judgeVerdict, tmpRoot: tempDir,
      findings: JSON.stringify({ overallVerdict: "clean", findings: [{ severity: "medium", angle: "correctness", summary: "edge case" }] }),
    });
    const log = JSON.parse(await readFile(written.path, "utf8"));
    assert.equal(log.overallVerdict, "findings_present");
    const { result, body, error } = await post(tempDir, { findings: log.findings, overallVerdict: log.overallVerdict, runChildOptions: { currentHead: A } });
    assert.equal(error, undefined);
    assert.equal(result.action, "updated");
    assert.match(body, /\*\*Verdict:\*\* findings_present/);
  }, { prefix: "dev-loops-judged-log-verdict-" });
});

test("without --converged-json an all-low/nit act list still refuses clean", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1), finding("nit", 2)];
    const refused = await post(tempDir, { findings, verdict: "clean", runChildOptions: { currentHead: A } });
    assert.match(refused.error, /composed with 2 open judge act item\(s\)/);
  }, { prefix: "dev-loops-converged-nojson-" });
});

test("a malformed --converged-json, one without bodyOnly: true and a fixer commit that is not the PR head fail closed", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("low", 1)];
    assert.match((await post(tempDir, { findings, converged: "not json" })).error, /converged-json/);
    for (const shape of ["null", { fixerCommit: FIX, actList: findings }, { fixerCommit: FIX, actList: findings, bodyOnly: false }, { fixerCommit: FIX, actList: findings, bodyOnly: "true" }]) {
      const out = await post(tempDir, { findings, converged: shape });
      assert.match(out.error ?? "", /must be a JSON object \{ fixerCommit, actList, bodyOnly: true \}/, JSON.stringify(shape));
      assert.deepEqual(out.puts, []);
    }
    const stale = await post(tempDir, { findings, converged: { fixerCommit: FIX, actList: findings, bodyOnly: true }, runChildOptions: { currentHead: "d".repeat(40) } });
    assert.match(stale.error, /is not the current PR head/);
  }, { prefix: "dev-loops-converged-input-" });
});

test("--converged-json is refused for any gate other than draft_gate and any verdict other than clean", () => {
  const base = ["--repo", "owner/repo", "--pr", "17", "--head-sha", A, "--findings-summary", "s", "--next-action", "n", "--inline-reason", "r", "--converged-json", "/x.json"];
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "pre_approval_gate", "--verdict", "clean"]), /--converged-json requires --gate draft_gate/);
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--verdict", "clean"]), /--converged-json requires --gate draft_gate/);
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "draft_gate", "--verdict", "findings_present"]), /--converged-json requires --gate draft_gate/);
});

// ADR 0271 (GATE-EXEC-NO-DEAD-END): a round whose act items are all PR-body items clears with no commit.
const EDITED_BODY = `${DEFAULT_TEST_PR_BODY}\nEdited for the cap round.`;
// ledgerTmpRoot puts the findings ledger and the prior rounds under another tmp root than the cap-round context (the main checkout versus the reviewed worktree).
async function bodyOnlyPost(tempDir, { findings, actList = findings, fixer = A, input = {}, reviewedBody = DEFAULT_TEST_PR_BODY, runChildOptions = {}, ledgerTmpRoot, priorRounds = 3, checkBaseFreshness }) {
  const ledgerPath = ledgerTmpRoot ? path.join(ledgerTmpRoot, "gate-findings", "owner-repo", "pr-17", "ledger.json") : undefined;
  const ctx = path.join(capOnRoot, buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }));
  await mkdir(path.dirname(ctx), { recursive: true });
  await writeFile(ctx, JSON.stringify({ requiredReads: [{ kind: "pr-body", sha256: prBodySha256(reviewedBody) }] }), "utf8");
  let out;
  await withPriorRounds(priorRounds, async () => {
    out = await post(tempDir, { findings, converged: { fixerCommit: fixer, actList, bodyOnly: true, ...input }, root: capOnRoot, ledgerPath, runChildOptions: { currentHead: fixer, liveBody: EDITED_BODY, ...runChildOptions }, checkBaseFreshness });
  }, ledgerTmpRoot);
  await rm(ctx, { force: true });
  return out;
}

test("body-only: --converged-json needs the existing draft_gate comment at A", async () => {
  await withTempDir(async (tempDir) => {
    const { error } = await bodyOnlyPost(tempDir, { findings: [bodyFinding("low", 1)], runChildOptions: { existingReview: false } });
    assert.match(error, /none is the latest draft_gate comment/);
  }, { prefix: "dev-loops-converged-noexisting-" });
});

test("body-only: a comment at A that is already clean or already converged is not converged again", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("low", 1)];
    const clean = existingBody().replace("findings_present", "clean");
    assert.match((await bodyOnlyPost(tempDir, { findings, runChildOptions: { body: clean } })).error, /already clean or converged/);
    const converged = `${clean}\n**Converged:** fixer \`${FIX}\` delta \`sha256:${"c".repeat(64)}\``;
    assert.match((await bodyOnlyPost(tempDir, { findings, runChildOptions: { body: converged } })).error, /already clean or converged/);
  }, { prefix: "dev-loops-converged-twice-" });
});

test("body-only: the act items include the ledger at A: a caller cannot list a subset", async () => {
  await withTempDir(async (tempDir) => {
    const lows = [bodyFinding("low", 1)];
    const findingsJson = path.join(tempDir, "findings.json");
    await writeFile(findingsJson, JSON.stringify(lows), "utf8");
    const out = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 2), ...lows], actList: lows });
    assert.match(out.error, /same items as the posted act items/);
    assert.deepEqual(out.puts, []);
  }, { prefix: "dev-loops-converged-subset-" });
});

test("body-only: two same-summary low items converge, a low item does not match a nit one and one extra copy refuses", async () => {
  await withTempDir(async (tempDir) => {
    const twins = [bodyFinding("low", 1), bodyFinding("low", 1)];
    assert.equal((await bodyOnlyPost(tempDir, { findings: twins })).error, undefined);
    const asNit = [{ ...bodyFinding("low", 1), severity: "nit" }];
    assert.match((await bodyOnlyPost(tempDir, { findings: [bodyFinding("low", 1)], actList: asNit })).error, /same items as the posted act items/);
    assert.match((await bodyOnlyPost(tempDir, { findings: twins, actList: [bodyFinding("low", 1)] })).error, /same items as the posted act items/);
  }, { prefix: "dev-loops-converged-keying-" });
});

async function postWithoutLedger(tempDir, { ledgerArgs = [], devloops = "version: 1\n" } = {}) {
  const lows = [bodyFinding("low", 1)];
  const findingsJson = path.join(tempDir, "findings.json");
  await writeFile(findingsJson, JSON.stringify(lows), "utf8");
  const root = path.join(tempDir, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".devloops"), devloops, "utf8");
  const converged = path.join(tempDir, "converged.json");
  await writeFile(converged, JSON.stringify({ fixerCommit: FIX, actList: lows, bodyOnly: true }), "utf8");
  const puts = [];
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", A, "--findings-summary", "converged test",
    "--findings-json", findingsJson, "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    "--findings-severity-counts", JSON.stringify({ high: 0, medium: 0, low: 1, question: 0, nit: 0 }), "--verdict", "clean", "--converged-json", converged,
    ...ledgerArgs,
  ];
  let error;
  try {
    await upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot: root, runChild: makeRunChild({ puts }) });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { error, puts };
}

for (const requireFanoutEvidence of [true, false]) test(`a converged post without --findings-ledger is refused (requireFanoutEvidence ${requireFanoutEvidence})`, async () => {
  await withTempDir(async (tempDir) => {
    const { error, puts } = await postWithoutLedger(tempDir, { devloops: `version: 1\ngates:\n  requireFanoutEvidence: ${requireFanoutEvidence}\n  draft:\n    maxReviewRounds: 0\n` });
    assert.match(error, /needs --findings-ledger/);
    assert.deepEqual(puts, []);
  }, { prefix: "dev-loops-converged-noledger-" });
});

test("a converged post whose --findings-ledger does not exist is refused naming the path and the error code", async () => {
  await withTempDir(async (tempDir) => {
    const missing = path.join(tempDir, "missing-ledger.json");
    const { error, puts } = await postWithoutLedger(tempDir, { ledgerArgs: ["--findings-ledger", missing] });
    assert.ok(error.includes(missing), error);
    assert.match(error, /ENOENT/);
    assert.deepEqual(puts, []);
  }, { prefix: "dev-loops-converged-missingledger-" });
});

// Post-time fan-out enforcement checks the candidate marker at the fixer commit B (convergedFromHeadSha A), not at A.
test("an inline converged post is refused when A qualifies for inline review but the fixer commit B adds a risk path", async () => {
  const gitRepo = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-postscope-"));
  const saved = { A, FIX, path: process.env.PATH };
  try {
    process.env.PATH = originalPath;
    initGitFixture(gitRepo, { branch: "main" });
    const git = (...args) => execFileSync("git", args, { cwd: gitRepo, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "pr");
    await mkdir(path.join(gitRepo, "docs"), { recursive: true });
    await writeFile(path.join(gitRepo, "docs", "a.md"), "a\n", "utf8");
    git("add", "."); git("commit", "-q", "-m", "A");
    const headA = git("rev-parse", "HEAD");
    await mkdir(path.join(gitRepo, "scripts", "loop"), { recursive: true });
    await writeFile(path.join(gitRepo, "scripts", "loop", "check-size-budget.mjs"), "export {};\n", "utf8");
    git("add", "."); git("commit", "-q", "-m", "B");
    const headB = git("rev-parse", "HEAD");
    // The fan-out evidence stays required (the repo's own config), so the inline review is checked.
    await writeFile(path.join(gitRepo, ".devloops"), (await readFile(path.resolve(".devloops"), "utf8")).replace("\n  draft:\n", "\n  draft:\n    maxReviewRounds: 0\n"), "utf8");
    A = headA; FIX = headB;
    const ctx = path.join(gitRepo, buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }));
    await mkdir(path.dirname(ctx), { recursive: true });
    await writeFile(ctx, JSON.stringify({ requiredReads: [{ kind: "pr-body", sha256: prBodySha256(DEFAULT_TEST_PR_BODY) }] }), "utf8");
    await withTempDir(async (tempDir) => {
      const findings = [bodyFinding("low", 1)];
      const { error, puts } = await post(tempDir, { findings, converged: { fixerCommit: headB, actList: findings, bodyOnly: true }, root: gitRepo, runChildOptions: { liveBody: EDITED_BODY } });
      assert.match(error, /Cannot post a inline_single_agent verdict/);
      assert.deepEqual(puts, []);
    }, { prefix: "dev-loops-converged-postscope-tmp-" });
  } finally {
    ({ A, FIX } = saved);
    process.env.PATH = saved.path;
    await rm(gitRepo, { recursive: true, force: true });
  }
});

test("body-only: an unchanged head and a head moved by a base-only merge both post the converged record", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1), bodyFinding("low", 2)];
    for (const fixer of [A, FIX]) {
      const { result, body, error } = await bodyOnlyPost(tempDir, { findings, fixer });
      assert.equal(error, undefined);
      assert.equal(result.action, "updated");
      assert.match(body, /\*\*Verdict:\*\* clean/);
      assert.match(body, new RegExp(`\\*\\*Converged:\\*\\* fixer \`${fixer}\` delta \`sha256:[a-f0-9]{64}\``));
    }
  }, { prefix: "dev-loops-converged-bodyonly-ok-" });
});

// ADR 0332: the body-only post applies at every draft_gate round, so round 2 of cap 4 posts after a body edit at the same head.
test("body-only: round 2 of cap 4 with two pr_body act items posts the converged record after a body edit at the same head", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1), bodyFinding("low", 2)];
    const { result, body, error } = await bodyOnlyPost(tempDir, { findings, priorRounds: 1 });
    assert.equal(error, undefined);
    assert.equal(result.action, "updated");
    assert.match(body, /\*\*Converged:\*\*/);
  }, { prefix: "dev-loops-converged-bodyonly-below-cap-" });
});

test("body-only: a missing cap-round context refuses body_read_unrecorded, not body_unchanged", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1)];
    let out;
    await withPriorRounds(3, async () => {
      out = await post(tempDir, { findings, converged: { fixerCommit: A, actList: findings, bodyOnly: true }, root: capOnRoot, runChildOptions: { currentHead: A, liveBody: EDITED_BODY } });
    });
    assert.match(out.error ?? "", /^body_read_unrecorded:/);
    assert.equal(out.puts.length, 0);
  }, { prefix: "dev-loops-converged-bodyonly-noctx-" });
});

test("body-only: each failed narrow check refuses with its typed reason and posts nothing", async () => {
  await withTempDir(async (tempDir) => {
    const bodyItems = [bodyFinding("medium", 1)];
    const cases = [
      ["body_item_locatable", { findings: [{ ...bodyFinding("low", 1), file: "src/a.mjs", line: 3 }] }],
      // A code item that names a file but no line is no PR-body item either.
      ["body_item_locatable", { findings: [{ ...bodyFinding("medium", 1), file: "src/a.mjs", summary: "missing NaN guard" }] }],
      ["body_item_locatable", { findings: [{ ...bodyFinding("medium", 1), files: ["src/a.mjs"] }] }],
      ["body_unchanged", { findings: bodyItems, reviewedBody: EDITED_BODY }],
      ["own_commit_in_range", { findings: bodyItems, fixer: FIX, runChildOptions: { ownShas: `${"c".repeat(40)}\n` } }],
      // A non-descendant fixer commit keeps its typed reason as the leading token.
      ["own_commit_in_range", { findings: bodyItems, fixer: FIX, runChildOptions: { countThrows: `own_commit_in_range: ${FIX} does not descend from the reviewed head ${A}` } }],
      ["blocked_item", { findings: [bodyFinding("high", 1)] }],
      // The ledger holds a deferred high next to the body item: the whole round blocks, not only the act list.
      ["blocked_item", { findings: [bodyFinding("medium", 1), { severity: "high", angle: "correctness", summary: "deferred high", judgeDisposition: "defer" }], actList: [bodyFinding("medium", 1)] }],
      ["blocked_item", { findings: [{ ...bodyFinding("medium", 1), failOpen: true }] }],
      ["blocked_item", { findings: [{ ...bodyFinding("medium", 1), angle: "renderer-security" }] }],
    ];
    for (const [reason, opts] of cases) {
      const out = await bodyOnlyPost(tempDir, opts);
      assert.match(out.error ?? "", new RegExp(`^${reason}:`), `${reason}: ${out.error}`);
      assert.equal(out.puts.length, 0, "nothing is posted");
    }
  }, { prefix: "dev-loops-converged-bodyonly-refuse-" });
});

test("body-only: a bodyOnly that is not true refuses with the body-only shape", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1)];
    for (const bodyOnly of ["true", 1, null, false, undefined]) {
      const out = await bodyOnlyPost(tempDir, { findings, input: { bodyOnly } });
      assert.match(out.error ?? "", /must be a JSON object \{ fixerCommit, actList, bodyOnly: true \}/, `${JSON.stringify(bodyOnly)}: ${out.error}`);
      assert.equal(out.puts.length, 0, "nothing is posted");
    }
  }, { prefix: "dev-loops-converged-bodyonly-type-" });
});

test("body-only: the pr-body read is found when the ledger and the cap-round context sit under different tmp roots", async () => {
  await withTempDir(async (tempDir) => {
    const { result, error } = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 1)], ledgerTmpRoot: path.join(tempDir, "main", "tmp") });
    assert.equal(error, undefined);
    assert.equal(result.action, "updated");
  }, { prefix: "dev-loops-converged-bodyonly-roots-" });
});

test("body-only: a throwing own-commit count never hides a typed refusal of the pure checks", async () => {
  await withTempDir(async (tempDir) => {
    const out = await bodyOnlyPost(tempDir, { findings: [bodyFinding("high", 1)], fixer: FIX, runChildOptions: { countThrows: true } });
    assert.match(out.error ?? "", /^blocked_item:/, out.error);
    const counted = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 1)], fixer: FIX, runChildOptions: { countThrows: true } });
    assert.match(counted.error ?? "", /^--converged-json bodyOnly: cannot count PR-own commits/, counted.error);
  }, { prefix: "dev-loops-converged-bodyonly-lazy-" });
});

test("body-only: two contexts at the reviewed head under different roots with different pr-body digests refuse body_read_unrecorded", async () => {
  await withTempDir(async (tempDir) => {
    const mainTmp = path.join(tempDir, "main", "tmp");
    const staleCtx = path.join(tempDir, "main", buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }));
    await mkdir(path.dirname(staleCtx), { recursive: true });
    await writeFile(staleCtx, JSON.stringify({ requiredReads: [{ kind: "pr-body", sha256: prBodySha256("an older round's body") }] }), "utf8");
    const out = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 1)], ledgerTmpRoot: mainTmp });
    assert.match(out.error ?? "", /^body_read_unrecorded: .*different pr-body digests/, out.error);
    assert.ok((out.error ?? "").includes(staleCtx), "the message names the stale context path");
    assert.ok((out.error ?? "").includes(path.join(capOnRoot, buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }))), "the message names the cap-round context path");
    assert.equal(out.puts.length, 0);
  }, { prefix: "dev-loops-converged-bodyonly-ambiguous-" });
});

test("body-only: an older same-head context in another checkout never stands in for a lost cap-round context", async () => {
  await withTempDir(async (tempDir) => {
    const mainTmp = path.join(tempDir, "main", "tmp");
    const staleCtx = path.join(tempDir, "main", buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }));
    await mkdir(path.dirname(staleCtx), { recursive: true });
    await writeFile(staleCtx, JSON.stringify({ requiredReads: [{ kind: "pr-body", sha256: prBodySha256(DEFAULT_TEST_PR_BODY) }] }), "utf8");
    const findings = [bodyFinding("medium", 1)];
    const ledgerPath = path.join(mainTmp, "gate-findings", "owner-repo", "pr-17", "ledger.json");
    let out;
    await withPriorRounds(3, async () => {
      out = await post(tempDir, { findings, converged: { fixerCommit: A, actList: findings, bodyOnly: true }, root: capOnRoot, ledgerPath, runChildOptions: { currentHead: A, liveBody: EDITED_BODY } });
    }, mainTmp);
    assert.match(out.error ?? "", /^body_read_unrecorded: the reviewed worktree holds no context/, out.error);
    assert.equal(out.puts.length, 0);
  }, { prefix: "dev-loops-converged-bodyonly-lostctx-" });
});

test("body-only: a malformed context beside a readable one refuses body_read_unrecorded naming the path", async () => {
  await withTempDir(async (tempDir) => {
    const mainTmp = path.join(tempDir, "main", "tmp");
    const badCtx = path.join(tempDir, "main", buildGateContextPath({ repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, tmpRoot: "tmp" }));
    await mkdir(path.dirname(badCtx), { recursive: true });
    await writeFile(badCtx, '{"requiredReads": [', "utf8");
    const out = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 1)], ledgerTmpRoot: mainTmp });
    assert.match(out.error ?? "", /^body_read_unrecorded: the context .* cannot be read/, out.error);
    assert.ok((out.error ?? "").includes(badCtx));
    assert.equal(out.puts.length, 0);
  }, { prefix: "dev-loops-converged-bodyonly-malformed-" });
});

// Converged-record carry: real git, so the stubbed git on PATH is lifted for these cases.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
// Builds main, a PR branch with commit F (the fixer commit) and a merge M of main into it; returns { f, m }.
// The repo is a dedicated temp dir holding a copy of `template`'s .devloops; it replaces the shared `template` root (repoRoot or capOnRoot) for the call.
async function withMergeShape(template, { baseFile = "docs/main-only.md", baseContent = "main\n", changeAfterMerge = false, side = false, criss = false, noBaseRef = false, lagRef = false }, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-mergeshape-"));
  await writeFile(path.join(root, ".devloops"), await readFile(path.join(template, ".devloops"), "utf8"), "utf8");
  const swapCapOn = template === capOnRoot;
  if (swapCapOn) capOnRoot = root; else repoRoot = root;
  const git =(...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  const put = async (file, content) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); };
  const savedPath = process.env.PATH;
  process.env.PATH = originalPath;
  try {
    initGitFixture(root, { branch: "main" });
    await put("base.txt", "base\n");
    git("add", "base.txt"); git("commit", "-qm", "base");
    git("checkout", "-qb", "pr");
    await put("src/pr.mjs", "pr\n");
    git("add", "src"); git("commit", "-qm", "pr");
    await put("src/pr.mjs", "pr fixed\n");
    git("commit", "-qam", "fixer");
    const f = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    await put(baseFile, baseContent);
    git("add", baseFile); git("commit", "-qm", "main change");
    if (criss) { git("merge", "-q", "--no-ff", "--no-edit", f); }
    git("checkout", "-q", "pr");
    if (side) git("checkout", "-q", "-B", "pr", "main"); // F is no longer an ancestor of the PR head
    try { git("merge", "-q", "--no-ff", "--no-edit", criss ? "main~1" : "main"); } catch {
      // A same-path edit conflicts; resolve it by keeping the PR side, so every PR blob stays identical to F.
      git("checkout", "--ours", "src/pr.mjs"); git("add", "src/pr.mjs"); git("commit", "-q", "--no-edit");
    }
    if (changeAfterMerge) { await put("src/pr.mjs", "changed pr blob\n"); git("commit", "-qam", "own change"); }
    git("update-ref", "refs/remotes/origin/main", "main");
    if (noBaseRef) git("update-ref", "-d", "refs/remotes/origin/main");
    if (lagRef) git("update-ref", "refs/remotes/origin/main", "main~1"); // the tracking ref lags the base commit merged into M
    return await fn({ f, m: git("rev-parse", "HEAD") });
  } finally {
    process.env.PATH = savedPath;
    if (swapCapOn) capOnRoot = template; else repoRoot = template;
    await rm(root, { recursive: true, force: true });
  }
}

const REFUSED = /is not the current PR head/;

test("carry: a body-only converged post at a base merge M after F records convergence and refreshes the base at M before the carry classifier", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1), bodyFinding("low", 2)];
    await withMergeShape(capOnRoot, {}, async ({ f, m }) => {
      const countCalls = [];
      const heads = [];
      const checkBaseFreshness = async ({ head, base }) => { heads.push(head); return { ok: true, status: "base_current", base }; };
      const out = await bodyOnlyPost(tempDir, { findings, fixer: f, runChildOptions: { currentHead: m, countCalls }, checkBaseFreshness });
      assert.equal(out.error, undefined);
      assert.equal(out.result.action, "updated");
      assert.equal(countCalls.length, 1);
      assert.equal(countCalls[0][2], f, "the own-commit count ends at the fixer commit F, not the base merge M");
      assert.match(out.body, new RegExp(`\\*\\*Converged:\\*\\* fixer \`${f}\``));
    });
  }, { prefix: "dev-loops-converged-carry-body-" });
});

test("carry: a body-only converged post at M records convergence when the base tracking ref lags until the freshness fetch", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1)];
    await withMergeShape(capOnRoot, { lagRef: true }, async ({ f, m }) => {
      // The stub stands in for the fetch: it brings the tracking ref up to the base tip.
      const checkBaseFreshness = async ({ base, cwd }) => {
        execFileSync("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd, env: GIT_ENV });
        return { ok: true, status: "base_current", base };
      };
      const out = await bodyOnlyPost(tempDir, { findings, fixer: f, runChildOptions: { currentHead: m }, checkBaseFreshness });
      assert.equal(out.error, undefined);
      assert.equal(out.result.action, "updated");
    });
  }, { prefix: "dev-loops-converged-carry-lag-" });
});

test("carry: a converged post with a malformed fixerCommit is refused before the carry check", async () => {
  await withTempDir(async (tempDir) => {
    const out = await bodyOnlyPost(tempDir, { findings: [bodyFinding("medium", 1)], fixer: "not-a-sha", runChildOptions: { currentHead: "c".repeat(40) } });
    assert.match(out.error ?? "", REFUSED);
  }, { prefix: "dev-loops-converged-carry-badsha-" });
});

test("carry: a changed PR blob, a gate-tooling base delta, a non-ancestor F, a criss-cross base and a detection failure keep the refusal", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [bodyFinding("medium", 1)];
    const cases = {
      "changed PR blob": { changeAfterMerge: true },
      "gate-tooling base delta": { baseFile: "scripts/github/write-gate-context.mjs" },
      // Every PR blob is kept identical to F. main edits src/pr.mjs, so the base-delta intersection refuses here; the hand-resolved hunk rule is isolated in classify-base-merge-carry.test.mjs "hand-resolved conflict merge".
      "hand-resolved conflict merge": { baseFile: "src/pr.mjs", baseContent: "conflicting main\n" },
      "non-ancestor F": { side: true },
      "criss-cross merge base": { criss: true },
      "detection failure (no base ref)": { noBaseRef: true },
    };
    for (const [name, shape] of Object.entries(cases)) {
      await withMergeShape(capOnRoot, shape, async ({ f, m }) => {
        assert.match((await bodyOnlyPost(tempDir, { findings, fixer: f, runChildOptions: { currentHead: m } })).error ?? "", REFUSED, name);
      });
    }
  }, { prefix: "dev-loops-converged-carry-refuse-" });
});
