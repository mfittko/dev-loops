#!/usr/bin/env node
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
  summarizeGateReviewComments,
  summarizeGateReviewCommentMarkers,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";

const USAGE = `Usage:
  pre-pr-ready-gate.mjs --repo <owner/name> --pr <number>

Gate guard for gh pr ready (draft → ready-for-review transition).
Blocks unless a visible clean draft_gate checkpoint verdict comment exists
for the PR's current head SHA.

Exit codes:
  0  Draft gate evidence exists — ready transition is allowed
  1  Draft gate evidence missing or insufficient — transition blocked

Output (stdout, JSON on success):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "currentHeadSha": "abc1234",
    "draftGateSatisfied": true,
    "draftGate": { "visible": true, "headSha": "abc1234", "verdict": "clean", ... }
  }

Error output (stderr, JSON):
  { "ok": false, "error": "<reason>" }`.trim();

const parseError = buildParseError(USAGE);
const PR_VIEW_QUERY = `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { id, isDraft, headRefOid, state } } }`;

export function parsePrePrReadyGateCliArgs(argv) {
  const args = [...argv];
  const options = { help: false, repo: undefined, pr: undefined };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") { options.help = true; return options; }
    if (token === "--repo") { options.repo = requireOptionValue(args, "--repo", parseError).trim(); continue; }
    if (token === "--pr") { options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError); continue; }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("pre-pr-ready-gate requires both --repo <owner/name> and --pr <number>");
  }
  try { parseRepoSlug(options.repo); } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout);
}

async function fetchPrState({ repo, pr }, { env, ghCommand }) {
  const [owner, name] = repo.split("/");
  const r = await runGhJson(
    ["api", "graphql", "-f", `query=${PR_VIEW_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`],
    { env, ghCommand },
  );
  const d = r?.data?.repository?.pullRequest;
  if (!d) throw new Error(`Could not fetch PR #${pr}`);
  return {
    id: d.id,
    isDraft: d.isDraft === true,
    headRefOid: typeof d.headRefOid === "string" ? d.headRefOid.trim() : null,
    state: typeof d.state === "string" ? d.state.trim() : null,
  };
}

async function fetchGateEvidence({ repo, pr, headSha }, { env, ghCommand }) {
  const r = await runChild(
    ghCommand,
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
    env,
  );
  if (r.code !== 0) throw new Error(`Failed to fetch PR comments`);
  const raw = parseJsonText(r.stdout);
  const comments = Array.isArray(raw)
    ? (raw.every((e) => Array.isArray(e)) ? raw.flat() : raw)
    : [];
  const cs = summarizeGateReviewComments(comments);
  const ms = summarizeGateReviewCommentMarkers(comments, { headSha });

  const dg = cs.draft_gate ? { ...cs.draft_gate, visible: true } : { visible: false };
  const dm = ms.draft_gate
    ? { ...ms.draft_gate, visible: true, contractComplete: ms.draft_gate.contractComplete === true }
    : { visible: false, contractComplete: false };

  // Marker match: current head SHA starts with the marker's recorded head SHA
  const markerHeadMatch = dm.headSha && headSha && headSha.startsWith(dm.headSha);
  const currentHeadClean = dm.visible && markerHeadMatch && dm.verdict === "clean" && dm.contractComplete;

  // Legacy comment match (non-marker draft_gate comment)
  const cleanEvidenceExists = dg.visible && dg.verdict === "clean" && typeof dg.headSha === "string";
  const legacyHeadMatch = !currentHeadClean && dg.headSha && headSha && headSha.startsWith(dg.headSha) && dg.verdict === "clean";

  return {
    draftGate: dg,
    draftGateMarker: dm,
    currentHeadClean,
    cleanEvidenceExists,
    effectiveHeadClean: currentHeadClean || legacyHeadMatch,
  };
}

export async function prePrReadyGate(options, { env = process.env, ghCommand = "gh" } = {}) {
  const prState = await fetchPrState({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const headSha = prState.headRefOid;
  if (!headSha) throw new Error(`Could not resolve PR head SHA`);

  const gate = await fetchGateEvidence({ repo: options.repo, pr: options.pr, headSha }, { env, ghCommand });

  // When the PR is no longer draft, a visible clean draft_gate comment that
  // exists at all (one-time transition record) is sufficient — don't require
  // head-SHA matching after draft has been left.
  const gateSatisfied = prState.isDraft
    ? gate.effectiveHeadClean
    : gate.cleanEvidenceExists;

  if (!gateSatisfied) {
    const shortSha = headSha.slice(0, 7);
    const reason = gate.cleanEvidenceExists
      ? `PR #${options.pr} draft_gate evidence exists but does not match current head ${shortSha}. Re-run draft gate for the current head.`
      : `No visible clean draft_gate checkpoint verdict comment found on PR #${options.pr} for head ${shortSha}. Run the draft gate review and post a clean verdict before marking ready for review.`;
    return {
      ok: false,
      error: reason,
      repo: options.repo,
      pr: options.pr,
      currentHeadSha: headSha,
      draftGateSatisfied: false,
      draftGate: gate.draftGate,
      draftGateMarker: gate.draftGateMarker,
    };
  }

  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    currentHeadSha: headSha,
    draftGateSatisfied: true,
    draftGate: gate.draftGate,
    draftGateMarker: gate.draftGateMarker,
  };
}

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
  const options = parsePrePrReadyGateCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const result = await prePrReadyGate(options, runtime);
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return result;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
                process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
