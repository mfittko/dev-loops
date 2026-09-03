#!/usr/bin/env node
/**
 * audit-review-marker-presence.mjs — advisory `review`-gate marker-presence
 * check (issue #1899).
 *
 * The standalone `review` gate (skills/review/SKILL.md) is contract-specified
 * to post its verdict through `upsert-checkpoint-verdict.mjs --gate review
 * --findings-ledger <path>`, which stamps the posted PR review with the
 * `dev-loops:gate-findings-review review <headSha> round=<n>` marker
 * (`buildReviewHeaderMarker`, `_gate-finding-surface.mjs`) and attaches every
 * locatable finding as an inline comment. Nothing stops a caller from instead
 * posting a raw `gh pr review`/`gh api .../reviews` comment for the same
 * round — no ledger, no marker, no inline comments — and nothing has flagged
 * that degraded post path.
 *
 * This is a deterministic, ADVISORY-ONLY check: it scans the PR review stream
 * for a `review`-gate marker on the given head and, when a `--findings-ledger`
 * is supplied and it carries locatable findings, checks that the marked
 * review's inline comment count is non-zero. It emits WARNINGS, never a
 * block, and it produces no evidence for any gate — `review` stays absent
 * from GATE_CONFIG_KEY and the non-evidence exemption (#1850, #1840) is
 * untouched. This script is not wired into any merge-gate or ready-for-review
 * path; it is a standalone audit to run after a `review` round when the
 * caller wants to confirm the round went through the canonical path.
 */
import { parseArgs } from "node:util";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchPrHeadRefOid, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { listPrReviews, readGateFindingsLedger } from "./_gate-finding-surface.mjs";
import { flattenPaginatedSlurp, runGhJson } from "./post-gate-findings.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { hasLocatableShape } from "@dev-loops/core/loop/gate-fanin";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";

const USAGE = `Usage: audit-review-marker-presence.mjs --repo <owner/name> --pr <number> [--head-sha <sha>] [--findings-ledger <path>]
Advisory-only check (issue #1899): scans the PR review stream for a
\`dev-loops:gate-findings-review review\` marker on the given head, and, when
--findings-ledger carries locatable findings, checks the marked review's
inline comment count. NEVER blocks; produces no gate evidence.

Required:
  --repo <owner/name>
  --pr <number>
Optional:
  --head-sha <sha>          FULL head commit SHA to audit. When omitted the
                             helper fetches it via gh pr view.
  --findings-ledger <path>  A write-gate-findings-log.mjs ledger for gate
                             "review". When it carries locatable findings and
                             the marker is found, asserts the marked review
                             carries at least one inline comment.

Output (stdout, JSON):
  { "ok": true, "repo", "pr", "headSha", "markerFound", "reviewId", "round",
    "locatableFindingsCount", "inlineCommentCount", "warnings": [...] }
Exit codes:
  0   Always (advisory-only; never fails the run on a warning)
  1   Usage/IO/gh error
  2   Invalid --jq filter

${JQ_OUTPUT_USAGE}
`.trim();

// Scoped to gate "review" ONLY — deliberately narrower than
// _gate-finding-surface.mjs's own REVIEW_HEADER_RE (draft_gate/
// pre_approval_gate only), so this check can never be mistaken for, or
// mistakenly widen, that gate's own round bookkeeping.
const REVIEW_GATE_MARKER_RE = /^<!--\s*dev-loops:gate-findings-review\s+review\s+([0-9a-f]{7,64})\s+round=(\d+)\s*-->/m;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseAuditReviewMarkerPresenceCliArgs(argv) {
  const { values, tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "head-sha": { type: "string" },
      "findings-ledger": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: false,
    tokens: true,
  });
  if (values.help) {
    return { help: true };
  }
  if (!values.repo) throw parseError("Missing required argument: --repo <owner/name>");
  const repo = values.repo.trim();
  parseRepoSlug(repo);
  const pr = parsePrNumber(values.pr, parseError);
  let headSha = null;
  if (typeof values["head-sha"] === "string" && values["head-sha"].trim().length > 0) {
    headSha = normalizeFullHeadSha(values["head-sha"]);
    if (!headSha) {
      throw parseError("--head-sha must be the FULL head commit SHA (40 or 64 hex chars), or omitted to auto-fetch");
    }
  }
  const findingsLedger = typeof values["findings-ledger"] === "string" && values["findings-ledger"].trim().length > 0
    ? values["findings-ledger"].trim()
    : null;
  const out = { repo, pr, headSha, findingsLedger };
  for (const token of tokens) {
    if (matchJqOutputToken(token, values, (t) => requireTokenValue(t, parseError))) continue;
  }
  if (values.jq) out.jq = values.jq;
  if (values.silent) out.silent = true;
  return out;
}

const prReviewCommentsApiArgs = (repo, pr) => ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/comments?per_page=100`];

async function fetchInlineCommentCountForReview({ repo, pr, reviewId }, { env, ghCommand, runChild }) {
  const payload = await runGhJson(prReviewCommentsApiArgs(repo, pr), { env, ghCommand, runChild });
  const comments = flattenPaginatedSlurp(payload);
  return comments.filter((c) => c && typeof c === "object" && c.pull_request_review_id === reviewId).length;
}

// Picks the HIGHEST-round marker matching `headSha` (by prefix, either
// direction — mirrors audit-gate-evidence.mjs's abbreviated-head tolerance):
// a re-run on the same head produces a later, higher-numbered round, and that
// is the round this check should evaluate.
function findLatestReviewGateMarker(reviews, headSha) {
  let best = null;
  for (const r of reviews) {
    if (typeof r.body !== "string") continue;
    const match = r.body.match(REVIEW_GATE_MARKER_RE);
    if (!match) continue;
    const markerHeadSha = match[1];
    if (!headSha.startsWith(markerHeadSha) && !markerHeadSha.startsWith(headSha)) continue;
    const round = Number(match[2]);
    if (!best || round > best.round) {
      best = { reviewId: r.id, round };
    }
  }
  return best;
}

export async function auditReviewMarkerPresence(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const { repo, pr } = options;
  const currentHeadSha = options.headSha ?? (await fetchPrHeadRefOid({ repo, pr }, { env, ghCommand, runChild }));
  const reviews = await listPrReviews({ repo, pr }, { env, ghCommand, runChild });
  const warnings = [];

  const found = findLatestReviewGateMarker(reviews, currentHeadSha);
  const markerFound = found !== null;
  if (!markerFound) {
    warnings.push(
      `No \`dev-loops:gate-findings-review review\` marker found on head ${currentHeadSha}. ` +
      "This round may have been posted via a raw `gh pr review`/`gh api .../reviews` call instead of " +
      "`upsert-checkpoint-verdict.mjs --gate review --findings-ledger` — the review contract path.",
    );
  }

  let locatableFindingsCount = null;
  let inlineCommentCount = null;
  if (options.findingsLedger) {
    const ledger = await readGateFindingsLedger(options.findingsLedger, { errorFactory: parseError });
    if (ledger.gate !== "review") {
      throw parseError(`--findings-ledger "${options.findingsLedger}" is for gate "${ledger.gate}", not "review"`);
    }
    locatableFindingsCount = ledger.findings.filter(hasLocatableShape).length;
    if (markerFound && locatableFindingsCount > 0) {
      inlineCommentCount = await fetchInlineCommentCountForReview(
        { repo, pr, reviewId: found.reviewId },
        { env, ghCommand, runChild },
      );
      if (inlineCommentCount === 0) {
        warnings.push(
          `Ledger "${options.findingsLedger}" reports ${locatableFindingsCount} locatable finding(s), ` +
          `but the marked review (id ${found.reviewId}) carries no inline comments.`,
        );
      }
    }
  }

  return {
    ok: true,
    repo,
    pr,
    headSha: currentHeadSha,
    markerFound,
    reviewId: found?.reviewId ?? null,
    round: found?.round ?? null,
    locatableFindingsCount,
    inlineCommentCount,
    warnings,
    advisory: true,
  };
}

async function main() {
  let options;
  try {
    options = parseAuditReviewMarkerPresenceCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.usage ? err.message : formatCliError(err));
    if (err.usage) console.error(err.usage);
    process.exit(err.usage ? 1 : 2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    const result = await auditReviewMarkerPresence(options);
    // Advisory-only: --silent still prints nothing (mirrors audit-gate-evidence's
    // machine-predicate mode) but ALWAYS exits 0 — a warning here must never
    // fail a caller's script, only inform it.
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stdout, stderr: process.stderr, ok: true });
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(1);
  }
}

if (isDirectCliRun(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode ?? 0);
}
