#!/usr/bin/env node
/**
 * resolve-angle-carry-forward.mjs — the gate carry-forward decision CLI.
 *
 * Given a PRIOR CLEAN gate findings-log (recorded at head A) and the delta A..B
 * (the changed files between that head and the current worktree HEAD), decide,
 * per angle, whether the clean verdict may be CARRIED FORWARD to head B or the
 * angle MUST re-run. The decision itself is the pure, fail-closed seam
 * `resolveCarryForwardAngles` from @dev-loops/core/loop/gate-carry-forward; this
 * CLI only supplies its inputs (prior log + delta) and shapes the output so the
 * fan-out orchestrator can (a) skip re-fanning carried angles and (b) write the
 * new head's findings-log recording each carried verdict with provenance pointing
 * at the PRIOR head's reviewer (write-gate-findings-log's `carriedFromHead`).
 *
 * FAIL-CLOSED: only a prior log whose overall verdict is `clean` can carry
 * forward anything; any uncertainty (non-clean prior log, empty/unclassifiable
 * delta, unmapped angle, always-run angle) resolves to must-re-run. See
 * skills/docs/gate-review-sub-loop-contract.md.
 *
 * Also emits a Copilot convergence-carry-forward decision (AC2): whether a
 * post-convergence head bump is a pure doc/prose bump and so need not force a
 * fresh blocking Copilot round.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfig, resolveGateAngleContract } from "@dev-loops/core/config";
import {
  RENAME_ONLY_ANGLES,
  resolveCarryForwardAngles,
  resolveConvergenceCarryForward,
} from "@dev-loops/core/loop/gate-carry-forward";

import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { assertWorktreeAtHead, hasRenameEntry, mapGateToConfigKey, parseChangedFiles } from "./write-gate-context.mjs";

const GATE_NAMES = new Set(["draft_gate", "pre_approval_gate"]);

const USAGE = `Usage: resolve-angle-carry-forward.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --prev-head <sha> --head-sha <sha> [--tmp-root <path>]
Decide, per angle, whether a prior CLEAN gate verdict (recorded at --prev-head) may
be carried forward to the current head, using the fail-closed delta<->review-surface rule.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --prev-head <sha>              Head SHA the prior CLEAN findings-log was recorded on (head A)
  --head-sha <sha>              Current head SHA (head B); must be the CWD worktree HEAD
Optional:
  --tmp-root <path>             Root tmp directory (default: tmp/)

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function normalizeGate(value) {
  const normalized = String(value).trim().toLowerCase();
  return GATE_NAMES.has(normalized) ? normalized : null;
}

function normalizeHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

export function parseResolveAngleCarryForwardCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "prev-head": { type: "string" },
      "head-sha": { type: "string" },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    prevHead: undefined,
    headSha: undefined,
    tmpRoot: "tmp",
  };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") return { help: true };
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (token.name === "gate") {
      const gate = normalizeGate(requireTokenValue(token, parseError));
      if (!gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
      options.gate = gate;
      continue;
    }
    if (token.name === "prev-head") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--prev-head must be a 7-64 character hex SHA");
      options.prevHead = sha;
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token.name === "tmp-root") { options.tmpRoot = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "prevHead", "headSha"].filter((k) => options[k] === undefined);
  if (missing.length > 0) throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  return options;
}

/**
 * Pure carry-forward plan from a prior gate findings-log + the delta A..B.
 * FAIL-CLOSED: throws when the prior log is missing or not a clean verdict —
 * carry-forward has no clean verdict to reuse. Carried angles are annotated with
 * the prior head's reviewer identity (every recorded reviewer/dispatchId/model
 * field from the log's provenance) and `carriedFromHead` so the caller can write
 * honest, non-fabricated carried provenance.
 *
 * @param {object} input
 * @param {object|null} input.log — the prior findings-log JSON (verdict must be "clean")
 * @param {string[]} input.changedFiles — delta A..B changed files
 * @param {Iterable<string>} [input.alwaysRerun] — angles that must NEVER carry
 *   forward regardless of the delta (the gate's configured mandatory angles, plus
 *   the RENAME_ONLY-mapped angles when the delta contains any rename). Each
 *   resolves to an always-rerun surface so it lands in `mustRerun`, not `carried`.
 * @returns {{ prevHead: string, carried: Array<{angle: string, carriedFromHead: string, reviewer?: string, dispatchId?: string, model?: string, reason: string}>, mustRerun: Array<{angle: string, reason: string}> }}
 */
export function buildCarryForwardPlan({ log, changedFiles, alwaysRerun = [] }) {
  if (!log || typeof log !== "object") {
    throw new Error("prior gate findings-log not found or unreadable — cannot carry forward (fail-closed)");
  }
  if (log.verdict !== "clean") {
    throw new Error(`prior gate findings-log verdict is ${JSON.stringify(log.verdict ?? null)}, not "clean" — nothing to carry forward (fail-closed)`);
  }
  // FAIL-CLOSED: a carried entry stamps `carriedFromHead`/`prevHead` with the prior
  // log's headSha; downstream write-gate-findings-log requires a 7-64 hex SHA there.
  // A malformed prior log (missing/non-string/non-hex headSha) must NOT yield a plan
  // with a bad provenance stamp — reject it here so every angle re-runs from scratch.
  const headSha = typeof log.headSha === "string" ? normalizeHeadSha(log.headSha) : null;
  if (!headSha) {
    throw new Error(`prior gate findings-log headSha is ${JSON.stringify(log.headSha ?? null)}, not a 7-64 char hex SHA — cannot carry forward (fail-closed)`);
  }
  const perAngle = Array.isArray(log.provenance?.perAngle) ? log.provenance.perAngle : [];
  if (perAngle.length === 0) {
    throw new Error("prior gate findings-log has no provenance.perAngle reviewers to carry forward (fail-closed)");
  }
  // Preserve the FULL reviewer identity per angle. The provenance contract
  // (write-gate-findings-log / gate-fanin.countDistinctReviewers) counts an angle's
  // identity via `reviewer` OR `dispatchId`; carrying only `reviewer` would DROP the
  // identity of a prior entry recorded under `dispatchId`, breaking distinctReviewers
  // or the provenance-consistency check at the new head. Carry every recorded
  // identity field (reviewer/dispatchId/model) so a carried entry stays attributable.
  const identityByAngle = new Map();
  for (const entry of perAngle) {
    if (!entry || typeof entry.angle !== "string") continue;
    const identity = {};
    for (const key of ["reviewer", "dispatchId", "model"]) {
      if (typeof entry[key] === "string" && entry[key].length > 0) identity[key] = entry[key];
    }
    identityByAngle.set(entry.angle, identity);
  }
  const prevAngles = perAngle.map((a) => a.angle).filter((a) => typeof a === "string" && a.length > 0);
  const { carried, mustRerun } = resolveCarryForwardAngles({
    prevAngles,
    changedFiles,
    options: { alwaysRerun: [...alwaysRerun] },
  });
  const carriedProvenance = carried.map(({ angle, reason }) => ({
    angle,
    carriedFromHead: headSha,
    ...(identityByAngle.get(angle) ?? {}),
    reason,
  }));
  return { prevHead: headSha, carried: carriedProvenance, mustRerun };
}

// git-diff isolation flags (subset of write-gate-context's captureDiffFromBase):
// pin the name-status output bytes/rename detection so the changed-file SET is
// reproducible regardless of ambient gitconfig.
const GIT_ISOLATION = [
  "-c", "color.ui=false",
  "-c", "core.pager=cat",
  "-c", "diff.renames=true",
  "-c", "core.autocrlf=false",
];

function captureDeltaChangedFiles({ base, repoRoot }) {
  // TWO-dot: the direct tree diff between the reviewed head A (base) and HEAD (B).
  // NOT three-dot (`base...HEAD`), which diffs merge-base(A,B)..B and would OMIT a
  // file that differs between A and B but happens to equal their merge-base — under
  // a non-fast-forward advance (rebase/amend/revert) that would carry an angle whose
  // review surface actually changed since A. Two-dot never omits such a file.
  const range = `${base}..HEAD`;
  const out = execFileSync("git", [...GIT_ISOLATION, "diff", "--no-ext-diff", "--name-status", range], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { changedFiles: parseChangedFiles(out), hasRename: hasRenameEntry(out) };
}

export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
  let options;
  try {
    options = parseResolveAngleCarryForwardCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const logPath = buildLogPath({
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.prevHead,
      tmpRoot: options.tmpRoot || "tmp",
    });
    let log = null;
    try {
      log = JSON.parse(await readFile(path.resolve(repoRoot, logPath), "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error(`prior gate findings-log not found at ${logPath} — cannot carry forward (fail-closed)`);
      }
      throw err;
    }
    // Load the gate's CONFIGURED mandatory angles so any repo-configured
    // mandatory angle (even a CATEGORY_ANGLE_MAP-mapped one like `docs` or
    // `correctness`) is NEVER carried forward — it must be freshly re-reviewed at
    // head B. Without this the fail-closed "mandatory always re-runs" promise
    // would only cover the hardcoded ALWAYS_INCLUDE set. loadDevLoopConfig never
    // throws; it returns { config, ... }.
    const { config } = await loadDevLoopConfig({ repoRoot });
    const { mandatoryAngles } = resolveGateAngleContract(config, mapGateToConfigKey(options.gate));
    // FAIL-CLOSED: the delta is computed against the CWD worktree HEAD (base..HEAD),
    // but the plan is LABELED with --head-sha. If the worktree is checked out at a
    // different head than --head-sha, every carry-forward decision would be computed
    // against the WRONG head while claiming to be for --head-sha. Abort before
    // capturing the delta so no mislabeled plan is ever emitted.
    assertWorktreeAtHead(options.headSha, { repoRoot });
    const { changedFiles, hasRename } = captureDeltaChangedFiles({ base: options.prevHead, repoRoot });
    // A rename anywhere in the delta forces the RENAME_ONLY-mapped angles to
    // re-run: parseChangedFiles keeps only a rename's destination path, so
    // classifying that path alone misses what the rename itself implicates.
    const alwaysRerun = [...mandatoryAngles, ...(hasRename ? RENAME_ONLY_ANGLES : [])];
    const plan = buildCarryForwardPlan({ log, changedFiles, alwaysRerun });
    const copilotConvergence = resolveConvergenceCarryForward({ changedFiles });
    const result = {
      ok: true,
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      prevHead: options.prevHead,
      headSha: options.headSha,
      deltaChangedFiles: changedFiles,
      carried: plan.carried,
      mustRerun: plan.mustRerun,
      copilotConvergence,
    };
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
