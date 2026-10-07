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
  startDeltaSequence,
  threadsToActList,
} from "@dev-loops/core/loop/pre-push-delta-review";
import { normalizeFixerDispositionHandoff } from "@dev-loops/core/loop/fixer-disposition";
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
  return {
    help: false,
    actList: values["act-list"] ?? null,
    threadsFile: values["threads-file"] ?? null,
    repo: values.repo ?? null,
    pr: values.pr ? Number(values.pr) : null,
    baseline,
    specIdentity,
    siteCoverage: values["site-coverage"] ?? null,
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

export function runCli(
  argv = process.argv.slice(2),
  { revParse = gitRevParse, isAncestor = gitIsAncestor, stdout = process.stdout, tmpRoot } = {},
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
    // Result mode discards coverage for an older head; decideDeltaNextStep routes the stale result.
    siteCoverage = record.headSha === currentHead ? record.siteCoverage ?? [] : [];
  }
  let payload;
  if (options.result) {
    const result = JSON.parse(readFileSync(options.result, "utf8"));
    const decision = decideDeltaNextStep({ sequence, result, invocation: options.invocation, currentHead, siteCoverage });
    // Local evidence for the emitter and the fixed-reply guard; never a gate verdict.
    writeGateDeltaRecord({
      tmpRoot: tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree),
      sequence, candidateHead: currentHead, invocation: options.invocation, decision, result,
    });
    payload = { ok: true, ...decision };
  } else {
    payload = { ok: true, input: buildDeltaInput({ sequence, candidateHead: currentHead, specIdentity: options.specIdentity, siteCoverage }) };
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
