// Enforcement guard for issue #1541 (gate-context doc surfaces contradict the
// shipped resolution behavior). Three documentation surfaces in
// scripts/github/write-gate-context.mjs must stay aligned with the shipped
// behavior so a future behavior change fails these pins rather than silently
// re-diverging:
//
//   1. --help for --acceptance-criteria / --issue-body must describe multi-issue
//      resolution (every closing reference, comma-joined, cross-repo-qualified)
//      and the unreadable-linked-issue fail-closed, matching the contract doc.
//   2. renderBriefingPrefix's JSDoc must NOT claim same-head byte-identical
//      output; it states what the CLI path actually guarantees (a same-head
//      rebuild after a live description edit yields different prefix bytes).
//   3. PR_BODY_ABSENT_SENTINEL must be source-neutral (no GitHub-specific fact),
//      because it is also rendered by the programmatic renderBriefingPrefix /
//      writeGateContext path that never contacts GitHub.
//   4. ISSUE_BODY_ABSENT_SENTINEL must be source-neutral for the same reason (it
//      is also rendered by the programmatic path).
//
// These are doc/comment claims, so the pins are source reads of the module
// (plus the exported sentinel value) rather than behavioral assertions.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ISSUE_BODY_ABSENT_SENTINEL,
  PR_BODY_ABSENT_SENTINEL,
} from "../../scripts/github/write-gate-context.mjs";

const srcUrl = new URL("../../scripts/github/write-gate-context.mjs", import.meta.url);

test("write-gate-context --help: --acceptance-criteria and --issue-body describe multi-issue resolution and fail-closed (#1541)", async () => {
  const src = await readFile(srcUrl, "utf8");
  const acLine = src.split("\n").find((l) => l.startsWith("  --acceptance-criteria <ptr>"));
  const ibLine = src.split("\n").find((l) => l.startsWith("  --issue-body <text>"));
  assert.ok(acLine, "the --acceptance-criteria help line exists");
  assert.ok(ibLine, "the --issue-body help line exists");

  // Multi-issue: every closing reference is resolved (plural), umbrella PRs
  // resolve all of them, cross-repo-qualified references resolve in their own repo.
  assert.match(acLine, /closing issue references/i, "acceptance-criteria help describes resolving EVERY closing reference (multi-issue)");
  assert.match(acLine, /cross-repo|umbrella/i, "acceptance-criteria help names the multi-issue/cross-repo shape");
  assert.match(ibLine, /closing issue references/i, "issue-body help describes fetching from EVERY closing reference (multi-issue)");

  // Fail-closed on an unreadable linked issue, matching the contract doc.
  assert.match(acLine, /FAILS CLOSED|fail closed/i, "acceptance-criteria help names the unreadable-linked-issue fail-closed");
  assert.match(acLine, /no artifact written/i, "acceptance-criteria help names the no-artifact-written failure mode");
  assert.ok(ibLine.includes("FAILS CLOSED"), "issue-body help names the unreadable-linked-issue fail-closed");

  // The OLD single-issue phrasing must be gone (the divergence the issue filed).
  assert.ok(!acLine.includes("resolves to the PR's closing issue reference"), "old single-issue acceptance-criteria phrasing is gone");
  assert.ok(!ibLine.includes("fetched from the PR's closing issue reference"), "old single-issue issue-body phrasing is gone");
});

test("write-gate-context: renderBriefingPrefix JSDoc no longer claims same-head byte-identical output and states the CLI guarantee (#1541)", async () => {
  const src = await readFile(srcUrl, "utf8");
  // The disqualifying shared-prefix claim must be gone.
  assert.ok(
    !/two builds\s*\n?\s*at the same head produce a byte-identical prefix/.test(src),
    "renderBriefingPrefix JSDoc must not claim same-head byte-identical output",
  );
  // It states the CLI path's actual guarantee: a same-head rebuild after a live
  // description edit yields different prefix bytes.
  assert.match(src, /live description edit/i, "JSDoc states the same-head rebuild-after-edit scenario");
  assert.match(src, /DIFFERENT prefix bytes/i, "JSDoc states the rebuild-differs consequence");
});

test("write-gate-context: PR_BODY_ABSENT_SENTINEL is source-neutral (no GitHub-specific fact) (#1541)", () => {
  // The sentinel is also rendered by the exported renderBriefingPrefix /
  // writeGateContext programmatic path, which never contacts GitHub — so it
  // must not assert a fact only a GitHub reader could know.
  assert.ok(!/GitHub/i.test(PR_BODY_ABSENT_SENTINEL), "sentinel must not assert a GitHub-specific fact");
  assert.match(PR_BODY_ABSENT_SENTINEL, /no PR description/i, "sentinel reads as a source-neutral absence statement");
});

test("write-gate-context: ISSUE_BODY_ABSENT_SENTINEL is source-neutral (no GitHub-specific fact) (#1541)", () => {
  // ISSUE_BODY is rendered by the same exported programmatic path (lines 1279,
  // 1434) whenever an issue-section body is absent, so it must not assert a
  // fact only a GitHub reader could know — mirroring PR_BODY_ABSENT_SENTINEL.
  assert.ok(!/GitHub/i.test(ISSUE_BODY_ABSENT_SENTINEL), "issue sentinel must not assert a GitHub-specific fact");
  assert.match(ISSUE_BODY_ABSENT_SENTINEL, /no issue body/i, "issue sentinel reads as a source-neutral absence statement");
});
