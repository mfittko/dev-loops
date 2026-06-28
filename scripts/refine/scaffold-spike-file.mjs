#!/usr/bin/env node
// Scaffold a STARTABLE spike findings artifact from an inline question (#988 P2).
//
// `/start-spike <question>` needs a findings artifact that passes
// `validateSpikeExplorationSections` (non-empty Question/Approach/Findings) so
// `resolve-dev-loop-startup --spike <path>` accepts it. This is the only new
// piece behind /start-spike: a pure section builder + a thin file writer. The
// Recommendation is left for the spike to fill in (the exit marker), matching
// the spike-mode contract — so this scaffolds an in-progress spike, not a
// ready-for-exit one. No new spike behavior; the intake/gate/exit machinery is
// the shipped #964/#965/#966 surface.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { SPIKE_FILE_EXPLORATION_SECTIONS } from "./validate-spike-file.mjs";

// Placeholder bodies the operator fills in during the spike. Non-empty so the
// exploration scaffold validates; explicitly marked TBD so they are obviously
// stubs, not findings. (`Recommendation` is intentionally omitted — it is the
// exit marker, written when the spike concludes.)
const PLACEHOLDER = "TBD — filled in during the spike.";

const USAGE = `Usage: dev-loops refine scaffold-spike --question <text> --out <path>

Scaffold a startable spike findings artifact from an inline question. Writes a
file carrying the exploration scaffold (## Question filled from --question,
## Approach/## Findings stubbed) so \`resolve-dev-loop-startup --spike <path>\`
accepts it. The ## Recommendation is left for the spike to fill in.

Options:
  --question <text>   Required. The question the spike investigates.
  --out <path>        Required. Where to write the findings artifact.
  --help, -h          Show this help.

Output (stdout):
  JSON: { ok: true, path: "<abs>", question: "<text>" }

${JQ_OUTPUT_USAGE}
`.trim();

// Pure builder: question text -> a findings-artifact markdown body carrying the
// exploration scaffold. Question gets the operator's text; Approach/Findings get
// non-empty placeholder bodies so the exploration scaffold validates.
export function buildSpikeScaffold(question) {
  const trimmed = String(question ?? "").trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error("--question must be non-empty"), { code: "INVALID_ARGS" });
  }
  const bodies = { Question: trimmed, Approach: PLACEHOLDER, Findings: PLACEHOLDER };
  const sections = SPIKE_FILE_EXPLORATION_SECTIONS.map(
    (heading) => `## ${heading}\n\n${bodies[heading]}\n`,
  );
  return `# Spike\n\n${sections.join("\n")}`;
}

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE, code: "INVALID_ARGS" });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw parseError(message);
    }
    return v;
  };

  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      question: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unexpected argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        args.help = true;
        break;
      case "json":
        // Output is JSON by default; accepted as a no-op for callers that pass it.
        break;
      case "question":
        args.question = requireValue(token, "--question requires a value");
        break;
      case "out":
        args.out = requireValue(token, "--out requires a value (path)");
        break;
      case "jq":
        args.jq = requireValue(token, "--jq requires a filter");
        break;
      case "silent":
        args.silent = true;
        break;
      default:
        throw parseError(`Unknown flag: ${token.rawName}`);
    }
  }
  return args;
}

export async function main(args, { writeFileImpl = writeFile, mkdirImpl = mkdir } = {}) {
  if (!args.question) {
    throw Object.assign(new Error("--question is required"), { usage: USAGE, code: "INVALID_ARGS" });
  }
  if (!args.out) {
    throw Object.assign(new Error("--out is required"), { usage: USAGE, code: "INVALID_ARGS" });
  }
  const body = buildSpikeScaffold(args.question);
  const outPath = path.resolve(args.out);
  await mkdirImpl(path.dirname(outPath), { recursive: true });
  await writeFileImpl(outPath, body, "utf8");
  return { ok: true, path: outPath, question: String(args.question).trim() };
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await main(args);
    process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = err.code === "INVALID_ARGS" ? 1 : 2;
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 2;
  });
}
