// Regression: the writer's CLI entry with --provenance must not deadlock.
//
// Recording provenance makes the writer read this round's dispatch membership
// from the keyed gate-context artifact. That path builder lives in
// write-gate-context.mjs, which statically imported `buildLogPath` back out of
// the writer — so reaching it through `await import("./write-gate-context.mjs")`
// from inside the writer's own (still-pending) top-level `await main()` closed an
// ESM cycle that can never settle: the event loop drained with the promise
// unresolved and Node exited 13 ("Detected unsettled top-level await") without
// writing the ledger. No durable ledger means no draft_gate evidence at all.
//
// This MUST spawn the writer as a CLI child, and it must spawn it under NODE:
// the defect is Node's ESM evaluation-order behaviour, and Bun (the test
// runner's own `process.execPath`) resolves the same cycle without deadlocking.
// Importing the module cannot catch it either — an imported module is not a
// direct CLI run, so nothing is left pending and the cycle never manifests.
// Those two blind spots are why the rest of the suite stayed green.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { runNode as runNodeHelper } from "../_helpers.mjs";

const writeGateFindingsLogScript = path.resolve("scripts/github/write-gate-findings-log.mjs");
const HEAD_SHA = "a1".repeat(20);
const REPO = "owner/repo";

// Minimal, fully controlled angle contract. The shipped extension defaults are
// merged in by name, so their mandatory angles are disabled here to keep the
// fixture's pool exact.
const DEVLOOPS = [
  "version: 1",
  "gates:",
  "  draft:",
  "    angles:",
  "      - scope",
  "      - name: pr-description",
  "        enabled: false",
  "      - name: holistic",
  "        enabled: false",
  "",
].join("\n");

test("CLI entry with --provenance writes the ledger instead of deadlocking on an import cycle", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "gate-findings-cli-provenance-"));
  try {
    await writeFile(path.join(repoRoot, ".devloops"), DEVLOOPS, "utf8");
    const result = await runNodeHelper(writeGateFindingsLogScript, [
      "--repo", REPO,
      "--pr", "42",
      "--gate", "draft_gate",
      "--head-sha", HEAD_SHA,
      "--verdict", "clean",
      "--findings", JSON.stringify([{ severity: "low", angle: "scope", summary: "a low finding" }]),
      "--provenance", JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "scope", reviewer: "reviewer-1" }] }),
      "--tmp-root", repoRoot,
    ], { cwd: repoRoot, execPath: Bun.which("node") ?? "node" });

    assert.equal(result.code, 0, `a provenance write must exit 0, got ${result.code}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/, "the CLI entry must not leave a pending top-level await");

    const ledger = JSON.parse(await readFile(buildLogPath({ repo: REPO, pr: 42, gate: "draft_gate", headSha: HEAD_SHA, tmpRoot: repoRoot }), "utf8"));
    assert.equal(ledger.verdict, "clean");
    assert.deepEqual(ledger.provenance.perAngle, [{ angle: "scope", reviewer: "reviewer-1" }]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
