#!/usr/bin/env node
/**
 * spec-context.mjs — the CLI seam the skill runs so it never hand-derives the
 * spec/digests (ADR 0061 AC5). Two modes:
 *
 *   extract (default): resolve the canonical issue or live PR body, extract the
 *   structured spec, and compute both revision-identity digests (specDigest,
 *   contentDigest) plus the complete criterion id set — everything judge-pass
 *   --spec-file/--content-digest needs, in one deterministic call.
 *
 *   changed-paths: emit the JSON string array of repo-relative paths changed
 *   between two refs — the --changed-paths input for judge-pass's ADR 0061
 *   AC7 affected-criteria producer.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfig } from "@dev-loops/core/config";
import {
  buildRevisionIdentity,
  computeContentDigest,
  computeSpecDigest,
  requireSpecFromBody,
  resolvePrDescriptionSpec,
  specCriterionIds,
} from "@dev-loops/core/loop/spec-authority";
import { resolveTrackerAdapter } from "@dev-loops/core/tracker";
import { rateLimitedResult, withGraphqlRateLimitWait } from "@dev-loops/core/github/gh";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { GRAPHQL_RATE_LIMIT_MAX_WAIT_MS } from "@dev-loops/core/loop/policy-constants";
import { setTimeout as delay } from "node:timers/promises";

import { parseIssueNumber, parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { captureChangedFilesBetween } from "../lib/git-delta.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveTrackerLocalSpec } from "../github/resolve-tracker-local-spec.mjs";
import { viewPr } from "../github/view-pr.mjs";

const USAGE = `Usage:
  spec-context.mjs --repo <owner/name> (--issue <number> | --pr <number> | --body-file <path>) --content-file <path> [--head-sha <sha>] [--spec-out <path>] [--identity-out <path>]
  spec-context.mjs changed-paths --base <ref> --head <ref> [--repo-root <path>]

Default (extract) mode: resolve the selected canonical issue or live PR body, extract the
structured spec ({ acceptanceCriteria, definitionOfDone, nonGoals }), and
compute specDigest (from the spec) + contentDigest (from --content-file) +
the complete criterionIds set — feeds judge-pass.mjs's --spec-file/
--content-digest directly, so the skill never hand-derives them.
Required (extract mode):
  --repo <owner/name>        Repository slug
  --issue <number>           Canonical tracker issue number; exactly one of --issue/--pr
  --pr <number>              Live GitHub PR number when routed authority is pr_body;
                              reads its own body/head without fetching an issue
  --body-file <path>         Standalone review gate: a PR description read from a file
                              (fetch it with scripts/github/view-pr.mjs). Resolves a
                              formal spec (specSource "pr_body"), else a scope-only
                              spec (specSource "pr_scope", specKind "pr_scope", no
                              fabricated criteria), else { specSource: "none",
                              reason: "no_usable_scope" } with no spec or digests.
                              Mutually exclusive with --issue/--pr.
  --content-file <path>      Path to the reviewed implementation/prose content;
                              its bytes are hashed into contentDigest
Optional (extract mode):
  --head-sha <sha>            Echoed onto the result (not hashed into any digest);
                              REQUIRED alongside --identity-out
                              For --pr, must be the full live PR head SHA
  --spec-out <path>           Also write the structured spec JSON to this path
                              (the shape judge-pass.mjs --spec-file expects)
  --identity-out <path>       Also write the revision-identity stamp JSON
                              { specDigest, headSha, contentDigest, checkedCriteria }
                              this call's own digests + specCriterionIds() —
                              the exact shape every writer's --spec-authority
                              <path> flag reads (issue 2008 / ADR 0061 AC1).
                              Requires --head-sha (fail-closed: the identity
                              is incomplete without it).

changed-paths mode: emit the JSON string array of repo-relative paths changed
between --base and --head (two-dot delta, reusing the same git isolation seam
as resolve-angle-carry-forward.mjs) — feeds judge-pass.mjs's --changed-paths.
Required (changed-paths mode):
  --base <ref>
  --head <ref>
Optional (changed-paths mode):
  --repo-root <path>           Worktree root the delta is computed against
                                (default: process.cwd())

GraphQL rate limit (extract mode): on GraphQL exhaustion the tool waits up to
${GRAPHQL_RATE_LIMIT_MAX_WAIT_MS / 60_000} minutes for the reset and retries once. Otherwise it returns at once with
  { "ok": false, "code": "RATE_LIMITED", "error": "...", "resetAt": "<ISO 8601>"|null }
The RATE_LIMITED envelope is written to stdout when output is unfiltered, and
always to stderr.

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
      pr: { type: "string" },
      "body-file": { type: "string" },
      "content-file": { type: "string" },
      "head-sha": { type: "string" },
      "spec-out": { type: "string" },
      "identity-out": { type: "string" },
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
    pr: undefined,
    bodyFile: undefined,
    contentFile: undefined,
    headSha: undefined,
    specOut: undefined,
    identityOut: undefined,
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
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "body-file") {
      options.bodyFile = requireTokenValue(token, parseError).trim();
      if (options.bodyFile.length === 0) throw parseError("--body-file requires a non-empty path");
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
    if (token.name === "identity-out") {
      options.identityOut = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.contentFile === undefined ||
      [options.issue, options.pr, options.bodyFile].filter((value) => value !== undefined).length !== 1) {
    throw parseError("extract mode requires --repo <owner/name>, exactly one of --issue <number>, --pr <number> or --body-file <path>, and --content-file <path>");
  }
  if (options.contentFile.length === 0) {
    throw parseError("--content-file requires a non-empty path");
  }
  if (options.specOut !== undefined && options.specOut.length === 0) {
    throw parseError("--spec-out requires a non-empty path");
  }
  if (options.identityOut !== undefined) {
    if (options.identityOut.length === 0) {
      throw parseError("--identity-out requires a non-empty path");
    }
    if (options.headSha === undefined) {
      throw parseError("--identity-out requires --head-sha (the revision identity is incomplete without it)");
    }
  }
  return options;
}

/**
 * Pure-ish extract: resolves the selected issue or PR body, extracts the
 * structured spec, and computes both revision-identity
 * digests + the complete criterion id set.
 */
export async function specContextExtract(
  options,
  { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), tracker, sleep = delay, now = Date.now, runChild } = {},
) {
  if ([options.issue, options.pr, options.bodyFile].filter((value) => value !== undefined).length !== 1) {
    throw new Error("extract mode requires exactly one of --issue, --pr or --body-file");
  }
  const { owner, name } = parseRepoSlug(options.repo);
  const repo = `${owner}/${name}`;
  let resolved;
  try {
    let readSource;
    if (options.bodyFile !== undefined) {
      readSource = async () => {
        try {
          return { repo, body: await readFile(path.resolve(repoRoot, options.bodyFile), "utf8") };
        } catch (error) {
          throw new Error(`Cannot read --body-file "${options.bodyFile}": ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    } else if (options.pr !== undefined) {
      readSource = async () => {
        const { pr } = await viewPr(
          { repo, pr: options.pr, fields: "number,body,headRefOid" },
          { env, ghCommand, ...(runChild ? { run: runChild } : {}) },
        );
        if (pr.number !== options.pr || typeof pr.body !== "string" ||
            typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(pr.headRefOid)) {
          throw new Error("Cannot resolve usable live PR data (number, body and full head SHA required)");
        }
        if (options.headSha !== undefined && options.headSha.toLowerCase() !== pr.headRefOid.toLowerCase()) {
          throw new Error("--head-sha must match the full live PR head SHA");
        }
        return { repo, pr: pr.number, body: pr.body };
      };
    } else {
      const resolvedTracker = tracker ?? await (async () => {
        const { config, errors } = await loadDevLoopConfig({ repoRoot });
        return resolveTrackerAdapter(errors.length === 0 ? config : {}, { env, ghCommand });
      })();
      readSource = () => resolveTrackerLocalSpec(
        { repo, issue: options.issue }, { env, ghCommand, tracker: resolvedTracker },
      );
    }
    resolved = await withGraphqlRateLimitWait(
      readSource,
      { maxWaitMs: GRAPHQL_RATE_LIMIT_MAX_WAIT_MS, sleep, now, env, ghCommand, ...(runChild ? { runChild } : {}) },
    );
  } catch (error) {
    if (error?.code !== "RATE_LIMITED") throw error;
    return rateLimitedResult(error);
  }
  let spec;
  let specSource = options.issue !== undefined ? "issue" : "pr_body";
  if (options.bodyFile !== undefined) {
    const prSpec = resolvePrDescriptionSpec(resolved.body);
    if (prSpec.specSource === "none") return { ok: true, repo: resolved.repo, ...prSpec };
    ({ spec, specSource } = prSpec);
  } else {
    spec = requireSpecFromBody(resolved.body);
  }
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
    ...(options.pr !== undefined ? { pr: resolved.pr } : options.issue !== undefined ? { issue: resolved.issue } : {}),
    specSource,
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
  if (options.identityOut !== undefined) {
    if (options.headSha === undefined) {
      throw new Error("--identity-out requires --head-sha (the revision identity is incomplete without it)");
    }
    // AC1 (issue 2008 / ADR 0061): reuse buildRevisionIdentity for its
    // fail-closed distinctness/embedding checks — never hand-build the
    // digest trio a second time — and specCriterionIds for the checked-set,
    // producing the exact shape every writer's --spec-authority <path> reads.
    const identity = buildRevisionIdentity({ specDigest, headSha: options.headSha, contentDigest });
    const identityPath = path.resolve(repoRoot, options.identityOut);
    await mkdir(path.dirname(identityPath), { recursive: true });
    await writeFile(
      identityPath,
      `${JSON.stringify({ ...identity, checkedCriteria: criterionIds }, null, 2)}\n`,
      "utf8",
    );
    result.identityOut = options.identityOut;
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

export async function specContextChangedPaths(options, { repoRoot = process.cwd() } = {}) {
  const resolvedRoot = options.repoRoot ? path.resolve(repoRoot, options.repoRoot) : repoRoot;
  const { changedFiles } = await captureChangedFilesBetween({ base: options.base, head: options.head, repoRoot: resolvedRoot });
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

/** CLI entry; returns the exit code. `extractDeps` feeds specContextExtract (test seam). */
export async function runCli(
  argv,
  { stdout = process.stdout, stderr = process.stderr, extractDeps = undefined } = {},
) {
  let options;
  try {
    options = parseSpecContextCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = options.mode === "changed-paths"
      ? await specContextChangedPaths(options)
      : await specContextExtract(options, extractDeps);
    // --jq/--silent would filter the RATE_LIMITED envelope away (a `.contentDigest`
    // read prints null); always keep code/resetAt on the stderr error surface.
    if (result?.ok === false) {
      stderr.write(`${JSON.stringify({ ok: false, code: result.code, error: result.error, resetAt: result.resetAt ?? null })}\n`);
    }
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
