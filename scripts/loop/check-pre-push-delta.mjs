#!/usr/bin/env node
/**
 * check-pre-push-delta
 *
 * Shell entry for the pre-push reviewer's delta mode
 * (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-* rules). The dev-loop
 * coordinator runs it between the fixer's act-list fix commit and its push:
 *
 * - without --result: prints the neutral reviewer input for the current
 *   worktree head (cumulative baseline..candidate range, act refs, spec
 *   identity, surface hints, checklist);
 * - with --result: validates the reviewer's DeltaPrePushReviewResult against
 *   the current worktree head and prints the next step.
 *
 * Read-only: it reads the act list, the result file and `git rev-parse HEAD`,
 * and writes only to stdout. All logic lives in
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
} from "@dev-loops/core/loop/pre-push-delta-review";
import { HEAD_SHA_RE } from "@dev-loops/core/loop/spec-authority";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: check-pre-push-delta.mjs --act-list <path> --baseline <sha> [--spec-identity <id>] [--worktree <dir>]
       check-pre-push-delta.mjs --act-list <path> --baseline <sha> --result <path> --invocation <1-3> [--worktree <dir>]

Delta-mode pre-push review checks (skills/docs/pre-pr-review-contract.md).

  --act-list <path>       The judge-pass --out act list the fix resolves
  --baseline <sha>        reviewBaselineHead: the head the gate round reviewed (hex SHA)
  --spec-identity <id>    Current spec identity passed to the reviewer
  --result <path>         The reviewer's DeltaPrePushReviewResult JSON
  --invocation <n>        1-based delta review invocation in this sequence (max 3)
  --worktree <dir>        Worktree whose HEAD is the candidate (default: cwd)

Output (stdout, JSON):
  without --result: { "ok": true, "input": { ... } }
  with --result:    { "ok": true, "outcome": "locally_clear|needs_fix|bounded_out",
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
        baseline: { type: "string" },
        "spec-identity": { type: "string" },
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
  if (!values["act-list"]) throw parseError("--act-list <path> is required");
  if (!values.baseline) throw parseError("--baseline <sha> is required");
  const baseline = values.baseline.trim().toLowerCase();
  if (!HEAD_SHA_RE.test(baseline)) throw parseError("--baseline must be a hex commit SHA (7-64 hex characters)");
  const invocation = values.invocation === undefined ? null : Number(values.invocation);
  if (invocation !== null && !(Number.isInteger(invocation) && invocation >= 1 && invocation <= DELTA_MAX_INVOCATIONS)) {
    throw parseError(`--invocation must be an integer in 1..${DELTA_MAX_INVOCATIONS}`);
  }
  if (values.result && invocation === null) throw parseError("--result requires --invocation <1-3>");
  return {
    help: false,
    actList: values["act-list"],
    baseline,
    specIdentity: values["spec-identity"] ?? null,
    result: values.result ?? null,
    invocation,
    worktree: values.worktree ?? process.cwd(),
    jq: values.jq,
    silent: values.silent === true,
    fields: values.fields,
  };
}

function gitRevParse(worktree, rev) {
  const out = spawnSync("git", ["-C", worktree, "rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git rev-parse ${rev} failed in ${worktree}: ${out.stderr.trim()}`);
  return out.stdout.trim();
}

function gitIsAncestor(worktree, ancestor, descendant) {
  const out = spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8" });
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed in ${worktree}: ${out.stderr.trim()}`);
}

export function runCli(
  argv = process.argv.slice(2),
  { revParse = gitRevParse, isAncestor = gitIsAncestor, stdout = process.stdout } = {},
) {
  const options = parseCheckPrePushDeltaArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const sequence = startDeltaSequence({
    reviewBaselineHead: revParse(options.worktree, options.baseline),
    actList: JSON.parse(readFileSync(options.actList, "utf8")),
  });
  const currentHead = revParse(options.worktree, "HEAD");
  // The CLI runs before the push, so the fix is unpushed by construction.
  const fixCommitted = currentHead !== sequence.reviewBaselineHead;
  if (resolveDeltaTrigger({ actItemCount: sequence.actItems.length, fixCommitted }) !== "delta") {
    throw new Error(`worktree HEAD ${currentHead} equals the baseline: commit the act-list fix before the delta review`);
  }
  if (!isAncestor(options.worktree, sequence.reviewBaselineHead, currentHead)) {
    throw new Error(
      `baseline ${sequence.reviewBaselineHead} is not an ancestor of worktree HEAD ${currentHead}: the delta range must extend the reviewed head`,
    );
  }
  const payload = options.result
    ? {
        ok: true,
        ...decideDeltaNextStep({
          sequence,
          result: JSON.parse(readFileSync(options.result, "utf8")),
          invocation: options.invocation,
          currentHead,
        }),
      }
    : { ok: true, input: buildDeltaInput({ sequence, candidateHead: currentHead, specIdentity: options.specIdentity }) };
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
