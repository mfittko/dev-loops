#!/usr/bin/env node
/**
 * audit-pi-session.mjs
 *
 * Audits Pi session transcripts (.jsonl files) to measure token efficiency,
 * detect coordinator context snowballing, and report per-agent/per-unit token breakdowns.
 *
 * Usage:
 *   node scripts/loop/audit-pi-session.mjs [path/to/session.jsonl | path/to/session_dir]
 *   node scripts/loop/audit-pi-session.mjs --latest
 *   node scripts/loop/audit-pi-session.mjs --json
 *   node scripts/loop/audit-pi-session.mjs --jq '.summary.totalTokens'
 */
import { parseArgs } from "node:util";
import path from "node:path";

import {
  findLatestPiSession,
  auditPiSession,
  formatMarkdownSummary,
} from "../lib/audit-pi-session.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import {
  JQ_OUTPUT_PARSE_OPTIONS,
  JQ_OUTPUT_USAGE,
  emitResult,
} from "../lib/jq-output.mjs";

const USAGE = `Usage: audit-pi-session.mjs [session-path] [options]

Audit Pi session transcripts (.jsonl files) to measure token efficiency,
detect context snowballing, and report per-agent token breakdowns.

Arguments:
  [session-path]    Path to a session directory, coordinator session.jsonl,
                    or subagent run folder. A single transcript file is audited
                    alone. If omitted, defaults to --latest.

Options:
  --latest          Automatically find and inspect the latest session for this
                    repository, including its tmp/worktrees session directories
  --json            Emit raw structured JSON instead of human-readable Markdown
  --help, -h        Show this help

${JQ_OUTPUT_USAGE}`;

export async function runAuditCli(
  args = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    findLatestSession = findLatestPiSession,
    cwd = process.cwd(),
  } = {},
) {
  const options = {
    json: false,
    latest: false,
    sessionPath: null,
    jq: undefined,
    silent: false,
    fields: undefined,
  };

  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        latest: { type: "boolean" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      allowPositionals: true,
    });

    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }

    options.json = !!values.json;
    options.latest = !!values.latest;
    options.jq = values.jq;
    options.silent = !!values.silent;
    options.fields = values.fields;

    if (positionals.length > 1) {
      stderr.write(`${formatCliError("Pass at most one session path.", { usage: USAGE })}\n`);
      return 2;
    }
    if (positionals.length === 1) {
      options.sessionPath = positionals[0];
    }
  } catch (error) {
    stderr.write(`${formatCliError(error.message, { usage: USAGE })}\n`);
    return 1;
  }

  if (options.sessionPath && options.latest) {
    stderr.write(`${formatCliError("Pass either an explicit session path or --latest, not both.", { usage: USAGE })}\n`);
    return 2;
  }

  let result;
  try {
    let targetPath = options.sessionPath;

    if (!targetPath) {
      const latest = findLatestSession(undefined, cwd);
      if (!latest) {
        stderr.write(`${formatCliError("Could not automatically locate latest Pi session directory.", { usage: USAGE })}\n`);
        return 1;
      }
      targetPath = latest;
    }

    targetPath = path.resolve(cwd, targetPath);
    result = await auditPiSession(targetPath);
  } catch (error) {
    stderr.write(`${formatCliError(error.message, { usage: USAGE })}\n`);
    return 1;
  }

  if (options.json || options.jq !== undefined || options.silent || options.fields !== undefined) {
    return emitResult(result, {
      jq: options.jq,
      silent: options.silent,
      fields: options.fields,
      stdout,
      stderr,
    });
  }

  stdout.write(`${formatMarkdownSummary(result)}\n`);
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  runAuditCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
      process.exitCode = 1;
    });
}
