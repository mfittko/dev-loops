#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { fetchDraftGateEvidence } from "./_gate-finding-surface.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";
import { findBlockingTitleMarkers } from "@dev-loops/core/loop/pr-title-markers";
import { syncBoardStatus as realSyncBoardStatus, loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: ready-for-review.mjs --repo <owner/name> --pr <number>\nWrapper around gh pr ready that enforces gate-evidence validation.\n\n${JQ_OUTPUT_USAGE}`;
const parseError = buildParseError(USAGE);
const PR_VIEW_QUERY = `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { id, isDraft, headRefOid, state, mergeStateStatus, title, closingIssuesReferences(first:10){ nodes{ number } } } } }`;

export function parseReadyForReviewCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, pr: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const opts = { help: false, repo: undefined, pr: undefined };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { opts.help = true; return opts; }
    if (token.name === "repo") { opts.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { opts.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (matchJqOutputToken(token, opts, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!opts.repo || opts.pr === undefined) throw parseError("ready-for-review requires --repo and --pr");
  parseRepoSlug(opts.repo);
  return opts;
}

async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) throw new Error(`gh command failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  return parseJsonText(result.stdout);
}

async function fetchPrState({ repo, pr }, { env, ghCommand }) {
  const [owner, name] = repo.split("/");
  const r = await runGhJson(["api", "graphql", "-f", `query=${PR_VIEW_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`], { env, ghCommand });
  const d = r?.data?.repository?.pullRequest;
  if (!d) throw new Error(`Could not fetch PR #${pr}`);
  const closingIssues = (d.closingIssuesReferences?.nodes ?? [])
    .map((n) => n?.number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return { id: d.id, isDraft: d.isDraft === true, headRefOid: typeof d.headRefOid === "string" ? d.headRefOid.trim() : null, state: typeof d.state === "string" ? d.state.trim() : null, mergeStateStatus: typeof d.mergeStateStatus === "string" ? d.mergeStateStatus.trim() : null, title: typeof d.title === "string" ? d.title : null, closingIssues };
}

async function fetchCiStatus({ repo, pr }, { env, ghCommand }) {
  const result = await runChild(ghCommand, ["pr", "checks", String(pr), "--repo", repo, "--json", "bucket,state,name,workflow"], env);
  if (result.code !== 0 && result.code !== 1 && result.code !== 8) throw new Error(`gh pr checks failed`);
  const stdout = result.stdout.trim();
  if (!stdout) return { status: "none" };
  const payload = parseJsonText(stdout);
  if (!Array.isArray(payload)) return { status: "none" };
  const buck = (c = {}) => { const b = typeof c?.bucket === "string" ? c.bucket.trim().toLowerCase() : ""; if (b) return b; const s = typeof c?.state === "string" ? c.state.trim().toLowerCase() : ""; if (["success","passed","pass"].includes(s)) return "pass"; if (["skipped","skipping"].includes(s)) return "skipping"; if (["pending","queued","in_progress","waiting"].includes(s)) return "pending"; if (["failure","failed","fail","error","timed_out","startup_failure"].includes(s)) return "fail"; if (["cancel","cancelled"].includes(s)) return "cancel"; return s||"unknown"; };
  const checks = payload.map(c => ({ bucket: buck(c) }));
  const blocking = checks.filter(c => !["pass","skipping"].includes(c.bucket));
  return { status: blocking.length === 0 ? "success" : "blocked", blockingSummary: blocking.length > 0 ? `Blocking: ${blocking.map(c=>c.bucket).join(", ")}` : null };
}

export async function readyForReview(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), syncBoardStatus = realSyncBoardStatus } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const draftGateConfig = resolveGateConfig(config, "draft");
  const requireCi = draftGateConfig?.requireCi !== false;
  const prState = await fetchPrState({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const headSha = prState.headRefOid;
  if (!headSha) throw new Error(`Could not resolve head SHA`);
  if (!prState.isDraft) throw new Error(`PR #${options.pr} is not in draft state`);
  const titleMarkers = findBlockingTitleMarkers(prState.title);
  if (titleMarkers.length > 0) throw new Error(`PR #${options.pr} cannot be marked ready: title contains merge-blocking marker(s): ${titleMarkers.join(", ")}. Remove them from the title first.`);
  if (requireCi) { const ci = await fetchCiStatus({ repo: options.repo, pr: options.pr }, { env, ghCommand }); if (ci.status === "blocked") throw new Error(`PR #${options.pr} has blocking CI checks`); if (ci.status !== "success") throw new Error(`PR #${options.pr} CI is not green`); }
  const gate = await fetchDraftGateEvidence({ repo: options.repo, pr: options.pr, headSha }, { env, ghCommand });
  if (!gate.cleanEvidenceExists && !gate.effectiveHeadClean) throw new Error(`No visible clean draft_gate evidence on ${headSha.slice(0,7)}`);
  if (!gate.effectiveHeadClean) { const mv = gate.draftGateMarker?.visible; const mh = gate.draftGateMarker?.headSha; throw new Error(mv && mh ? `PR #${options.pr} draft_gate marker does not match current head ${headSha.slice(0,7)}. Re-run draft gate.` : `PR #${options.pr} draft_gate marker is missing or incomplete on current head ${headSha.slice(0,7)}. Re-run draft gate.`); }
  const readyResult = await runChild(ghCommand, ["pr", "ready", String(options.pr), "--repo", options.repo], env);
  if (readyResult.code !== 0) throw new Error(`gh pr ready failed`);
  // #1069: couple the In-Progress board move to the ready transition. Best-effort
  // and NON-FATAL — a board failure must NEVER block or fail marking ready.
  let boardSync;
  try {
    const inProgressColumn = loadStateColumnMap(repoRoot).columnNames[LOGICAL_COLUMN.IN_PROGRESS];
    const targets = prState.closingIssues.length > 0 ? prState.closingIssues : [options.pr];
    boardSync = [];
    for (const target of targets) {
      boardSync.push(await syncBoardStatus(options.repo, repoRoot, target, inProgressColumn, env, {}));
    }
  } catch (err) {
    boardSync = [{ ok: true, skipped: true, reason: err?.message ?? "board sync failed" }];
  }
  return { ok: true, action: "marked_ready", repo: options.repo, pr: options.pr, headSha, draftGateSatisfied: gate.effectiveHeadClean, boardSync };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseReadyForReviewCliArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const result = await readyForReview(options, runtime);
  return emitResult(result, { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then(c => { process.exitCode = c; }).catch(e => { process.stderr.write(`${formatCliError(e, { usage: USAGE })}\n`); process.exitCode = 1; });
}
