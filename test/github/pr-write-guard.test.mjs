import { test } from "bun:test";
import assert from "node:assert/strict";

import { mergePr } from "../../scripts/github/merge-pr.mjs";
import { editPr } from "../../scripts/github/edit-pr.mjs";
import { spawnCreatePr } from "../../scripts/github/create-pr.mjs";

// PR-side-helper fail-closed regression for issue 2216: the guard is wired
// into mergePr/editPr/spawnCreatePr, but nothing asserted they actually throw
// unstubbed — deleting the guard line would fail no test. These run under
// `bun test` (NODE_ENV=test) with the DEFAULT (live) seam and a fake repo
// slug, so a guard regression here would reach a live `gh` call rather than
// silently passing; no stub / DEV_LOOPS_GH_STUB is set on purpose.

test("mergePr fails closed when unstubbed in test mode", async () => {
  await assert.rejects(
    () => mergePr({ repo: "owner/repo", pr: 1, humanApprovedBy: "somelogin" }, {}),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("editPr fails closed when unstubbed in test mode", async () => {
  await assert.rejects(
    () => editPr({ repo: "owner/repo", pr: 1, title: "t" }, {}),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("spawnCreatePr fails closed when unstubbed in test mode", async () => {
  // spawnCreatePr throws the guard error synchronously (before constructing its
  // Promise), so the check must be wrapped in an async fn: assert.rejects only
  // catches an actual rejected promise, not a bare sync throw.
  await assert.rejects(
    async () => spawnCreatePr(["pr", "create", "--repo", "owner/repo"], { env: process.env }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});
