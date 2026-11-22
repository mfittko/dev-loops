#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import {
  fetchSpecChangeFacts,
  interpretRefinementGrillState,
  normalizeGrillSnapshot,
} from "@dev-loops/core/loop/refinement-grill-state";
import { buildGrillFactsSnapshot } from "@dev-loops/core/loop/issue-refinement-artifact";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const HELP = `Usage: detect-refinement-grill-state.mjs [--input <path> | --body-file <path> [--surface issue|pr|plan] [--comments-file <path>] [--repo <owner/name> --number <n>]]
Detect refinement/grill sub-loop state.
Modes (choose exactly one):
  --input <path>                  Interpret a JSON grill snapshot from file
  --body-file <path>              Seed the deterministic already-refined / zero-iteration
                                  snapshot from a markdown body on disk
Options (body-file mode only):
  --surface issue|pr|plan         Surface the body belongs to (default: issue)
  --comments-file <path>          JSON array of comments (or { "comments": [...] }), each a
                                  string or an object with a string "body"; detects recorded
                                  grill provenance (a posted "🔬 Grill / refinement results"
                                  comment, optionally carrying a recorded bypass line); a
                                  comment's "createdAt" feeds the spec-changed check; when no
                                  results comment carries a parseable "createdAt", the check
                                  fails closed (detect_gaps / spec_changed_since_grill)
  --repo <owner/name> --number <n>
                                  Read the target's comments (with the truncation flag) and GraphQL
                                  body "lastEditedAt" (issue or PR). The fetched comments replace
                                  --comments-file, so the grill and startup read the same window.
                                  A counted comment or a body edit after the latest results comment
                                  returns detect_gaps / spec_changed_since_grill. On an issue, a body
                                  without a "## Simplest design" section returns detect_gaps /
                                  simplest_design_missing, and a latest results comment without a
                                  balanced "simplicity-review: <n> findings, <n> corrected, <n> rejected"
                                  line returns detect_gaps / simplicity_review_missing

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;

const VALID_SURFACES = new Set(["issue", "pr", "plan"]);

export function parseDetectGrillCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      "body-file": { type: "string" },
      surface: { type: "string" },
      "comments-file": { type: "string" },
      repo: { type: "string" },
      number: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    inputPath: undefined,
    bodyFilePath: undefined,
    surface: undefined,
    commentsFilePath: undefined,
    help: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new Error(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token);
      continue;
    }
    if (token.name === "body-file") {
      options.bodyFilePath = requireTokenValue(token);
      continue;
    }
    if (token.name === "surface") {
      const surface = requireTokenValue(token).trim();
      if (!VALID_SURFACES.has(surface)) {
        throw new Error("--surface must be one of: issue, pr, plan");
      }
      options.surface = surface;
      continue;
    }
    if (token.name === "comments-file") {
      options.commentsFilePath = requireTokenValue(token);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token).trim();
      continue;
    }
    if (token.name === "number") {
      options.number = parsePositiveInteger(requireTokenValue(token), "--number");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t))) continue;
    throw new Error(`Unknown argument: ${token.rawName}`);
  }
  const hasInput = options.inputPath !== undefined;
  const hasBodyFile = options.bodyFilePath !== undefined;
  if (hasInput === hasBodyFile) {
    throw new Error("Provide exactly one input source: --input <path> or --body-file <path>");
  }
  if (hasInput && options.surface !== undefined) {
    throw new Error("--surface applies only to --body-file mode");
  }
  if (hasInput && options.commentsFilePath !== undefined) {
    throw new Error("--comments-file applies only to --body-file mode");
  }
  if ((options.repo === undefined) !== (options.number === undefined)) {
    throw new Error("--repo and --number must be given together");
  }
  if (options.repo !== undefined && (hasInput || options.surface === "plan")) {
    throw new Error("--repo/--number apply only to --body-file mode on an issue or pr surface");
  }
  return options;
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, runChild: run = runChild, env = process.env } = {},
) {
  const options = parseDetectGrillCliArgs(argv);
  if (options.help) { stdout.write(HELP); return; }

  let snapshot;
  if (options.inputPath) {
    const text = await readFile(options.inputPath, "utf8");
    snapshot = normalizeGrillSnapshot(parseJsonText(text));
  } else {
    const body = await readFile(options.bodyFilePath, "utf8");
    const surface = options.surface ?? "issue";
    let comments = [];
    if (options.commentsFilePath) {
      const commentsText = await readFile(options.commentsFilePath, "utf8");
      const parsedComments = parseJsonText(commentsText);
      comments = Array.isArray(parsedComments)
        ? parsedComments
        : (parsedComments && typeof parsedComments === "object" && Array.isArray(parsedComments.comments)
          ? parsedComments.comments
          : undefined);
      if (comments === undefined) {
        throw new Error('--comments-file must be a JSON array or { "comments": [...] }');
      }
    }
    // --repo/--number read through the same facts reader as startup, so both see the same comment window.
    const facts = options.repo !== undefined
      ? await fetchSpecChangeFacts({ repo: options.repo, number: options.number, env, runChild: run })
      : null;
    if (facts) comments = facts.comments;
    const bodyLastEditedAt = facts?.lastEditedAt ?? null;
    // Deterministic seed for the already-refined / zero-iteration path only: the full
    // semantic gap detection (scope/actor/decision) is the agent-layer bounded input consumed
    // at await_answers. This body-file mode computes ONLY the deterministic AC-presence signal
    // via the single is-it-refined source of truth, detectIssueRefinementArtifact, plus the
    // recorded-provenance signal from the comments (ADR 0084); startup reads the same facts through the same function.
    snapshot = buildGrillFactsSnapshot({ body, comments, bodyLastEditedAt, commentsTruncated: facts?.commentsTruncated, surface });
  }

  const interpretation = interpretRefinementGrillState(snapshot);
  process.exitCode = emitResult(
    {
      ok: true,
      snapshot,
      state: interpretation.state,
      allowedTransitions: interpretation.allowedTransitions,
      nextAction: interpretation.nextAction,
      reason: interpretation.reason,
      bypass: interpretation.bypass,
    },
    { jq: options.jq, silent: options.silent, stdout, stderr },
  );
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
