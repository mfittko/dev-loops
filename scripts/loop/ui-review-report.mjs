#!/usr/bin/env node
/**
 * CLI wrapper for the ui_review report stage (Stage 4, terminal reporting).
 *
 * Reads the Stage-3 diagnose output, builds the self-contained CSP-safe HTML
 * artifact + the pending draft-review input + the harness-aware hosting
 * directive via the pure core (packages/core/src/loop/ui-review-report.mjs),
 * then posts the head-pinned PENDING review by invoking the shared poster
 * (scripts/github/stage-reviewer-draft.mjs). The review always stays pending;
 * the severity->event decision is emitted as guidance — submitting is a separate
 * authorized action this stage never performs.
 *
 * Thin adapter: the diagnose read, the live-head reuse (loop info), the
 * screenshot read + base64 inline, the HTML write, and the poster spawn are the
 * only IO. Every mapping/policy/cap decision lives in core.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, parsePositiveInteger } from "../_cli-primitives.mjs";
import { detectRepoSlug, normalizeRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  buildArtifactHtml,
  buildReviewInput,
  decideHosting,
  severityToEvent,
  ARTIFACT_MAX_SCREENSHOT_BYTES,
} from "@dev-loops/core/loop/ui-review-report";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOOP_INFO_SCRIPT = path.join(HERE, "info.mjs");
export const STAGE_REVIEWER_DRAFT_SCRIPT = path.join(HERE, "..", "github", "stage-reviewer-draft.mjs");

const MAX_DIAGNOSE_RESULT_BYTES = 16 * 1024 * 1024;

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

const USAGE = `Usage:
  ui-review-report.mjs --pr <n> --diagnose-result <p> --html-output <p> [--repo <slug>] [options]
Publish a self-contained screenshot/findings artifact and post a head-pinned PENDING
PR review with inline comments on the exact Stage-3 diff anchors (Stage 4 of ui_review).
Required:
  --pr <n>              PR number (also used to reuse live head via loop info).
  --diagnose-result <p> Path to the Stage-3 diagnose JSON (its findings + pr.headSha).
  --html-output <p>     Path to write the self-contained HTML artifact.
Optional:
  --repo <slug>         Repository slug (auto-detected from the git remote when omitted).
  --review-file <p>     Path to write the poster's review-file input (default: alongside --html-output).
  --submit-authorized   Record the severity->event decision as authorized (never auto-submits).
  --hosted-url <url>    A real hosted artifact URL to link in the review body (when known).
  --dry-run             Build + write the artifact and emit the directive, but do NOT post.
  -h, --help            Show this help.
Output (stdout, JSON):
  { ok, pr, htmlPath, reviewFile, hosting:{hosting,publishable,...}, policy:{event,blocking,severity},
    review:{reviewId,reviewUrl,commitSha}|null, caps:[...] }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseUiReviewReportCliArgs(argv) {
  const options = {
    help: false, pr: undefined, diagnoseResult: undefined, htmlOutput: undefined,
    repo: undefined, reviewFile: undefined, submitAuthorized: false, hostedUrl: undefined, dryRun: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      pr: { type: "string" },
      "diagnose-result": { type: "string" },
      "html-output": { type: "string" },
      repo: { type: "string" },
      "review-file": { type: "string" },
      "submit-authorized": { type: "boolean" },
      "hosted-url": { type: "string" },
      "dry-run": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "pr") { options.pr = parsePositiveInteger(requireTokenValue(token, parseError), "--pr", parseError); continue; }
    if (token.name === "diagnose-result") { options.diagnoseResult = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "html-output") { options.htmlOutput = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError); continue; }
    if (token.name === "review-file") { options.reviewFile = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "submit-authorized") { options.submitAuthorized = true; continue; }
    if (token.name === "hosted-url") { options.hostedUrl = requireTokenValue(token, parseError); continue; }
    if (token.name === "dry-run") { options.dryRun = true; continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (options.pr === undefined) throw parseError("Missing required --pr");
  if (!options.diagnoseResult) throw parseError("Missing required --diagnose-result");
  if (!options.htmlOutput) throw parseError("Missing required --html-output");
  return options;
}

/** Reuse the live head SHA from `loop info --pr` (never an ad-hoc re-fetch), so
 * the report can detect the head advancing since diagnose and fail closed. */
function loadLiveHeadSha(pr, repo, cwd) {
  const raw = execFileSync(process.execPath, [LOOP_INFO_SCRIPT, "--pr", String(pr), "--repo", repo, "--json"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const info = JSON.parse(raw);
  const sha = info?.pr?.headRefOid;
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}

/** Read the shared reproduced-evidence screenshot (Stage 3 surfaces one shared
 * ref across findings) and inline it as a data URI. Bounded: an oversized or
 * unreadable screenshot is skipped with a logged cap, never fatal. */
function loadScreenshot(findings, caps) {
  const withEvidence = findings.find((f) => f?.evidence?.screenshotPath);
  const p = withEvidence?.evidence?.screenshotPath;
  if (!p) return null;
  let size;
  try {
    size = statSync(p).size;
  } catch {
    caps.push(`artifact: evidence screenshot not readable, omitted: ${p}`);
    return null;
  }
  if (size > ARTIFACT_MAX_SCREENSHOT_BYTES) {
    caps.push(`artifact: screenshot omitted (${size} bytes > ${ARTIFACT_MAX_SCREENSHOT_BYTES} cap): ${p}`);
    return null;
  }
  const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "image/png";
  const dataUri = `data:${mime};base64,${readFileSync(p).toString("base64")}`;
  return { path: p, dataUri };
}

/** Post the head-pinned PENDING review via the shared poster and return its
 * parsed result. The poster asserts state === PENDING and pins to commit_id. */
function postPendingReview({ repo, pr, reviewFile, cwd }) {
  const raw = execFileSync(process.execPath, [STAGE_REVIEWER_DRAFT_SCRIPT, "--repo", repo, "--pr", String(pr), "--review-file", reviewFile], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  return { reviewId: parsed.reviewId ?? null, reviewUrl: parsed.reviewUrl ?? null, commitSha: parsed.commitSha ?? null };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const options = parseUiReviewReportCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return; }

  const cwd = process.cwd();
  const rawRepo = options.repo || detectRepoSlug(cwd);
  if (!rawRepo) throw parseError("Repo auto-detection failed. Set origin remote or use --repo.");
  const repo = normalizeRepoSlug(rawRepo, { errorMessage: "--repo must match <owner/name>" });

  const diagSize = statSync(options.diagnoseResult).size;
  if (diagSize > MAX_DIAGNOSE_RESULT_BYTES) {
    throw parseError(`--diagnose-result is too large (${diagSize} bytes > ${MAX_DIAGNOSE_RESULT_BYTES} cap)`);
  }
  const diagnose = JSON.parse(readFileSync(options.diagnoseResult, "utf8"));
  const findings = Array.isArray(diagnose.findings) ? diagnose.findings : [];
  const counts = diagnose.counts ?? { total: findings.length, anchorable: 0, nonAnchorable: 0 };
  const diagnosedHeadSha = diagnose?.pr?.headSha ?? null;

  // Head pinning: the inline anchors bind to the reviewed commit. Fail closed
  // when the diagnose head is missing or the live head has advanced since.
  const liveHeadSha = loadLiveHeadSha(options.pr, repo, cwd);
  if (!diagnosedHeadSha) {
    throw parseError("Stage-3 diagnose output has no pr.headSha; cannot head-pin the review. Failing closed.");
  }
  if (liveHeadSha && liveHeadSha !== diagnosedHeadSha) {
    throw parseError(`Live PR head (${liveHeadSha}) advanced past the diagnosed head (${diagnosedHeadSha}); re-run diagnose. Failing closed.`);
  }

  const caps = [];
  const screenshot = loadScreenshot(findings, caps);
  const { html, caps: artifactCaps } = buildArtifactHtml({
    findings,
    counts,
    pr: { number: options.pr, headSha: diagnosedHeadSha },
    screenshot,
    generatedAt: new Date().toISOString(),
  });
  caps.push(...artifactCaps);

  mkdirSync(path.dirname(path.resolve(options.htmlOutput)), { recursive: true });
  writeFileSync(options.htmlOutput, html, "utf8");

  const hosting = decideHosting({ htmlPath: path.resolve(options.htmlOutput), env });
  const policy = severityToEvent({ findings, submitAuthorized: options.submitAuthorized });

  const reviewInput = buildReviewInput({
    findings,
    headSha: diagnosedHeadSha,
    hosting,
    hostedUrl: options.hostedUrl ?? null,
  });
  const reviewFile = options.reviewFile
    ? path.resolve(options.reviewFile)
    : `${path.resolve(options.htmlOutput)}.review.json`;
  mkdirSync(path.dirname(reviewFile), { recursive: true });
  writeFileSync(reviewFile, `${JSON.stringify(reviewInput, null, 2)}\n`, "utf8");

  for (const cap of caps) stderr.write(`[ui-review-report] cap: ${cap}\n`);

  const review = options.dryRun ? null : postPendingReview({ repo, pr: options.pr, reviewFile, cwd });

  const result = {
    ok: true,
    pr: { number: options.pr, headSha: diagnosedHeadSha },
    htmlPath: path.resolve(options.htmlOutput),
    reviewFile,
    hosting,
    policy,
    review,
    caps,
  };
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: result.ok });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
