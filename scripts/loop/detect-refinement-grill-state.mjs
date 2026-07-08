#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import {
  interpretRefinementGrillState,
  normalizeGrillSnapshot,
} from "@dev-loops/core/loop/refinement-grill-state";
import { detectIssueRefinementArtifact } from "@dev-loops/core/loop/issue-refinement-artifact";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const HELP = `Usage: detect-refinement-grill-state.mjs [--input <path> | --body-file <path> [--surface issue|pr|plan]]
Detect refinement/grill sub-loop state.
Modes (choose exactly one):
  --input <path>                  Interpret a JSON grill snapshot from file
  --body-file <path>              Seed the deterministic already-refined / zero-iteration
                                  snapshot from a markdown body on disk
Options (body-file mode only):
  --surface issue|pr|plan         Surface the body belongs to (default: issue)

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
  return options;
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr } = {},
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
    // Deterministic seed for the already-refined / zero-iteration path only: the full
    // semantic gap detection (scope/actor/decision) is the agent-layer bounded input consumed
    // at await_answers. This body-file mode computes ONLY the deterministic AC-presence signal
    // via the single is-it-refined source of truth, detectIssueRefinementArtifact.
    const artifact = detectIssueRefinementArtifact({ body });
    snapshot = normalizeGrillSnapshot({
      loaded: true,
      detectRan: true,
      surface,
      openGapCount: artifact.finding ? 1 : 0,
      unresolvedGapCount: 0,
    });
  }

  const interpretation = interpretRefinementGrillState(snapshot);
  process.exitCode = emitResult(
    {
      ok: true,
      snapshot,
      state: interpretation.state,
      allowedTransitions: interpretation.allowedTransitions,
      nextAction: interpretation.nextAction,
    },
    { jq: options.jq, silent: options.silent, stdout, stderr },
  );
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
