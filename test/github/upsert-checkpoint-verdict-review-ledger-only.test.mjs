import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseUpsertCheckpointVerdictCliArgs } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

const HEAD = "a".repeat(40);
const base = ["--execution-mode", "fanout_fanin","--repo", "owner/repo", "--pr", "7", "--head-sha", HEAD, "--findings-ledger", "/tmp/ledger.json"];

test("#3199: --gate review accepts --findings-ledger as the only findings input", () => {
  const options = parseUpsertCheckpointVerdictCliArgs([...base, "--gate", "review"]);
  assert.equal(options.findingsLedger, "/tmp/ledger.json");
});

test("#3199: draft_gate and pre_approval_gate still require a findings input", () => {
  for (const gate of ["draft_gate", "pre_approval_gate"]) {
    assert.throws(() => parseUpsertCheckpointVerdictCliArgs([...base, "--gate", gate, "--next-action", "x"]), /requires --repo/);
  }
});

// Rendering: a ledger-only review post derives the findings summary from the ledger.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "bun:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

let gitStubDir; let originalPath; let repoRoot;
beforeAll(async () => {
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-3199-gitstub-"));
  await writeFile(path.join(gitStubDir, "git"), "#!/bin/sh\n[ \"$1\" = cat-file ] && exit 1\nexit 0\n", "utf8");
  await chmod(path.join(gitStubDir, "git"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].join(path.delimiter);
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-3199-repo-"));
  const real = await readFile(path.resolve(".devloops"), "utf8");
  await writeFile(path.join(repoRoot, ".devloops"), real.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false"), "utf8");
});
afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(gitStubDir, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

function makeRunChild(posted, existingReviews = []) {
  const prJson = JSON.stringify({
    number: 7, state: "OPEN", isDraft: true, headRefOid: HEAD, body: DEFAULT_TEST_PR_BODY,
    closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }) + "\n";
  return async (cmd, args = [], _env, stdin = "") => {
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    const a = args.join(" ");
    if (a.includes("pulls/7/reviews") && a.includes("-X POST")) {
      posted.push(String(stdin ?? ""));
      return { code: 0, stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/7#pullrequestreview-101"}\n', stderr: "" };
    }
    if (a.includes("requested_reviewers")) return { code: 0, stdout: '{"users":[],"teams":[]}\n', stderr: "" };
    if (a.includes("api") && a.includes("user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("graphql")) return { code: 0, stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n', stderr: "" };
    if (a.includes("issues/7/comments")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("pulls/7/reviews")) return { code: 0, stdout: JSON.stringify(existingReviews) + "\n", stderr: "" };
    if (a.includes("pulls/7/files")) return { code: 0, stdout: "[]\n", stderr: "" };
    if (a.includes("--json") && a.includes("headRefOid") && !a.includes("state") && !a.includes("statusCheckRollup")) return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD }) + "\n", stderr: "" };
    if (a.includes("--json") && a.includes("files") && !a.includes("statusCheckRollup")) return { code: 0, stdout: "src/db.mjs\n", stderr: "" };
    if (a.includes("--json")) return { code: 0, stdout: prJson, stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

test("#3199: ledger-only review post renders ledger findings, no 'undefined', and a same-head rerun is a noop", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = path.join(tempDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo", pr: 7, gate: "review", headSha: HEAD, verdict: "findings_present", overallVerdict: "findings_present",
      loggedAt: "2026-09-23T00:00:00.000Z",
      findings: [{ severity: "medium", angle: "correctness", summary: "ledger-only medium finding", judgeDisposition: "act", judgeRationale: "r" }],
    }), "utf8");
    const args = ["--repo", "owner/repo", "--pr", "7", "--gate", "review", "--head-sha", HEAD, "--submit", "comment", "--inline-reason", "ledger only", "--judge-spec-source", "pr_body", "--findings-ledger", ledgerPath];
    const run = (runChild) => upsertCheckpointVerdict(parseUpsertCheckpointVerdictCliArgs(args), {
      env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", repoRoot, runChild,
    });
    const posted = [];
    await run(makeRunChild(posted));
    const body = posted.join("\n");
    assert.match(body, /ledger-only medium finding/);
    assert.match(body, /\*\*Findings summary:\*\* .*1 finding/);
    assert.doesNotMatch(body, /undefined/);
    const rerunPosted = [];
    const result = await run(makeRunChild(rerunPosted, [{ id: 101, user: { login: "gate-bot" }, commit_id: HEAD, state: "COMMENTED", body: JSON.parse(posted[0]).body }]));
    assert.equal(rerunPosted.length, 0);
    assert.match(JSON.stringify(result), /noop|unchanged/i);
  }, { prefix: "dev-loops-3199-render-" });
});
