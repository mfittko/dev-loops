#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParseError, formatCliError, parseJsonText } from "../_core-helpers.mjs";
import { requireOptionValue } from "../_cli-primitives.mjs";
import {
  interpretTrackerPrState,
  normalizeTrackerPrSnapshot,
} from "@dev-loops/core/loop/tracker-pr-state";
const USAGE = `Usage:
  detect-tracker-pr-state.mjs --input <path>
Interpret a pre-built tracker-PR snapshot JSON and emit the current lifecycle
state, allowed transitions, recommended next action, and canonical reverse-sync
action.
Required:
  --input <path>   Path to a JSON file containing the tracker-PR snapshot.
Snapshot schema (all fields optional; unknown fields are ignored):
  trackerItemExists  boolean     Whether a tracker work item was found
  trackerItemId      string|null Opaque tracker item ID (e.g. "PROJ-123") when present
  prExists           boolean     Whether a GitHub PR exists for this item
  prNumber           number|null PR number if known; prNumber with prExists=false is contradictory
  prDraft            boolean     Whether the PR is in draft state
  prMerged           boolean     Whether the PR has been merged
  prClosed           boolean     Whether the PR is closed on GitHub (merged PRs are also closed)
  prHeadSha          string|null Current PR head SHA
  draftGateCommentVisible boolean Whether the draft-gate comment is visible on the PR thread
  draftGateCommentHeadSha string|null Head SHA encoded in the draft-gate comment
  draftGateCommentVerdict string|null Draft-gate verdict: clean|findings_present|blocked
This snapshot intentionally excludes tracker-native workflow readiness/blocking
state. Callers must combine tracker-owned workflow state separately when
interpreting whether opening a PR is appropriate.
Unlike the Copilot/reviewer loop snapshots, this tracker contract uses prClosed
for the raw GitHub closed state. Merged PRs therefore set both prMerged=true
and prClosed=true, while pr_closed_unmerged is derived from
prClosed && !prMerged.
Output (stdout, JSON):
  {
    "ok": true,
    "snapshot": { ... },
    "state": "...",
    "allowedTransitions": [...],
    "nextAction": "...",
    "reverseSyncAction": "..."
  }
Error output (stderr, JSON):
  Argument/usage errors: { "ok": false, "error": "...", "usage": "..." }
  Runtime failures:      { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error or runtime failure`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectTrackerPrCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    inputPath: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--input") {
      options.inputPath = requireOptionValue(args, "--input", parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.inputPath === undefined) {
    throw parseError("--input <path> is required");
  }
  return options;
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
  } = {},
) {
  const options = parseDetectTrackerPrCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const text = await readFile(path.resolve(options.inputPath), "utf8");
  const raw = parseJsonText(text);
  const snapshot = normalizeTrackerPrSnapshot(raw);
  const { state, allowedTransitions, nextAction, reverseSyncAction } = interpretTrackerPrState(snapshot);
  stdout.write(
    `${JSON.stringify({ ok: true, snapshot, state, allowedTransitions, nextAction, reverseSyncAction })}\n`,
  );
}
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
