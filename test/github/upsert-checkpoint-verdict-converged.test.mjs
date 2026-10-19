import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { parseUpsertCheckpointVerdictCliArgs, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { startDeltaSequence } from "../../packages/core/src/loop/pre-push-delta-review.mjs";

// GATE-EXEC-LOW-NIT-CONVERGENCE: an all-low/nit draft_gate round at head A converges after one fixer pass and a
// clean delta review. The comment at A is updated to clean with the Converged field while the PR head is the
// fixer commit. Everything else keeps today's refusal.

const A = "a".repeat(40);
const FIX = "b".repeat(40);

let gitStubDir = null;
let originalPath = null;
let repoRoot = null;
before(async () => {
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\n[ \"$1\" = cat-file ] && exit 1\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-converged-repo-"));
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

const finding = (severity, n = 1) => ({ severity, angle: "correctness", summary: `${severity} finding ${n}`, judgeDisposition: "act", judgeRationale: "test rationale" });

const EXISTING_BODY = [
  "### Gate review: `draft_gate`",
  "",
  `**Reviewed head SHA:** \`${A}\``,
  "**Verdict:** findings_present",
  "**Findings summary:** low findings",
  "**Next action:** stay draft and fix",
].join("\n");

// The fixer commit and the clean delta review for an act list at head A.
function convergedInput(actList, overrides = {}) {
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList });
  return {
    fixerCommit: FIX,
    actList,
    deltaResult: {
      reviewBaselineHead: A,
      candidateHead: FIX,
      actSetId: sequence.actSetId,
      actionableItems: sequence.actItems.map((item) => ({ ref: item.ref, status: "resolved", evidence: ["fixed"] })),
      newFindings: [],
      widenedReads: [],
      outcome: "locally_clear",
    },
    ...overrides,
  };
}

// Answers every gh call; the PR head is the fixer commit and the draft_gate review lives at A.
function makeRunChild({ puts, existingReview = true, currentHead = FIX, body = EXISTING_BODY }) {
  const prJson = JSON.stringify({
    number: 17, state: "OPEN", isDraft: true, headRefOid: currentHead, body: DEFAULT_TEST_PR_BODY,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  const reviews = existingReview
    ? [{ id: 55, state: "COMMENTED", submitted_at: "2026-10-20T10:00:00Z", body, html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-55", user: { login: "gate-bot" }, commit_id: A }]
    : [];
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
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
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: currentHead }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson, stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

async function post(tempDir, { findings, converged, extraArgs = [], runChildOptions = {}, verdict }) {
  const ledgerPath = path.join(tempDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo", pr: 17, gate: "draft_gate", headSha: A, verdict: "clean", overallVerdict: "clean",
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
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild: makeRunChild({ puts, ...runChildOptions }),
    });
    return { result, body: puts.join("\n") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), puts };
  }
}

test("an all-low/nit act list with a clean delta updates the comment at A to clean with the Converged field", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1), finding("nit", 2)];
    const { result, body, error } = await post(tempDir, { findings, converged: convergedInput(findings) });
    assert.equal(error, undefined);
    assert.equal(result.action, "updated");
    assert.equal(result.headSha, A);
    assert.match(body, /\*\*Verdict:\*\* clean/);
    assert.match(body, new RegExp(`\\*\\*Reviewed head SHA:\\*\\* \`${A}\``));
    assert.match(body, new RegExp(`\\*\\*Converged:\\*\\* fixer \`${FIX}\` delta \`sha256:[a-f0-9]{64}\``));
  }, { prefix: "dev-loops-converged-ok-" });
});

test("without --converged-json the same all-low/nit act list still refuses clean", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1), finding("nit", 2)];
    const refused = await post(tempDir, { findings, verdict: "clean", runChildOptions: { currentHead: A } });
    assert.match(refused.error, /composed with 2 open judge act item\(s\)/);
  }, { prefix: "dev-loops-converged-nojson-" });
});

for (const [name, findings] of [
  ["a medium-only act list", [finding("medium", 1)]],
  ["a high-only act list", [finding("high", 1)]],
  ["a question-only act list", [finding("question", 1)]],
  ["a mixed list of one medium and two low items", [finding("medium", 1), finding("low", 2), finding("low", 3)]],
]) {
  test(`${name} requires a full round`, async () => {
    await withTempDir(async (tempDir) => {
      const { error, puts } = await post(tempDir, { findings, converged: convergedInput(findings) });
      assert.match(error, /needs a full round/);
      assert.deepEqual(puts, []);
    }, { prefix: "dev-loops-converged-full-" });
  });
}

test("an empty act list, a stale delta result and a delta result that is not locally_clear fail closed", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1)];
    const empty = await post(tempDir, { findings: [{ ...finding("low", 1), judgeDisposition: "reject" }], converged: convergedInput(findings) });
    assert.match(empty.error, /needs a full round/);
    const stale = convergedInput(findings);
    stale.deltaResult.candidateHead = "c".repeat(40);
    assert.match((await post(tempDir, { findings, converged: stale })).error, /stale/);
    const notClear = convergedInput(findings);
    notClear.deltaResult.outcome = "needs_fix";
    assert.match((await post(tempDir, { findings, converged: notClear })).error, /deltaResult/);
  }, { prefix: "dev-loops-converged-delta-" });
});

test("a malformed --converged-json or a fixer commit that is not the PR head fails closed", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1)];
    assert.match((await post(tempDir, { findings, converged: "not json" })).error, /converged-json/);
    assert.match((await post(tempDir, { findings, converged: "null" })).error, /must be a JSON object/);
    assert.match((await post(tempDir, { findings, converged: convergedInput(findings), runChildOptions: { currentHead: "d".repeat(40) } })).error, /is not the current PR head/);
  }, { prefix: "dev-loops-converged-input-" });
});

test("--converged-json needs the existing draft_gate comment at A", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1)];
    const { error } = await post(tempDir, { findings, converged: convergedInput(findings), runChildOptions: { existingReview: false } });
    assert.match(error, /none is the latest draft_gate comment/);
  }, { prefix: "dev-loops-converged-noexisting-" });
});

test("--converged-json is refused for any gate other than draft_gate and any verdict other than clean", () => {
  const base = ["--repo", "owner/repo", "--pr", "17", "--head-sha", A, "--findings-summary", "s", "--next-action", "n", "--inline-reason", "r", "--converged-json", "/x.json"];
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "pre_approval_gate", "--verdict", "clean"]), /--converged-json requires --gate draft_gate/);
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--verdict", "clean"]), /--converged-json requires --gate draft_gate/);
  assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "draft_gate", "--verdict", "findings_present"]), /--converged-json requires --gate draft_gate/);
});

test("a comment at A that is already clean or already converged is not converged again", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1)];
    const clean = EXISTING_BODY.replace("findings_present", "clean");
    assert.match((await post(tempDir, { findings, converged: convergedInput(findings), runChildOptions: { body: clean } })).error, /already clean or converged/);
    const converged = `${clean}\n**Converged:** fixer \`${FIX}\` delta \`sha256:${"c".repeat(64)}\``;
    assert.match((await post(tempDir, { findings, converged: convergedInput(findings), runChildOptions: { body: converged } })).error, /already clean or converged/);
  }, { prefix: "dev-loops-converged-twice-" });
});

test("the act items include the ledger at A: a caller cannot list a subset", async () => {
  await withTempDir(async (tempDir) => {
    const lows = [finding("low", 1)];
    const findingsJson = path.join(tempDir, "findings.json");
    await writeFile(findingsJson, JSON.stringify(lows), "utf8");
    const { error, puts } = await post(tempDir, { findings: [finding("medium", 2), ...lows], converged: convergedInput(lows), extraArgs: ["--findings-json", findingsJson] });
    assert.match(error, /needs a full round/);
    assert.deepEqual(puts, []);
  }, { prefix: "dev-loops-converged-subset-" });
});

test("two same-summary low items converge and a low item does not match a nit one", async () => {
  await withTempDir(async (tempDir) => {
    const twins = [finding("low", 1), finding("low", 1)];
    const ok = await post(tempDir, { findings: twins, converged: convergedInput(twins) });
    assert.equal(ok.error, undefined);
    const low = [finding("low", 1)];
    const asNit = [{ ...finding("low", 1), severity: "nit" }];
    assert.match((await post(tempDir, { findings: low, converged: convergedInput(asNit) })).error, /same items as the posted act items/);
  }, { prefix: "dev-loops-converged-keying-" });
});

test("same-summary low items at different files must both be in the delta list", async () => {
  await withTempDir(async (tempDir) => {
    const a = { ...finding("low", 1), files: ["a.mjs"], line: 10 };
    const b = { ...finding("low", 1), files: ["b.mjs"], line: 20 };
    const refused = await post(tempDir, { findings: [a, b], converged: convergedInput([a]) });
    assert.match(refused.error, /same items as the posted act items/);
    assert.deepEqual(refused.puts, []);
    assert.equal((await post(tempDir, { findings: [a, b], converged: convergedInput([a, b]) })).error, undefined);
  }, { prefix: "dev-loops-converged-sites-" });
});

test("the ledger and --findings-json carrying the same low item, with and without files and line, converge", async () => {
  await withTempDir(async (tempDir) => {
    const withSite = { ...finding("low", 1), files: ["a.mjs"], line: 10 };
    const findingsJson = path.join(tempDir, "findings.json");
    await writeFile(findingsJson, JSON.stringify([finding("low", 1)]), "utf8");
    const { error } = await post(tempDir, { findings: [withSite], converged: convergedInput([withSite]), extraArgs: ["--findings-json", findingsJson] });
    assert.equal(error, undefined);
  }, { prefix: "dev-loops-converged-union-" });
});

test("one extra unresolved copy of a same-summary item refuses convergence", async () => {
  await withTempDir(async (tempDir) => {
    const { error, puts } = await post(tempDir, { findings: [finding("low", 1), finding("low", 1)], converged: convergedInput([finding("low", 1)]) });
    assert.match(error, /same items as the posted act items/);
    assert.deepEqual(puts, []);
  }, { prefix: "dev-loops-converged-extra-" });
});

test("a delta result carrying a new finding fails closed", async () => {
  await withTempDir(async (tempDir) => {
    const findings = [finding("low", 1)];
    const input = convergedInput(findings);
    input.deltaResult.newFindings = [{ severity: "low", summary: "unposted" }];
    assert.match((await post(tempDir, { findings, converged: input })).error, /deltaResult/);
  }, { prefix: "dev-loops-converged-newfinding-" });
});

test("a judge-enriched --findings-json medium act item over an all-low ledger requires a full round", async () => {
  await withTempDir(async (tempDir) => {
    const lows = [finding("low", 1)];
    const findingsJson = path.join(tempDir, "findings.json");
    await writeFile(findingsJson, JSON.stringify([...lows, finding("medium", 2)]), "utf8");
    const { error, puts } = await post(tempDir, { findings: lows, converged: convergedInput(lows), extraArgs: ["--findings-json", findingsJson] });
    assert.match(error, /needs a full round/);
    assert.deepEqual(puts, []);
  }, { prefix: "dev-loops-converged-enriched-" });
});

async function postWithoutLedger(tempDir, { ledgerArgs = [], devloops = "version: 1\n" } = {}) {
  const lows = [finding("low", 1)];
  const findingsJson = path.join(tempDir, "findings.json");
  await writeFile(findingsJson, JSON.stringify(lows), "utf8");
  const root = path.join(tempDir, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".devloops"), devloops, "utf8");
  const converged = path.join(tempDir, "converged.json");
  await writeFile(converged, JSON.stringify(convergedInput(lows)), "utf8");
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
    const { error, puts } = await postWithoutLedger(tempDir, { devloops: `version: 1\ngates:\n  requireFanoutEvidence: ${requireFanoutEvidence}\n` });
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
