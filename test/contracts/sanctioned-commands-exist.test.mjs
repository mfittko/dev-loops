// Contract guard for issue #1081: the canonical sanctioned operation → wrapper
// command map (scripts/loop/sanctioned-commands.mjs) is the SINGLE SOURCE OF
// TRUTH carried into every handoff envelope. This test asserts every wrapper
// path named in the map actually exists on disk, so the map cannot silently
// drift when a wrapper is renamed or removed. It fails CLOSED: a missing
// wrapper (or an empty map) is a hard failure.

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import {
  SANCTIONED_COMMANDS,
  listSanctionedWrapperPaths,
} from "../../scripts/loop/sanctioned-commands.mjs";

const repoRootUrl = new URL("../../", import.meta.url);

test("sanctioned-commands: every mapped wrapper exists on disk (fails closed)", async () => {
  const paths = listSanctionedWrapperPaths();
  assert.ok(paths.length > 0, "map must name at least one wrapper path");

  for (const relPath of paths) {
    const fileUrl = new URL(relPath, repoRootUrl);
    await assert.doesNotReject(
      access(fileUrl),
      `mapped wrapper missing on disk: ${relPath} — update scripts/loop/sanctioned-commands.mjs or restore the wrapper`,
    );
  }
});

test("sanctioned-commands: forbidden + orchestrator-owned lists are non-empty", () => {
  assert.ok(SANCTIONED_COMMANDS.forbidden.length > 0, "forbidden list must not be empty");
  assert.ok(SANCTIONED_COMMANDS.orchestratorOwned.length > 0, "orchestrator-owned list must not be empty");
});

test("sanctioned-commands: the map is carried into the built handoff envelope", async () => {
  const { buildHandoffEnvelopeCli } = await import("../../scripts/loop/build-handoff-envelope.mjs");

  // Minimal in-memory resolver output + stub adapter — no git/network.
  const resolverOutput = {
    bundle: {
      selectedStrategy: "copilot_pr_followup",
      executionMode: "bounded_handoff",
      nextAction: "Draft PR implementation.",
      requiredReads: ["skills/docs/public-dev-loop-contract.md"],
      repoSlug: "owner/name",
      activeArtifact: { kind: "issue", issue: 1 },
    },
  };

  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "sanctioned-cmd-"));
  const inputPath = path.join(dir, "resolver.json");
  await writeFile(inputPath, JSON.stringify(resolverOutput), "utf8");

  const adapter = {
    getCwd: () => dir,
    getRepoRoot: () => dir,
  };

  const envelope = await buildHandoffEnvelopeCli({ inputPath }, { adapter });

  assert.ok(envelope.sanctionedCommands, "envelope must carry sanctionedCommands by default");
  assert.equal(
    envelope.sanctionedCommands.lifecycle["ready-for-review"],
    "scripts/github/ready-for-review.mjs",
    "envelope must carry the canonical map verbatim",
  );
});
