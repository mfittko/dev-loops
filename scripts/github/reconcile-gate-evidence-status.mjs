#!/usr/bin/env node
/**
 * reconcile-gate-evidence-status.mjs — self-heal a stuck `gate-evidence`
 * required status (issue #1935).
 *
 * The server-side `gate-evidence` check re-fires when a gate verdict is posted
 * (ADR 0043), but that native re-fire is racy: a verdict-post run can be
 * CANCELLED by `cancel-in-progress` when a superseding event lands, or evaluate
 * before the just-posted verdict is API-visible. Either way the required status
 * can stay `failure` on the current head even though a clean current-head
 * `pre_approval_gate` verdict now exists, and nothing re-fires afterward — the
 * merge stays `UNSTABLE` until a manual `gh run rerun` (observed on PR #1934).
 *
 * This helper closes that seam deterministically. It reads the authoritative
 * evidence exactly as the CI check does (`detect-checkpoint-evidence.mjs
 * --skip-fanout-ledger-check`) and the `gate-evidence` commit status on the
 * current head. When the evidence is genuinely satisfied but the status is
 * stuck non-green, it re-fires the concrete run that posted the stale status
 * (`gh run rerun <id>`) — the rerun re-evaluates LIVE evidence, which is now
 * satisfied, so the status flips to `success`. When the evidence is NOT
 * satisfied, it does nothing: a head that truly lacks a clean current-head
 * verdict keeps failing closed (issue #1935 AC #3).
 *
 * Design record: docs/decisions/0057-gate-evidence-status-reconcile.md
 * Reporting/reconcile tool only — it never posts a status itself (that would
 * bypass the trusted server-side detector); it only re-triggers the CI run.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  GATE_EVIDENCE_STATUS_CONTEXT,
  parseRunIdFromTargetUrl,
  resolveGateEvidenceStatusReconcile,
} from "@dev-loops/core/loop/gate-evidence-reconcile";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const DETECT_EVIDENCE_SCRIPT = fileURLToPath(new URL("./detect-checkpoint-evidence.mjs", import.meta.url));

/**
 * Parse the first JSON object from a captured stream. The detector emits one
 * JSON result object, but the not-satisfied path may prefix it with plain
 * `WARNING:` lines, so try the whole trimmed payload first and fall back to the
 * last JSON-object-shaped line. Returns null when nothing parses.
 */
function parseFirstJson(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through to a line scan
  }
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // keep scanning
    }
  }
  return null;
}

const USAGE = `Usage: reconcile-gate-evidence-status.mjs --repo <owner/name> --pr <number> [--dry-run]
Self-heal a stuck server-side \`gate-evidence\` required status (issue #1935).
Reads the authoritative gate evidence the way the CI check does and the
\`gate-evidence\` commit status on the current head. When the evidence is
satisfied but the status is stuck non-green (a cancelled/raced verdict-post
re-fire), re-fires the run that posted the stale status so it flips to success
without a manual \`gh run rerun\`. Fail-closed: when the evidence is genuinely
not satisfied, it does nothing.

Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --dry-run             Report the decision without re-firing the run
Exit codes:
  0   Success (reconciled, or nothing to reconcile)
  1   Usage/IO/gh error
  2   Invalid --jq filter

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseReconcileCliArgs(argv) {
  const { values, tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "dry-run": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: false,
    tokens: true,
  });
  if (values.help) return { help: true };
  if (!values.repo) throw parseError("Missing required argument: --repo <owner/name>");
  const repo = values.repo.trim();
  // An invalid --repo is a usage error (exit 1), not the invalid-jq exit (2):
  // parseRepoSlug throws a plain Error, so re-wrap it in the usage envelope.
  try {
    parseRepoSlug(repo);
  } catch (err) {
    throw parseError(`Invalid --repo: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pr = parsePrNumber(values.pr, parseError);
  const out = { repo, pr, dryRun: values["dry-run"] === true };
  for (const token of tokens) {
    if (matchJqOutputToken(token, values, (t) => requireTokenValue(t, parseError))) continue;
  }
  if (values.jq) out.jq = values.jq;
  if (values.silent) out.silent = true;
  return out;
}

/**
 * Read the authoritative gate evidence exactly as the CI check does, by
 * invoking the same detector with `--skip-fanout-ledger-check`. Returns
 * `{ evidenceState, currentHeadSha }`. Throws on a missing/unparseable
 * evidenceState so the reconcile never silently treats an errored detector as
 * "not satisfied" (which would still fail-closed to `action: none`, but hide
 * the real error).
 */
async function defaultDetectEvidence({ repo, pr }, { runChild, nodeBin = process.execPath }) {
  const res = await runChild(nodeBin, [
    DETECT_EVIDENCE_SCRIPT,
    "--repo", repo,
    "--pr", String(pr),
    "--skip-fanout-ledger-check",
  ]);
  // The detector exits non-zero when evidence is not satisfied; that is a
  // normal signal here, not an error. On the SATISFIED path it emits the JSON
  // result to stdout; on the NOT-satisfied path it writes the JSON (still
  // carrying evidenceState/currentHeadSha) to STDERR and leaves stdout empty.
  // Read whichever stream carries the JSON — same as the gate-evidence
  // workflow, which parses both — so the genuinely-not-satisfied case yields a
  // clean fail-closed `action: none` instead of throwing (issue #1935 AC #3).
  const parsed = parseFirstJson(res.stdout) ?? parseFirstJson(res.stderr);
  if (!parsed) {
    throw new Error(`detect-checkpoint-evidence returned unparseable output (exit ${res.code}): ${res.stderr || res.stdout}`.trim());
  }
  const evidenceState = typeof parsed?.evidenceState === "string" ? parsed.evidenceState : null;
  if (!evidenceState) {
    throw new Error(`detect-checkpoint-evidence returned no evidenceState (exit ${res.code})`);
  }
  return { evidenceState, currentHeadSha: parsed.currentHeadSha ?? null };
}

/**
 * Read the `gate-evidence` commit status on a head SHA. Returns
 * `{ statusState, runId, targetUrl }` where statusState is the context's state
 * (`success`/`failure`/`error`/`pending`) or `none` when no gate-evidence
 * status is posted for the head.
 */
async function readGateEvidenceStatus({ repo, headSha }, { runChild }) {
  const res = await runChild("gh", ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`]);
  if (res.code !== 0) {
    throw new Error(`Failed to read commit status for ${headSha}: ${res.stderr || res.stdout}`.trim());
  }
  let payload = null;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    throw new Error(`Unparseable commit-status payload for ${headSha}`);
  }
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  // The gate-evidence workflow re-posts the same context per head; the API
  // lists the most recent first, so the first match is authoritative.
  const entry = statuses.find((s) => s?.context === GATE_EVIDENCE_STATUS_CONTEXT) ?? null;
  if (!entry) return { statusState: "none", runId: null, targetUrl: null };
  return {
    statusState: typeof entry.state === "string" ? entry.state : "none",
    runId: parseRunIdFromTargetUrl(entry.target_url),
    targetUrl: entry.target_url ?? null,
  };
}

export async function reconcileGateEvidenceStatus(options, {
  runChild = defaultRunChild,
  detectEvidence = defaultDetectEvidence,
} = {}) {
  const { repo, pr, dryRun } = options;
  const { evidenceState, currentHeadSha } = await detectEvidence({ repo, pr }, { runChild });
  const evidenceSatisfied = evidenceState === "satisfied";
  const headSha = currentHeadSha;
  if (!headSha) {
    throw new Error("Could not resolve the current head SHA for the gate-evidence status read");
  }
  const status = await readGateEvidenceStatus({ repo, headSha }, { runChild });
  const decision = resolveGateEvidenceStatusReconcile({
    evidenceSatisfied,
    statusState: status.statusState,
    runId: status.runId,
  });

  const base = {
    ok: true,
    repo,
    pr,
    currentHeadSha: headSha,
    evidenceState,
    statusState: status.statusState,
    runId: status.runId,
    action: decision.action,
    reason: decision.reason,
    refired: false,
  };

  if (decision.action !== "refire" || dryRun) {
    return { ...base, refired: false, dryRun: dryRun === true };
  }

  const rerun = await runChild("gh", ["run", "rerun", String(decision.runId)]);
  if (rerun.code !== 0) {
    throw new Error(`Failed to re-fire gate-evidence run ${decision.runId}: ${rerun.stderr || rerun.stdout}`.trim());
  }
  return { ...base, refired: true };
}

async function main() {
  let options;
  try {
    options = parseReconcileCliArgs(process.argv.slice(2));
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
    const result = await reconcileGateEvidenceStatus(options);
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stdout, stderr: process.stderr, ok: result.ok !== false });
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(1);
  }
}

if (isDirectCliRun(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode ?? 0);
}
