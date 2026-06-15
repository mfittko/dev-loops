#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText, summarizeGateReviewComments, summarizeGateReviewCommentMarkers } from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";

const USAGE = `Usage: ready-for-review.mjs --repo <owner/name> --pr <number>\nWrapper around gh pr ready that enforces gate-evidence validation.`;
const parseError = buildParseError(USAGE);
const PR_VIEW_QUERY = `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { id, isDraft, headRefOid, state, mergeStateStatus } } }`;

export function parseReadyForReviewCliArgs(argv) {
  const args = [...argv], opts = { help: false, repo: undefined, pr: undefined };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") { opts.help = true; return opts; }
    if (token === "--repo") { opts.repo = requireOptionValue(args, "--repo", parseError).trim(); continue; }
    if (token === "--pr") { opts.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError); continue; }
    throw parseError(`Unknown argument: ${token}`);
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
  return { id: d.id, isDraft: d.isDraft === true, headRefOid: typeof d.headRefOid === "string" ? d.headRefOid.trim() : null, state: typeof d.state === "string" ? d.state.trim() : null, mergeStateStatus: typeof d.mergeStateStatus === "string" ? d.mergeStateStatus.trim() : null };
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

async function fetchGateEvidence({ repo, pr, headSha }, { env, ghCommand }) {
  const r = await runChild(ghCommand, ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`], env);
  if (r.code !== 0) throw new Error(`Failed to fetch PR comments`);
  const raw = parseJsonText(r.stdout), comments = Array.isArray(raw) ? (raw.every(e=>Array.isArray(e)) ? raw.flat() : raw) : [];
  const cs = summarizeGateReviewComments(comments), ms = summarizeGateReviewCommentMarkers(comments, { headSha });
  const dg = cs.draft_gate ? { ...cs.draft_gate, visible: true } : { visible: false };
  const dm = ms.draft_gate ? { ...ms.draft_gate, visible: true, contractComplete: ms.draft_gate.contractComplete === true } : { visible: false, contractComplete: false };
  const mh = dm.headSha && headSha && headSha.startsWith(dm.headSha);
  const chc = dm.visible && mh && dm.verdict === "clean" && dm.contractComplete;
  const cee = dg.visible && dg.verdict === "clean" && dg.headSha;
  const cphm = !chc && dg.headSha && headSha && headSha.startsWith(dg.headSha) && dg.verdict === "clean";
  return { draftGate: dg, draftGateMarker: dm, currentHeadClean: chc, cleanEvidenceExists: cee, effectiveHeadClean: chc || cphm };
}

export async function readyForReview(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const draftGateConfig = resolveGateConfig(config, "draft");
  const requireCi = draftGateConfig?.requireCi !== false;
  const prState = await fetchPrState({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const headSha = prState.headRefOid;
  if (!headSha) throw new Error(`Could not resolve head SHA`);
  if (!prState.isDraft) throw new Error(`PR #${options.pr} is not in draft state`);
  if (requireCi) { const ci = await fetchCiStatus({ repo: options.repo, pr: options.pr }, { env, ghCommand }); if (ci.status === "blocked") throw new Error(`PR #${options.pr} has blocking CI checks`); if (ci.status !== "success") throw new Error(`PR #${options.pr} CI is not green`); }
  const gate = await fetchGateEvidence({ repo: options.repo, pr: options.pr, headSha }, { env, ghCommand });
  if (!gate.cleanEvidenceExists && !gate.effectiveHeadClean) throw new Error(`No visible clean draft_gate evidence on ${headSha.slice(0,7)}`);
  if (!gate.effectiveHeadClean) { const mv = gate.draftGateMarker?.visible; const mh = gate.draftGateMarker?.headSha; throw new Error(mv && mh ? `PR #${options.pr} draft_gate marker does not match current head ${headSha.slice(0,7)}. Re-run draft gate.` : `PR #${options.pr} draft_gate marker is missing or incomplete on current head ${headSha.slice(0,7)}. Re-run draft gate.`); }
  const readyResult = await runChild(ghCommand, ["pr", "ready", String(options.pr), "--repo", options.repo], env);
  if (readyResult.code !== 0) throw new Error(`gh pr ready failed`);
  return { ok: true, action: "marked_ready", repo: options.repo, pr: options.pr, headSha, draftGateSatisfied: gate.effectiveHeadClean };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseReadyForReviewCliArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const result = await readyForReview(options, runtime);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  main().then(c => { process.exitCode = c; }).catch(e => { process.stderr.write(`${formatCliError(e, { usage: USAGE })}\n`); process.exitCode = 1; });
}
