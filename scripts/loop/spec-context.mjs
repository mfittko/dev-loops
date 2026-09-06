#!/usr/bin/env node
/**
 * spec-context.mjs — the CLI seam the skill runs so it never hand-derives the
 * spec/digests (issue 2008 / ADR 0061 AC5). Two modes:
 *
 *   extract (default): resolve the canonical tracker issue body, extract the
 *   structured spec, and compute both revision-identity digests (specDigest,
 *   contentDigest) plus the complete criterion id set — everything judge-pass
 *   --spec-file/--content-digest needs, in one deterministic call.
 *
 *   changed-paths: emit the JSON string array of repo-relative paths changed
 *   between two refs — the --changed-paths input for judge-pass's AC7
 *   affected-criteria producer.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfig } from "@dev-loops/core/config";
import {
  computeContentDigest,
  computeSpecDigest,
  extractSpecFromBody,
  specCriterionIds,
} from "@dev-loops/core/loop/spec-authority";
import { resolveTrackerAdapter } from "@dev-loops/core/tracker";

import { parseIssueNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { captureChangedFilesBetween } from "../lib/git-delta.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveTrackerLocalSpec } from "../github/resolve-tracker-local-spec.mjs";

const USAGE = `Usage:
  spec-context.mjs --repo <owner/name> --issue <number> --content-file <path> [--head-sha <sha>] [--spec-out <path>]
  spec-context.mjs changed-paths --base <ref> --head <ref> [--repo-root <path>]

Default (extract) mode: resolve the canonical tracker issue body, extract the
structured spec ({ acceptanceCriteria, definitionOfDone, nonGoals }), and
compute specDigest (from the spec) + contentDigest (from --content-file) +
the complete criterionIds set — feeds judge-pass.mjs's --spec-file/
--content-digest directly, so the skill never hand-derives them.
Required (extract mode):
  --repo <owner/name>        Repository slug
  --issue <number>           Canonical tracker issue number
  --content-file <path>      Path to the reviewed implementation/prose content;
                              its bytes are hashed into contentDigest
Optional (extract mode):
  --head-sha <sha>            Echoed onto the result (not hashed into any digest)
  --spec-out <path>           Also write the structured spec JSON to this path
                              (the shape judge-pass.mjs --spec-file expects)

changed-paths mode: emit the JSON string array of repo-relative paths changed
between --base and --head (two-dot delta, reusing the same git isolation seam
as resolve-angle-carry-forward.mjs) — feeds judge-pass.mjs's --changed-paths.
Required (changed-paths mode):
  --base <ref>
  --head <ref>
Optional (changed-paths mode):
  --repo-root <path>           Worktree root the delta is computed against
                                (default: process.cwd())

${JQ_OUTPUT_USAGE}

Exit codes:
  0  Success
  1  Argument error or resolution failure
  2  Invalid --jq filter
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

// ---------------------------------------------------------------------------
// extract mode
// ---------------------------------------------------------------------------

function parseExtractCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      "content-file": { type: "string" },
      "head-sha": { type: "string" },
      "spec-out": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    mode: "extract",
    help: false,
    repo: undefined,
    issue: undefined,
    contentFile: undefined,
    headSha: undefined,
    specOut: undefined,
    jq: undefined,
    silent: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "issue") {
      options.issue = parseIssueNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "content-file") {
      options.contentFile = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "head-sha") {
      const sha = requireTokenValue(token, parseError).trim().toLowerCase();
      if (!/^[0-9a-f]{7,64}$/.test(sha)) {
        throw parseError("--head-sha must be a 7-64 char hex SHA");
      }
      options.headSha = sha;
      continue;
    }
    if (token.name === "spec-out") {
      options.specOut = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined || options.contentFile === undefined) {
    throw parseError("extract mode requires --repo <owner/name>, --issue <number>, and --content-file <path>");
  }
  if (options.contentFile.length === 0) {
    throw parseError("--content-file requires a non-empty path");
  }
  if (options.specOut !== undefined && options.specOut.length === 0) {
    throw parseError("--spec-out requires a non-empty path");
  }
  return options;
}

/**
 * Pure-ish extract: resolves the tracker issue body (network via the tracker
 * adapter), extracts the structured spec, and computes both revision-identity
 * digests + the complete criterion id set.
 */
export async function specContextExtract(
  options,
  { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), tracker } = {},
) {
  const resolvedTracker = tracker ?? await (async () => {
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    return resolveTrackerAdapter(errors.length === 0 ? config : {}, { env, ghCommand });
  })();
  const resolved = await resolveTrackerLocalSpec(
    { repo: options.repo, issue: options.issue },
    { env, ghCommand, tracker: resolvedTracker },
  );
  const spec = extractSpecFromBody(resolved.body);
  let contentBytes;
  try {
    contentBytes = await readFile(path.resolve(repoRoot, options.contentFile), "utf8");
  } catch (error) {
    throw new Error(`Cannot read --content-file "${options.contentFile}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const specDigest = computeSpecDigest(spec);
  const contentDigest = computeContentDigest(contentBytes);
  const criterionIds = specCriterionIds(spec);
  const result = {
    ok: true,
    repo: resolved.repo,
    issue: resolved.issue,
    spec,
    specDigest,
    contentDigest,
    criterionIds,
    ...(options.headSha !== undefined ? { headSha: options.headSha } : {}),
  };
  if (options.specOut !== undefined) {
    const specPath = path.resolve(repoRoot, options.specOut);
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    result.specOut = options.specOut;
  }
  return result;
}

// ---------------------------------------------------------------------------
// changed-paths mode
// ---------------------------------------------------------------------------

function parseChangedPathsCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      base: { type: "string" },
      head: { type: "string" },
      "repo-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    mode: "changed-paths",
    help: false,
    base: undefined,
    head: undefined,
    repoRoot: undefined,
    jq: undefined,
    silent: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "base") {
      options.base = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "head") {
      options.head = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "repo-root") {
      options.repoRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.base || !options.head) {
    throw parseError("changed-paths mode requires --base <ref> and --head <ref>");
  }
  return options;
}

export function specContextChangedPaths(options, { repoRoot = process.cwd() } = {}) {
  const resolvedRoot = options.repoRoot ? path.resolve(repoRoot, options.repoRoot) : repoRoot;
  const { changedFiles } = captureChangedFilesBetween({ base: options.base, head: options.head, repoRoot: resolvedRoot });
  return { ok: true, base: options.base, head: options.head, changedFiles };
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

export function parseSpecContextCliArgs(argv) {
  if (argv[0] === "changed-paths") {
    return parseChangedPathsCliArgs(argv.slice(1));
  }
  return parseExtractCliArgs(argv);
}

async function main() {
  let options;
  try {
    options = parseSpecContextCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = options.mode === "changed-paths"
      ? specContextChangedPaths(options)
      : await specContextExtract(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
