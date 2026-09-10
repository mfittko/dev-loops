#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: create-label.mjs --repo <owner/name> --name <label> [--color <hex>] [--description <text>] [--force]
Create (or idempotently reuse) a GitHub label. Thin wrapper over \`gh label create\`
— use this instead of an agent-level raw \`gh label create\` so the loop's
internal-tooling record stays clean (siblings: comment-issue.mjs, edit-pr.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --name <label>                Label name to create
Optional:
  --color <hex>                 Hex color without '#' (default: d73a4a)
  --description <text>          Label description
  --force                       Update the label if it already exists
Output (stdout, JSON):
  { "ok": true, "created": true, "name": "gate:full", "color": "d73a4a", "repo": "owner/repo" }
  { "ok": true, "created": false, "alreadyExists": true, "name": "gate:full" }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (created or already exists)
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseCreateLabelCliArgs(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      name: { type: "string" },
      color: { type: "string" },
      description: { type: "string" },
      force: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: false,
    strict: false,
  });
  if (values.help) {
    return { help: true };
  }
  const repo = typeof values.repo === "string" ? values.repo.trim() : undefined;
  const name = typeof values.name === "string" ? values.name.trim() : undefined;
  if (!repo || !name) {
    throw parseError("Creating a label requires both --repo <owner/name> and --name <label>");
  }
  try {
    parseRepoSlug(repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  const color = typeof values.color === "string" && values.color.trim().length > 0 ? values.color.trim() : "d73a4a";
  const description =
    typeof values.description === "string" && values.description.length > 0 ? values.description : undefined;
  return {
    help: false,
    repo,
    name,
    color,
    description,
    force: values.force === true,
    jq: values.jq,
    silent: values.silent === true,
  };
}

// Pure: assemble the `gh label create` argv. Exported so the arg shape can be
// tested without spawning gh.
export function buildLabelArgs({ repo, name, color, description, force }) {
  const args = ["label", "create", name, "--repo", repo, "--color", color];
  if (description !== undefined) {
    args.push("--description", description);
  }
  if (force) {
    args.push("--force");
  }
  return args;
}

export function createLabel(options, { ghCommand = "gh", exec = execFileSync } = {}) {
  const args = buildLabelArgs(options);
  try {
    exec(ghCommand, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : String(error?.stderr ?? "");
    // Without --force, gh errors if the label exists. Treat that as idempotent
    // success so re-runs are safe; any other failure propagates.
    if (!options.force && /already exists/i.test(stderr)) {
      return { ok: true, created: false, alreadyExists: true, name: options.name };
    }
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`gh label create failed: ${detail}`);
  }
  return { ok: true, created: true, name: options.name, color: options.color, repo: options.repo };
}

export function run(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, ghCommand = "gh", exec = execFileSync } = {},
) {
  let options;
  try {
    options = parseCreateLabelCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  let result;
  try {
    result = createLabel(options, { ghCommand, exec });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

export const main = run;

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = run();
}
