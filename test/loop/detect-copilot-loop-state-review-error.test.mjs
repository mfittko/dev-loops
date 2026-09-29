// ADR 0114: a Copilot error review on the current head is no review, so the
// detector never reports the head as same-head clean converged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { runNode, writeAutoDetectGhStub } from "./detect-copilot-loop-state-test-helpers.mjs";

const ERROR_BODY = readFileSync(new URL("../../packages/core/test/fixtures/copilot-overview/review-error.md", import.meta.url), "utf8");

test("detect-copilot-loop-state: a current-head Copilot error review is not clean converged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-review-error-"));
  try {
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        headRefOid: "currentsha",
        reviews: [{
          id: "R_err",
          author: { login: "copilot-pull-request-reviewer[bot]" },
          state: "COMMENTED",
          body: ERROR_BODY,
          commit: { oid: "currentsha" },
          submittedAt: "2026-09-27T20:23:16Z",
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      },
    });
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.copilotReviewPresent, true);
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.equal(output.snapshot.copilotErrorReviewCountOnCurrentHead, 1);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.sameHeadCleanConverged, false);
    assert.notEqual(output.loopDisposition, "clean_converged");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
