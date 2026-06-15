#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineSubcommand, isDirectCliRun } from "@dev-loops/core/cli/subcommand-runner";

const CHECKPOINT_FILE = ".pi/dev-loop-retrospective-checkpoint.json";
const ALLOWED_STATES = new Set(["required", "complete", "skipped", "none", "missing"]);

export function buildRetrospectiveCheckpointPayload({ state, notes = null, reason = null }, now = new Date()) {
  const timestamp = now.toISOString();
  if (state === "complete") return { state, completedAt: timestamp, notes };
  if (state === "skipped") return { state, skippedAt: timestamp, reason };
  if (state === "required") return { state, triggeredAt: timestamp };
  if (state === "missing") return { state, triggeredAt: timestamp };
  if (state === "none") return { state };
  throw new Error(`Unsupported state: ${state}`);
}

const { runAsScript } = defineSubcommand({
  name: "checkpoint-contract --state <state>",
  description: "Write .pi/dev-loop-retrospective-checkpoint.json using the retrospective contract format.",
  options: [
    { flag: "--state", type: "string", required: true, choices: [...ALLOWED_STATES],
      description: "Checkpoint state (required, complete, skipped, none, missing)" },
    { flag: "--notes", type: "string", description: "Required when --state is complete" },
    { flag: "--reason", type: "string", description: "Required when --state is skipped" },
  ],
  async run({ state, notes, reason }, { args: _args, usage }) {
    if (!ALLOWED_STATES.has(state)) {
      throw Object.assign(new Error(`Invalid --state: "${state}". Allowed: ${[...ALLOWED_STATES].join(", ")}.`), { usage });
    }
    if (state === "complete" && !notes) {
      throw Object.assign(new Error('state "complete" requires --notes'), { usage });
    }
    if (state === "skipped" && !reason) {
      throw Object.assign(new Error('state "skipped" requires --reason'), { usage });
    }

    const cwd = process.cwd();
    const payload = buildRetrospectiveCheckpointPayload({ state, notes, reason });
    const checkpointPath = path.join(cwd, CHECKPOINT_FILE);
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stdout.write(JSON.stringify({ ok: true, path: CHECKPOINT_FILE, checkpoint: payload }) + "\n");
    return 0;
  },
});

if (isDirectCliRun(import.meta.url)) { runAsScript(); }
