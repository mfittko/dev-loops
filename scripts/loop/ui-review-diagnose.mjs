#!/usr/bin/env node
/**
 * CLI wrapper for the ui_review diagnose + anchor stage (Stage 3).
 *
 * Reads the drive stage's captured-failures result, reuses PR state from
 * `loop info --pr` (never a re-fetch), fetches the PR's unified diff, and maps
 * each failure to a diff-line anchor or an explicit non-anchorable flag via the
 * pure core (packages/core/src/loop/ui-review-diagnose.mjs). Emits a ranked
 * findings list for the poster stage on the shared --jq/--silent emit path.
 *
 * Thin adapter: the diff fetch and the loop-info read are the only IO. All
 * parsing/mapping/ranking decisions live in core.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, parsePositiveInteger } from "../_cli-primitives.mjs";
import { detectRepoSlug, normalizeRepoSlug } from "@dev-loops/core/github/repo-slug";
import { diagnoseFailures } from "@dev-loops/core/loop/ui-review-diagnose";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

/** The `loop info` script is a same-dir sibling (both live in scripts/loop/). */
export const LOOP_INFO_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "info.mjs");

/** Bound the drive-result read, matching the PR diff fetch's maxBuffer. */
const MAX_DRIVE_RESULT_BYTES = 16 * 1024 * 1024;

const USAGE = `Usage:
  ui-review-diagnose.mjs --pr <number> --drive-result <path> [--repo <slug>]
Map each Stage-2 captured failure (exception + stack/server-log context) to a source
line, then to a PR diff line, producing the {path,line,side:RIGHT} anchors the poster
stage needs (Stage 3 of the ui_review route).
Required:
  --pr <n>            PR number (reused via loop info; scopes the diff fetch).
  --drive-result <p>  Path to the drive stage's JSON result (its failures + captures).
Optional:
  --repo <slug>       Repository slug (auto-detected from the git remote when omitted).
  -h, --help          Show this help.
Output (stdout, JSON):
  { "ok": bool, "pr": {number,headRefName,baseRefName,state},
    "findings": [ { severity, kind, message, exception:{type,message}, source:{file,line}|null,
                    anchor:{path,line,side}|null, anchorable, nonAnchorableReason, evidence } ],
    "counts": { total, anchorable, nonAnchorable } }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseUiReviewDiagnoseCliArgs(argv) {
  const options = { help: false, pr: undefined, driveResult: undefined, repo: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      pr: { type: "string" },
      "drive-result": { type: "string" },
      repo: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInteger(requireTokenValue(token, parseError), "--pr", parseError);
      continue;
    }
    if (token.name === "drive-result") {
      options.driveResult = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (options.pr === undefined) throw parseError("Missing required --pr");
  if (!options.driveResult) throw parseError("Missing required --drive-result");
  return options;
}

/** Reuse PR state from `loop info --pr --json` rather than re-fetching ad hoc. */
function loadPrInfo(pr, repo, cwd) {
  const raw = execFileSync(process.execPath, [LOOP_INFO_SCRIPT, "--pr", String(pr), "--repo", repo, "--json"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const info = JSON.parse(raw);
  const p = info.pr ?? {};
  return { number: p.number ?? pr, headRefName: p.headRefName ?? null, baseRefName: p.baseRefName ?? null, state: p.state ?? null };
}

/** Fetch the PR's unified diff. A bounded read: the diff is the head-vs-base
 * patch the anchor mapping needs; no ad-hoc file/hunk API stitching. */
function loadPrDiff(pr, repo, cwd) {
  return execFileSync("gh", ["pr", "diff", String(pr), "--repo", repo], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseUiReviewDiagnoseCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  const cwd = process.cwd();
  const rawRepo = options.repo || detectRepoSlug(cwd);
  if (!rawRepo) throw parseError("Repo auto-detection failed. Set origin remote or use --repo.");
  const repo = normalizeRepoSlug(rawRepo, { errorMessage: "--repo must match <owner/name>" });

  const driveSize = statSync(options.driveResult).size;
  if (driveSize > MAX_DRIVE_RESULT_BYTES) {
    throw parseError(`--drive-result is too large (${driveSize} bytes > ${MAX_DRIVE_RESULT_BYTES} cap)`);
  }
  const drive = JSON.parse(readFileSync(options.driveResult, "utf8"));
  const pr = loadPrInfo(options.pr, repo, cwd);
  const diffOutput = loadPrDiff(options.pr, repo, cwd);

  const { findings, counts } = diagnoseFailures({
    failures: Array.isArray(drive.failures) ? drive.failures : [],
    captures: Array.isArray(drive.captures) ? drive.captures : [],
    diffOutput,
  });

  // ok reflects a clean review (no findings), consistent with the drive stage.
  const result = { ok: counts.total === 0, pr, findings, counts };
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: result.ok });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
