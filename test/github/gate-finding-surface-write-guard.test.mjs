import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commentDeferredFindings } from "../../scripts/github/_gate-finding-surface.mjs";
import { writeGhStub } from "../_helpers.mjs";

// AC4 regression for issue #2216: the PR-2215 incident path let an unstubbed
// `bun run verify` reach a live GitHub write. The deferral path now writes
// exactly one thing, the batched deferral comment (core commentIssue), and never
// creates an issue. commentDeferredFindings is the exported surface judge-pass
// and close-gate-findings both call, so the path is modelled here.
//
// The reads (closing-reference lookup, the target's comment list) go to a fake
// `gh` binary on disk, so nothing touches the network. The write seam (`run`,
// `commentIssue`) stays at its live default. Without the stub attestation in
// the env, the guard must block the write; with it, the write reaches the fake.

const entries = [{ fingerprint: "1111111111111111", severity: "low", angle: "scope", summary: "deferred finding" }];

async function withFakeGh(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "deferral-write-guard-"));
  try {
    const { env, ghPath } = await writeGhStub(tmpDir, [
      { assertArgs: ["pr", "view"], stdout: `${JSON.stringify({ closingIssuesReferences: [{ number: 999, repository: { name: "repo", owner: { login: "owner" } } }] })}\n` },
      { assertArgs: ["api"], stdout: "[]\n" },
      { assertArgs: ["issue", "comment", "999"], stdout: "https://github.com/owner/repo/issues/999#issuecomment-1\n" },
    ]);
    return await fn({ env, ghPath });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("AC4 the deferral comment write fails closed when the write path is unstubbed", async () => {
  await withFakeGh(async ({ env, ghPath }) => {
    const { DEV_LOOPS_GH_STUB: _attestation, ...unattestedEnv } = env;
    await assert.rejects(
      () => commentDeferredFindings({ repo: "owner/repo", pr: 2215, entries }, { env: unattestedEnv, ghCommand: ghPath }),
      (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
    );
  });
});

test("AC2/AC4 a properly-stubbed deferral comment runs unaffected and creates no issue", async () => {
  await withFakeGh(async ({ env, ghPath }) => {
    const result = await commentDeferredFindings({ repo: "owner/repo", pr: 2215, entries }, { env, ghCommand: ghPath });
    assert.equal(result.issueNumber, 999);
    assert.deepEqual([...result.appendedFingerprints], ["1111111111111111"]);
  });
});
