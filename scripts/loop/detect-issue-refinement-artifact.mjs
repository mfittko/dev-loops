#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  detectIssueRefinementArtifact,
  REFINEMENT_SOURCE,
} from "@dev-loops/core/loop/issue-refinement-artifact";
const USAGE = `Usage:
  detect-issue-refinement-artifact.mjs --repo <owner/name> --issue <number>
  detect-issue-refinement-artifact.mjs --input <path>
Detect whether a GitHub issue carries an explicit refinement artifact
(Acceptance criteria section, DoD section, or linked refinement doc).
Required (exactly one):
  --repo <owner/name>   Repository slug (e.g. owner/name)
  --issue <number>      Issue number
  --input <path>        Path to a JSON file with { "repo", "issue", "body" }
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/name",
    "issue": 532,
    "source": "issue-body-ac" | "issue-body-dod" | "linked-doc" | "missing",
    "hasACs": true | false,
    "acItems": [...],
    "dodItems": [...],
    "linkedDoc": { "found": true, "path": "...", "reason": "..." },
    "finding": "missing_refinement_artifact" | null,
    "reason": "..."
  }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectIssueRefinementArtifactCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    issue: undefined,
    input: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--issue") {
      const value = requireOptionValue(args, "--issue", parseError);
      if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw parseError("--issue must be a positive integer");
      }
      options.issue = Number(value);
      continue;
    }
    if (token === "--input") {
      options.input = requireOptionValue(args, "--input", parseError).trim();
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  const hasInput = typeof options.input === "string" && options.input.length > 0;
  const hasRemote = typeof options.repo === "string" && options.repo.length > 0 && Number.isInteger(options.issue);
  if (options.help) {
    return options;
  }
  if (hasInput === hasRemote) {
    throw parseError("Provide exactly one of --input <path> or --repo <owner/name> --issue <number>");
  }
  return options;
}
async function fetchIssueBody({ repo, issue }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["issue", "view", String(issue), "--repo", repo, "--json", "body"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout, { label: "gh issue view" });
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid gh issue view payload: missing body");
  }
  return typeof payload.body === "string" ? payload.body : "";
}
async function loadInputPayload(inputPath) {
  const text = await readFile(inputPath, "utf8");
  const payload = parseJsonText(text, { label: `input file ${inputPath}` });
  if (!payload || typeof payload !== "object") {
    throw new Error(`Input file ${inputPath} must be a JSON object`);
  }
  return payload;
}
function toOutput(repo, issue, artifact) {
  return {
    ok: true,
    repo: repo ?? null,
    issue: issue ?? null,
    source: artifact.source,
    hasACs: artifact.hasACs,
    acItems: artifact.acItems,
    dodItems: artifact.dodItems,
    linkedDoc: artifact.linkedDoc,
    sections: artifact.sections,
    finding: artifact.finding,
    reason: artifact.reason,
    sources: REFINEMENT_SOURCE,
  };
}
export async function detectIssueRefinementArtifactFromOptions(options, { env = process.env, ghCommand = "gh" } = {}) {
  if (typeof options.input === "string" && options.input.length > 0) {
    const payload = await loadInputPayload(options.input);
    const body = typeof payload.body === "string" ? payload.body : "";
    const issue = Number.isInteger(payload.issue) ? payload.issue : options.issue ?? null;
    const repo = typeof payload.repo === "string" ? payload.repo : options.repo ?? null;
    const artifact = detectIssueRefinementArtifact({ body, issueNumber: issue });
    return toOutput(repo, issue, artifact);
  }
  if (typeof options.repo === "string" && options.repo.length > 0 && Number.isInteger(options.issue)) {
    parseRepoSlug(options.repo);
    const body = await fetchIssueBody({ repo: options.repo, issue: options.issue }, { env, ghCommand });
    const artifact = detectIssueRefinementArtifact({ body, issueNumber: options.issue });
    return toOutput(options.repo, options.issue, artifact);
  }
  throw new Error("detect-issue-refinement-artifact requires either --input <path> or --repo/--issue");
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  let options;
  try {
    options = parseDetectIssueRefinementArtifactCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await detectIssueRefinementArtifactFromOptions(options, { env, ghCommand });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  const code = await runCli();
  if (code !== 0) {
    process.exitCode = code;
  }
}
