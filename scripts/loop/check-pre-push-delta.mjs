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
 *   identity, surface hints (act angles and the round angles of --findings-log),
 *   staleSurfaceHits[], checklist);
 * - with --result: validates the reviewer's DeltaPrePushReviewResult against
 *   the current worktree head, prints the next step and records the decision at
 *   <tmp-root>/gate-delta/<baseline>.json (last write wins; local evidence only,
 *   PRE-PUSH-DELTA-NOT-GATE-EVIDENCE).
 *
 * The run without --result (except --handback, which writes nothing and omits patchPath and evidenceRule) writes only the cumulative patch (PRE-PUSH-DELTA-PATCH-ARTIFACT) at
 * <tmp-root>/gate-delta/<baseline>-<candidate>.patch: it reads the act list (or the
 * unresolved-threads file of the thread route), the result file, the
 * --findings-log file and `git rev-parse HEAD`, runs the stale-surface reads
 * (`git cat-file`, `git diff`, `git grep`), and authenticates ACT coverage without further writes.
 * Pure result checks live in @dev-loops/core/loop/pre-push-delta-review.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { loadDevLoopConfig, resolveBaseBranch } from "@dev-loops/core/config";
import { clearSequenceMarker, readSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import {
  DELTA_MAX_INVOCATIONS,
  buildDeltaInput,
  decideDeltaNextStep,
  deltaCoverageBinding,
  resolveDeltaTrigger,
  staleSurfaceTruncatedHit,
  startDeltaSequence,
  threadsToActList,
} from "@dev-loops/core/loop/pre-push-delta-review";
import { collectStaleSurface } from "@dev-loops/core/loop/stale-surface-hits";
import { normalizeFixerDispositionHandoff, siteCoverageGaps } from "@dev-loops/core/loop/fixer-disposition";
import { HEAD_SHA_RE } from "@dev-loops/core/loop/spec-authority";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { materializationHash, verifyPulledResult, workOrderDigest } from "../github/_work-order-protocol.mjs";
import { fixerPlanPath, locateFixerUnit } from "./emit-fixer-work-order.mjs";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";
import { writeGateDeltaRecord } from "./_gate-delta-record.mjs";
import { createGitClient, main as validateChangelog } from "../docs/validate-changelog-completeness.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: check-pre-push-delta.mjs --act-list <path> --baseline <sha> --spec-identity <id> --findings-log <path> --fixer-plan <path> --site-coverage <path> [--worktree <dir>]
       check-pre-push-delta.mjs --act-list <path> --baseline <sha> --spec-identity <id> --handback --site-coverage <path> [--worktree <dir>]   (fixer handbackCheck run)
       check-pre-push-delta.mjs --act-list <path> --baseline <sha> --result <path> --invocation <1-3> --fixer-plan <path> --site-coverage <path> [--worktree <dir>]
       check-pre-push-delta.mjs --threads-file <path> --repo <owner/name> --pr <n> --baseline <sha> ...   (thread route: replaces --act-list)

Delta-mode pre-push review checks (skills/docs/pre-pr-review-contract.md).

  --act-list <path>       The judge-pass --out act list the fix resolves
  --threads-file <path>   Thread route, in place of --act-list: successful list-review-threads --unresolved-only
                          output for --repo/--pr. Each unresolved thread is one act item; its ref is the threadId.
  --repo <owner/name>     Required with --threads-file
  --pr <n>                Required with --threads-file
  --baseline <sha>        reviewBaselineHead: the head the gate round reviewed (hex SHA)
  --pr-head <sha>         The PR head just read from GitHub; the check fails closed when it differs from --baseline
  --spec-identity <id>    Current spec identity passed to the reviewer (required without --result)
  --site-coverage <path>  The fixer's commit_only handback { headSha, siteCoverage: [...] } (the work order's outputRef)
  --fixer-plan <path>     Canonical current pulled commit_only plan; both flags required for ACT input/result
  --findings-log <path>   Required on the act-list route, input mode: the reviewed gate round's findings log (its headSha must equal --baseline);
                          its provenance.perAngle angles join the surface hints (PRE-PUSH-DELTA-INPUT). Refused with --threads-file.
  --handback              The fixer handbackCheck run: waives the --findings-log requirement (it validates --site-coverage, no reviewer input is used)
  --result <path>         The reviewer's DeltaPrePushReviewResult JSON
  --invocation <n>        1-based delta review invocation in this sequence (max 3)
  --worktree <dir>        Worktree whose HEAD is the candidate (default: cwd)

Output (stdout, JSON):
  without --result (except --handback, which writes nothing and omits "patchPath" and "evidenceRule"): { "ok": true, "input": { ..., "patchPath", "evidenceRule", "resultShape": { ... } } }
                    Also writes the cumulative baseline..candidate patch to input.patchPath (<tmp-root>/gate-delta/<baseline>-<candidate>.patch); the reviewer reads it with the read tool and needs no shell.
                    Fill input.resultShape; on ACT copy its binding below unchanged.

Result JSON (--result, DeltaPrePushReviewResult):
  Base shape (complete THREAD shape; genuine legacy results remain readable):
  { "reviewBaselineHead": "<sha>", "candidateHead": "<sha>", "actSetId": "<input.actSetId>",
    "actionableItems": [{ "ref", "status": "resolved|not_resolved|cannot_verify", "evidence": ["..."] }],
    "newFindings": [{ "severity", "summary", "evidence": ["..."], "residueOf"?, "site"?, "skipReason"? }],
    "widenedReads": [{ "path": "...", "reason": "..." }],   (objects, not strings; [] when none)
    "outcome": "locally_clear|needs_fix|bounded_out" }

  ACT results additionally require this binding from input.resultShape:
    { "coverageProtocol": "pulled_commit_only_v1",
      "siteCoverageDigest": "<raw semantic coverage SHA-256>",
      "handbackBytesDigest": "<exact handback bytes SHA-256>",
      "origin": { "workOrderRef": "<pulled fixer ref>", "workOrderDigest": "<sha256:...>",
                  "executionIdentity": "<pulled fixer execution>" } }
  Keep these four fields at the result's top level, copied unchanged; never reconstruct them.
  THREAD results use only the base shape and cannot claim this ACT binding.

  with --result:    also writes <tmp-root>/gate-delta/<baseline>.json { reviewBaselineHead, candidateHead, actSetId,
                    invocation, outcome, nextStep, items: [{ ref, status }],
                    coverageProtocol, siteCoverageDigest, handbackBytesDigest, origin } (last four ACT-only).
                    { "ok": true, "outcome": "locally_clear|needs_fix|bounded_out",
                      "nextStep": "push|fix_and_rereview|rereview_current_head|push_to_gate",
                      "locallyClear": bool, "fresh": bool, "errors": [...],
                      "coverageProtocol", "siteCoverageDigest", "handbackBytesDigest", "origin" }
                    The last four stdout fields are ACT-only and match the result binding above.
                    THREAD decisions/stdout and genuine legacy records omit the ACT binding.

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
        "pr-head": { type: "string" },
        "spec-identity": { type: "string" },
        "site-coverage": { type: "string" },
        "fixer-plan": { type: "string" },
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
  const prHead = values["pr-head"]?.trim().toLowerCase() ?? null;
  if (prHead !== null && !HEAD_SHA_RE.test(prHead)) throw parseError("--pr-head must be a hex commit SHA (7-64 hex characters)");
  const invocation = values.invocation === undefined ? null : Number(values.invocation);
  if (invocation !== null && !(Number.isInteger(invocation) && invocation >= 1 && invocation <= DELTA_MAX_INVOCATIONS)) {
    throw parseError(`--invocation must be an integer in 1..${DELTA_MAX_INVOCATIONS}`);
  }
  if (values.result && invocation === null) throw parseError("--result requires --invocation <1-3>");
  const specIdentity = values["spec-identity"]?.trim() || null;
  if (!values.result && !specIdentity) throw parseError("--spec-identity <id> is required without --result");
  if (values.handback && !(values["act-list"] && values["site-coverage"] && !values.result)) throw parseError("--handback is the fixer handbackCheck flag: it requires --act-list and --site-coverage and refuses --result; the coordinator input run never passes it");
  if (values["act-list"] && !values.result && !values.handback && !values["findings-log"]) throw parseError("--findings-log <path> is required on the act-list input run: PRE-PUSH-DELTA-INPUT makes the reviewed round's angles part of the surface hints");
  if (values["act-list"] && !values.handback && !(values["fixer-plan"] && values["site-coverage"])) throw parseError("ACT review requires both --fixer-plan and --site-coverage");
  if (values["fixer-plan"] && values.handback) throw parseError("--fixer-plan is only for coordinator input/result runs");
  return {
    help: false,
    actList: values["act-list"] ?? null,
    threadsFile: values["threads-file"] ?? null,
    repo: values.repo ?? null,
    pr: values.pr ? Number(values.pr) : null,
    baseline,
    prHead,
    specIdentity,
    siteCoverage: values["site-coverage"] ?? null,
    fixerPlan: values["fixer-plan"] ?? null,
    findingsLog: values["findings-log"] ?? null,
    result: values.result ?? null,
    handback: values.handback === true,
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

export const DELTA_EVIDENCE_RULE = "Read patchPath with the read tool. Evidence is a file:line, or a test's path:line, read from disk. Run no tests, builds, or other command that mutates or executes anything; for a site query use only the shell-inert read/search commands the reviewer read-only gate allows (git grep, grep, rg).";

export const deltaPatchPath = (tmpRoot, baseline, candidate) => path.join(tmpRoot, "gate-delta", `${baseline}-${candidate}.patch`);

// The cumulative baseline..head patch the reviewer reads; formats pinned against operator git config.
function gitDiffPatch(worktree, baseline, head) {
  const out = spawnSync("git", ["-C", worktree, "-c", "core.quotePath=false", "diff", "--unified=3", "--diff-algorithm=myers", "-O/dev/null", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--no-renames", "--no-relative", "--ignore-submodules=none", `${baseline}..${head}`], {
    env: gitEnvNoDirOverrides(), maxBuffer: 1024 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`git diff ${baseline}..${head} failed in ${worktree}: ${out.error?.message ?? out.stderr.toString().trim()}`);
  return out.stdout;
}

function gitIsAncestor(worktree, ancestor, descendant) {
  const out = spawnSync("git", ["-C", worktree, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8", env: gitEnvNoDirOverrides(),
  });
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed in ${worktree}: ${out.stderr.trim()}`);
}

function gitChangedPaths(worktree, baseline, head) {
  const out = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", "--no-relative", "--no-ext-diff", `${baseline}..${head}`], {
    cwd: resolveRepoRoot(worktree), env: gitEnvNoDirOverrides(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`git diff changed paths failed: ${out.error?.message ?? out.stderr.trim()}`);
  return out.stdout.split("\0").filter(Boolean);
}

// Tracked-file hits of the sentences and identifiers the delta range removed, grepped at the candidate head.
// A git failure throws (fail closed), including a missing baseline or head object. The diff and grep
// formats are pinned so operator git config (prefix, color, external diff, textconv, algorithm, renames, path quoting, submodules, diff.orderFile via -O/dev/null, relative paths via --no-relative, hunk merging via --inter-hunk-context=0) cannot blank the check.
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
  const diff = git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-renames", "-O/dev/null", "--no-relative", "--inter-hunk-context=0", `${baseline}..${head}`);
  if (diff.status !== 0) throw new Error(`git diff ${baseline}..${head} failed in ${worktree}: ${diff.stderr.trim()}; the stale-surface check cannot read the delta range`);
  const grep = (needle, { word }) => {
    const out = git("grep", "-n", "-I", "--full-name", "-F", "--no-color", "--no-recurse-submodules", ...(word ? ["-w"] : []), "-e", needle, head);
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
// A log at an earlier head is accepted when the baseline is a base-only merge of it (the closure round after a cap round, ADR 0197); any error fails closed.
async function roundAnglesOf(findingsLogPath, baseline, { worktree, baseOnlyMerge }) {
  if (!findingsLogPath) return [];
  const log = JSON.parse(readFileSync(findingsLogPath, "utf8"));
  const perAngle = log?.provenance?.perAngle;
  const logHead = typeof log?.headSha === "string" ? log.headSha.trim().toLowerCase() : "";
  const sameHead = HEAD_SHA_RE.test(logHead) && (logHead.startsWith(baseline) || baseline.startsWith(logHead));
  const earlierHead = !sameHead && HEAD_SHA_RE.test(logHead)
    && await Promise.resolve().then(async () => {
      const { config, errors } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(worktree) });
      if (errors?.length) throw new Error(`.devloops failed to load (${errors.length} error(s)): the earlier-head findings log fails closed`);
      return baseOnlyMerge({ fromHead: logHead, head: baseline, mainRef: `origin/${resolveBaseBranch(config, { cwd: worktree })}`, repoRoot: worktree });
    }).catch(() => false);
  if (!sameHead && !earlierHead) {
    throw new Error(`--findings-log ${findingsLogPath} records head ${log?.headSha ?? "(none)"}, not the baseline ${baseline}: pass the findings log of the reviewed round`);
  }
  // An inline_single_agent round writes no provenance: take the angles of its findings.
  if (log.executionMode === "inline_single_agent" && !Array.isArray(perAngle)) {
    return [...new Set((Array.isArray(log.findings) ? log.findings : []).map((f) => f?.angle).filter((a) => typeof a === "string" && a.length > 0))];
  }
  if (!Array.isArray(perAngle) || perAngle.length === 0) throw new Error(`--findings-log ${findingsLogPath} has no non-empty provenance.perAngle: pass the reviewed gate round's findings log`);
  return perAngle.map((row) => row?.angle).filter((angle) => typeof angle === "string" && angle.length > 0);
}

async function authenticateCoverage(options, sequence, currentHead, raw, reportBytes, result, isAncestor) {
  const root = realpathSync(resolveGateArtifactTmpRoot(options.worktree));
  const planPath = realpathSync(options.fixerPlan), plan = JSON.parse(readFileSync(planPath, "utf8"));
  const order = plan.workOrder, origin = { workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity };
  const refuse = (condition, reason) => { if (!condition) throw new Error(`Delta coverage binding: ${reason}`); };
  const canonicalPlan = fixerPlanPath(plan.workOrderRef, root);
  refuse(canonicalPlan && planPath === path.resolve(canonicalPlan), "not the canonical current fixer plan");
  const branch = spawnSync("git", ["-C", options.worktree, "branch", "--show-current"], { encoding: "utf8", env: gitEnvNoDirOverrides() });
  const target = order?.target;
  refuse(order?.role === "fixer" && order.phase === "commit_only" && order.source === (options.threadsFile ? "threads" : "act-list")
    && order.headSha === sequence.reviewBaselineHead && target?.repo === order.mutationAuthority?.repo && target?.pr === order.mutationAuthority?.pr
    && (!options.repo || target.repo === options.repo) && (!options.pr || target.pr === options.pr)
    && branch.status === 0 && branch.stdout.trim() === order.mutationAuthority?.branch
    && plan.workOrderRef === `fixer:${target?.repo}#${target?.pr}:${sequence.reviewBaselineHead}:${plan.executionIdentity}`
    && workOrderDigest(order) === plan.workOrderDigest, "wrong role, target, phase, baseline, branch or semantic digest");
  const unit = await locateFixerUnit({ ref: plan.workOrderRef, cwd: options.worktree, tmpRoots: [root] });
  refuse(unit && !unit.stale && unit.executionIdentity === plan.executionIdentity, unit?.stale ?? "no current emitted unit");
  const dir = path.dirname(planPath), expectedOutput = path.join(dir, plan.executionIdentity, "fixer-disposition.json");
  const expectedPrompt = path.join(dir, "work-orders", `${plan.executionIdentity}.md`);
  refuse(realpathSync(options.siteCoverage) === expectedOutput && order.outputRefs?.length === 1
    && realpathSync(order.outputRefs[0]) === expectedOutput && realpathSync(plan.promptPath) === expectedPrompt, "noncanonical materialization or output path");
  const pull = await verifyPulledResult({ resultPath: expectedOutput, receiptTmpRoot: root, role: "fixer", ...origin });
  refuse(pull.ok, `pull/result verification failed: ${pull.reason}`);
  const subject = pull.receipt.subject;
  refuse(subject?.repo === target.repo && subject.pr === target.pr && subject.headSha === sequence.reviewBaselineHead
    && subject.branch === order.mutationAuthority.branch && subject.phase === "commit_only"
    && typeof subject.planPath === "string" && realpathSync(subject.planPath) === planPath, "wrong original pull subject");
  const renderedHash = materializationHash(readFileSync(expectedPrompt));
  refuse(renderedHash === plan.materializationHash && renderedHash === unit.materializationHash
    && renderedHash === pull.receipt.materializationHash, "materialization differs from actual bytes, renderer, plan or receipt");
  const sourcePath = options.threadsFile ?? options.actList;
  const actRead = order.requiredReads?.find((read) => read.kind === order.source);
  const actBytes = readFileSync(sourcePath);
  refuse(actRead && realpathSync(actRead.path) === realpathSync(sourcePath)
    && actRead.sha256 === sha256Hex(actBytes).slice(7) && order.authority?.sourceDigest === sha256Hex(JSON.parse(actBytes)).slice(7)
    && startDeltaSequence({ reviewBaselineHead: sequence.reviewBaselineHead, actList: options.threadsFile ? threadsToActList(JSON.parse(actBytes), { repo: options.repo, pr: options.pr }) : JSON.parse(actBytes) }).actSetId === sequence.actSetId, "changed ACT source or authority");
  refuse(raw.headSha === (result ? result.candidateHead : currentHead)
    && isAncestor(options.worktree, sequence.reviewBaselineHead, raw.headSha)
    && isAncestor(options.worktree, raw.headSha, currentHead), "handback candidate is not the reviewed contained commit");
  return options.threadsFile ? null : { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: sha256Hex(raw.siteCoverage).slice(7), handbackBytesDigest: sha256Hex(reportBytes).slice(7), origin };
}

export async function runCli(
  argv = process.argv.slice(2),
  { revParse = gitRevParse, diffPatch = gitDiffPatch, isAncestor = gitIsAncestor, staleSurface = gitStaleSurfaceHits, changedPaths = gitChangedPaths, validateChangelog: changelog = validateChangelog, baseOnlyMerge = isBaseOnlyMergeSince, stdout = process.stdout, tmpRoot } = {},
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
  // PRE-PUSH-DELTA-PUSH-AUTHORITY: the PR head moved since the gate round reviewed it (a stray push).
  if (options.prHead && revParse(options.worktree, options.prHead) !== sequence.reviewBaselineHead) {
    throw new Error(`PRE-PUSH-DELTA-PUSH-AUTHORITY: PR head ${options.prHead} is not the reviewed baseline ${sequence.reviewBaselineHead}; the PR head moved during the fix sequence, refresh and restart the gate round`);
  }
  const currentHead = revParse(options.worktree, "HEAD");
  // The CLI runs before the push, so the fix is unpushed by construction.
  const fixCommitted = currentHead !== sequence.reviewBaselineHead;
  const itemCounts = options.threadsFile ? { threadItemCount: sequence.actItems.length } : { actItemCount: sequence.actItems.length };
  if (resolveDeltaTrigger({ ...itemCounts, fixCommitted }) !== "delta") {
    if (fixCommitted) {
      // PRE-PUSH-DELTA-PUSH-AUTHORITY: an unpushed fix commit exists, so the marker stays and keeps guarding the push.
      throw new Error(`worktree HEAD ${currentHead} differs from the baseline ${sequence.reviewBaselineHead} but the ${options.threadsFile ? "thread" : "act"} list has no items: the delta review has nothing to check, and the sequence marker stays until the fix commit is pushed or the marker is deleted`);
    }
    // PRE-PUSH-DELTA-PUSH-AUTHORITY: the commit_only round ended without a fix commit, so its marker guards nothing and would only block later pushes.
    if (!options.fixerPlan) throw new Error(`worktree HEAD ${currentHead} equals the baseline: pass the current pulled --fixer-plan and --site-coverage to close its sequence`);
  }
  // The fixer's commit_only handback. Without it every act item with a site query reports a coverage gap.
  const result = options.result ? JSON.parse(readFileSync(options.result, "utf8")) : null;
  if (options.threadsFile && deltaCoverageBinding(result)) throw new Error("THREAD cannot opt into ACT coverage binding");
  let siteCoverage = [], validationCoverage = [], coverageBinding;
  if (options.siteCoverage) {
    const reportBytes = readFileSync(options.siteCoverage);
    const raw = JSON.parse(reportBytes);
    const record = normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
    if (options.fixerPlan && !options.result && !options.handback && (!fixCommitted || record.headSha !== currentHead)) {
      const planBytes = readFileSync(options.fixerPlan);
      await authenticateCoverage(options, sequence, raw.headSha, raw, reportBytes, { candidateHead: raw.headSha }, isAncestor);
      const root = tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree);
      const plan = JSON.parse(planBytes);
      const marker = readSequenceMarker(root, sequence.reviewBaselineHead);
      if (!readFileSync(options.fixerPlan).equals(planBytes) || !marker || marker.branch !== plan.workOrder.mutationAuthority.branch || marker.fullGranted) throw new Error("sequence closure requires the matching active commit_only branch marker");
      clearSequenceMarker(root, sequence.reviewBaselineHead);
      const payload = { ok: true, outcome: fixCommitted ? "head_moved" : "no_commit", nextStep: "push_to_gate", reviewBaselineHead: sequence.reviewBaselineHead, candidateHead: currentHead };
      process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, fields: options.fields, stdout });
      return payload;
    }
    if (!isAncestor(options.worktree, sequence.reviewBaselineHead, currentHead)) {
      throw new Error(`baseline ${sequence.reviewBaselineHead} is not an ancestor of worktree HEAD ${currentHead}: the delta range must extend the reviewed head`);
    }
    if (record.headSha !== currentHead && !options.result) {
      throw new Error(`site coverage record names head ${record.headSha}, not the worktree HEAD ${currentHead}: the fixer must record coverage for its latest commit`);
    }
    if (!options.result) {
      const gaps = siteCoverageGaps(sequence.actItems, record.siteCoverage);
      if (gaps.length > 0) throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: the disposition handoff leaves site coverage incomplete: ${gaps.join("; ")}`);
    }
    // Only the validation view discards stale coverage; the reviewed raw identity stays bound.
    if (options.fixerPlan && !options.threadsFile) coverageBinding = await authenticateCoverage(options, sequence, currentHead, raw, reportBytes, result, isAncestor);
    siteCoverage = options.fixerPlan && !options.threadsFile ? raw.siteCoverage : record.headSha === currentHead ? record.siteCoverage ?? [] : [];
    validationCoverage = record.headSha === currentHead ? record.siteCoverage ?? [] : [];
  }
  if (!options.siteCoverage && !isAncestor(options.worktree, sequence.reviewBaselineHead, currentHead)) {
    throw new Error(`baseline ${sequence.reviewBaselineHead} is not an ancestor of worktree HEAD ${currentHead}: the delta range must extend the reviewed head`);
  }
  // A custom `staleSurface` may return the hits array alone.
  const stale = staleSurface(options.worktree, sequence.reviewBaselineHead, currentHead);
  const staleSurfaceHits = Array.isArray(stale) ? stale : stale.hits;
  const staleSurfaceTruncated = Array.isArray(stale) ? false : stale.truncated === true;
  const truncatedNeedles = Array.isArray(stale) ? [] : stale.truncatedNeedles ?? [];
  let payload;
  if (options.result) {
    // A truncated hit list blocks locally_clear until a finding or a skipped site names the gap.
    const decision = decideDeltaNextStep({
      sequence, result, invocation: options.invocation, currentHead, siteCoverage, validationCoverage, coverageBinding,
      staleSurfaceHits: staleSurfaceTruncated ? [...staleSurfaceHits, staleSurfaceTruncatedHit()] : staleSurfaceHits,
    });
    if (changedPaths(options.worktree, sequence.reviewBaselineHead, currentHead).some((file) => file.startsWith("changes/"))) {
      const diagnostics = [];
      const log = { log: (...args) => diagnostics.push(args.join(" ")), error: (...args) => diagnostics.push(args.join(" ")) };
      let code;
      try {
        const root = resolveRepoRoot(options.worktree);
        const exec = promisify(execFile);
        const git = createGitClient(root, (command, args, options) => exec(command, args, { ...options, env: gitEnvNoDirOverrides() }));
        code = await changelog({ root, git, log, requireHeadInputs: true });
      } catch (error) {
        diagnostics.push(error.message);
        code = 1;
      }
      if (code !== 0) throw new Error(`LIFECYCLE-CHANGELOG-COMPLETENESS: ${diagnostics.join("; ")}`);
    }
    // Local evidence for the emitter and the fixed-reply guard; never a gate verdict.
    writeGateDeltaRecord({
      tmpRoot: tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree),
      sequence, candidateHead: currentHead, invocation: options.invocation, decision, result,
    });
    payload = { ok: true, ...decision };
  } else {
    const patchPath = deltaPatchPath(tmpRoot ?? resolveGateArtifactTmpRoot(options.worktree), sequence.reviewBaselineHead, currentHead);
    if (!options.handback) { // the fixer handbackCheck stays write-free
      mkdirSync(path.dirname(patchPath), { recursive: true });
      writeFileSync(patchPath, diffPatch(options.worktree, sequence.reviewBaselineHead, currentHead));
    }
    payload = { ok: true, input: { ...(options.handback ? {} : { patchPath, evidenceRule: DELTA_EVIDENCE_RULE }), ...buildDeltaInput({ sequence, candidateHead: currentHead, specIdentity: options.specIdentity, siteCoverage, coverageBinding, roundAngles: await roundAnglesOf(options.findingsLog, sequence.reviewBaselineHead, { worktree: options.worktree, baseOnlyMerge }), staleSurfaceHits, staleSurfaceTruncated, truncatedNeedles }) } };
  }
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, fields: options.fields, stdout });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  }
}
