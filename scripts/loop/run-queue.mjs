#!/usr/bin/env node
/**
 * run-queue.mjs — Queue runner for dev-loop queue mode.
 *
 * Usage:
 *   dev-loops queue run --repo <owner/name> [--merge-authorized] [--parallel] [--redispatch-max-retries <n>]
 *
 * Reads queue state from .pi/dev-loop-queue.json and drives entries
 * through the sequential queue driver. Queue config (maxParallel etc.)
 * lives in .devloops at repo root.
 *
 * For parallel execution, use --parallel (file-overlap detection is
 * deferred to a future phase; currently falls back to sequential).
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runQueue, DEFAULT_QUEUE_DRIVER_OPTIONS } from "@dev-loops/core/loop/queue-driver";
import { computeParallelSchedule } from "@dev-loops/core/loop/queue-parallel";
import { readQueue } from "@dev-loops/core/loop/queue-state";
import { reconcileBoardMembership } from "@dev-loops/core/loop/queue-membership";
import { parsePositiveInteger } from "@dev-loops/core/cli/primitives";
import { loadDevLoopConfig, resolveEffectiveMergeAuthorizedFromLoad } from "@dev-loops/core/config";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const USAGE = `Usage:
  dev-loops queue run --repo <owner/name> [--merge-authorized] [--parallel] [--redispatch-max-retries <n>]

Run the dev-loop queue driver over entries in .pi/dev-loop-queue.json.
Exit codes: 0 success, 1 error`.trim();

function parseCliArgs(argv) {
  const args = {
    repo: null,
    mergeAuthorized: false,
    parallel: false,
    reDispatchMaxRetries: 1,
    maxParallel: 3,
    help: false,
  };

  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      "merge-authorized": { type: "boolean" },
      parallel: { type: "boolean" },
      "redispatch-max-retries": { type: "string" },
      "max-parallel": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new Error(`unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "repo":
        args.repo = token.value;
        break;
      case "merge-authorized":
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        args.mergeAuthorized = true;
        break;
      case "parallel":
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        args.parallel = true;
        break;
      case "redispatch-max-retries":
        args.reDispatchMaxRetries = parsePositiveInteger(token.value, "--redispatch-max-retries");
        break;
      case "max-parallel":
        args.maxParallel = parsePositiveInteger(token.value, "--max-parallel");
        break;
      case "help":
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${token.rawName}`);
    }
  }

  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!args.repo) {
    console.error("Error: --repo <owner/name> is required");
    process.exit(1);
  }

  const queue = await readQueue(REPO_ROOT);

  // A configured GitHub Projects board is the authoritative queue MEMBERSHIP
  // source (issue #864): fold its "Next Up" items into the queue before judging
  // emptiness so a populated board with an empty local queue is no longer a
  // silent no-op. Fail-open — a board hiccup falls back to the local queue.
  // reconcileBoardMembership already logs an "added N ... from board Next Up"
  // line to stderr (single source of truth); we deliberately do not duplicate
  // it here to avoid noise for JSON consumers of stdout.
  const membership = await reconcileBoardMembership(REPO_ROOT, args.repo, queue);

  if (membership.emptiness === "board_empty") {
    // Distinct from the legacy generic "Queue is empty": the board is the
    // membership source and it currently has nothing in Next Up. This branch is
    // only reached for a genuinely empty Next Up (reason == null), never for a
    // resolution failure (which falls through to the local queue below).
    console.log(JSON.stringify({
      ok: true,
      // Canonical empty-Next-Up outcome — matches queue-driver.mjs so operators
      // see one message regardless of which layer detects it.
      message: "queue empty — prioritize Backlog items into Next Up",
      boardConfigured: true,
      reason: "next-up-empty",
      results: [],
    }));
    return;
  }

  if (membership.emptiness === "board_unavailable") {
    // The board IS configured but Next Up resolution failed (fail-open) and the
    // local queue had nothing to fall back to. Do NOT claim "Next Up is empty";
    // surface the real reason so consumers can distinguish an outage from an
    // intentionally empty board.
    console.log(JSON.stringify({
      ok: true,
      message: `Board configured but unavailable (${membership.reason}); nothing to run`,
      boardConfigured: true,
      reason: membership.reason ?? null,
      results: [],
    }));
    return;
  }

  if (membership.emptiness === "queue_empty") {
    console.log(JSON.stringify({ ok: true, message: "Queue is empty", results: [] }));
    return;
  }

  const pending = queue.entries.filter((e) => e.status !== "done" && e.status !== "blocked");
  console.error(`Queue: ${queue.entries.length} entries, ${pending.length} pending`);

  if (args.parallel && pending.length > 1) {
    // Note: file lists are not resolved from issues yet; real overlap
    // detection requires fetching issue bodies via gh CLI. For now,
    // compute a schedule from entry metadata and fall back to sequential.
    const schedule = computeParallelSchedule(
      pending.map((e) => ({
        target: e.target,
        files: [],
        dependsOn: e.dependsOn || [],
      })),
      args.maxParallel
    );

    console.error(`Parallel schedule: ${schedule.waves.length} waves`);
    for (let wi = 0; wi < schedule.waves.length; wi++) {
      const wave = schedule.waves[wi];
      console.error(`  Wave ${wi + 1}: ${wave.map((g) => `[${g.join(", ")}]`).join("  ")}`);
    }

    console.error("Parallel dispatch via async subagents not yet wired; falling back to sequential.");
  }

  // Authoritative merge-authorization gate: when the repo enforces
  // humanMergeOnly, --merge-authorized is ignored (fails closed) so the queue
  // driver never auto-merges. `loadDevLoopConfig` never throws — it returns an
  // `errors` array — so a try/catch would not catch an unreadable/invalid
  // `.devloops` (which may be the very file declaring humanMergeOnly). FAIL
  // CLOSED on any config load/validation error: if the config cannot be
  // confirmed, do NOT grant merge authorization. A compliance invariant must
  // never be silently dropped because its config could not be read.
  let effectiveMergeAuthorized = args.mergeAuthorized;
  if (args.mergeAuthorized) {
    const load = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    effectiveMergeAuthorized = resolveEffectiveMergeAuthorizedFromLoad(args.mergeAuthorized, load);
    if ((load.errors?.length ?? 0) > 0) {
      console.error(
        JSON.stringify({
          ok: true,
          warning: "dev-loop config could not be loaded/validated; failing closed on merge authorization (not auto-merging).",
          errors: load.errors.map((e) => (e && e.message) || String(e)),
        }),
      );
    }
  }

  const result = await runQueue(REPO_ROOT, args.repo, {
    ...DEFAULT_QUEUE_DRIVER_OPTIONS,
    mergeAuthorized: effectiveMergeAuthorized,
    reDispatchMaxRetries: args.reDispatchMaxRetries,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
