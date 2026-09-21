#!/usr/bin/env node
/**
 * resolve-angle-carry-forward.mjs — the gate carry-forward decision CLI.
 *
 * Given a PRIOR gate findings-log (verdict `clean` or `findings_present`, at
 * head A) and the delta A..B, decide per angle whether its prior verdict may
 * be CARRIED FORWARD to head B or the angle MUST re-run. A `findings_present`
 * angle whose surface the delta provably did not touch carries
 * forward WITH its prior open findings unchanged: carry-forward only skips
 * re-running a reviewer, it never converts an open finding into an approval.
 * The decision itself is the pure, fail-closed
 * `resolveAngleCarryForward`/`angleReviewSurface` seam in
 * @dev-loops/core/loop/gate-carry-forward; this CLI supplies its inputs and
 * shapes the output for the fan-out orchestrator (skip re-fanning carried
 * angles; write carried provenance pointing at the PRIOR head's reviewer).
 *
 * FAIL-CLOSED: only `clean`/`findings_present` prior verdicts can carry
 * forward; any uncertainty (other verdict, empty/unclassifiable delta,
 * unmapped angle, always-run angle, or an AMBIGUOUS angle attribution — a
 * finding matching more than one provenance.perAngle row) resolves to
 * must-re-run. See skills/docs/gate-review-sub-loop-contract.md.
 *
 * Also emits a Copilot convergence-carry-forward decision (AC2): whether a
 * post-convergence head bump is a pure doc/prose bump, so it need not force a
 * fresh blocking Copilot round.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfig, resolveBaseBranch, resolveGateAngleContract } from "@dev-loops/core/config";
import {
  angleReviewSurface,
  RENAME_ONLY_ANGLES,
  resolveAngleCarryForward,
  resolveConvergenceCarryForward,
} from "@dev-loops/core/loop/gate-carry-forward";
import { baseAngleName } from "@dev-loops/core/loop/gate-fanin";

import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { captureMainRelativeChangedFilesSince, runGitCommand } from "../lib/git-delta.mjs";
export { runGitCommand } from "../lib/git-delta.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { readSpecAuthorityIdentity, stampOptionalSpecAuthority } from "../lib/spec-authority-stamp.mjs";
import { normalizeGate as normalizeGateShared, normalizeHeadSha as normalizeHeadShaShared } from "./_gate-names.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import {
  buildCarryForwardPlanPath,
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
      // FULL SHA only: buildLogPath keys the prior log's path on --prev-head
      // verbatim (every sanctioned writer keys by the full SHA). A prefix would
      // resolve a path that can never exist, refusing as a misleading "log not
      // found" — read as "no prior round", silently disabling carry-forward.
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
      // FULL SHA only: the resolver now writes a path-KEYED plan artifact
      // (buildCarryForwardPlanPath) at --head-sha, and the fan-out emitter looks
      // that artifact up by the FULL current head SHA. An abbreviated spelling
      // would key a file the emitter can never find, refusing a re-gate that
      // actually ran the resolver. head-sha.mjs's contract also requires a
      // path-key writer to take the full SHA.
      const sha = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be the FULL head commit SHA (40 or 64 hex chars), not a short prefix — the resolver keys its carry-forward plan artifact by the full SHA");
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
  // FAIL-CLOSED: a same-head "carry" would re-seed the CURRENT round from its
  // own (possibly retired) verdict — the exact case round retirement
  // (GATE-EXEC-ROUND-RETIREMENT) discards; a fresh fan-out at the same head
  // must re-review every angle. Both --prev-head and --head-sha are now FULL
  // SHAs, so an exact compare is correct (a mixed 40/64 spelling of one commit
  // does not occur within a single repo's object format).
  if (options.prevHead === options.headSha) {
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
 * prior open `findings` — the caller must write these findings
 * through unchanged, never dropped and never converted into a pass, so the
 * gate still blocks on them exactly as if freshly reviewed. A carried clean
 * angle carries `prevVerdict: "clean"` and an empty `findings` array.
 *
 * @param {object} input
 * @param {object|null} input.log — the prior findings-log JSON (verdict must be
 *   "clean" or "findings_present")
 * @param {string[]} input.changedFiles — the MAIN-RELATIVE incremental delta
 *   (files changed since head A whose head-B content is genuinely PR-own), NOT
 *   the raw two-dot A..B delta.
 * @param {Iterable<string>} [input.alwaysRerun] — angles that must NEVER carry
 *   forward regardless of the delta (the gate's configured mandatory angles, plus
 *   the RENAME_ONLY-mapped angles when the delta contains any rename). Each
 *   resolves to an always-rerun surface so it lands in `mustRerun`, not `carried`.
 * @param {boolean} [input.deltaComplete=false] — proof the main-relative reduction
 *   ran, so an EMPTY delta carries every eligible angle (integrate-only base-move)
 *   instead of failing closed. Threaded to {@link resolveAngleCarryForward}.
 * @returns {{ prevHead: string, carried: Array<{angle: string, carriedFromHead: string, reviewer?: string, dispatchId?: string, model?: string, prevVerdict: "clean"|"findings_present", findings: Array<object>, reason: string}>, mustRerun: Array<{angle: string, reason: string}> }}
 */
export function buildCarryForwardPlan({ log, changedFiles, alwaysRerun = [], deltaComplete = false }) {
  if (!log || typeof log !== "object") {
    throw new Error("prior gate findings-log not found or unreadable — cannot carry forward (fail-closed)");
  }
  if (log.verdict !== "clean" && log.verdict !== "findings_present") {
    // This is the ONE genuine carry-forward ELIGIBILITY refusal: a readable,
    // well-formed prior log whose verdict simply is not carry-eligible. Its
    // contract outcome is a safe full re-dispatch, so the CLI records a fallback
    // marker for it. Every OTHER throw below is a log INTEGRITY failure (corrupt/
    // truncated/inconsistent ledger), which is not a carry-forward decision — the
    // CLI leaves NO marker for those, so the emitter fails closed on the re-gate
    // exactly as it does for an operational failure, rather than silently
    // dispatching off an untrustworthy ledger.
    const refusal = new Error(`prior gate findings-log verdict is ${JSON.stringify(log.verdict ?? null)}, not carry-forward-eligible (clean or findings_present) — nothing to carry forward (fail-closed)`);
    refusal.carryForwardRefusal = true;
    throw refusal;
  }
  // FAIL-CLOSED: a "findings_present" overall verdict is only
  // meaningful if `findings` is a non-empty array — a missing/empty/non-array
  // value is indistinguishable from a truncated log and would fall through to
  // the per-angle loop as all-clean, silently dropping whatever the round
  // actually raised. Refuse the whole plan so the round re-fans instead.
  if (log.verdict === "findings_present" && !(Array.isArray(log.findings) && log.findings.length > 0)) {
    throw new Error(`prior gate findings-log verdict is "findings_present" but its findings field is ${JSON.stringify(log.findings ?? null)} (missing/empty/non-array) — a findings_present round implies at least one finding; cannot carry forward without proof of which angle(s) are still open (fail-closed)`);
  }
  // FAIL-CLOSED: a carried entry stamps `carriedFromHead`/`prevHead` with the
  // prior log's headSha; downstream write-gate-findings-log requires a 7-64 hex
  // SHA there. A malformed headSha must not yield a plan with a bad provenance
  // stamp — reject it here so every angle re-runs from scratch.
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
  // Preserve the FULL reviewer identity per angle: the provenance contract
  // (write-gate-findings-log / gate-fanin.countDistinctReviewers) counts an
  // angle's identity via `reviewer` OR `dispatchId`, so carrying only `reviewer`
  // would drop a `dispatchId`-recorded identity and break distinctReviewers or
  // the new head's provenance-consistency check.
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
  // FAIL-CLOSED, per-angle: an angle's PRIOR verdict is derived from its OWN
  // findings, never from the log's overall verdict — a clean/findings_present
  // overall log can still carry a per-angle non-blocking finding. ANY recorded
  // finding against an angle makes it "findings_present" for carry-forward, so
  // carrying it forward (below) is how the problem stays visible instead of
  // silently vanishing because a later delta left its surface untouched.
  //
  // Attribution: `log.findings` must be an array, and every finding must match
  // a KNOWN prevAngles entry via {@link baseAngleName} (a `<angle>-delta-at-...`
  // re-review entry counts toward its base angle, per gate-fanin's own coverage
  // check) case-insensitively. An unattributable finding means no angle is
  // provably clean, so it refuses the whole plan.
  if (log.findings !== undefined && !Array.isArray(log.findings)) {
    throw new Error("prior gate findings-log's findings field is not an array — cannot verify which angles are clean (fail-closed)");
  }
  // MANY-TO-ONE, not last-wins: a base+lowercase key can legitimately collect
  // MORE THAN ONE prevAngles entry — a base angle and its `-delta-at-...`
  // re-review sibling are both legal, independently-carry-forward-eligible rows
  // (per the contract doc and gate-fanin's coverage check), and the exact-string
  // duplicate guard above doesn't catch a base/case collision. A last-wins Map
  // would silently drop the other row from attribution, so bucket every match.
  const prevAnglesByLowerBase = new Map();
  for (const angle of prevAngles) {
    const key = baseAngleName(angle).toLowerCase();
    const bucket = prevAnglesByLowerBase.get(key);
    if (bucket) bucket.push(angle);
    else prevAnglesByLowerBase.set(key, [angle]);
  }
  // A finding's angle attribution is UNAMBIGUOUS only when it matches EXACTLY
  // ONE provenance.perAngle row. A match against more than one (a base angle
  // plus its `-delta-at-...` sibling, or a case-drifted duplicate) makes it
  // impossible to say which row owns the finding, so carrying it onto only one
  // risks dropping it off the other or double-counting it. FAIL-CLOSED:
  // every row in an ambiguous bucket always re-runs; only an unambiguous
  // single-row match is eligible for carry-with-findings below.
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
    const decision = resolveAngleCarryForward({ angle, angleSurface, changedFiles, prevVerdict, deltaComplete });
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

/**
 * Persist the resolver's plan (or a fail-closed full-fallback marker) as the
 * keyed carry-forward plan artifact at the CURRENT head (head B). Its mere
 * presence is the deterministic proof that carry-forward was consulted before
 * dispatch — `emit-fanout-dispatch.mjs` refuses to spawn a reviewer on a
 * re-gate head without it (GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED). Written for
 * BOTH outcomes: the success path (ok: true, with carried/mustRerun) and the
 * fail-closed refusal path (ok: false, fallback: true — the resolver ran and
 * decided full re-dispatch, which is safe), so the artifact records "the
 * resolver ran" regardless of whether anything carried. Keyed by --head-sha,
 * so a stale plan sits at a different filename and can never be mistaken for
 * this head's.
 */
async function persistCarryForwardPlan(planBody, { repoRoot, repo, pr, gate, headSha, tmpRoot }) {
  const planPath = path.resolve(repoRoot, buildCarryForwardPlanPath({ repo, pr, gate, headSha, tmpRoot: tmpRoot || "tmp" }));
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(planBody, null, 2)}\n`, "utf8");
  return planPath;
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
    // Remove any stale plan artifact for this exact (repo, pr, gate, headSha)
    // BEFORE doing any work, so EVERY invocation's outcome is authoritative and
    // a run that fails operationally (or on an integrity error) leaves NO plan
    // behind — a prior successful run's artifact must never be laundered into
    // "this resolver run succeeded". Mirrors emit-fanout-dispatch.mjs's
    // start-of-flow emit-plan removal. The success and eligibility-refusal paths
    // below re-write the artifact; every other exit leaves it absent. ENOENT is
    // fine (nothing to remove).
    await rm(
      path.resolve(repoRoot, buildCarryForwardPlanPath({
        repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot || "tmp",
      })),
      { force: true },
    );
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
    // mandatory angle (even a CATEGORY_ANGLE_MAP-mapped one) is NEVER carried
    // forward — without this the "mandatory always re-runs" promise would only
    // cover the hardcoded ALWAYS_INCLUDE set. loadDevLoopConfig never throws.
    const { config } = await loadDevLoopConfig({ repoRoot });
    const { mandatoryAngles } = resolveGateAngleContract(config, mapGateToConfigKey(options.gate));
    // FAIL-CLOSED: the delta is computed against the CWD worktree HEAD, but the
    // plan is LABELED with --head-sha. A worktree checked out at a different
    // head would compute every decision against the wrong head; abort before
    // capturing the delta so no mislabeled plan is emitted.
    await assertWorktreeAtHeadAsync(options.headSha, { repoRoot, runGit });
    // MAIN-RELATIVE incremental delta: files changed since the prior reviewed
    // head (prev-head..HEAD) MINUS files already on the PR's base branch at HEAD.
    // A base-move re-gate that only integrates already-merged base commits then
    // contributes NO touched surface, so every eligible angle (and Copilot
    // convergence) carries forward instead of deadlocking against the round cap.
    // The exclusion ref is the CONFIGURED base branch (workflow.baseBranch, else
    // the auto-detected default), never a hardcoded origin/main: a repo whose
    // base is e.g. release-x must exclude against origin/release-x, or a stale
    // origin/main could exclude files that still differ from the true base and
    // permit an UNSAFE carry (fail-open). resolveBaseBranch returns a bare branch
    // name, so origin/ is prepended for the remote-tracking ref.
    const mainRef = `origin/${resolveBaseBranch(config, { cwd: repoRoot })}`;
    // `reduced` is true only when the base-relative exclusion actually ran; it
    // becomes `deltaComplete` below so an EMPTY reduced delta carries (proven
    // "nothing PR-own changed") while an unreduced/unavailable delta still fails
    // closed.
    const { changedFiles, hasRename, reduced } = await captureMainRelativeChangedFilesSince({ base: options.prevHead, mainRef, repoRoot, runGit });
    // A rename anywhere in the delta forces the RENAME_ONLY-mapped angles to
    // re-run: parseChangedFiles keeps only a rename's destination path, so
    // classifying that path alone misses what the rename itself implicates.
    const alwaysRerun = [...mandatoryAngles, ...(hasRename ? RENAME_ONLY_ANGLES : [])];
    // buildCarryForwardPlan tags ONLY the genuine eligibility refusal (an
    // ineligible prior verdict) with `carryForwardRefusal`; a log INTEGRITY
    // failure (corrupt/truncated/inconsistent ledger — missing provenance,
    // malformed headSha, unattributable finding, findings_present with no
    // findings, duplicate angle) throws UNTAGGED and is treated like an
    // operational failure below: no marker, emitter refuses. So the catch never
    // blanket-tags — it trusts the tag the pure seam set.
    const rawPlan = buildCarryForwardPlan({ log, changedFiles, alwaysRerun, deltaComplete: reduced });
    // AC1 (ADR 0061): optional --spec-authority stamps the pinned revision
    // identity onto the plan via the ONE shared helper. Pure no-op when absent.
    // Resolved against `repoRoot` (default process.cwd()) — matching every
    // other writer's path resolution, not read cwd-relative-only.
    const specAuthorityIdentity = await readSpecAuthorityIdentity(
      options.specAuthority !== undefined ? path.resolve(repoRoot, options.specAuthority) : undefined,
      parseError,
    );
    const plan = stampOptionalSpecAuthority(rawPlan, specAuthorityIdentity);
    const copilotConvergence = resolveConvergenceCarryForward({ changedFiles, deltaComplete: reduced });
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
    // Persist the keyed plan artifact BEFORE emitting to stdout, so the proof
    // that carry-forward ran at head B is durable on disk regardless of how the
    // stdout emit is shaped (--jq/--silent) or whether the caller captures it.
    await persistCarryForwardPlan(result, {
      repoRoot, repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot,
    });
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // FAIL-CLOSED full-fallback: record a marker ONLY for a genuine carry-forward
    // ELIGIBILITY refusal (tagged above). The resolver consulted carry-forward and
    // decided nothing carries — a full re-dispatch, which is safe — so the emitter's
    // re-gate guard proceeds instead of deadlocking against a missing plan. An
    // OPERATIONAL failure (missing/mismatched prior log, wrong worktree, git error,
    // spec-authority/IO) is NOT a decision that carry-forward ran, so it leaves NO
    // marker and the emitter keeps refusing (a wrong --prev-head that resolves no
    // log must never be laundered into "resolver ran"). Best-effort persist; never
    // masks the original refusal.
    if (error instanceof Error && error.carryForwardRefusal === true) {
      try {
        await persistCarryForwardPlan({
          ok: false, fallback: true, reason: message,
          repo: options.repo, pr: options.pr, gate: options.gate,
          prevHead: options.prevHead, headSha: options.headSha,
          carried: [], mustRerun: [],
        }, { repoRoot, repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot });
      } catch {
        // Best-effort only — the original refusal below is authoritative.
      }
    }
    process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
