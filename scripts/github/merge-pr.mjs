#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson as defaultGhJson } from "@dev-loops/core/github/gh";
import { loadDevLoopConfig, resolveEffectiveMergeAuthorizedFromLoad } from "@dev-loops/core/config";
import { resolveHumanReviewDecision, countUnresolvedHumanChangesRequested } from "@dev-loops/core/loop/size-budget-merge-gate";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import { evaluateMergePreconditions, resolveCiGreenFromRollup, isValidGithubLogin } from "@dev-loops/core/loop/merge-approval";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const VALID_METHODS = new Set(["squash", "merge", "rebase"]);

const USAGE = `Usage: merge-pr.mjs --repo <owner/name> --pr <number> --human-approved-by <github-login>
                   [--method squash|merge|rebase] [--stable-release]

Sanctioned dev-loops merge wrapper (issue #1939). Runs the FULL merge-precondition
set fail-closed, then performs the merge. Raw \`gh pr merge\` is forbidden — route
every merge through this wrapper. This wrapper NEVER tags or publishes and NEVER
satisfies the operator-owned stable-release approval gate: it only merges the PR
into its base.

Required:
  --repo <owner/name>          Repository slug
  --pr <number>                Pull request number
  --human-approved-by <login>  The human approver's GitHub login. Validated as a
                               real login (not a boolean or free text). Stamped on
                               the machine-readable result and audit trail.

Optional:
  --method <m>                 Merge method: squash (default) | merge | rebase
  --stable-release             Mark this as a stable-release merge, forcing the
                               escalated approval class (a standing authorization
                               never satisfies it). Does NOT tag or publish.

Preconditions (each refuses with a machine-readable reason naming the failing one):
  human_approver, mergeable, ci_green, title_markers, gate_evidence,
  size_budget_human_approval, merge_approval. gate_evidence reuses
  detect-checkpoint-evidence (draft_gate + current-head pre_approval_gate with
  fan-out provenance, zero unresolved threads, a non-stale/non-foreign runner lock).

Merge classes:
  drain      normal merge — satisfied by a recorded standing authorization
             (autonomy.humanMergeOnly:false) OR a fresh operator approval.
  escalated  size escalate/block, T1-touching, or --stable-release — requires a
             fresh per-merge operator approval; a standing authorization does not
             satisfy it. Fresh approval = a head-pinned APPROVED review by
             <login>, else a head-pinned operator comment "approve merge <headSha>".

Output (stdout, JSON): { ok, merged, mergeCommit, approvedBy, mergeClass, approvalVia, method, repo, pr, headSha }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Merge succeeded
  1  Argument error, gh failure, or a failed precondition
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

export function parseMergePrCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "human-approved-by": { type: "string" },
      method: { type: "string" },
      "stable-release": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, pr: undefined, humanApprovedBy: undefined, method: "squash", stableRelease: false };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (token.name === "human-approved-by") { options.humanApprovedBy = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "method") { options.method = requireTokenValue(token, parseError).trim().toLowerCase(); continue; }
    if (token.name === "stable-release") { options.stableRelease = true; continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("merge-pr requires both --repo <owner/name> and --pr <number>");
  }
  if (options.humanApprovedBy === undefined || options.humanApprovedBy === "") {
    throw parseError("merge-pr requires --human-approved-by <github-login> (fail-closed: a merge cannot proceed without a recorded human approver)");
  }
  if (!isValidGithubLogin(options.humanApprovedBy)) {
    throw parseError(`--human-approved-by must be a real GitHub login, got "${options.humanApprovedBy}"`);
  }
  if (!VALID_METHODS.has(options.method)) {
    throw parseError(`--method must be one of squash|merge|rebase, got "${options.method}"`);
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// Flatten a `gh api --paginate --slurp` payload (array of per-page arrays) into
// a single flat array; a non-paginated array passes through unchanged.
function flattenSlurp(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.every((entry) => Array.isArray(entry)) ? payload.flat() : payload;
}

// Default gate-evidence probe: shell the sanctioned detect-checkpoint-evidence
// CLI and read its verdict. It is the single source of truth for draft_gate /
// current-head pre_approval_gate verdicts, unresolved threads, the runner lock,
// and fan-out provenance — reused wholesale (non-goal: do not re-derive the set).
const DETECT_EVIDENCE_PATH = fileURLToPath(new URL("./detect-checkpoint-evidence.mjs", import.meta.url));
function defaultDetectEvidence({ repo, pr, env, cwd }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DETECT_EVIDENCE_PATH, "--repo", repo, "--pr", String(pr)],
      { env, cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let parsed = null;
        try { parsed = JSON.parse(error ? stderr : stdout); } catch { parsed = null; }
        // A zero exit with unparseable output must NOT pass as satisfied evidence:
        // we could no longer read the size-budget outcome (which sets the merge
        // class), so treat it as a gate_evidence failure and fail closed.
        const ok = !error && parsed !== null;
        const size = parsed?.preApprovalGate ?? {};
        const failures = Array.isArray(parsed?.preMergeGateCheck?.failures)
          ? parsed.preMergeGateCheck.failures
          : parsed?.error
            ? [parsed.error]
            : ok
              ? []
              : ["detect-checkpoint-evidence output could not be read"];
        resolve({
          ok,
          sizeOutcome: typeof size.sizeOutcome === "string" ? size.sizeOutcome : null,
          touchesT1: size.sizeTouchesT1 === true,
          currentHeadSha: typeof parsed?.currentHeadSha === "string" ? parsed.currentHeadSha : null,
          failures,
        });
      },
    );
  });
}

export async function mergePr(options, runtime = {}) {
  const {
    env = process.env,
    ghCommand = "gh",
    cwd = process.cwd(),
    ghJson = defaultGhJson,
    runChild = defaultRunChild,
    detectEvidence = defaultDetectEvidence,
    loadConfig = loadDevLoopConfig,
  } = runtime;

  const prView = await ghJson(
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "mergeable,mergeStateStatus,title,headRefOid,url,statusCheckRollup"],
    { env, ghCommand, runChild },
  );
  const currentHeadSha = typeof prView?.headRefOid === "string" && prView.headRefOid.trim().length > 0 ? prView.headRefOid.trim() : null;
  if (!currentHeadSha) throw new Error("Invalid gh pr view payload: missing headRefOid");

  const rawReviews = flattenSlurp(await ghJson(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/pulls/${options.pr}/reviews?per_page=100`],
    { env, ghCommand, runChild },
  )).map((r) => ({ login: r?.user?.login ?? null, state: r?.state ?? null, commit_id: r?.commit_id ?? null }));
  const comments = flattenSlurp(await ghJson(
    ["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`],
    { env, ghCommand, runChild },
  )).map((c) => ({ login: c?.user?.login ?? null, body: c?.body ?? "" }));

  const evidence = await detectEvidence({ repo: options.repo, pr: options.pr, env, cwd });
  const configLoad = await loadConfig({ repoRoot: resolveRepoRoot(cwd) });
  const standingAuthorized = resolveEffectiveMergeAuthorizedFromLoad(true, configLoad);

  const verdict = evaluateMergePreconditions({
    humanApprovedBy: options.humanApprovedBy,
    mergeable: typeof prView?.mergeable === "string" ? prView.mergeable : null,
    mergeStateStatus: typeof prView?.mergeStateStatus === "string" ? prView.mergeStateStatus : null,
    ciGreen: resolveCiGreenFromRollup(prView?.statusCheckRollup),
    title: typeof prView?.title === "string" ? prView.title : null,
    gateEvidence: { ok: evidence.ok === true, failures: evidence.failures },
    sizeOutcome: evidence.sizeOutcome,
    touchesT1: evidence.touchesT1,
    humanReviewDecision: resolveHumanReviewDecision(rawReviews),
    unresolvedChangesRequestedCount: countUnresolvedHumanChangesRequested(rawReviews),
    currentHeadSha,
    reviews: rawReviews,
    comments,
    standingAuthorized,
    stableRelease: options.stableRelease === true,
  });

  if (!verdict.ok) {
    const error = new Error(`Merge preconditions not satisfied: ${verdict.failures.map((f) => `${f.precondition} (${f.reason})`).join("; ")}`);
    error.mergePrFailure = {
      ok: false,
      merged: false,
      repo: options.repo,
      pr: options.pr,
      headSha: currentHeadSha,
      approvedBy: options.humanApprovedBy,
      mergeClass: verdict.mergeClass,
      failures: verdict.failures,
    };
    throw error;
  }

  // All preconditions satisfied — perform the merge. NEVER a tag or publish.
  await runChild(ghCommand, ["pr", "merge", String(options.pr), "--repo", options.repo, `--${options.method}`], { env });
  const merged = await ghJson(
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "mergeCommit,state"],
    { env, ghCommand, runChild },
  );

  return {
    ok: true,
    merged: String(merged?.state ?? "").toUpperCase() === "MERGED",
    mergeCommit: typeof merged?.mergeCommit?.oid === "string" ? merged.mergeCommit.oid : null,
    approvedBy: options.humanApprovedBy,
    mergeClass: verdict.mergeClass,
    approvalVia: verdict.approvalVia,
    method: options.method,
    repo: options.repo,
    pr: options.pr,
    headSha: currentHeadSha,
  };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  let options;
  try {
    options = parseMergePrCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await mergePr(options, runtime);
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (error) {
    if (error && typeof error === "object" && error.mergePrFailure) {
      stderr.write(`${JSON.stringify({ ...error.mergePrFailure, error: error.message })}\n`);
      return 1;
    }
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
