#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { normalizeCheckpointCycleIdentity } from "@dev-loops/core/loop/public-dev-loop-routing";
import { parseMainWorktreePath } from "@dev-loops/core/loop/worktree-guard";
import { parsePositiveInteger } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

export const CHECKPOINT_FILE = ".pi/dev-loop-retrospective-checkpoint.json";
const ALLOWED_STATES = new Set(["required", "complete", "skipped", "none", "missing"]);
const REPO_SHAPE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_MERGE_COMMIT_RE = /^[0-9a-f]{40}$/i;

const USAGE = `Usage: dev-loops checkpoint-contract --state <state> [--notes <text>] [--reason <text>]
       [--repo <owner/name> --pr <number> --merge-commit <full-40-hex-sha>]

Write .pi/dev-loop-retrospective-checkpoint.json using the retrospective contract format.

Required:
  --state <state>          Checkpoint state (required, complete, skipped, none, missing)

Optional:
  --notes <text>           Required when --state is complete (non-blank)
  --reason <text>          Required when --state is skipped (non-blank)
  --repo <owner/name>      Cycle identity. MUST be provided together (with
  --pr <number>            --pr and --merge-commit) when --state is complete
  --merge-commit <sha>     or skipped, so a later reader can tell WHICH cycle
                           it discharges — a complete/skipped record with no
                           identity can never be told apart from a stale one.
                           Optional for required/missing. Not accepted with
                           --state none. --repo must be owner/name shape;
                           --merge-commit must be the full 40-character commit
                           oid, never an abbreviated/short sha.

${JQ_OUTPUT_USAGE}`;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

/**
 * Resolve the checkpoint file's REPO ROOT — the main git checkout — from any
 * cwd inside the repo's worktree family (the main checkout, a dev-loop
 * worktree, or a subdirectory of either).
 *
 * `.pi/dev-loop-retrospective-checkpoint.json` is gitignored and lives ONCE
 * per repo, not once per worktree. Resolving it cwd-relative let a worktree's
 * write get silently discarded the moment the worktree is removed (e.g. the
 * post-merge cleanup step) and let the main checkout and a worktree of the
 * same repo disagree about the checkpoint state depending on which one last
 * wrote it. `resolve-dev-loop-startup.mjs`'s read path uses this exact same
 * helper so read and write always address one file.
 *
 * `git worktree list`'s first line is always the main worktree, regardless of
 * which worktree of the same repo `cwd` is inside — this reuses the existing
 * `parseMainWorktreePath` parser (also used by the worktree-isolation gate)
 * rather than new path logic. Falls back to `cwd` itself, never throwing,
 * when `git worktree list` cannot be resolved at all (cwd is not inside a git
 * repo) — the only case where a caller-supplied cwd is trusted as-is.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveCheckpointRepoRoot(cwd) {
  try {
    const output = execFileSync("git", ["worktree", "list"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const mainPath = parseMainWorktreePath(output);
    if (mainPath) return mainPath;
  } catch {
    // Not inside a git repo at all — fall through to cwd itself.
  }
  return cwd;
}

export function buildRetrospectiveCheckpointPayload({ state, notes = null, reason = null, identity = null }, now = new Date()) {
  const timestamp = now.toISOString();
  const normalizedIdentity = identity != null ? normalizeCheckpointCycleIdentity(identity) : null;
  const identityField = normalizedIdentity ? { identity: normalizedIdentity } : {};
  if (state === "complete") return { state, completedAt: timestamp, notes, ...identityField };
  if (state === "skipped") return { state, skippedAt: timestamp, reason, ...identityField };
  if (state === "required") return { state, triggeredAt: timestamp, ...identityField };
  if (state === "missing") return { state, triggeredAt: timestamp, ...identityField };
  if (state === "none") return { state };
  throw new Error(`Unsupported state: ${state}`);
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        state: { type: "string" },
        notes: { type: "string" },
        reason: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        "merge-commit": { type: "string" },
        help: { type: "boolean", short: "h" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    return { help: true };
  }

  if (!values.state) throw parseError("Missing required option: --state");
  const state = values.state;
  if (!ALLOWED_STATES.has(state)) {
    throw parseError(`--state must be one of: ${[...ALLOWED_STATES].join(", ")}`);
  }
  // Trimmed truthiness (not bare `!values.notes`) so a whitespace-only value
  // is rejected here rather than silently written as blank content — the
  // same standard the identity flags below already hold themselves to.
  if (state === "complete" && !values.notes?.trim()) {
    throw parseError('state "complete" requires --notes');
  }
  if (state === "skipped" && !values.reason?.trim()) {
    throw parseError('state "skipped" requires --reason');
  }

  const mergeCommit = values["merge-commit"];
  const hasIdentityFlag = values.repo !== undefined || values.pr !== undefined || mergeCommit !== undefined;
  if (hasIdentityFlag && state === "none") {
    throw parseError("--state none does not accept a cycle identity; --repo/--pr/--merge-commit only apply to required/complete/skipped/missing");
  }
  // `complete`/`skipped` MUST carry an identity: without one, a later reader
  // can never tell WHICH cycle the record discharges, so it would fail closed
  // forever (and re-running the identical command could never clear it,
  // since state stays unchanged run to run without an identity delta).
  if ((state === "complete" || state === "skipped") && !hasIdentityFlag) {
    throw parseError(`state "${state}" requires a cycle identity: --repo, --pr, and --merge-commit together`);
  }
  let identity = null;
  if (hasIdentityFlag) {
    // Trim before the truthiness check so a whitespace-only value (which is
    // truthy) is rejected here rather than silently normalizing away to an
    // invalid identity that gets dropped without a word.
    if (!values.repo?.trim() || values.pr === undefined || !mergeCommit?.trim()) {
      throw parseError("--repo, --pr, and --merge-commit must be provided together to record a cycle identity");
    }
    if (!REPO_SHAPE_RE.test(values.repo.trim())) {
      throw parseError("--repo must be in owner/name shape");
    }
    if (!FULL_MERGE_COMMIT_RE.test(mergeCommit.trim())) {
      throw parseError("--merge-commit must be the full 40-character commit oid, not an abbreviated/short sha — a short sha can never match on a later read and would leave the checkpoint permanently stale");
    }
    const prNumber = parsePositiveInteger(values.pr, "--pr", parseError);
    identity = { repo: values.repo, prNumber, mergeCommit };
    if (normalizeCheckpointCycleIdentity(identity) === null) {
      throw parseError("--repo, --pr, and --merge-commit must form a valid cycle identity");
    }
  }

  return {
    state,
    notes: values.notes ?? null,
    reason: values.reason ?? null,
    identity,
    jq: values.jq,
    silent: values.silent === true,
  };
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { state, notes, reason, identity } = parsed;
  const payload = buildRetrospectiveCheckpointPayload({ state, notes, reason, identity });
  const checkpointPath = path.join(resolveCheckpointRepoRoot(process.cwd()), CHECKPOINT_FILE);
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return emitResult({ ok: true, path: CHECKPOINT_FILE, checkpoint: payload }, { jq: parsed.jq, silent: parsed.silent });
}

if (isDirectCliRun(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
