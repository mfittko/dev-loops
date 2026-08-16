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
  const { owner, name } = parseRepoSlug(values.repo);
  const repo = `${owner}/${name}`;
  if (repo !== values.repo) {
    throw parseError("--repo must be <owner/name> shape");
  }
  const pr = parsePrNumber(values.pr, parseError);
  let headSha = null;
  if (typeof values["head-sha"] === "string" && values["head-sha"].trim().length > 0) {
    headSha = values["head-sha"].trim().toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(headSha)) {
      throw parseError("--head-sha must be a hex commit sha (or omitted to auto-fetch)");
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

/**
 * Read the PR head ref oid via `gh pr view` (used when --head-sha is omitted).
 * Mirrors detect-checkpoint-evidence's lightweight head read.
 */
async function fetchHeadSha({ repo, pr }, { env, ghCommand, runChild }) {
  const res = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"],
    env,
  );
  if (res.code !== 0) {
    throw new Error(`gh pr view failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
  }
  let payload;
  try {
    payload = JSON.parse(res.stdout.trim());
  } catch (e) {
    throw new Error(`Invalid JSON from gh pr view: ${e.message}`);
  }
  const head = typeof payload?.headRefOid === "string" && payload.headRefOid.trim().length > 0
    ? payload.headRefOid.trim().toLowerCase()
    : null;
  if (!head) throw new Error("gh pr view returned no headRefOid");
  return head;
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
  const currentHeadSha = options.headSha ?? (await fetchHeadSha({ repo, pr }, { env, ghCommand, runChild }));
  const comments = await fetchGateEvidenceComments({ repo, pr }, { env, ghCommand, runChild });
  const summary = summarizeGateReviewComments(comments);
  const draftGate = normalizeVerdict(summary.draft_gate);
  const preApprovalGate = normalizeVerdict(summary.pre_approval_gate);

  const missing = [];
  if (draftGate.verdict !== "clean" || !draftGate.visible) missing.push("draft_gate");
  if (preApprovalGate.verdict !== "clean" || !preApprovalGate.visible) missing.push("pre_approval_gate");

  return {
    ok: true,
    repo,
    pr,
    currentHeadSha,
    surfaces: ["review", "issue_comment"],
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
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stdout, stderr: process.stderr });
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(1);
  }
}

if (isDirectCliRun(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode ?? 0);
}
