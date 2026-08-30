#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { normalizeCheckpointCycleIdentity, normalizeRetroProvenance, RETROSPECTIVE_PROVENANCE } from "@dev-loops/core/loop/public-dev-loop-routing";
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
  --retro-context <c>      Required when --state is complete: MUST be "fresh".
                           Pins that the retrospective was produced by a
                           fresh-context, independent dispatch (issue #1870).
                           "inline" (self-authored by the working context) is
                           rejected — an inline retro fails the checkpoint.
  --record-source <path>   Required when --state is complete (non-blank): path
                           of the agent/subagent tool-call record (transcript
                           or journal artifact) the fresh-context retro was
                           seeded with.
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

export function buildRetrospectiveCheckpointPayload({ state, notes = null, reason = null, identity = null, provenance = null }, now = new Date()) {
  const timestamp = now.toISOString();
  const normalizedIdentity = identity != null ? normalizeCheckpointCycleIdentity(identity) : null;
  const identityField = normalizedIdentity ? { identity: normalizedIdentity } : {};
  const normalizedProvenance = provenance != null ? normalizeRetroProvenance(provenance) : null;
  // Fail closed at WRITE time too: silently dropping an invalid provenance
  // would let a programmatic caller write a `complete` record that only fails
  // closed at read time, with no signal at the write. A null provenance
  // (absent) stays the CLI's legitimate "not provided" shape — the CLI itself
  // rejects `complete` without provenance, but the payload builder stays
  // permissive about absence for direct callers, mirroring identity handling.
  if (provenance != null && normalizedProvenance === null) {
    throw new Error(`Invalid retrospective provenance for state "complete": must pin a fresh-context pass over the agent/subagent tool-call record (RETRO-FRESH-CONTEXT-MANDATORY)`);
  }
  const provenanceField = normalizedProvenance ? { provenance: normalizedProvenance } : {};
  if (state === "complete") return { state, completedAt: timestamp, notes, ...identityField, ...provenanceField };
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
        "retro-context": { type: "string" },
        "record-source": { type: "string" },
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

  // Fresh-context provenance validation for `complete` — runs after the
  // identity block above so identity errors take precedence (issue #1870,
  // RETRO-FRESH-CONTEXT-MANDATORY: an inline self-authored retro is rejected
  // outright, and so is a complete record with no provenance at all — the
  // reader fails closed on both).
  let provenance = null;
  if (state === "complete") {
    const retroContext = values["retro-context"]?.trim().toLowerCase();
    if (!retroContext) {
      throw parseError('state "complete" requires --retro-context fresh (RETRO-FRESH-CONTEXT-MANDATORY: the retrospective must be a fresh-context, independent pass over the tool-call record — an inline self-authored retro fails the checkpoint)');
    }
    if (retroContext === RETROSPECTIVE_PROVENANCE.CONTEXT_INLINE) {
      throw parseError('retro-context "inline" is rejected (RETRO-FRESH-CONTEXT-MANDATORY): an inline, self-authored retrospective fails the checkpoint. Dispatch a fresh-context pass seeded with the full tool-call record, then record with --retro-context fresh');
    }
    if (retroContext !== RETROSPECTIVE_PROVENANCE.CONTEXT_FRESH) {
      throw parseError(`--retro-context must be "${RETROSPECTIVE_PROVENANCE.CONTEXT_FRESH}" (got "${retroContext}")`);
    }
    if (!values["record-source"]?.trim()) {
      throw parseError('state "complete" requires --record-source (RETRO-FRESH-CONTEXT-MANDATORY: the path of the agent/subagent tool-call record the fresh-context retro was seeded with)');
    }
    // The record must actually exist and carry content: a retro attested
    // against a record that does not exist is rejected at write time rather
    // than shipping an unverifiable provenance pointer.
    const recordSource = values["record-source"].trim();
    const recordPath = path.isAbsolute(recordSource) ? recordSource : path.resolve(process.cwd(), recordSource);
    let recordStat = null;
    try {
      recordStat = statSync(recordPath);
    } catch {
      recordStat = null;
    }
    if (!recordStat?.isFile() || recordStat.size === 0) {
      throw parseError(`--record-source must resolve to an existing, non-empty file (the agent/subagent tool-call record the fresh-context retro was seeded with): ${recordSource}`);
    }
    // Delegate shape ownership to the core normalizer — the CLI validates the
    // two flag values above, but never hand-builds the canonical provenance
    // object. Values are pre-validated, so a null result here is unreachable.
    provenance = normalizeRetroProvenance({
      context: retroContext,
      seededFrom: RETROSPECTIVE_PROVENANCE.SEEDED_FROM_RECORD,
      recordSource,
    });
    if (provenance === null) {
      throw parseError("internal error: validated provenance failed normalization");
    }
  } else if (values["retro-context"] !== undefined || values["record-source"] !== undefined) {
    throw parseError("--retro-context/--record-source only apply to --state complete");
  }

  return {
    state,
    notes: values.notes ?? null,
    reason: values.reason ?? null,
    identity,
    provenance,
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

  const { state, notes, reason, identity, provenance } = parsed;
  const payload = buildRetrospectiveCheckpointPayload({ state, notes, reason, identity, provenance });
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
