#!/usr/bin/env node
/**
 * resolve-angle-carry-forward.mjs — the gate carry-forward decision CLI.
 *
 * Given a PRIOR gate findings-log (recorded at head A, verdict `clean` OR
 * `findings_present`) and the delta A..B (the changed files between that head
 * and the current worktree HEAD), decide, per angle, whether its prior verdict
 * may be CARRIED FORWARD to head B or the angle MUST re-run. For a
 * `findings_present` angle whose surface the delta provably did not touch
 * (issue #2017), the carried verdict is accompanied by that angle's PRIOR OPEN
 * FINDINGS, unchanged — carry-forward never converts an open finding into an
 * approval, it only ever skips re-running a reviewer whose surface the delta
 * provably did not touch. The decision itself is the pure, fail-closed seam
 * `resolveAngleCarryForward`/`angleReviewSurface` from
 * @dev-loops/core/loop/gate-carry-forward; this CLI only supplies its inputs
 * (prior log + delta) and shapes the output so the fan-out orchestrator can
 * (a) skip re-fanning carried angles and (b) write the new head's
 * findings-log recording each carried verdict with provenance pointing at the
 * PRIOR head's reviewer (write-gate-findings-log's `carriedFromHead`).
 *
 * FAIL-CLOSED: only a prior log whose overall verdict is `clean` or
 * `findings_present` can carry forward anything; any uncertainty (any other
 * prior verdict, empty/unclassifiable delta, unmapped angle, always-run
 * angle, or a finding whose angle attribution is AMBIGUOUS — matches more than
 * one provenance.perAngle row, e.g. a base angle plus its `-delta-at-...`
 * re-review sibling or a case-drifted duplicate) resolves to must-re-run. See
 * skills/docs/gate-review-sub-loop-contract.md.
 *
 * Also emits a Copilot convergence-carry-forward decision (AC2): whether a
 * post-convergence head bump is a pure doc/prose bump and so need not force a
 * fresh blocking Copilot round.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfig, resolveGateAngleContract } from "@dev-loops/core/config";
import {
  angleReviewSurface,
  RENAME_ONLY_ANGLES,
  resolveAngleCarryForward,
  resolveConvergenceCarryForward,
} from "@dev-loops/core/loop/gate-carry-forward";
import { baseAngleName } from "@dev-loops/core/loop/gate-fanin";

import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { captureChangedFilesBetween, runGitCommand } from "../lib/git-delta.mjs";
export { runGitCommand } from "../lib/git-delta.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { readSpecAuthorityIdentity, stampOptionalSpecAuthority } from "../lib/spec-authority-stamp.mjs";
import { normalizeGate as normalizeGateShared, normalizeHeadSha as normalizeHeadShaShared } from "./_gate-names.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import {
  mapGateToConfigKey,
} from "./write-gate-context.mjs";

const USAGE = `Usage: resolve-angle-carry-forward.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --prev-head <sha> --head-sha <sha> [--tmp-root <path>]
Decide, per angle, whether a prior gate verdict (clean OR findings_present, recorded
at --prev-head) may be carried forward to the current head, using the fail-closed
delta<->review-surface rule. A carried findings_present angle also carries its prior
open findings, unchanged (issue #2017) — the gate still blocks on them.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --prev-head <sha>              FULL head SHA the prior findings-log (clean or findings_present) was
                                 recorded on (head A); the log path is keyed by the full SHA, so a
                                 prefix refuses "not found"
  --head-sha <sha>              Current head SHA (head B); must be the CWD worktree HEAD
Optional:
  --tmp-root <path>             Root tmp directory (default: tmp/)
  --spec-authority <path>       JSON { specDigest, headSha, contentDigest, checkedCriteria }
                                 (issue 2008 / ADR 0061 AC1). When supplied, stamps the plan's
                                 durable record with the pinned revision identity via the ONE
                                 shared stamp helper. Pure no-op (byte-identical output) when absent.

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

const normalizeGate = normalizeGateShared;
const normalizeHeadSha = normalizeHeadShaShared;

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
      "spec-authority": { type: "string" },
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
    specAuthority: undefined,
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
      // FULL SHA only: buildLogPath keys the prior findings-log's path on --prev-head
      // verbatim, and every log the sanctioned writer produces is keyed by the FULL
      // SHA (write-gate-findings-log's normalizeFullHeadSha). An abbreviated value
      // would resolve a path that can never exist and refuse with a misleading
      // "log not found" — reading as "no prior round" and silently disabling
      // carry-forward forever instead of surfacing the real mistake.
      const sha = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!sha) {
        throw parseError(
          "--prev-head must be the FULL head commit SHA (40 or 64 hex chars), not a short prefix — " +
          "the prior findings-log path is keyed by the full SHA, so a prefix resolves a path that can " +
          "never exist and refuses with a misleading \"log not found\", silently disabling carry-forward",
        );
      }
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
    if (token.name === "spec-authority") { options.specAuthority = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "prevHead", "headSha"].filter((k) => options[k] === undefined);
  if (missing.length > 0) throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  // FAIL-CLOSED: a same-head "carry" is not a carry at all — it would re-seed the
  // CURRENT round from its own (possibly retired) verdict, the exact channel
  // round retirement (GATE-EXEC-ROUND-RETIREMENT) discards. A fresh fan-out at
  // the same head must re-review every angle.
  // startsWith, not ===: --prev-head is full-SHA-validated but --head-sha
  // accepts 7-64 hex, so an abbreviated spelling of the same commit must not
  // slip past the guard.
  if (options.prevHead.startsWith(options.headSha)) {
    throw parseError("--prev-head equals --head-sha — a same-head carry-forward would re-seed the round from its own prior verdict (retired rounds included); re-review the angles instead");
  }
  return options;
}

/**
 * Pure carry-forward plan from a prior gate findings-log + the delta A..B.
 * FAIL-CLOSED: throws when the prior log is missing or its verdict is not
 * carry-forward-eligible (clean or findings_present) — carry-forward has no
 * prior verdict to reuse. Carried angles are annotated with the prior head's
 * reviewer identity (every recorded reviewer/dispatchId/model field from the
 * log's provenance) and `carriedFromHead` so the caller can write honest,
 * non-fabricated carried provenance. A carried angle whose prior verdict was
 * findings_present ALSO carries `prevVerdict: "findings_present"` and its
 * prior open `findings` (issue #2017) — the caller must write these findings
 * through unchanged, never dropped and never converted into a pass, so the
 * gate still blocks on them exactly as if freshly reviewed. A carried clean
 * angle carries `prevVerdict: "clean"` and an empty `findings` array.
 *
 * @param {object} input
 * @param {object|null} input.log — the prior findings-log JSON (verdict must be
 *   "clean" or "findings_present")
 * @param {string[]} input.changedFiles — delta A..B changed files
 * @param {Iterable<string>} [input.alwaysRerun] — angles that must NEVER carry
 *   forward regardless of the delta (the gate's configured mandatory angles, plus
 *   the RENAME_ONLY-mapped angles when the delta contains any rename). Each
 *   resolves to an always-rerun surface so it lands in `mustRerun`, not `carried`.
 * @returns {{ prevHead: string, carried: Array<{angle: string, carriedFromHead: string, reviewer?: string, dispatchId?: string, model?: string, prevVerdict: "clean"|"findings_present", findings: Array<object>, reason: string}>, mustRerun: Array<{angle: string, reason: string}> }}
 */
export function buildCarryForwardPlan({ log, changedFiles, alwaysRerun = [] }) {
  if (!log || typeof log !== "object") {
    throw new Error("prior gate findings-log not found or unreadable — cannot carry forward (fail-closed)");
  }
  if (log.verdict !== "clean" && log.verdict !== "findings_present") {
    throw new Error(`prior gate findings-log verdict is ${JSON.stringify(log.verdict ?? null)}, not carry-forward-eligible (clean or findings_present) — nothing to carry forward (fail-closed)`);
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
  // FAIL-CLOSED: a duplicate angle row makes reviewer attribution ambiguous.
  // identityByAngle below keeps only the LAST row for an angle, while prevAngles
  // keeps both — so both carried entries would be stamped with one reviewer and
  // the other reviewer's identity would vanish. Reject the log rather than
  // silently misattribute a carried verdict.
  const duplicateAngle = perAngle
    .map((entry) => (entry && typeof entry.angle === "string" ? entry.angle : null))
    .find((angle, index, all) => angle !== null && all.indexOf(angle) !== index);
  if (duplicateAngle !== undefined) {
    throw new Error(`prior gate findings-log records angle ${JSON.stringify(duplicateAngle)} more than once — reviewer attribution is ambiguous (fail-closed)`);
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
  // FAIL-CLOSED, per-angle: an angle's PRIOR verdict is derived from the
  // findings themselves, never from the log's overall verdict — a clean OR
  // findings_present overall log can still have a per-angle non-blocking
  // finding (a "low"/"nit" against an otherwise-clean round). ANY recorded
  // finding against an angle — regardless of severity — makes that angle
  // "findings_present" for carry-forward purposes: it reported a problem, and
  // that problem must never silently vanish because a later delta happened to
  // leave its surface untouched. Carrying it forward is exactly how it stays
  // visible (see the per-angle loop below), never how it gets dropped.
  //
  // FAIL-CLOSED attribution: `log.findings` must be an array (a malformed/
  // truncated log cannot prove no angle has an open finding), and every finding
  // must be attributable to a KNOWN prevAngles entry — matched by
  // {@link baseAngleName} (a `<angle>-delta-at-...` re-review entry still counts
  // toward its base angle, exactly as gate-fanin's own coverage check does) and
  // case-insensitively (the finding's angle and provenance.perAngle's angle are
  // independently authored). A finding this cannot attribute to any known angle
  // means no angle is provably clean, so it refuses the whole plan rather than
  // silently forcing nothing.
  if (log.findings !== undefined && !Array.isArray(log.findings)) {
    throw new Error("prior gate findings-log's findings field is not an array — cannot verify which angles are clean (fail-closed)");
  }
  // MANY-TO-ONE, not last-wins: a base+lowercase key can legitimately collect
  // MORE THAN ONE prevAngles entry — a base angle and its `-delta-at-...`
  // re-review sibling are both legal, independently-carry-forward-eligible rows
  // (the contract doc and gate-fanin's own coverage check both treat a
  // delta-suffixed row as counting toward its base angle), and the exact-string
  // duplicate guard above does not catch a base/case collision either. A Map
  // keyed 1:1 to the LAST matching row would silently drop every other row
  // sharing that key from attribution — exactly the fail-open this guard exists
  // to close — so bucket every match instead.
  const prevAnglesByLowerBase = new Map();
  for (const angle of prevAngles) {
    const key = baseAngleName(angle).toLowerCase();
    const bucket = prevAnglesByLowerBase.get(key);
    if (bucket) bucket.push(angle);
    else prevAnglesByLowerBase.set(key, [angle]);
  }
  // A finding's angle attribution is UNAMBIGUOUS only when it matches EXACTLY
  // ONE provenance.perAngle row. When it matches more than one (a base angle
  // plus its `-delta-at-...` re-review sibling, or a case-drifted duplicate —
  // see the bucket comment above), it is impossible to say WHICH of those rows
  // actually owns the finding's content, so — issue #2017 — carrying that
  // finding forward onto only one of them risks either dropping it off the
  // other or double-counting it onto both. FAIL-CLOSED: every row in an
  // ambiguous bucket keeps today's behavior (always re-run), exactly as before
  // this issue; only an unambiguous single-row match is eligible for the new
  // carry-with-findings path below.
  const ambiguousAngles = new Set();
  const priorFindingsByAngle = new Map();
  for (const finding of Array.isArray(log.findings) ? log.findings : []) {
    const rawAngle = finding && typeof finding.angle === "string" ? finding.angle.trim() : "";
    if (rawAngle.length === 0) {
      throw new Error("prior gate findings-log has a finding with no angle — cannot attribute it to a carried angle (fail-closed)");
    }
    const matches = prevAnglesByLowerBase.get(baseAngleName(rawAngle).toLowerCase());
    if (!matches || matches.length === 0) {
      throw new Error(`prior gate findings-log has a finding for angle ${JSON.stringify(rawAngle)}, which matches no provenance.perAngle entry — cannot prove that angle is clean (fail-closed)`);
    }
    if (matches.length > 1) {
      for (const angle of matches) ambiguousAngles.add(angle);
      continue;
    }
    const [angle] = matches;
    if (!priorFindingsByAngle.has(angle)) priorFindingsByAngle.set(angle, []);
    priorFindingsByAngle.get(angle).push(finding);
  }

  const carried = [];
  const mustRerun = [];
  const AMBIGUOUS_FINDING_REASON = "angle returned a finding at the prior head that matches more than one provenance.perAngle entry — attribution is ambiguous, so it never carries forward regardless of the delta (fail-closed)";
  for (const angle of prevAngles) {
    if (ambiguousAngles.has(angle)) {
      mustRerun.push({ angle, reason: AMBIGUOUS_FINDING_REASON });
      continue;
    }
    const priorFindings = priorFindingsByAngle.get(angle);
    const prevVerdict = priorFindings ? "findings_present" : "clean";
    const angleSurface = angleReviewSurface(angle, { alwaysRerun });
    const decision = resolveAngleCarryForward({ angle, angleSurface, changedFiles, prevVerdict });
    if (decision.carryForward) {
      carried.push({
        angle,
        carriedFromHead: headSha,
        ...(identityByAngle.get(angle) ?? {}),
        prevVerdict,
        findings: priorFindings ?? [],
        reason: decision.reason,
      });
    } else {
      mustRerun.push({ angle, reason: decision.reason });
    }
  }
  return { prevHead: headSha, carried, mustRerun };
}

async function assertWorktreeAtHeadAsync(headSha, { repoRoot, runGit = runGitCommand }) {
  const declared = String(headSha).trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(declared)) {
    throw new Error(`assertWorktreeAtHead: headSha ${JSON.stringify(headSha)} is not a 7-64 character hex SHA — refusing to prefix-match against the worktree HEAD (an empty/short value would false-accept).`);
  }
  let result;
  try {
    result = await runGit(["rev-parse", "HEAD"], { repoRoot });
  } catch (error) {
    throw new Error(`--base was given but the current working directory (${repoRoot}) is not inside a git worktree (git rev-parse HEAD failed: ${error?.message ?? error}). cd into the PR's worktree — the one checked out at --head-sha ${headSha} — before building its gate context.`);
  }
  if (result.code !== 0) {
    throw new Error(`--base was given but the current working directory (${repoRoot}) is not inside a git worktree (git rev-parse HEAD failed: ${result.stderr.trim() || `exit ${result.code}`}). cd into the PR's worktree — the one checked out at --head-sha ${headSha} — before building its gate context.`);
  }
  const actualHead = result.stdout.trim().toLowerCase();
  if (!actualHead.startsWith(declared)) {
    throw new Error(`worktree HEAD ${actualHead} does not match --head-sha ${declared}: the current working directory is the WRONG worktree for this PR, so \`git diff <base>...HEAD\` would resolve the WRONG diff. cd into the worktree checked out at ${declared} and re-run.`);
  }
}

export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), runGit = runGitCommand } = {}) {
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
    // FAIL-CLOSED: the log path is keyed by --prev-head, but `carriedFromHead` is
    // stamped from the log's OWN headSha and the delta is diffed from --prev-head.
    // A log whose internal head disagrees with the path it sits at would stamp a
    // provenance head that was never diffed — reject rather than reconcile.
    const recordedHead = typeof log?.headSha === "string" ? log.headSha.trim().toLowerCase() : null;
    if (recordedHead !== options.prevHead) {
      throw new Error(`prior gate findings-log at ${logPath} records headSha ${JSON.stringify(log?.headSha ?? null)}, which is not --prev-head ${options.prevHead} — cannot carry forward (fail-closed)`);
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
    await assertWorktreeAtHeadAsync(options.headSha, { repoRoot, runGit });
    const { changedFiles, hasRename } = await captureChangedFilesBetween({ base: options.prevHead, repoRoot, runGit });
    // A rename anywhere in the delta forces the RENAME_ONLY-mapped angles to
    // re-run: parseChangedFiles keeps only a rename's destination path, so
    // classifying that path alone misses what the rename itself implicates.
    const alwaysRerun = [...mandatoryAngles, ...(hasRename ? RENAME_ONLY_ANGLES : [])];
    const rawPlan = buildCarryForwardPlan({ log, changedFiles, alwaysRerun });
    // AC1 (issue 2008 / ADR 0061): optional --spec-authority stamps the pinned
    // revision identity onto the plan via the ONE shared helper. Pure no-op
    // (byte-identical output) when the flag is absent. Resolved against
    // `repoRoot` (default process.cwd()) — the same root this function
    // already anchors --prev-head's log path to (issue 2008 draft-gate
    // review finding F2: --spec-authority path resolution must match every
    // other writer, not read cwd-relative-only).
    const specAuthorityIdentity = await readSpecAuthorityIdentity(
      options.specAuthority !== undefined ? path.resolve(repoRoot, options.specAuthority) : undefined,
      parseError,
    );
    const plan = stampOptionalSpecAuthority(rawPlan, specAuthorityIdentity);
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
      ...(plan.specAuthority !== undefined ? { specAuthority: plan.specAuthority } : {}),
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
