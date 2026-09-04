#!/usr/bin/env node
/**
 * audit-gate-evidence.mjs — deterministic post-drive gate-evidence audit
 * (issue #1729).
 *
 * Gate verdicts are posted as PR reviews (`pulls/<n>/reviews`, the single
 * visible surface per GATE-COMMENT-SINGLE-SURFACE / ADR 0046). A gate-evidence
 * audit that reads only the issue-comment stream (`issues/<n>/comments`) will
 * report these verdicts as "missing" even though they are legitimately posted —
 * the false conclusion at the root of issue #1674. This helper scans BOTH
 * surfaces through the shared two-surface reader
 * (`fetchGateEvidenceComments`, which reads the issue-comment stream
 * fail-closed and the PR-review stream fail-open) and reports whether the clean
 * draft_gate and pre_approval_gate verdicts are present on either, so a verdict
 * posted only as a PR review is never reported missing.
 *
 * This is a reporting/audit tool only. It does not change
 * `detect-checkpoint-evidence.mjs`'s evidence-satisfaction semantics (that
 * detector already reads both surfaces and is the merge-gate authority).
 */
import { parseArgs } from "node:util";

import { formatCliError, isDirectCliRun, summarizeGateReviewComments } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchPrHeadRefOid, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { fetchGateEvidenceComments } from "./_gate-finding-surface.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";

const USAGE = `Usage: audit-gate-evidence.mjs --repo <owner/name> --pr <number> [--head-sha <sha>]
Deterministic post-drive gate-evidence audit. Scans BOTH verdict surfaces — the
PR review stream (primary, per GATE-COMMENT-SINGLE-SURFACE) and the visible PR
issue-comment stream (back-compat for legacy/fallback-posted verdicts) — and
reports whether the clean draft_gate and pre_approval_gate verdicts are present
on either surface.

Required:
  --repo <owner/name>
  --pr <number>
Optional:
  --head-sha <sha>          Current PR head SHA to annotate in the report. When
                             omitted the helper fetches it via gh pr view.

Output (stdout, JSON):
  { "ok": true, "repo": "...", "pr": 17, "currentHeadSha": "...",
    "surfaces": ["review", "issue_comment"],
    "draftGate":       { "visible", "surface", "verdict", "headSha", "commentId" },
    "preApprovalGate": { "visible", "surface", "verdict", "headSha", "commentId" },
    "allVerdictsPosted": true, "missing": [] }
  A verdict posted only as a PR review is reported visible with surface "review"
  — never a false "missing" just because no issue-comment body exists.
Exit codes:
  0   Success
  1   Usage/IO/gh error
  2   Invalid --jq filter

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseAuditGateEvidenceCliArgs(argv) {
  const { values, tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "head-sha": { type: "string" },
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
    // --head-sha must be the FULL head SHA (40/64 hex), matching the shared
    // head-sha.mjs convention (FULL_HEAD_SHA_ERROR). The audit compares the
    // verdict-body head SHA against it by prefix, so an abbreviated annotation
    // could never match a full-sha verdict body and would false-report
    // "missing" (pre-approval dry / contradiction-lens findings). Auto-fetch
    // (full oid) remains the default and is unaffected.
    headSha = normalizeFullHeadSha(values["head-sha"]);
    if (!headSha) {
      throw parseError("--head-sha must be the FULL head commit SHA (40 or 64 hex chars), or omitted to auto-fetch");
    }
  }
  const out = { repo, pr, headSha };
  for (const token of tokens) {
    if (matchJqOutputToken(token, values, (t) => requireTokenValue(t, parseError))) continue;
  }
  if (values.jq) out.jq = values.jq;
  if (values.silent) out.silent = true;
  return out;
}

function normalizeVerdict(summary) {
  if (!summary) {
    return { visible: false, surface: null, verdict: null, headSha: null, commentId: null };
  }
  return {
    visible: summary.visible === true,
    surface: summary.surface ?? null,
    verdict: summary.verdict ?? null,
    headSha: summary.headSha ?? null,
    commentId: summary.commentId ?? null,
  };
}

export async function auditGateEvidence(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const { repo, pr } = options;
  const currentHeadSha = options.headSha ?? (await fetchPrHeadRefOid({ repo, pr }, { env, ghCommand, runChild }));
  // Report which surfaces were actually read so `surfaces` never claims a
  // review read that silently failed (fail-open degradation would otherwise
  // reproduce the false-missing this audit exists to prevent).
  const { comments, surfaces } = await fetchGateEvidenceComments({ repo, pr }, { env, ghCommand, runChild, reportSurfaces: true });
  const summary = summarizeGateReviewComments(comments);
  const draftGate = normalizeVerdict(summary.draft_gate);
  const preApprovalGate = normalizeVerdict(summary.pre_approval_gate);

  const missing = [];
  // draft_gate is a one-time draft->ready transition gate: a clean verdict on
  // an earlier head legitimately stands for that transition (mirrors
  // detect-checkpoint-evidence). pre_approval_gate MUST be stamped on the
  // current head — a clean verdict on an older head is not evidence for the
  // current head and must not drive allVerdictsPosted=true (issue #1729 /
  // Copilot head-match finding).
  if (draftGate.verdict !== "clean" || !draftGate.visible) missing.push("draft_gate");
  // Verdict-body head SHAs may be abbreviated (7-64 hex, e.g. the back-compat
  // issue-comment surface), while currentHeadSha is always the FULL oid (from
  // gh pr view, or a full --head-sha). Compare by prefix — the repo convention
  // fetchDraftGateEvidence uses — so an abbreviated-but-current head never
  // false-reports missing (pre-approval contradiction-lens finding).
  const preApprovalCurrentHead =
    preApprovalGate.verdict === "clean" &&
    preApprovalGate.visible &&
    preApprovalGate.headSha !== null &&
    currentHeadSha.startsWith(preApprovalGate.headSha);
  if (!preApprovalCurrentHead) missing.push("pre_approval_gate");

  return {
    ok: true,
    repo,
    pr,
    currentHeadSha,
    surfaces,
    draftGate,
    preApprovalGate,
    allVerdictsPosted: missing.length === 0,
    missing,
  };
}

async function main() {
  let options;
  try {
    options = parseAuditGateEvidenceCliArgs(process.argv.slice(2));
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
    const result = await auditGateEvidence(options);
    // --silent is a verdict-presence predicate: exit non-zero when not all
    // verdicts are posted (jq -e style), so a status check reflects the audit
    // outcome rather than always exiting 0. Verbose mode always exits 0 (the
    // audit completed and printed its report).
    const ok = options.silent ? result.allVerdictsPosted : result.ok !== false;
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stdout, stderr: process.stderr, ok });
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(1);
  }
}

if (isDirectCliRun(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode ?? 0);
}
