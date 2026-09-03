import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode as runNodeHelper, withTempDir, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";
import {
  auditReviewMarkerPresence,
  parseAuditReviewMarkerPresenceCliArgs,
} from "../../scripts/github/audit-review-marker-presence.mjs";

const scriptPath = path.resolve("scripts/github/audit-review-marker-presence.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);
const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries);

const HEAD_SHA = "abc1234000000000000000000000000000000000";

function stubRunChild({ reviews = [], reviewComments = [] }) {
  return async function runChild(command, args) {
    assert.equal(command, "gh");
    const joined = args.join(" ");
    if (joined.includes("repos/owner/repo/pulls/17/reviews?")) {
      return { code: 0, stdout: `${JSON.stringify(reviews)}\n`, stderr: "" };
    }
    if (joined.includes("repos/owner/repo/pulls/17/comments?")) {
      return { code: 0, stdout: `${JSON.stringify(reviewComments)}\n`, stderr: "" };
    }
    if (joined.includes("--json") && joined.includes("headRefOid")) {
      return { code: 0, stdout: `${JSON.stringify({ headRefOid: HEAD_SHA })}\n`, stderr: "" };
    }
    throw new Error(`Unexpected gh invocation: ${joined}`);
  };
}

function markerReview({ id, round = 1, gate = "review", headSha = HEAD_SHA, extra = "" }) {
  return {
    id,
    body: [`<!-- dev-loops:gate-findings-review ${gate} ${headSha} round=${round} -->`, "", "### Gate review: `review`", extra].join("\n"),
    state: "COMMENTED",
    submitted_at: "2026-08-10T05:10:00Z",
  };
}

const RAW_GH_COMMENT_REVIEW = {
  id: 999,
  body: "LGTM overall, a couple of small nits but nothing blocking.",
  state: "COMMENTED",
  submitted_at: "2026-08-10T05:10:00Z",
};

const LOCATABLE_FINDING = { severity: "must-fix", angle: "correctness", summary: "SQL injection in the query builder", files: ["src/db.mjs"], line: 2 };

async function writeReviewLedger(tempDir, findings, overrides = {}) {
  const ledgerPath = path.join(tempDir, "review-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo",
    pr: 17,
    gate: "review",
    headSha: HEAD_SHA,
    verdict: findings.length > 0 ? "findings_present" : "clean",
    findings,
    ...overrides,
  }), "utf8");
  return ledgerPath;
}

test("audit-review-marker-presence: a contract-compliant round (marker + inlines) produces no warning", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeReviewLedger(tempDir, [LOCATABLE_FINDING]);
    const result = await auditReviewMarkerPresence(
      { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: ledgerPath },
      {
        runChild: stubRunChild({
          reviews: [markerReview({ id: 501 })],
          reviewComments: [{ id: 1, pull_request_review_id: 501, path: "src/db.mjs", line: 2 }],
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.markerFound, true);
    assert.equal(result.reviewId, 501);
    assert.equal(result.round, 1);
    assert.equal(result.locatableFindingsCount, 1);
    assert.equal(result.inlineCommentCount, 1);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.advisory, true);
  });
});

test("audit-review-marker-presence: a raw-gh-comment round (no marker) produces the WARNING", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeReviewLedger(tempDir, [LOCATABLE_FINDING]);
    const result = await auditReviewMarkerPresence(
      { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: ledgerPath },
      { runChild: stubRunChild({ reviews: [RAW_GH_COMMENT_REVIEW] }) },
    );

    assert.equal(result.ok, true);
    assert.equal(result.markerFound, false);
    assert.equal(result.reviewId, null);
    // The ledger read still runs (locatableFindingsCount reported) even
    // though no marker was found — only the inline-comment cross-check is
    // gated on markerFound.
    assert.equal(result.locatableFindingsCount, 1);
    assert.equal(result.inlineCommentCount, null);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /No `dev-loops:gate-findings-review review` marker found/);
  });
});

test("audit-review-marker-presence: a draft_gate/pre_approval_gate marker on the same head does NOT satisfy the review-gate check (scoped to review only)", async () => {
  const result = await auditReviewMarkerPresence(
    { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: null },
    { runChild: stubRunChild({ reviews: [markerReview({ id: 1, gate: "draft_gate" })] }) },
  );

  assert.equal(result.markerFound, false);
  assert.equal(result.warnings.length, 1);
});

test("audit-review-marker-presence: marker present but zero inline comments despite locatable findings produces the WARNING", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeReviewLedger(tempDir, [LOCATABLE_FINDING]);
    const result = await auditReviewMarkerPresence(
      { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: ledgerPath },
      {
        runChild: stubRunChild({
          reviews: [markerReview({ id: 501 })],
          reviewComments: [],
        }),
      },
    );

    assert.equal(result.markerFound, true);
    assert.equal(result.inlineCommentCount, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /carries no inline comments/);
  });
});

test("audit-review-marker-presence: a bare verdict ledger (no locatable findings) never requires inline comments", async () => {
  const result = await auditReviewMarkerPresence(
    { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: null },
    { runChild: stubRunChild({ reviews: [markerReview({ id: 501 })] }) },
  );

  assert.equal(result.markerFound, true);
  assert.equal(result.locatableFindingsCount, null);
  assert.equal(result.inlineCommentCount, null);
  assert.deepEqual(result.warnings, []);
});

test("audit-review-marker-presence: a ledger for a different gate is rejected (scoped to review only)", async () => {
  await withTempDir(async (tempDir) => {
    const ledgerPath = await writeReviewLedger(tempDir, [LOCATABLE_FINDING], { gate: "draft_gate" });
    await assert.rejects(
      auditReviewMarkerPresence(
        { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: ledgerPath },
        { runChild: stubRunChild({ reviews: [markerReview({ id: 501 })] }) },
      ),
      /is for gate "draft_gate", not "review"/,
    );
  });
});

test("audit-review-marker-presence: latest (highest-round) marker on the head wins over an earlier round", async () => {
  const result = await auditReviewMarkerPresence(
    { repo: "owner/repo", pr: 17, headSha: HEAD_SHA, findingsLedger: null },
    {
      runChild: stubRunChild({
        reviews: [markerReview({ id: 1, round: 1 }), markerReview({ id: 2, round: 2 })],
      }),
    },
  );

  assert.equal(result.reviewId, 2);
  assert.equal(result.round, 2);
});

test("parseAuditReviewMarkerPresenceCliArgs: rejects malformed inputs (coverage regression)", () => {
  assert.throws(() => parseAuditReviewMarkerPresenceCliArgs(["--pr", "17"]), /repo/);
  assert.throws(() => parseAuditReviewMarkerPresenceCliArgs(["--repo", "owner/repo"]), /pr/);
  assert.throws(() => parseAuditReviewMarkerPresenceCliArgs(["--repo", "owner/repo", "--pr", "abc"]), /pr/);
  assert.throws(
    () => parseAuditReviewMarkerPresenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--head-sha", "zzz"]),
    /head-sha/,
  );
  assert.throws(
    () => parseAuditReviewMarkerPresenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--head-sha", "abc1234"]),
    /head-sha/,
  );
  const parsed = parseAuditReviewMarkerPresenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--head-sha", HEAD_SHA]);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.pr, 17);
  assert.equal(parsed.headSha, HEAD_SHA);
  assert.equal(parsed.findingsLedger, null);
});

// The CLI entrypoint is advisory-only: it must exit 0 even when it emits a
// WARNING (a missing marker), never surface a warning as a failing exit code.
// This is the "never blocks" pin from the AC.

test("audit-review-marker-presence spawned CLI: exits 0 even when the marker is missing (never blocks)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-review-marker-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([[RAW_GH_COMMENT_REVIEW]])}\n`,
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--head-sha", HEAD_SHA], { env: gh.env });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.markerFound, false);
    assert.equal(output.warnings.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("audit-review-marker-presence spawned CLI: --silent still exits 0 on a warning (advisory only, never a fail-closed predicate)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-review-marker-silent-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([[RAW_GH_COMMENT_REVIEW]])}\n`,
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--head-sha", HEAD_SHA, "--silent"], { env: gh.env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("audit-review-marker-presence spawned CLI: exits 0 for a contract-compliant round (no warnings)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-review-marker-clean-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([[markerReview({ id: 501 })]])}\n`,
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--head-sha", HEAD_SHA], { env: gh.env });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.markerFound, true);
    assert.deepEqual(output.warnings, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
