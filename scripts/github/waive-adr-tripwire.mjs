#!/usr/bin/env node
/**
 * waive-adr-tripwire — the sanctioned writer of the ADR tripwire waiver
 * (ADR-TRIPWIRE-STANDING-WAIVER). It writes one head-pinned
 * `adr-tripwire:allow standing-authorization ...` line into the PR body through
 * edit-pr.mjs, and only when a standing authorization is in force on the
 * default branch and every eligibility check passes. Any failed check refuses
 * with a typed reason and leaves the body unchanged. The scope is fixed here;
 * the standing authorization record carries no scope field.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson } from "@dev-loops/core/github/gh";
import { extractClosingIssueNumbers } from "@dev-loops/core/github/closing-ref-guard";
import { detectAcDodMatrix } from "@dev-loops/core/loop/issue-refinement-artifact";
import { computeSpecDigest, requireSpecFromBody } from "@dev-loops/core/loop/spec-authority";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { evaluateAdrTripwire as realEvaluateAdrTripwire } from "../loop/check-adr-tripwire.mjs";
import { buildStandingWaiverLine, replaceStandingWaiverLine } from "../loop/adr-waiver-markers.mjs";
import { readStandingAuthorization as realReadStandingAuthorization } from "../loop/standing-authorization.mjs";
import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { fetchIssueBody as realFetchIssueBody } from "../loop/detect-issue-refinement-artifact.mjs";
import { fetchDraftGateEvidence as realFetchDraftGateEvidence } from "./_gate-finding-surface.mjs";
import { buildLogPath } from "./_gate-artifact-paths.mjs";
import { editPr as realEditPr } from "./edit-pr.mjs";

const USAGE = `Usage: waive-adr-tripwire.mjs --repo <owner/name> --pr <number>
Write the head-pinned ADR tripwire waiver into the PR body (ADR-TRIPWIRE-STANDING-WAIVER).
The only sanctioned writer of an \`adr-tripwire:allow\` line: edit-pr.mjs and
create-pr.mjs refuse a hand-written one. It applies the waiver only when:
  - a standing authorization (.devloops standingAuthorizations.adrTripwireWaiver
    on origin/<defaultBranch>) is in force (present, well-formed, at most 90 days,
    not expired);
  - the PR body links exactly one tracker issue (Closes/Fixes) and is not on the
    lightweight pr_body path;
  - the ADR tripwire blocks, and every trigger is a skills/docs/*-contract.md path;
  - every triggering path appears, backticked, in a row of the linked issue's AC / DoD matrix;
  - the current head has a clean draft_gate verdict whose recorded specDigest
    equals the specDigest of the linked issue's current body.
Otherwise it refuses with a typed reason and leaves the body unchanged. It never
waives an extension-defaults.yaml trigger, a rule-modality reversal or removal,
an unresolvable scan, a standingAuthorizations change, or any other approval.
Required:
  --repo <owner/name>   Repository slug
  --pr <number>         Pull request number
Output (stdout, JSON):
  { "ok": true, "action": "waiver_written", "repo", "pr", "head", "issue", "line" }
Refusal (stderr, JSON, exit 1; a thrown gh or git failure is reason "writer_error"):
  { "ok": false, "refused": true, "reason": "<code>", "detail": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);

export function parseWaiveAdrTripwireCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, pr: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, pr: undefined, jq: undefined, silent: false };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || options.pr === undefined) throw parseError("waive-adr-tripwire requires --repo and --pr");
  parseRepoSlug(options.repo);
  return options;
}

const refuse = (reason, detail, extra = {}) => ({ ok: false, refused: true, reason, detail, ...extra });

async function defaultFetchPr({ repo, pr }, { env, ghCommand, runChild }) {
  return ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "body,headRefOid,baseRefName,closingIssuesReferences"], { env, ghCommand, runChild });
}

async function defaultReadRecordedSpecDigest({ repo, pr, headSha, repoRoot }) {
  const ledgerPath = buildLogPath({ repo, pr, gate: "draft_gate", headSha, tmpRoot: resolveGateArtifactTmpRoot(repoRoot) });
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    return typeof ledger?.specAuthority?.specDigest === "string" ? ledger.specAuthority.specDigest : null;
  } catch {
    return null;
  }
}

/** Every trigger path must appear, backticked, in some row of the issue's valid AC / DoD matrix. */
function pathsMissingFromMatrix(paths, issueBody) {
  const matrix = detectAcDodMatrix(issueBody);
  if (!matrix.found || !matrix.valid) return { matrixInvalid: true, missing: paths };
  const missing = paths.filter((p) => !matrix.rows.some((row) => `${row.criterion}\n${row.evidence}`.includes(`\`${p}\``)));
  return { matrixInvalid: false, missing };
}

export async function waiveAdrTripwire(options, {
  env = process.env,
  ghCommand = "gh",
  repoRoot = process.cwd(),
  runChild = defaultRunChild,
  now = new Date(),
  readStandingAuthorization = realReadStandingAuthorization,
  fetchPr = defaultFetchPr,
  fetchIssueBody = realFetchIssueBody,
  evaluateAdrTripwire = realEvaluateAdrTripwire,
  fetchDraftGateEvidence = realFetchDraftGateEvidence,
  readRecordedSpecDigest = defaultReadRecordedSpecDigest,
  editPr = realEditPr,
} = {}) {
  const { repo, pr } = options;
  const gh = { env, ghCommand, runChild };

  const authorization = readStandingAuthorization({ repoRoot, now });
  if (!authorization.inForce) {
    return refuse("no_standing_authorization", `no standing authorization is in force (${authorization.state}: ${authorization.detail})`, { state: authorization.state });
  }

  const prState = await fetchPr({ repo, pr }, gh);
  const headSha = typeof prState?.headRefOid === "string" ? prState.headRefOid.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !prState?.baseRefName) return refuse("pr_state_unreadable", `cannot read PR #${pr} head and base`);
  const body = typeof prState.body === "string" ? prState.body : "";

  // A closing reference into another repo is not a link to this repo's tracker issue.
  const refRepo = (n) => n?.repository?.nameWithOwner ?? (n?.repository?.owner?.login && n?.repository?.name ? `${n.repository.owner.login}/${n.repository.name}` : null);
  const sameRepo = (r) => r === null || r.toLowerCase() === repo.toLowerCase();
  const crossRepoBody = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+([\w.-]+\/[\w.-]+)#\d+/giu)].some((m) => !sameRepo(m[1]));
  const closingNodes = prState.closingIssuesReferences?.nodes ?? prState.closingIssuesReferences ?? [];
  if (crossRepoBody || closingNodes.some((n) => !sameRepo(refRepo(n)))) {
    return refuse("not_exactly_one_tracker_issue", `PR #${pr} closes an issue in another repository; exactly one tracker issue in ${repo} is required`);
  }
  const bodyIssues = extractClosingIssueNumbers(body);
  const linkedIssues = (prState.closingIssuesReferences?.nodes ?? prState.closingIssuesReferences ?? []).map((n) => n?.number).filter(Number.isInteger);
  if (bodyIssues.length === 0) {
    return refuse("lightweight_pr_body_path", `PR #${pr} links no tracker issue (a lightweight pr_body PR is not eligible)`);
  }
  if (bodyIssues.length !== 1 || (linkedIssues.length > 0 && (linkedIssues.length !== 1 || linkedIssues[0] !== bodyIssues[0]))) {
    return refuse("not_exactly_one_tracker_issue", `PR #${pr} must link exactly one canonical tracker issue via Closes/Fixes (body: ${bodyIssues.join(", ")}; GitHub: ${linkedIssues.join(", ") || "none"})`);
  }
  const issue = bodyIssues[0];

  const tripwire = await evaluateAdrTripwire({ base: `origin/${prState.baseRefName}`, head: headSha, prBody: body, repoRoot, env, now });
  if (tripwire.outcome !== "block") {
    return refuse("tripwire_not_blocking", `the ADR tripwire does not block PR #${pr} at head ${headSha.slice(0, 7)} (satisfiedBy: ${tripwire.satisfiedBy ?? "no trigger"}); nothing to waive`);
  }
  const ineligible = tripwire.triggers.filter((t) => t.type !== "contract-doc");
  if (ineligible.length > 0) {
    return refuse("ineligible_trigger", `the standing authorization waives only skills/docs/*-contract.md triggers; found: ${ineligible.map((t) => `${t.type} ${t.path}${t.ruleId ? ` (${t.ruleId})` : ""}`).join("; ")}`, { triggers: ineligible });
  }
  const paths = [...new Set(tripwire.triggers.map((t) => t.path))].sort();

  const issueBody = await fetchIssueBody({ repo, issue }, { env, ghCommand, runChild });
  const { matrixInvalid, missing } = pathsMissingFromMatrix(paths, issueBody);
  if (matrixInvalid) return refuse("issue_matrix_invalid", `linked issue #${issue} has no valid AC / DoD matrix`);
  if (missing.length > 0) {
    return refuse("contract_doc_not_in_matrix", `contract doc(s) not named as a backticked path in a row of issue #${issue}'s AC / DoD matrix: ${missing.join(", ")}`, { missing });
  }

  const gate = await fetchDraftGateEvidence({ repo, pr, headSha }, gh);
  if (!gate?.currentHeadClean) {
    return refuse("no_clean_draft_gate", `no clean draft_gate checkpoint verdict on the current head ${headSha.slice(0, 7)}`);
  }
  let currentSpecDigest;
  try {
    currentSpecDigest = computeSpecDigest(requireSpecFromBody(issueBody));
  } catch (error) {
    return refuse("spec_unreadable", `cannot derive the spec digest of issue #${issue}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const recorded = await readRecordedSpecDigest({ repo, pr, headSha, repoRoot });
  if (recorded === null) return refuse("spec_digest_unrecorded", `the draft_gate for head ${headSha.slice(0, 7)} recorded no specDigest`);
  if (recorded !== currentSpecDigest) {
    return refuse("spec_digest_mismatch", `the draft_gate recorded specDigest ${recorded}, but issue #${issue} now yields ${currentSpecDigest}`);
  }

  const { record } = authorization;
  const line = buildStandingWaiverLine({ head: headSha, issue, grantedBy: record.grantedBy, expires: record.expires, paths });
  const nextBody = replaceStandingWaiverLine(body, line);
  // The tripwire is first-marker-wins: an earlier bare marker can mask the new line.
  const effective = await evaluateAdrTripwire({ base: `origin/${prState.baseRefName}`, head: headSha, prBody: nextBody, repoRoot, env, now });
  if (effective.outcome === "block") {
    return refuse("waiver_ineffective", `the standing-authorization line would not waive the tripwire at head ${headSha.slice(0, 7)} (another adr-tripwire:allow line in the body likely masks it); remove that line in the GitHub UI and re-run`);
  }
  await editPr(
    { repo, pr, body: nextBody, addAssignees: [], removeAssignees: [] },
    { env, ghCommand, run: runChild, waiverWriter: true, currentBody: body },
  );
  return { ok: true, action: "waiver_written", repo, pr, head: headSha, issue, line };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...runtime } = {}) {
  let options;
  try {
    options = parseWaiveAdrTripwireCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
  let result;
  try {
    result = await waiveAdrTripwire(options, runtime);
  } catch (error) {
    stderr.write(`${JSON.stringify(refuse("writer_error", error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
  if (!result.ok) {
    stderr.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
