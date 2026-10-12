#!/usr/bin/env node
/**
 * check-pre-push-delta
 *
 * Shell entry for the pre-push reviewer's delta mode
 * (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-* rules). The dev-loop
 * coordinator runs it between the fixer's act-list or thread-route fix commit and its push:
 *
 * - without --result: prints the neutral reviewer input for the current
 *   worktree head (cumulative baseline..candidate range, act refs, spec
 *   identity, surface hints, checklist);
 * - with --result: validates the reviewer's DeltaPrePushReviewResult against
 *   the current worktree head, prints the next step and records the decision at
 *   <tmp-root>/gate-delta/<baseline>.json (last write wins; local evidence only,
 *   PRE-PUSH-DELTA-NOT-GATE-EVIDENCE).
 *
 * The run without --result is write-free: it reads the act list (or the
 * unresolved-threads file of the thread route), the result file and
 * `git rev-parse HEAD`, and writes only to stdout. All logic lives in
 * @dev-loops/core/loop/pre-push-delta-review.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  DELTA_MAX_INVOCATIONS,
  buildDeltaInput,
  decideDeltaNextStep,
  resolveDeltaTrigger,
  staleSurfaceTruncatedHit,
  startDeltaSequence,
  threadsToActList,
} from "@dev-loops/core/loop/pre-push-delta-review";
import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { collectStaleSurface } from "@dev-loops/core/loop/stale-surface-hits";
import { normalizeFixerDispositionHandoff, siteCoverageGaps } from "@dev-loops/core/loop/fixer-disposition";
import { HEAD_SHA_RE } from "@dev-loops/core/loop/spec-authority";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";
import { writeGateDeltaRecord } from "./_gate-delta-record.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: check-pre-push-delta.mjs --act-list <path> --baseline <sha> --spec-identity <id> [--site-coverage <path>] [--worktree <dir>]
       check-pre-push-delta.mjs --act-list <path> --baseline <sha> --result <path> --invocation <1-3> [--site-coverage <path>] [--worktree <dir>]
       check-pre-push-delta.mjs --threads-file <path> --repo <owner/name> --pr <n> --baseline <sha> ...   (thread route: replaces --act-list)

Delta-mode pre-push review checks (skills/docs/pre-pr-review-contract.md).

  --act-list <path>       The judge-pass --out act list the fix resolves
  --threads-file <path>   Thread route, in place of --act-list: successful list-review-threads --unresolved-only
                          output for --repo/--pr. Each unresolved thread is one act item; its ref is the threadId.
  --repo <owner/name>     Required with --threads-file
  --pr <n>                Required with --threads-file
  --baseline <sha>        reviewBaselineHead: the head the gate round reviewed (hex SHA)
  --spec-identity <id>    Current spec identity passed to the reviewer (required without --result)
  --site-coverage <path>  The fixer's commit_only handback { headSha, siteCoverage: [...] } (the work order's outputRef)
                          Omitting it in --result mode reports a coverage gap for every act item with a siteQuery
  --findings-log <path>   The reviewed gate round's findings log; its provenance.perAngle angles join the surface hints
  --pr-head <sha>         The full PR head SHA just read from GitHub; refused when it differs from --baseline (the head moved)
  --result <path>         The reviewer's DeltaPrePushReviewResult JSON
  --invocation <n>        1-based delta review invocation in this sequence (max 3)
  --worktree <dir>        Worktree whose HEAD is the candidate (default: cwd)

Output (stdout, JSON):
  without --result: { "ok": true, "input": { ..., "resultShape": { ... } } }
                    input.resultShape is the template the reviewer fills in.

Result JSON (--result, DeltaPrePushReviewResult):
  { "reviewBaselineHead": "<sha>", "candidateHead": "<sha>", "actSetId": "<input.actSetId>",
    "actionableItems": [{ "ref", "status": "resolved|not_resolved|cannot_verify", "evidence": ["..."] }],
    "newFindings": [{ "severity", "summary", "evidence": ["..."], "residueOf"?, "site"?, "skipReason"? }],
    "widenedReads": [{ "path": "...", "reason": "..." }],   (objects, not strings; [] when none)
    "outcome": "locally_clear|needs_fix|bounded_out" }

  with --result:    also writes <tmp-root>/gate-delta/<baseline>.json { reviewBaselineHead, candidateHead, actSetId,
                    invocation, outcome, nextStep, items: [{ ref, status }] }.
                    { "ok": true, "outcome": "locally_clear|needs_fix|bounded_out",
                      "nextStep": "push|fix_and_rereview|rereview_current_head|push_to_gate",
                      "locallyClear": bool, "fresh": bool, "errors": [...] }

${JQ_OUTPUT_USAGE}

Exit codes: 0 decision printed; 2 argument or runtime error (including HEAD equal
to the baseline), or invalid --jq filter.`;

const parseError = buildParseError(USAGE);

export function parseCheckPrePushDeltaArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        "act-list": { type: "string" },
        "threads-file": { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        baseline: { type: "string" },
        "spec-identity": { type: "string" },
        "site-coverage": { type: "string" },
        "findings-log": { type: "string" },
        "pr-head": { type: "string" },
        result: { type: "string" },
        invocation: { type: "string" },
        worktree: { type: "string" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
    }));
  } catch (error) {
    throw parseError(error.message);
  }
  if (values.help) return { help: true };
  if (Boolean(values["act-list"]) === Boolean(values["threads-file"])) throw parseError("pass exactly one of --act-list <path> and --threads-file <path>");
  if (values["threads-file"] && !(values.repo && /^[1-9]\d*$/.test(values.pr ?? ""))) throw parseError("--threads-file requires --repo <owner/name> and --pr <n>");
  if (!values.baseline) throw parseError("--baseline <sha> is required");
  const baseline = values.baseline.trim().toLowerCase();
  if (!HEAD_SHA_RE.test(baseline)) throw parseError("--baseline must be a hex commit SHA (7-64 hex characters)");
  const invocation = values.invocation === undefined ? null : Number(values.invocation);
  if (invocation !== null && !(Number.isInteger(invocation) && invocation >= 1 && invocation <= DELTA_MAX_INVOCATIONS)) {
    throw parseError(`--invocation must be an integer in 1..${DELTA_MAX_INVOCATIONS}`);
  }
  if (values.result && invocation === null) throw parseError("--result requires --invocation <1-3>");
  const specIdentity = values["spec-identity"]?.trim() || null;
  if (!values.result && !specIdentity) throw parseError("--spec-identity <id> is required without --result");
  const prHead = values["pr-head"]?.trim().toLowerCase() ?? null;
  if (prHead !== null && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(prHead)) throw parseError("--pr-head must be a full 40- or 64-character commit SHA");
  return {
    help: false,
    actList: values["act-list"] ?? null,
    threadsFile: values["threads-file"] ?? null,
    repo: values.repo ?? null,
    pr: values.pr ? Number(values.pr) : null,
    baseline,
    specIdentity,
    siteCoverage: values["site-coverage"] ?? null,
    findingsLog: values["findings-log"] ?? null,
    prHead,
    result: values.result ?? null,
    invocation,
    worktree: values.worktree ?? process.cwd(),
    jq: values.jq,
    silent: values.silent === true,
    fields: values.fields,
  };
}

function gitRevParse(worktree, rev) {
  const out = spawnSync("git", ["-C", worktree, "rev-parse", "--verify", `${rev}^{commit}`], {
    encoding: "utf8", env: gitEnvNoDirOverrides(),
  });
  if (out.status !== 0) throw new Error(`git rev-parse ${rev} failed in ${worktree}: ${out.stderr.trim()}`);
  return out.stdout.trim();
}

function gitIsAncestor(worktree, ancestor, descendant) {
  const out = spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8", env: gitEnvNoDirOverrides(),
  });
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed in ${worktree}: ${out.stderr.trim()}`);
}

// Tracked-file hits of the sentences and identifiers the delta range removed, grepped at the candidate head.
// A git failure throws (fail closed). When either commit object does not exist locally (the tests'
// placeholder SHAs), there is no range to read and the check reports no hits.
function gitStaleSurfaceHits(worktree, baseline, head) {
  const git = (...args) => spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", env: gitEnvNoDirOverrides(), maxBuffer: 64 * 1024 * 1024 });
  if ([baseline, head].some((rev) => git("cat-file", "-e", `${rev}^{commit}`).status !== 0)) return { hits: [], truncated: false };
  const diff = git("diff", "-U0", "--no-color", `${baseline}..${head}`);
  if (diff.status !== 0) throw new Error(`git diff ${baseline}..${head} failed in ${worktree}: ${diff.stderr.trim()}; the stale-surface check cannot read the delta range`);
  const grep = (needle, { word }) => {
    const out = git("grep", "-n", "-I", "-F", ...(word ? ["-w"] : []), "-e", needle, head);
    if (out.status === 1) return [];
    if (out.status !== 0) throw new Error(`git grep failed in ${worktree} (exit ${out.status}): ${out.stderr.trim()}`);
    return out.stdout.split("\n").filter(Boolean).flatMap((row) => {
      const match = /^[^:]*:(.+?):(\d+):/u.exec(row);
      return match ? [{ file: match[1], line: Number(match[2]) }] : [];
    });
  };
  return collectStaleSurface({ diffText: diff.stdout, grep });
}

function roundAnglesOf(findingsLogPath) {
  if (!findingsLogPath) return [];
  const perAngle = JSON.parse(readFileSync(findingsLogPath, "utf8"))?.provenance?.perAngle;
  return Array.isArray(perAngle) ? perAngle.map((row) => row?.angle).filter((angle) => typeof angle === "string" && angle.length > 0) : [];
}

export function runCli(
  argv = process.argv.slice(2),
  { revParse = gitRevParse, isAncestor = gitIsAncestor, staleSurface = gitStaleSurfaceHits, stdout = process.stdout, tmpRoot } = {},
) {
  const options = parseCheckPrePushDeltaArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const sequence = startDeltaSequence({
    reviewBaselineHead: revParse(options.worktree, options.baseline),
    actList: options.threadsFile
      ? threadsToActList(JSON.parse(readFileSync(options.threadsFile, "utf8")), { repo: options.repo, pr: options.pr })
      : JSON.parse(readFileSync(options.actList, "utf8")),
  });
  if (options.prHead && options.prHead !== sequence.reviewBaselineHead) {
    throw new Error(`PRE-PUSH-DELTA-PUSH-AUTHORITY: the PR head ${options.prHead} differs from the recorded pre-delta head ${sequence.reviewBaselineHead}: another actor pushed; stop and refresh the gate round`);
  }
  const currentHead = revParse(options.worktree, "HEAD");
  // The CLI runs before the push, so the fix is unpushed by construction.
  const fixCommitted = currentHead !== sequence.reviewBaselineHead;
  const itemCounts = options.threadsFile ? { threadItemCount: sequence.actItems.length } : { actItemCount: sequence.actItems.length };
  if (resolveDeltaTrigger({ ...itemCounts, fixCommitted }) !== "delta") {
    throw new Error(`worktree HEAD ${currentHead} equals the baseline: commit the act-list or thread-route fix before the delta review`);
  }
  if (!isAncestor(options.worktree, sequence.reviewBaselineHead, currentHead)) {
    throw new Error(
      `baseline ${sequence.reviewBaselineHead} is not an ancestor of worktree HEAD ${currentHead}: the delta range must extend the reviewed head`,
    );
  }
  // The fixer's commit_only handback. Without it every act item with a site query reports a coverage gap.
  let siteCoverage = [];
  if (options.siteCoverage) {
    const record = normalizeFixerDispositionHandoff(JSON.parse(readFileSync(options.siteCoverage, "utf8")), { ruleIds: loadKnownRuleIds() });
    if (record.headSha !== currentHead && !options.result) {
      throw new Error(`site coverage record names head ${record.headSha}, not the worktree HEAD ${currentHead}: the fixer must record coverage for its latest commit`);
    }
    if (!options.result) {
      const gaps = siteCoverageGaps(sequence.actItems, record.siteCoverage);
      if (gaps.length > 0) throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: the disposition handoff leaves site coverage incomplete: ${gaps.join("; ")}`);
    }
    // Result mode discards coverage for an older head; decideDeltaNextStep routes the stale result.
    siteCoverage = record.headSha === currentHead ? record.siteCoverage ?? [] : [];
  }
  // A custom `staleSurface` may return the hits array alone.
  const stale = staleSurface(options.worktree, sequence.reviewBaselineHead, currentHead);
  const staleSurfaceHits = Array.isArray(stale) ? stale : stale.hits;
  const staleSurfaceTruncated = Array.isArray(stale) ? false : stale.truncated === true;
  let payload;
  if (options.result) {
    const result = JSON.parse(readFileSync(options.result, "utf8"));
    // A truncated hit list blocks locally_clear until a finding or a skipped site names the gap.
    const decision = decideDeltaNextStep({
      sequence, result, invocation: options.invocation, currentHead, siteCoverage,
      staleSurfaceHits: staleSurfaceTruncated ? [...staleSurfaceHits, staleSurfaceTruncatedHit()] : staleSurfaceHits,
    });
    // Local evidence for the emitter and the fixed-reply guard; never a gate verdict.
    writeGateDeltaRecord({
      tmpRoot: tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree),
      sequence, candidateHead: currentHead, invocation: options.invocation, decision, result,
    });
    payload = { ok: true, ...decision };
  } else {
    // PRE-PUSH-DELTA-PUSH-AUTHORITY: mark the sequence active for the push guard (never downgrades a granted marker).
    writeSequenceMarker({ tmpRoot: tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree), baselineHead: sequence.reviewBaselineHead });
    payload = { ok: true, input: buildDeltaInput({ sequence, candidateHead: currentHead, specIdentity: options.specIdentity, siteCoverage, roundAngles: roundAnglesOf(options.findingsLog), staleSurfaceHits, staleSurfaceTruncated }) };
  }
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, fields: options.fields, stdout });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  }
}
