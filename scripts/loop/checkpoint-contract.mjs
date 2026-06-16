#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";

const CHECKPOINT_FILE = ".pi/dev-loop-retrospective-checkpoint.json";
const ALLOWED_STATES = new Set(["required", "complete", "skipped", "none", "missing"]);

const USAGE = `Usage: dev-loops checkpoint-contract --state <state> [--notes <text>] [--reason <text>]

Write .pi/dev-loop-retrospective-checkpoint.json using the retrospective contract format.

Required:
  --state <state>          Checkpoint state (required, complete, skipped, none, missing)

Optional:
  --notes <text>           Required when --state is complete
  --reason <text>          Required when --state is skipped`;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function buildRetrospectiveCheckpointPayload({ state, notes = null, reason = null }, now = new Date()) {
  const timestamp = now.toISOString();
  if (state === "complete") return { state, completedAt: timestamp, notes };
  if (state === "skipped") return { state, skippedAt: timestamp, reason };
  if (state === "required") return { state, triggeredAt: timestamp };
  if (state === "missing") return { state, triggeredAt: timestamp };
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
        help: { type: "boolean", short: "h" },
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

  return { state, notes: values.notes ?? null, reason: values.reason ?? null };
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { state, notes, reason } = parsed;
  const payload = buildRetrospectiveCheckpointPayload({ state, notes, reason });
  const checkpointPath = path.join(process.cwd(), CHECKPOINT_FILE);
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ok: true, path: CHECKPOINT_FILE, checkpoint: payload }) + "\n");
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      const usage = error instanceof Error && typeof error.usage === "string" ? error.usage : undefined;
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(usage && { usage }) })}\n`);
      process.exitCode = 1;
    },
  );
}
