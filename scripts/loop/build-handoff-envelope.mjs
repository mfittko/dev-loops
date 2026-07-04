#!/usr/bin/env node
/**
 * CLI wrapper for buildDevLoopHandoffEnvelope().
 *
 * Subagents and shell scripts should call this instead of writing ad-hoc
 * inline Node.js to import from the @dev-loops/core subpath. Using the
 * bare `@dev-loops/core` specifier fails because the package has no
 * default export — only named subpath exports.
 *
 * Typical usage (pipeline):
 *   dev-loops loop startup --issue 42 > resolver-output.json
 *   dev-loops loop build-envelope --input resolver-output.json
 *
 * Or via npx:
 *   npx dev-loops@<version> loop build-envelope --input resolver-output.json
 */
import { readFile } from "node:fs/promises";
import { detectRepoSlug } from "@dev-loops/core/github/repo-slug";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildDevLoopHandoffEnvelope } from "@dev-loops/core/loop/handoff-envelope";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { createPiAdapter } from "@dev-loops/core/harness";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: build-handoff-envelope.mjs --input <path>
Build a deterministic handoff envelope from startup resolver output and settings.
Required:
  --input <path>         Path to resolver output JSON (from resolve-dev-loop-startup.mjs)
Optional:
  --gate-state <json>    Gate state JSON string
                           { currentHeadSha?, ciStatus?, unresolvedThreadCount?, copilotRoundCount?, retrospectiveFindings? }
  --overrides <json>     Overrides JSON string
                           { mergeAuthorized?, preferLocal?, scopeConstraint?, customStopAt? }
  --repo <owner/name>    Repository slug override (falls back to bundle.repoSlug or bundle.repo)
Output (stdout, JSON):
  Handoff envelope object — see workflow-handoff-contract.md for schema.
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  Runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or runtime failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

function parseFlagJson(raw, flagName, parseErrorFn) {
  try {
    return parseJsonText(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseErrorFn(`Invalid JSON for ${flagName}: ${message}`);
  }
}

export function parseBuildHandoffEnvelopeCliArgs(argv) {
  const options = {
    help: false,
    inputPath: undefined,
    gateState: undefined,
    overrides: undefined,
    repo: undefined,
  };

  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      "gate-state": { type: "string" },
      overrides: { type: "string" },
      repo: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "gate-state") {
      options.gateState = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "overrides") {
      options.overrides = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }

  if (!options.inputPath) {
    throw parseError("--input <path> is required");
  }

  return options;
}


export async function buildHandoffEnvelopeCli(
  options,
  { adapter = createPiAdapter() } = {},
) {
  // Resolve repo root via the adapter so envelope construction stays harness-agnostic.
  const cwd = adapter.getCwd();
  const repoRoot = adapter.getRepoRoot();

  // Load resolver output from file
  const inputPath = path.resolve(cwd, options.inputPath);
  const inputText = await readFile(inputPath, "utf8");
  const resolverOutput = parseJsonText(inputText);

  // Load dev-loop settings from repo config
  const configLoadResult = await loadDevLoopConfig({ repoRoot });
  const hasConfigErrors = Array.isArray(configLoadResult.errors) && configLoadResult.errors.length > 0;
  const settings = hasConfigErrors ? {} : (configLoadResult.config ?? {});

  // Parse optional gate state
  let gateState = {};
  if (options.gateState) {
    gateState = parseFlagJson(options.gateState, "--gate-state", parseError);
  }

  // Build options for envelope builder
  const envelopeOptions = {};

  // Repo slug: explicit --repo, then resolver output bundle, then git remote
  const bundleSlug = resolverOutput?.bundle?.repoSlug ?? resolverOutput?.bundle?.repo ?? null;
  const repoSlug = options.repo ?? bundleSlug ?? detectRepoSlug(repoRoot);
  if (repoSlug) {
    envelopeOptions.repoSlug = repoSlug;
  } else {
    throw parseError(
      "Repository slug could not be resolved. " +
      "Pass --repo <owner/name>, ensure the resolver output includes a repo slug, " +
      "or configure a git remote 'origin'.",
    );
  }
  envelopeOptions.repoRoot = repoRoot;

  // Parse optional overrides
  if (options.overrides) {
    envelopeOptions.overrides = parseFlagJson(options.overrides, "--overrides", parseError);
  }

  const envelope = buildDevLoopHandoffEnvelope(resolverOutput, settings, gateState, envelopeOptions);
  return envelope;
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, adapter = createPiAdapter() } = {},
) {
  let options;
  try {
    options = parseBuildHandoffEnvelopeCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  try {
    const envelope = await buildHandoffEnvelopeCli(options, { adapter });
    process.exitCode = emitResult(envelope, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (err) {
    const msg = formatCliError(err);
    stderr.write(`${msg}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await runCli();
}
