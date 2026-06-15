#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STEERING_KIND,
  STEERING_RESULT,
  classifySafePoint,
  normalizeSteeringEvent,
  normalizeSteeringState,
  createSteeringState,
  promoteQueuedSteering,
  submitSteering,
  getSteeringStatus,
} from "@dev-loops/core/loop/steering";
import { STATE } from "@dev-loops/core/loop/copilot-loop-state";
import {
  ACTIVE_STATE_FAMILY,
  deriveRunIdForInspectionTarget,
  SOURCE_MODE,
  TRUST,
} from "@dev-loops/core/loop/run-inspection";
import { inspectRun } from "./inspect-run.mjs";
import {
  defaultStateFilePath,
  defaultStateFilePathForTarget,
  loadStateFile,
  saveStateFile,
  validateSteeringStateTarget,
  withStateFileLock,
} from "./_steering-state-file.mjs";
import { formatCliError } from "../_core-helpers.mjs";
import { requireOptionValue as readSharedOptionValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
const SUBMIT_USAGE = `Usage:
  steer-loop.mjs submit --repo <owner/name> --pr <number>
    --kind stop_at_next_safe_gate --directive <text> --seq <n>
    [--state-file <path>] [--copilot-input <path>] [--reviewer-input <path>]
    [--run-id <id>] [--event-id <id>]
  # Internal/testing mode only:
  steer-loop.mjs submit --run-id <id> --kind <kind> --directive <text> --seq <n>
    [--state-file <path>] [--loop-state <loop-state>] [--apply-mode <mode>]
    [--event-id <id>]
Submit a mid-flight steering directive to an active dev loop run.
Required:
  --kind <kind>           Steering kind
  --directive <text>      Operator payload / directive text
  --seq <n>               Positive integer sequence number (monotonically increasing per run)
  --run-id <id>           Target run identifier (required in low-level mode)
  --repo <owner/name>     Repository slug (required with --pr in operator-facing mode)
  --pr <number>           Pull request number (required with --repo in operator-facing mode)
Optional:
  --state-file <path>     Path to steering state JSON file (default: repo/pr mode => .pi/steering/<owner>/<repo>/pr-<n>.json; run-id mode => .pi/steering/<run-id>.json)
  --loop-state <state>    Current copilot loop state (low-level/testing mode only)
  --apply-mode <mode>     Application mode: immediate | next_safe_point (low-level/testing mode only)
  --event-id <id>         Unique event ID (default: auto-generated)
  --copilot-input <path>  Pre-built copilot snapshot JSON (operator-facing test mode)
  --reviewer-input <path> Pre-built reviewer snapshot JSON (operator-facing test mode)
Output (stdout, JSON):
  { "ok": true, "acknowledgement": { ... }, "result": { ... }, "steeringState": { ... } }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }`.trim();
const STATUS_USAGE = `Usage:
  steer-loop.mjs status --run-id <id> [--state-file <path>]
  steer-loop.mjs status --repo <owner/name> --pr <number> [--state-file <path>]
Inspect the steering state for a run.
Choose exactly one target mode:
  --run-id <id>           Target run identifier
  --repo <owner/name>     Repository slug (required with --pr)
  --pr <number>           Pull request number (required with --repo)
Optional:
  --state-file <path>     Path to steering state JSON file (default: repo/pr mode => .pi/steering/<owner>/<repo>/pr-<n>.json; run-id mode => .pi/steering/<run-id>.json)
Output (stdout, JSON):
  { "ok": true, "status": { ... } }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }`.trim();
const PROMOTE_USAGE = `Usage:
  steer-loop.mjs promote --run-id <id> --loop-state <state> [--state-file <path>]
  steer-loop.mjs promote --repo <owner/name> --pr <number>
    --loop-state <state> [--state-file <path>]
Explicitly promote queued steering to the effective stack when the caller knows
the loop has reached a safe point.
Choose exactly one target mode:
  --run-id <id>           Target run identifier
  --repo <owner/name>     Repository slug (required with --pr)
  --pr <number>           Pull request number (required with --repo)
Required:
  --loop-state <state>    Current copilot loop state
Optional:
  --state-file <path>     Path to steering state JSON file (default: repo/pr mode => .pi/steering/<owner>/<repo>/pr-<n>.json; run-id mode => .pi/steering/<run-id>.json)
Output (stdout, JSON):
  { "ok": true, "promotedCount": <n>, "promoted": [ ... ], "steeringState": { ... } }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }`.trim();
const TOP_USAGE = `Usage:
  steer-loop.mjs <subcommand> [options]
Subcommands:
  submit   Submit a steering directive to an active dev loop run
  promote  Explicitly promote queued steering at a known loop state
  status   Inspect the steering state for a run
Run steer-loop.mjs <subcommand> --help for subcommand-specific help.`.trim();
const VALID_KINDS = new Set(Object.values(STEERING_KIND));
const VALID_APPLY_MODES = new Set(["immediate", "next_safe_point"]);
const VALID_LOOP_STATES = new Set(Object.values(STATE));
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
function usageError(message, usage) {
  return Object.assign(new Error(message), { usage });
}
function runIdMismatchError(persistedRunId, requestedRunId) {
  return new Error(
    `run-id mismatch: --state-file contains run ${JSON.stringify(persistedRunId)} but --run-id is ${JSON.stringify(requestedRunId)}. Use the correct --run-id or point --state-file at the right file.`
  );
}
function readRequiredOptionValue(args, flag, usage, { allowFlagLike = false } = {}) {
  return readSharedOptionValue(
    args,
    flag,
    (message) => usageError(message, usage),
    { flagPattern: allowFlagLike ? /$^/u : /^--/u },
  );
}
function validateSafeRunId(runId, usage) {
  if (!SAFE_RUN_ID_RE.test(runId)) {
    throw usageError("--run-id must contain only letters, numbers, dot, underscore, or hyphen", usage);
  }
}
function parseRepoSlugOption(rawRepo, usage) {
  try {
    parseRepoSlug(rawRepo);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error), usage);
  }
}
function parsePositiveIntegerOption(raw, flag, usage) {
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw usageError(`${flag} must be a positive integer`, usage);
  }
  return Number(raw);
}
export function parseSubmitCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    runId: undefined,
    kind: undefined,
    directive: undefined,
    seq: undefined,
    stateFile: undefined,
    loopState: "ready_to_rerequest_review",
    loopStateExplicit: false,
    applyMode: "immediate",
    eventId: undefined,
    copilotInputPath: undefined,
    reviewerInputPath: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--run-id") {
      options.runId = readRequiredOptionValue(args, "--run-id", SUBMIT_USAGE).trim();
      validateSafeRunId(options.runId, SUBMIT_USAGE);
      continue;
    }
    if (token === "--repo") {
      options.repo = readRequiredOptionValue(args, "--repo", SUBMIT_USAGE).trim();
      parseRepoSlugOption(options.repo, SUBMIT_USAGE);
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePositiveIntegerOption(readRequiredOptionValue(args, "--pr", SUBMIT_USAGE), "--pr", SUBMIT_USAGE);
      continue;
    }
    if (token === "--kind") {
      const val = readRequiredOptionValue(args, "--kind", SUBMIT_USAGE);
      if (!VALID_KINDS.has(val)) {
        throw usageError(`--kind must be one of: ${[...VALID_KINDS].join(", ")}`, SUBMIT_USAGE);
      }
      options.kind = val;
      continue;
    }
    if (token === "--directive") {
      options.directive = readRequiredOptionValue(args, "--directive", SUBMIT_USAGE, { allowFlagLike: true }).trim();
      continue;
    }
    if (token === "--seq") {
      options.seq = parsePositiveIntegerOption(readRequiredOptionValue(args, "--seq", SUBMIT_USAGE), "--seq", SUBMIT_USAGE);
      continue;
    }
    if (token === "--state-file") {
      options.stateFile = readRequiredOptionValue(args, "--state-file", SUBMIT_USAGE);
      continue;
    }
    if (token === "--loop-state") {
      const val = readRequiredOptionValue(args, "--loop-state", SUBMIT_USAGE);
      if (!VALID_LOOP_STATES.has(val)) {
        throw usageError(`--loop-state must be one of: ${[...VALID_LOOP_STATES].join(", ")}`, SUBMIT_USAGE);
      }
      options.loopState = val;
      options.loopStateExplicit = true;
      continue;
    }
    if (token === "--apply-mode") {
      const val = readRequiredOptionValue(args, "--apply-mode", SUBMIT_USAGE);
      if (!VALID_APPLY_MODES.has(val)) {
        throw usageError(`--apply-mode must be one of: ${[...VALID_APPLY_MODES].join(", ")}`, SUBMIT_USAGE);
      }
      options.applyMode = val;
      continue;
    }
    if (token === "--event-id") {
      options.eventId = readRequiredOptionValue(args, "--event-id", SUBMIT_USAGE);
      continue;
    }
    if (token === "--copilot-input") {
      options.copilotInputPath = readRequiredOptionValue(args, "--copilot-input", SUBMIT_USAGE);
      continue;
    }
    if (token === "--reviewer-input") {
      options.reviewerInputPath = readRequiredOptionValue(args, "--reviewer-input", SUBMIT_USAGE);
      continue;
    }
    throw usageError(`Unknown argument: ${token}`, SUBMIT_USAGE);
  }
  if (!options.help) {
    if ((options.repo === undefined) !== (options.pr === undefined)) {
      throw usageError("--repo and --pr must be provided together", SUBMIT_USAGE);
    }
    if (!options.runId && options.repo === undefined) {
      throw usageError("--run-id is required, or both --repo and --pr must be provided together", SUBMIT_USAGE);
    }
    if (options.repo !== undefined && options.loopStateExplicit) {
      throw usageError("--loop-state is low-level/testing mode only; omit it when using --repo/--pr operator mode", SUBMIT_USAGE);
    }
    if (!options.kind) {
      throw usageError("--kind is required", SUBMIT_USAGE);
    }
    if (!options.directive || options.directive.length === 0) {
      throw usageError("--directive is required and must be non-empty", SUBMIT_USAGE);
    }
    if (options.seq === undefined) {
      throw usageError("--seq is required", SUBMIT_USAGE);
    }
  }
  return options;
}
export function parseStatusCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    runId: undefined,
    stateFile: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--run-id") {
      options.runId = readRequiredOptionValue(args, "--run-id", STATUS_USAGE).trim();
      validateSafeRunId(options.runId, STATUS_USAGE);
      continue;
    }
    if (token === "--repo") {
      options.repo = readRequiredOptionValue(args, "--repo", STATUS_USAGE).trim();
      parseRepoSlugOption(options.repo, STATUS_USAGE);
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePositiveIntegerOption(readRequiredOptionValue(args, "--pr", STATUS_USAGE), "--pr", STATUS_USAGE);
      continue;
    }
    if (token === "--state-file") {
      options.stateFile = readRequiredOptionValue(args, "--state-file", STATUS_USAGE);
      continue;
    }
    throw usageError(`Unknown argument: ${token}`, STATUS_USAGE);
  }
  if (!options.help) {
    if ((options.repo === undefined) !== (options.pr === undefined)) {
      throw usageError("--repo and --pr must be provided together", STATUS_USAGE);
    }
    if (options.runId && options.repo !== undefined) {
      throw usageError("Choose exactly one target mode: either --run-id or --repo/--pr", STATUS_USAGE);
    }
    if (!options.runId && options.repo === undefined) {
      throw usageError("--run-id is required, or both --repo and --pr must be provided together", STATUS_USAGE);
    }
  }
  return options;
}
export function parsePromoteCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    runId: undefined,
    stateFile: undefined,
    loopState: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--run-id") {
      options.runId = readRequiredOptionValue(args, "--run-id", PROMOTE_USAGE).trim();
      validateSafeRunId(options.runId, PROMOTE_USAGE);
      continue;
    }
    if (token === "--repo") {
      options.repo = readRequiredOptionValue(args, "--repo", PROMOTE_USAGE).trim();
      parseRepoSlugOption(options.repo, PROMOTE_USAGE);
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePositiveIntegerOption(readRequiredOptionValue(args, "--pr", PROMOTE_USAGE), "--pr", PROMOTE_USAGE);
      continue;
    }
    if (token === "--state-file") {
      options.stateFile = readRequiredOptionValue(args, "--state-file", PROMOTE_USAGE);
      continue;
    }
    if (token === "--loop-state") {
      const val = readRequiredOptionValue(args, "--loop-state", PROMOTE_USAGE);
      if (!VALID_LOOP_STATES.has(val)) {
        throw usageError(`--loop-state must be one of: ${[...VALID_LOOP_STATES].join(", ")}`, PROMOTE_USAGE);
      }
      options.loopState = val;
      continue;
    }
    throw usageError(`Unknown argument: ${token}`, PROMOTE_USAGE);
  }
  if (!options.help) {
    if ((options.repo === undefined) !== (options.pr === undefined)) {
      throw usageError("--repo and --pr must be provided together", PROMOTE_USAGE);
    }
    if (options.runId && options.repo !== undefined) {
      throw usageError("Choose exactly one target mode: either --run-id or --repo/--pr", PROMOTE_USAGE);
    }
    if (!options.runId && options.repo === undefined) {
      throw usageError("--run-id is required, or both --repo and --pr must be provided together", PROMOTE_USAGE);
    }
    if (options.loopState === undefined) {
      throw usageError("--loop-state is required", PROMOTE_USAGE);
    }
  }
  return options;
}
function deriveTargetRunId(options) {
  if (options.repo !== undefined && options.pr !== undefined) {
    return deriveRunIdForInspectionTarget({ repo: options.repo, pr: options.pr });
  }
  return options.runId;
}
function quoteCliValue(value) {
  return JSON.stringify(String(value));
}
function resolveRequestedRunId(options, usage) {
  const derivedRunId = deriveTargetRunId(options);
  if (options.runId && options.repo !== undefined && options.pr !== undefined && options.runId !== derivedRunId) {
    throw usageError(
      `run-id mismatch: explicit --run-id ${JSON.stringify(options.runId)} does not match derived run ${JSON.stringify(derivedRunId)} for --repo/--pr target`,
      usage,
    );
  }
  return derivedRunId;
}
function mapDisposition(resultCode) {
  switch (resultCode) {
    case STEERING_RESULT.APPLIED_NOW:
      return "applied_now";
    case STEERING_RESULT.QUEUED_FOR_SAFE_POINT:
      return "queued_for_safe_point";
    default:
      return "rejected";
  }
}
function buildReadbackPath({ repo, pr, runId, stateFilePath }) {
  const inspectionStateFileFlag = stateFilePath ? ` --steering-state-file ${quoteCliValue(stateFilePath)}` : "";
  const statusStateFileFlag = stateFilePath ? ` --state-file ${quoteCliValue(stateFilePath)}` : "";
  const quotedRepo = repo ? quoteCliValue(repo) : null;
  const quotedPr = pr !== undefined && pr !== null ? quoteCliValue(pr) : null;
  const inspection = quotedRepo && quotedPr
    ? `node scripts/loop/inspect-run.mjs --repo ${quotedRepo} --pr ${quotedPr}${inspectionStateFileFlag}`
    : null;
  const steeringStatus = quotedRepo && quotedPr
    ? `node scripts/loop/steer-loop.mjs status --repo ${quotedRepo} --pr ${quotedPr}${statusStateFileFlag}`
    : `node scripts/loop/steer-loop.mjs status --run-id ${quoteCliValue(runId)}${statusStateFileFlag}`;
  return {
    inspection,
    steeringStatus,
  };
}
function buildAcknowledgement({
  repo,
  pr,
  runId,
  directiveKind,
  directiveText,
  resultCode,
  reason,
  reasonCode = null,
  inspectedState,
  safePointCategory,
  readbackPath,
}) {
  return {
    runId,
    directiveKind,
    directive: directiveText,
    disposition: mapDisposition(resultCode),
    resultCode,
    reason,
    ...(reasonCode ? { reasonCode } : {}),
    inspectedState,
    safePointCategory,
    effectiveNow: resultCode === STEERING_RESULT.APPLIED_NOW,
    readbackPath,
    ...(repo && pr ? { target: { repo, pr } } : {}),
  };
}
function buildLowLevelResult({
  eventId,
  seq,
  resultCode,
  reason,
  reasonCode = null,
  acknowledgedAt = new Date().toISOString(),
}) {
  return {
    eventId,
    seq,
    result: resultCode,
    reason,
    ...(reasonCode ? { reasonCode } : {}),
    acknowledgedAt,
  };
}
async function loadOrCreateSteeringState(filePath, runId, target = null) {
  const raw = await loadStateFile(filePath);
  const steeringState = raw !== null
    ? normalizeSteeringState(raw)
    : createSteeringState(runId, target);
  if (raw !== null && steeringState.runId !== runId) {
    throw runIdMismatchError(steeringState.runId, runId);
  }
  if (target !== null) {
    const validation = validateSteeringStateTarget(steeringState, {
      repo: target.repo,
      pr: target.pr,
      runId,
    });
    if (!validation.ok) {
      throw new Error(`state-file target mismatch: ${validation.reason}`);
    }
  }
  return steeringState;
}
function rejectUnsteerableInspection(inspection, { runId, eventId, seq, directiveKind, directiveText, readbackPath }) {
  if (inspection.activeStateFamily !== ACTIVE_STATE_FAMILY) {
    const reasonCode = "inspection_unsupported_state_family";
    const result = buildLowLevelResult({
      eventId,
      seq,
      resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
      reasonCode,
      reason: `inspection target family '${inspection.activeStateFamily}' is unsupported for operator-facing steering`,
    });
    return {
      acknowledgement: buildAcknowledgement({
        repo: inspection.target?.repo,
        pr: inspection.target?.pr,
        runId,
        directiveKind,
        directiveText,
        resultCode: result.result,
        reason: result.reason,
        reasonCode: result.reasonCode,
        inspectedState: inspection.layers?.copilot?.currentState ?? "unknown",
        safePointCategory: null,
        readbackPath,
      }),
      result,
    };
  }
  if (inspection.runId !== runId) {
    const reasonCode = "inspection_run_mismatch";
    const result = buildLowLevelResult({
      eventId,
      seq,
      resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
      reasonCode,
      reason: `inspection run mismatch: expected ${JSON.stringify(runId)} but inspected ${JSON.stringify(inspection.runId)}`,
    });
    return {
      acknowledgement: buildAcknowledgement({
        repo: inspection.target?.repo,
        pr: inspection.target?.pr,
        runId,
        directiveKind,
        directiveText,
        resultCode: result.result,
        reason: result.reason,
        reasonCode: result.reasonCode,
        inspectedState: inspection.layers?.copilot?.currentState ?? "unknown",
        safePointCategory: null,
        readbackPath,
      }),
      result,
    };
  }
  const inspectedState = inspection.layers?.copilot?.currentState;
  const safePointCategory = typeof inspectedState === "string" ? classifySafePoint(inspectedState) : null;
  if (typeof inspectedState !== "string" || inspection.statusClass === "unknown") {
    const reasonCode = "inspection_target_unidentifiable";
    const result = buildLowLevelResult({
      eventId,
      seq,
      resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
      reasonCode,
      reason: "target run could not be confidently identified from the inspection snapshot",
    });
    return {
      acknowledgement: buildAcknowledgement({
        repo: inspection.target?.repo,
        pr: inspection.target?.pr,
        runId,
        directiveKind,
        directiveText,
        resultCode: result.result,
        reason: result.reason,
        reasonCode: result.reasonCode,
        inspectedState: inspectedState ?? "unknown",
        safePointCategory,
        readbackPath,
      }),
      result,
    };
  }
  if (
    inspection.sourceMode !== SOURCE_MODE.LIVE_DETECTOR_BACKED
    || inspection.trust !== TRUST.AUTHORITATIVE
    || inspection.markers.missing.length > 0
    || inspection.markers.stale.length > 0
    || inspection.markers.conflicts.length > 0
  ) {
    const detail = [
      `sourceMode=${inspection.sourceMode}`,
      `trust=${inspection.trust}`,
      `missing=${inspection.markers.missing.length}`,
      `stale=${inspection.markers.stale.length}`,
      `conflicts=${inspection.markers.conflicts.length}`,
    ].join(", ");
    const reasonCode = "inspection_not_authoritative";
    const result = buildLowLevelResult({
      eventId,
      seq,
      resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
      reasonCode,
      reason: `inspection snapshot is degraded or stale and cannot be steered safely (${detail})`,
    });
    return {
      acknowledgement: buildAcknowledgement({
        repo: inspection.target?.repo,
        pr: inspection.target?.pr,
        runId,
        directiveKind,
        directiveText,
        resultCode: result.result,
        reason: result.reason,
        reasonCode: result.reasonCode,
        inspectedState,
        safePointCategory,
        readbackPath,
      }),
      result,
    };
  }
  return null;
}
export async function runSubmit(
  argv = [],
  { stdout = process.stdout, cwd = process.cwd(), env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseSubmitCliArgs(argv);
  if (options.help) {
    stdout.write(`${SUBMIT_USAGE}\n`);
    return;
  }
  const runId = resolveRequestedRunId(options, SUBMIT_USAGE);
  const target = options.repo !== undefined && options.pr !== undefined
    ? { repo: options.repo, pr: options.pr }
    : null;
  const defaultTargetStateFilePath = target ? defaultStateFilePathForTarget(target, cwd) : defaultStateFilePath(runId, cwd);
  const stateFilePath = options.stateFile ?? defaultTargetStateFilePath;
  const readbackPath = buildReadbackPath({
    repo: options.repo,
    pr: options.pr,
    runId,
    stateFilePath,
  });
  const eventId = options.eventId ?? `evt-${randomUUID()}`;
  let persistedTargetMismatch = null;
  if (target !== null) {
    try {
      const rawExistingState = await loadStateFile(stateFilePath);
      if (rawExistingState !== null) {
        const normalizedExistingState = normalizeSteeringState(rawExistingState);
        const validation = validateSteeringStateTarget(normalizedExistingState, {
          repo: target.repo,
          pr: target.pr,
          runId,
        });
        if (!validation.ok) {
          persistedTargetMismatch = validation.reason;
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      persistedTargetMismatch = `existing steering state is invalid: ${detail}`;
    }
  }
  let inspectedState = options.loopState;
  let safePointCategory = classifySafePoint(options.loopState);
  let validationRejection = null;
  if (options.repo !== undefined && options.pr !== undefined) {
    if (persistedTargetMismatch !== null) {
      const safeReadbackPath = buildReadbackPath({
        repo: options.repo,
        pr: options.pr,
        runId,
        stateFilePath: defaultTargetStateFilePath,
      });
      validationRejection = {
        acknowledgement: buildAcknowledgement({
          repo: options.repo,
          pr: options.pr,
          runId,
          directiveKind: options.kind,
          directiveText: options.directive,
          resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
          reason: `steering state file does not match the requested target (${persistedTargetMismatch})`,
          inspectedState: "unknown",
          safePointCategory: null,
          readbackPath: safeReadbackPath,
        }),
        result: buildLowLevelResult({
          eventId,
          seq: options.seq,
          resultCode: STEERING_RESULT.REJECTED_UNSAFE_NOW,
          reason: `steering state file does not match the requested target (${persistedTargetMismatch})`,
        }),
      };
    } else {
      const inspection = await inspectRun({
        repo: options.repo,
        pr: options.pr,
        steeringStateFile: stateFilePath,
        copilotInputPath: options.copilotInputPath,
        reviewerInputPath: options.reviewerInputPath,
      }, { env, ghCommand });
      inspectedState = inspection.layers?.copilot?.currentState;
      safePointCategory = inspectedState ? classifySafePoint(inspectedState) : null;
      if (options.applyMode !== "immediate") {
        validationRejection = {
          acknowledgement: buildAcknowledgement({
            repo: options.repo,
            pr: options.pr,
            runId,
            directiveKind: options.kind,
            directiveText: options.directive,
            resultCode: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
            reason: "external operator submit does not accept --apply-mode overrides in this first slice",
            inspectedState: inspectedState ?? "unknown",
            safePointCategory,
            readbackPath,
          }),
          result: buildLowLevelResult({
            eventId,
            seq: options.seq,
            resultCode: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
            reason: "external operator submit does not accept --apply-mode overrides in this first slice",
          }),
        };
      } else if (options.kind !== STEERING_KIND.STOP_AT_NEXT_SAFE_GATE) {
        validationRejection = {
          acknowledgement: buildAcknowledgement({
            repo: options.repo,
            pr: options.pr,
            runId,
            directiveKind: options.kind,
            directiveText: options.directive,
            resultCode: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
            reason: "external operator submit accepts only stop_at_next_safe_gate in this first slice",
            inspectedState: inspectedState ?? "unknown",
            safePointCategory,
            readbackPath,
          }),
          result: buildLowLevelResult({
            eventId,
            seq: options.seq,
            resultCode: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
            reason: "external operator submit accepts only stop_at_next_safe_gate in this first slice",
          }),
        };
      } else {
        validationRejection = rejectUnsteerableInspection(inspection, {
          runId,
          eventId,
          seq: options.seq,
          directiveKind: options.kind,
          directiveText: options.directive,
          readbackPath,
        });
      }
    }
  }
  if (validationRejection !== null) {
    let steeringState;
    try {
      steeringState = await loadOrCreateSteeringState(stateFilePath, runId, target);
    } catch {
      steeringState = createSteeringState(runId, target);
    }
    stdout.write(`${JSON.stringify({
      ok: true,
      acknowledgement: validationRejection.acknowledgement,
      result: validationRejection.result,
      steeringState,
    })}\n`);
    return;
  }
  const { steeringState: newState, result } = await withStateFileLock(stateFilePath, async () => {
    const steeringState = await loadOrCreateSteeringState(stateFilePath, runId, target);
    const event = normalizeSteeringEvent({
      eventId,
      runId,
      kind: options.kind,
      directive: options.directive,
      seq: options.seq,
      applyMode: options.applyMode,
      submittedAt: new Date().toISOString(),
    });
    const submission = submitSteering(event, steeringState, inspectedState);
    await saveStateFile(stateFilePath, submission.steeringState);
    return submission;
  });
  const acknowledgement = buildAcknowledgement({
    repo: options.repo,
    pr: options.pr,
    runId,
    directiveKind: options.kind,
    directiveText: options.directive,
    resultCode: result.result,
    reason: result.reason,
    inspectedState,
    safePointCategory,
    readbackPath,
  });
  stdout.write(`${JSON.stringify({ ok: true, acknowledgement, result, steeringState: newState })}\n`);
}
export async function runStatus(argv = [], { stdout = process.stdout, cwd = process.cwd() } = {}) {
  const options = parseStatusCliArgs(argv);
  if (options.help) {
    stdout.write(`${STATUS_USAGE}\n`);
    return;
  }
  const runId = resolveRequestedRunId(options, STATUS_USAGE);
  const target = options.repo !== undefined && options.pr !== undefined
    ? { repo: options.repo, pr: options.pr }
    : null;
  const stateFilePath = options.stateFile ?? (target ? defaultStateFilePathForTarget(target, cwd) : defaultStateFilePath(runId, cwd));
  const steeringState = await loadOrCreateSteeringState(stateFilePath, runId, target);
  const status = getSteeringStatus(steeringState);
  stdout.write(`${JSON.stringify({ ok: true, status })}\n`);
}
export async function runPromote(argv = [], { stdout = process.stdout, cwd = process.cwd() } = {}) {
  const options = parsePromoteCliArgs(argv);
  if (options.help) {
    stdout.write(`${PROMOTE_USAGE}\n`);
    return;
  }
  const runId = resolveRequestedRunId(options, PROMOTE_USAGE);
  const target = options.repo !== undefined && options.pr !== undefined
    ? { repo: options.repo, pr: options.pr }
    : null;
  const stateFilePath = options.stateFile ?? (target ? defaultStateFilePathForTarget(target, cwd) : defaultStateFilePath(runId, cwd));
  const promotedState = await withStateFileLock(stateFilePath, async () => {
    const steeringState = await loadOrCreateSteeringState(stateFilePath, runId, target);
    const nextState = promoteQueuedSteering(steeringState, options.loopState);
    if (nextState.promoted.length > 0) {
      await saveStateFile(stateFilePath, nextState.steeringState);
    }
    return nextState;
  });
  stdout.write(`${JSON.stringify({
    ok: true,
    promotedCount: promotedState.promoted.length,
    promoted: promotedState.promoted,
    steeringState: promotedState.steeringState,
  })}\n`);
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, cwd = process.cwd(), env = process.env, ghCommand = "gh" } = {},
) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    stdout.write(`${TOP_USAGE}\n`);
    return;
  }
  if (subcommand === "submit") {
    return runSubmit(rest, { stdout, cwd, env, ghCommand });
  }
  if (subcommand === "promote") {
    return runPromote(rest, { stdout, cwd });
  }
  if (subcommand === "status") {
    return runStatus(rest, { stdout, cwd });
  }
  const error = usageError(`Unknown subcommand: ${subcommand}`, TOP_USAGE);
  throw error;
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
