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
import { collectStaleSurface } from "@dev-loops/core/loop/stale-surface-hits";
import { normalizeFixerDispositionHandoff, siteCoverageGaps } from "@dev-loops/core/loop/fixer-disposition";
import { HEAD_SHA_RE } from "@dev-loops/core/loop/spec-authority";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";
import { writeGateDeltaRecord } from "./_gate-delta-record.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: check-pre-push-delta.mjs --act-list <path> --baseline <sha> --spec-identity <id> --findings-log <path> [--site-coverage <path>] [--worktree <dir>]
       check-pre-push-delta.mjs --act-list <path> --baseline <sha> --spec-identity <id> --handback --site-coverage <path> [--worktree <dir>]   (fixer handbackCheck run)
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
  --findings-log <path>   Required on the act-list route, input mode: the reviewed gate round's findings log (its headSha must equal --baseline);
                          its provenance.perAngle angles join the surface hints (PRE-PUSH-DELTA-INPUT). Refused with --threads-file.
  --handback              The fixer handbackCheck run: waives the --findings-log requirement (it validates --site-coverage, no reviewer input is used)
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
        handback: { type: "boolean" },
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
  if (values["threads-file"] && values["findings-log"]) throw parseError("--findings-log is refused with --threads-file: PRE-PUSH-DELTA-INPUT gives the thread route the act items' angles only");
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
  if (values.handback && !(values["act-list"] && values["site-coverage"] && !values.result)) throw parseError("--handback is the fixer handbackCheck flag: it requires --act-list and --site-coverage and refuses --result; the coordinator input run never passes it");
  if (values["act-list"] && !values.result && !values.handback && !values["findings-log"]) throw parseError("--findings-log <path> is required on the act-list input run: PRE-PUSH-DELTA-INPUT makes the reviewed round's angles part of the surface hints");
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
// A git failure throws (fail closed), including a missing baseline or head object. The diff and grep
// formats are pinned so operator git config (prefix, color, external diff, textconv, algorithm, renames, path quoting) cannot blank the check.
export function gitStaleSurfaceHits(worktreeArg, baseline, head) {
  // Run from the top level so a subdirectory --worktree cannot scope the diff or grep to that subtree.
  const top = spawnSync("git", ["-C", worktreeArg, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnvNoDirOverrides() });
  if (top.status !== 0 || !top.stdout.trim()) throw new Error(`git rev-parse --show-toplevel failed in ${worktreeArg}: ${top.stderr.trim()}; the stale-surface check cannot locate the repository`);
  const worktree = top.stdout.trim();
  const git = (...args) => spawnSync("git", ["-C", worktree, "-c", "core.quotePath=false", ...args], { encoding: "utf8", env: gitEnvNoDirOverrides(), maxBuffer: 64 * 1024 * 1024 });
  for (const rev of [baseline, head]) {
    const exists = git("cat-file", "-e", `${rev}^{commit}`);
    if (exists.status !== 0) throw new Error(`git cat-file ${rev} failed in ${worktree}: ${exists.stderr.trim()}; the stale-surface check cannot read the delta range`);
  }
  const diff = git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-renames", "--no-relative", "--inter-hunk-context=0", `${baseline}..${head}`);
  if (diff.status !== 0) throw new Error(`git diff ${baseline}..${head} failed in ${worktree}: ${diff.stderr.trim()}; the stale-surface check cannot read the delta range`);
  const grep = (needle, { word }) => {
    const out = git("grep", "-n", "-I", "--full-name", "-F", "--no-color", ...(word ? ["-w"] : []), "-e", needle, head);
    if (out.status === 1) return [];
    if (out.status !== 0) throw new Error(`git grep failed in ${worktree} (exit ${out.status}): ${out.stderr.trim()}`);
    const rows = out.stdout.split("\n").filter(Boolean);
    const hits = rows.flatMap((row) => {
      const match = /^[^:]*:(.+?):(\d+):/u.exec(row);
      return match ? [{ file: match[1], line: Number(match[2]) }] : [];
    });
    if (rows.length > 0 && hits.length === 0) throw new Error(`git grep output could not be parsed in ${worktree}: the stale-surface check fails closed`);
    return hits;
  };
  return collectStaleSurface({ diffText: diff.stdout, grep });
}

// The findings log writer stamps `headSha`; the log must be the baseline round's and carry provenance.perAngle.
function roundAnglesOf(findingsLogPath, baseline) {
  if (!findingsLogPath) return [];
  const log = JSON.parse(readFileSync(findingsLogPath, "utf8"));
  const perAngle = log?.provenance?.perAngle;
  const logHead = typeof log?.headSha === "string" ? log.headSha.trim().toLowerCase() : "";
  if (!HEAD_SHA_RE.test(logHead) || !(logHead.startsWith(baseline) || baseline.startsWith(logHead))) {
    throw new Error(`--findings-log ${findingsLogPath} records head ${log?.headSha ?? "(none)"}, not the baseline ${baseline}: pass the findings log of the reviewed round`);
  }
  // An inline_single_agent round writes no provenance: take the angles of its findings.
  if (log.executionMode === "inline_single_agent" && !Array.isArray(perAngle)) {
    return [...new Set((Array.isArray(log.findings) ? log.findings : []).map((f) => f?.angle).filter((a) => typeof a === "string" && a.length > 0))];
  }
  if (!Array.isArray(perAngle) || perAngle.length === 0) throw new Error(`--findings-log ${findingsLogPath} has no non-empty provenance.perAngle: pass the reviewed gate round's findings log`);
  return perAngle.map((row) => row?.angle).filter((angle) => typeof angle === "string" && angle.length > 0);
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
  const truncatedNeedles = Array.isArray(stale) ? [] : stale.truncatedNeedles ?? [];
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
    payload = { ok: true, input: buildDeltaInput({ sequence, candidateHead: currentHead, specIdentity: options.specIdentity, siteCoverage, roundAngles: roundAnglesOf(options.findingsLog, sequence.reviewBaselineHead), staleSurfaceHits, staleSurfaceTruncated, truncatedNeedles }) };
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
