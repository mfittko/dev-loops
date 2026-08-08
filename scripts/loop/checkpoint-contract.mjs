#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { normalizeCheckpointCycleIdentity } from "@dev-loops/core/loop/public-dev-loop-routing";
import { parsePositiveInteger } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

export const CHECKPOINT_FILE = ".pi/dev-loop-retrospective-checkpoint.json";
const ALLOWED_STATES = new Set(["required", "complete", "skipped", "none", "missing"]);

const USAGE = `Usage: dev-loops checkpoint-contract --state <state> [--notes <text>] [--reason <text>]
       [--repo <owner/name> --pr <number> --merge-commit <sha>]

Write .pi/dev-loop-retrospective-checkpoint.json using the retrospective contract format.

Required:
  --state <state>          Checkpoint state (required, complete, skipped, none, missing)

Optional:
  --notes <text>           Required when --state is complete
  --reason <text>          Required when --state is skipped
  --repo <owner/name>      Cycle identity (repo). Provide with --pr and
  --pr <number>            --merge-commit together to scope this checkpoint
  --merge-commit <sha>     record to one specific qualifying completion — a
                           later reader can then tell WHICH cycle it covers.
                           Not accepted with --state none.

${JQ_OUTPUT_USAGE}`;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function buildRetrospectiveCheckpointPayload({ state, notes = null, reason = null, identity = null }, now = new Date()) {
  const timestamp = now.toISOString();
  const normalizedIdentity = identity != null ? normalizeCheckpointCycleIdentity(identity) : null;
  const identityField = normalizedIdentity ? { identity: normalizedIdentity } : {};
  if (state === "complete") return { state, completedAt: timestamp, notes, ...identityField };
  if (state === "skipped") return { state, skippedAt: timestamp, reason, ...identityField };
  if (state === "required") return { state, triggeredAt: timestamp, ...identityField };
  if (state === "missing") return { state, triggeredAt: timestamp, ...identityField };
  if (state === "none") return { state };
  throw new Error(`Unsupported state: ${state}`);
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        state: { type: "string" },
        notes: { type: "string" },
        reason: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        "merge-commit": { type: "string" },
        help: { type: "boolean", short: "h" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    return { help: true };
  }

  if (!values.state) throw parseError("Missing required option: --state");
  const state = values.state;
  if (!ALLOWED_STATES.has(state)) {
    throw parseError(`--state must be one of: ${[...ALLOWED_STATES].join(", ")}`);
  }
  if (state === "complete" && !values.notes) {
    throw parseError('state "complete" requires --notes');
  }
  if (state === "skipped" && !values.reason) {
    throw parseError('state "skipped" requires --reason');
  }

  const mergeCommit = values["merge-commit"];
  const hasIdentityFlag = values.repo !== undefined || values.pr !== undefined || mergeCommit !== undefined;
  if (hasIdentityFlag && state === "none") {
    throw parseError("--state none does not accept a cycle identity; --repo/--pr/--merge-commit only apply to required/complete/skipped/missing");
  }
  let identity = null;
  if (hasIdentityFlag) {
    // Trim before the truthiness check so a whitespace-only value (which is
    // truthy) is rejected here rather than silently normalizing away to an
    // invalid identity that gets dropped without a word.
    if (!values.repo?.trim() || values.pr === undefined || !mergeCommit?.trim()) {
      throw parseError("--repo, --pr, and --merge-commit must be provided together to record a cycle identity");
    }
    const prNumber = parsePositiveInteger(values.pr, "--pr", parseError);
    identity = { repo: values.repo, prNumber, mergeCommit };
    if (normalizeCheckpointCycleIdentity(identity) === null) {
      throw parseError("--repo, --pr, and --merge-commit must form a valid cycle identity");
    }
  }

  return {
    state,
    notes: values.notes ?? null,
    reason: values.reason ?? null,
    identity,
    jq: values.jq,
    silent: values.silent === true,
  };
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { state, notes, reason, identity } = parsed;
  const payload = buildRetrospectiveCheckpointPayload({ state, notes, reason, identity });
  const checkpointPath = path.join(process.cwd(), CHECKPOINT_FILE);
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return emitResult({ ok: true, path: CHECKPOINT_FILE, checkpoint: payload }, { jq: parsed.jq, silent: parsed.silent });
}

if (isDirectCliRun(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
