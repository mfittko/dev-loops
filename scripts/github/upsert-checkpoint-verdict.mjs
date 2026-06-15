#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveRefinementConfig } from "../../packages/core/src/config/config.mjs";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { truncateText } from "../../packages/core/src/bash-exit-one.mjs";
import { parseRepoSlug } from "../../packages/core/src/github/repo-slug.mjs";
import { loadPrGateCoordinationContext } from "../loop/detect-pr-gate-coordination-state.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "../../packages/core/src/loop/pr-gate-coordination.mjs";
import { STATE } from "../../packages/core/src/loop/copilot-loop-state.mjs";
import { claimRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { detectInternalOnly } from "../loop/detect-internal-only-pr.mjs";
const GATE_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const GATE_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const MAX_GATE_COMMENT_TEXT_LENGTH = 2000;
const MAX_GATE_COMMENT_EXCERPT_LENGTH = 120;
const REMOVED_FLAGS = new Set([
  "--force",
  "--force-reason",
]);
const USAGE = `Usage: upsert-checkpoint-verdict.mjs --repo <owner/name> --pr <number> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings-summary <text> | --findings-file <path>) --next-action <text> [--gate <draft_gate|pre_approval_gate>]
Create or update the visible checkpoint verdict comment for a gate/head pair.
Same-head reruns are idempotent: if a visible marker already exists for the same
\`gate + headSha\`, this helper updates it in place when correction is needed and
suppresses duplicate reposts when the existing visible comment already matches.
The gate (draft_gate or pre_approval_gate) is auto-resolved from the PR gate
coordination state when --gate is not provided. Explicit --gate is still accepted
but must match the coordination state's allowed next actions.
Required:
  --repo <owner/name>
  --pr <number>
  --head-sha <sha>                            Full current head SHA or hexadecimal prefix of it
  --verdict <clean|findings_present|blocked>
  --findings-summary <text>                 Findings summary as a single argument
                                            (use --findings-file for multi-line)
  --findings-file <path>                    Read findings summary from file;
                                            alternative to --findings-summary
                                            (preserves newlines; takes precedence
                                            when both are present)
  --next-action <text>
Optional:
  --gate <draft_gate|pre_approval_gate>     Auto-resolved from coordination state
                                            when omitted. Explicit gate is validated
                                            against allowed coordination actions.
  --findings-severity-counts <json>         JSON object mapping severity to count
                                             (e.g. '{"must-fix":0,"worth-fixing-now":0}').
                                             Required for --verdict clean when
                                             blockCleanOnFindingSeverities is configured.
Output (stdout, JSON):
  {
    "ok": true,
    "action": "created"|"updated"|"noop",
    "repo": "owner/repo",
    "pr": 17,
    "gate": "draft_gate",
    "headSha": "abc1234",
    "currentHeadSha": "abc1234",
    "commentId": 101,
    "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101"
  }
A \`warning\` field is included when a gate comment for the same gate already
exists on a different head SHA (the old comment is stale for the current head).
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error, gh failure, or contradictory gate evidence`.trim();
const parseError = buildParseError(USAGE);
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. Force bypass requires separate operator authorization. Omit the flag.`,
  );
}
function normalizeGateName(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_NAMES.has(normalized) ? normalized : null;
}
function normalizeVerdict(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_VERDICTS.has(normalized) ? normalized : null;
}
function normalizeHeadSha(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}
function normalizeRequiredText(value, flag) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw parseError(`${flag} must be a non-empty string`);
  }
  if (flag === "--findings-summary") {
    return summarizeCheckpointVerdictText(normalized);
  }
  return smartTruncate(collapseWhitespace(normalized), MAX_GATE_COMMENT_TEXT_LENGTH);
}
function collapseWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}
function smartTruncate(value, limit) {
  const text = String(value);
  if (text.length <= limit) {
    return text;
  }
  const truncated = text.slice(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  const breakPoint = lastSpace > Math.floor(limit * 0.7) ? lastSpace : limit;
  const retained = truncated.slice(0, breakPoint);
  const omitted = text.length - retained.length;
  return `${retained}…[truncated ${omitted} chars]`;
}
function pushUnique(values, value) {
  if (value.length > 0 && !values.includes(value)) {
    values.push(value);
  }
}
function formatValidationCounts(counts) {
  const orderedKeys = ["tests", "pass", "fail", "skipped", "todo", "cancelled", "suites"];
  const parts = orderedKeys
    .filter((key) => Number.isInteger(counts[key]))
    .map((key) => `${key}: ${counts[key]}`);
  return parts.length > 0 ? parts.join(", ") : null;
}
function buildVerboseValidationSummary(lines) {
  const commands = [];
  const counts = Object.create(null);
  let ciLine = null;
  let failureExcerpt = null;
  let sawPassedSignal = false;
  for (const rawLine of lines) {
    const line = collapseWhitespace(rawLine.replace(/^[*-]\s*/u, ""));
    if (line.length === 0) {
      continue;
    }
    const commandMatch = line.match(/^(?:>|\$)\s*(.+)$/u);
    if (commandMatch) {
      pushUnique(commands, collapseWhitespace(commandMatch[1]));
      continue;
    }
    const countMatch = line.match(/^(?:ℹ\s*)?(tests|suites|pass|fail|cancelled|skipped|todo)\s*:?\s*(\d+)$/iu);
    if (countMatch) {
      counts[countMatch[1].toLowerCase()] = Number.parseInt(countMatch[2], 10);
      continue;
    }
    if (
      ciLine === null
      && /\b(?:github\s+ci|ci|checks?|workflow)\b/i.test(line)
      && /\b(?:pass(?:ed)?|green|success(?:ful)?|fail(?:ed)?|red|pending|blocked)\b/i.test(line)
    ) {
      ciLine = truncateText(line, MAX_GATE_COMMENT_EXCERPT_LENGTH);
      continue;
    }
    if (
      failureExcerpt === null
      && (/^✖\s*/u.test(line) || /^FAIL\b/u.test(line) || /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b/u.test(line) || /\bError:/u.test(line))
    ) {
      failureExcerpt = truncateText(line.replace(/^✖\s*/u, ""), MAX_GATE_COMMENT_EXCERPT_LENGTH);
      continue;
    }
    if (/\bpass(?:ed)?\b/i.test(line)) {
      sawPassedSignal = true;
    }
  }
  const parts = [];
  if (commands.length > 0) {
    parts.push(`commands: ${commands.join(", ")}`);
  }
  const countLine = formatValidationCounts(counts);
  if (countLine) {
    parts.push(countLine);
  }
  if (ciLine) {
    parts.push(`ci: ${ciLine}`);
  }
  const sawStructuredSignal = commands.length > 0 || countLine !== null || ciLine !== null || failureExcerpt !== null;
  if (failureExcerpt) {
    parts.push(`failure excerpt: ${failureExcerpt}`);
  } else if (Number.isInteger(counts.fail) && counts.fail > 0) {
    parts.push("validation: failed");
  } else if (!countLine && sawPassedSignal && sawStructuredSignal) {
    parts.push("validation: passed");
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
export function summarizeCheckpointVerdictText(value, limit = MAX_GATE_COMMENT_TEXT_LENGTH) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    return "";
  }
  const flat = collapseWhitespace(normalized);
  if (!/[\r\n]/u.test(normalized)) {
    return smartTruncate(flat, limit);
  }
  const lines = normalized.split(/\r?\n/u);
  const verboseSummary = buildVerboseValidationSummary(lines);
  return smartTruncate(verboseSummary ?? flat, limit);
}
export function parseUpsertCheckpointVerdictCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    verdict: undefined,
    findingsSummary: undefined,
    findingsFile: undefined,
    nextAction: undefined,
    findingsSeverityCounts: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (REMOVED_FLAGS.has(token)) {
      rejectRemovedFlag(token);
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    if (token === "--gate") {
      const gate = normalizeGateName(requireOptionValue(args, "--gate", parseError));
      if (!gate) {
        throw parseError("--gate must be one of: draft_gate, pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token === "--head-sha") {
      const headSha = normalizeHeadSha(requireOptionValue(args, "--head-sha", parseError));
      if (!headSha) {
        throw parseError("--head-sha must be a 7-64 character hexadecimal SHA");
      }
      options.headSha = headSha;
      continue;
    }
    if (token === "--verdict") {
      const verdict = normalizeVerdict(requireOptionValue(args, "--verdict", parseError));
      if (!verdict) {
        throw parseError("--verdict must be one of: clean, findings_present, blocked");
      }
      options.verdict = verdict;
      continue;
    }
    if (token === "--findings-summary") {
      options.findingsSummary = normalizeRequiredText(requireOptionValue(args, "--findings-summary", parseError), "--findings-summary");
      continue;
    }
    if (token === "--findings-file") {
      const rawPath = requireOptionValue(args, "--findings-file", parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--findings-file must be a non-empty path");
      }
      options.findingsFile = rawPath;
      continue;
    }
    if (token === "--next-action") {
      options.nextAction = normalizeRequiredText(requireOptionValue(args, "--next-action", parseError), "--next-action");
      continue;
    }
    if (token === "--findings-severity-counts") {
      const raw = requireOptionValue(args, "--findings-severity-counts", parseError);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw parseError("--findings-severity-counts must be valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw parseError("--findings-severity-counts must be a JSON object mapping severity to count");
      }
      const counts = Object.create(null);
      for (const [key, value] of Object.entries(parsed)) {
        if (!Number.isInteger(value) || value < 0) {
          throw parseError(`--findings-severity-counts.${key} must be a non-negative integer`);
        }
        counts[key] = value;
      }
      options.findingsSeverityCounts = counts;
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  const missing = ["repo", "pr", "headSha", "verdict", "findingsSummary", "nextAction"]
    .filter((key) => options[key] === undefined);
  if (options.findingsFile) {
    const fsIdx = missing.indexOf("findingsSummary");
    if (fsIdx !== -1) missing.splice(fsIdx, 1);
  }
  if (missing.length > 0) {
    throw parseError("upsert-checkpoint-verdict requires --repo, --pr, --head-sha, --verdict, --findings-summary (or --findings-file), and --next-action");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function appendGateEvidenceNote(summary, note) {
  const normalizedSummary = summarizeCheckpointVerdictText(summary);
  const normalizedNote = typeof note === "string" ? collapseWhitespace(note) : "";
  if (normalizedNote.length === 0) {
    return normalizedSummary;
  }
  if (normalizedSummary.length === 0) {
    return smartTruncate(normalizedNote, MAX_GATE_COMMENT_TEXT_LENGTH);
  }
  if (normalizedSummary.includes(normalizedNote)) {
    return normalizedSummary;
  }
  return smartTruncate(`${normalizedSummary}; ${normalizedNote}`, MAX_GATE_COMMENT_TEXT_LENGTH);
}
export function renderGateReviewCommentBody({ gate, headSha, verdict, findingsSummary, nextAction, blockCleanOnFindingSeverities }) {
  const lines = [
    `### Gate review: \`${gate}\``,
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    `**Verdict:** ${verdict}`,
  ];
  if ((verdict === "findings_present" || verdict === "blocked") && blockCleanOnFindingSeverities && blockCleanOnFindingSeverities.length > 0) {
    const sevs = blockCleanOnFindingSeverities.join(", ");
    lines.push(`**Blocking severities:** ${sevs} (clean requires no findings matching these severities)`);
  }
  lines.push(
    "",
    `**Findings summary:** ${findingsSummary}`,
    "",
    `**Next action:** ${nextAction}`,
  );
  return lines.join("\n");
}
function resolveRequestedHeadSha(requestedHeadSha, currentHeadSha) {
  if (requestedHeadSha === currentHeadSha) {
    return currentHeadSha;
  }
  if (currentHeadSha.startsWith(requestedHeadSha)) {
    return currentHeadSha;
  }
  throw new Error(`Requested head SHA ${requestedHeadSha} does not match the current PR head SHA ${currentHeadSha}; refuse to mutate stale gate evidence.`);
}
function resolveGateAction(gate) {
  return gate === "draft_gate"
    ? PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE
    : PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE;
}
function buildGateEntryRefusalError({ options, coordination }) {
  return `Cannot enter ${options.gate} on ${options.repo}#${options.pr}: ${coordination.reason}`;
}
function selectGateEvidence(evidence, gate) {
  if (gate === "draft_gate") {
    return {
      strict: evidence.draftGate,
      marker: evidence.draftGateMarker,
    };
  }
  return {
    strict: evidence.preApprovalGate,
    marker: evidence.preApprovalGateMarker,
  };
}
function summarizeExistingComment({ strict, marker, headSha }) {
  const strictSameHead = strict?.visible === true && strict.headSha === headSha ? strict : null;
  const markerSameHead = marker?.visible === true && marker.headSha === headSha ? marker : null;
  if (markerSameHead && (!strictSameHead || markerSameHead.commentId !== strictSameHead.commentId)) {
    return {
      kind: "marker",
      commentId: markerSameHead.commentId,
      commentUrl: markerSameHead.commentUrl,
      verdict: markerSameHead.verdict,
      findingsSummary: markerSameHead.findingsSummary ?? null,
      nextAction: markerSameHead.nextAction ?? null,
      contractComplete: markerSameHead.contractComplete === true,
    };
  }
  if (strictSameHead) {
    return {
      kind: "strict",
      commentId: strictSameHead.commentId,
      commentUrl: strictSameHead.commentUrl,
      verdict: strictSameHead.verdict,
      findingsSummary: strictSameHead.findingsSummary,
      nextAction: strictSameHead.nextAction,
      contractComplete: true,
    };
  }
  if (markerSameHead) {
    return {
      kind: "marker",
      commentId: markerSameHead.commentId,
      commentUrl: markerSameHead.commentUrl,
      verdict: markerSameHead.verdict,
      findingsSummary: markerSameHead.findingsSummary ?? null,
      nextAction: markerSameHead.nextAction ?? null,
      contractComplete: markerSameHead.contractComplete === true,
    };
  }
  return null;
}
function detectStaleGateCommentWarning({ strict, headSha, gate }) {
  if (!(strict?.visible === true && strict.headSha !== null && strict.headSha !== headSha)) {
    return null;
  }
  return `A gate comment for \`${gate}\` already exists on a different head SHA \`${strict.headSha}\` (comment ${strict.commentId}). The old comment is stale for the current head.`;
}
async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 3).join(" ")}` });
}
function parseCommentMutationResponse(payload) {
  const commentId = Number.isInteger(payload?.id) ? payload.id : null;
  const commentUrl = typeof payload?.html_url === "string" && payload.html_url.trim().length > 0
    ? payload.html_url.trim()
    : null;
  if (commentId === null || commentUrl === null) {
    throw new Error("Checkpoint verdict comment mutation did not return a comment id and html_url");
  }
  return { commentId, commentUrl };
}
async function createComment({ repo, pr, body }, { env, ghCommand }) {
  const payload = await runGhJson(["api", "repos/" + repo + "/issues/" + pr + "/comments", "-f", `body=${body}`], { env, ghCommand });
  return parseCommentMutationResponse(payload);
}
async function updateComment({ repo, commentId, body }, { env, ghCommand }) {
  const payload = await runGhJson(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`], { env, ghCommand });
  return parseCommentMutationResponse(payload);
}

async function verifyComment({ repo, commentId }, { env, ghCommand }) {
  try {
    const payload = await runGhJson(["api", `repos/${repo}/issues/comments/${commentId}`], { env, ghCommand });
    return payload?.id != null;
  } catch {
    return false;
  }
}

export async function upsertCheckpointVerdict(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  // Root cause 1: allow resurrected sessions to claim ownership when the previous
  // run's coordination record is stale. Without this, a new run ID is rejected even
  // though the old run is dead, forcing manual file deletion.
  const envRunId = typeof env?.PI_SUBAGENT_RUN_ID === "string" ? env.PI_SUBAGENT_RUN_ID.trim() : "";
  if (envRunId) {
    try {
      const staleCheck = await detectStaleRunner({ repo: options.repo, pr: options.pr, cwd: repoRoot });
      if (staleCheck.status === "stale_runner") {
        await claimRunnerOwnership({ repo: options.repo, pr: options.pr, runId: envRunId, cwd: repoRoot, mode: "takeover" });
      }
    } catch {
      // Non-fatal: stale-runner takeover is best-effort. If it fails, the subsequent
      // loadPrGateCoordinationContext call will surface the real error.
    }
  }
  const coordinationContext = await loadPrGateCoordinationContext({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const evidence = coordinationContext.gateEvidence;
  const canonicalHeadSha = resolveRequestedHeadSha(options.headSha, evidence.currentHeadSha);
  const { config } = await loadDevLoopConfig({ repoRoot });
  const draftGateConfig = resolveGateConfig(config, "draft");
  const preApprovalGateConfig = resolveGateConfig(config, "preApproval");
  const maxCopilotRounds = resolveRefinementConfig(config, "maxCopilotRounds");
  // Root cause 2: detect internal-only PRs so the Copilot convergence requirement
  // is suppressed. Docs-only / tooling-only PRs should go straight to pre_approval_gate
  // without requiring an external Copilot review cycle.
  let reviewMode = null;
  try {
    const internalResult = await detectInternalOnly({ repo: options.repo, pr: options.pr }, { env, ghCommand });
    if (internalResult?.ok && internalResult.internalOnly) {
      reviewMode = "internal_only";
    }
  } catch {
    // Non-fatal: internal-only detection failure is best-effort.
    // Proceed with the default (external Copilot review) mode.
  }
  const coordination = evaluatePrGateCoordination({
    repo: coordinationContext.repo,
    pr: coordinationContext.pr,
    currentHeadSha: coordinationContext.currentHeadSha,
    prDraft: Boolean(coordinationContext.prData?.isDraft),
    prClosed: String(coordinationContext.prData?.state || "").toUpperCase() === "CLOSED",
    prMerged: String(coordinationContext.prData?.state || "").toUpperCase() === "MERGED",
    lifecycleState: coordinationContext.interpretation.state,
    loopDisposition: coordinationContext.disposition.loopDisposition,
    ciStatus: coordinationContext.snapshot?.ciStatus ?? null,
    copilotReviewRoundCount: coordinationContext.snapshot?.copilotReviewRoundCount ?? 0,
    maxCopilotRounds,
    sameHeadCleanConverged: coordinationContext.interpretation.sameHeadCleanConverged,
    draftGateRequireCi: draftGateConfig.requireCi,
    draftGate: coordinationContext.gateEvidence.draftGate,
    draftGateMarker: coordinationContext.gateEvidence.draftGateMarker,
    preApprovalGate: coordinationContext.gateEvidence.preApprovalGate,
    preApprovalGateMarker: coordinationContext.gateEvidence.preApprovalGateMarker,
    ...(reviewMode ? { reviewMode } : {}),
  });
  if (!options.gate) {
    if (coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE)) {
      options.gate = "draft_gate";
    } else if (coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE)) {
      options.gate = "pre_approval_gate";
    } else if (coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE)) {
      options.gate = "draft_gate";
    } else {
      throw new Error(`Cannot auto-resolve gate for ${options.repo}#${options.pr}: no gate action is currently allowed (${coordination.reason})`);
    }
  }
  const requestedGateAction = resolveGateAction(options.gate);
  if (options.gate === "draft_gate" && coordination.draftGateAlreadySatisfied) {
    throw new Error(
      `Cannot enter draft_gate on ${options.repo}#${options.pr}: draft gate was already satisfied ` +
      `(clean evidence exists, PR is no longer draft). ` +
      `Do not re-post draft_gate. The draft→ready transition was already recorded.`,
    );
  }
  const gateActionForbidden = coordination.forbiddenActions.includes(requestedGateAction);
  if (gateActionForbidden) {
    throw new Error(buildGateEntryRefusalError({ options, coordination }));
  }
  const activeGateConfig = options.gate === "draft_gate" ? draftGateConfig : preApprovalGateConfig;
  if (
    options.verdict === "clean"
    && activeGateConfig.blockCleanOnFindingSeverities
    && activeGateConfig.blockCleanOnFindingSeverities.length > 0
  ) {
    if (!options.findingsSeverityCounts) {
      throw new Error(
        `Cannot set verdict "clean" for ${options.gate}: --findings-severity-counts is required to verify that no unresolved blocking severities remain (example: --findings-severity-counts '{"must-fix":0,"worth-fixing-now":0,"defer":0}') (blocking: [${activeGateConfig.blockCleanOnFindingSeverities.join(", ")}]).`,
      );
    }
    const missingBlockingKeys = activeGateConfig.blockCleanOnFindingSeverities.filter(
      sev => !(sev in options.findingsSeverityCounts),
    );
    if (missingBlockingKeys.length > 0) {
      throw new Error(
        `Cannot set verdict "clean" for ${options.gate}: --findings-severity-counts must include explicit counts for all configured blocking severities. Missing: [${missingBlockingKeys.join(", ")}].`,
      );
    }
    const blocking = activeGateConfig.blockCleanOnFindingSeverities.filter(
      sev => (options.findingsSeverityCounts[sev] ?? 0) > 0,
    );
    if (blocking.length > 0) {
      throw new Error(
        `Cannot set verdict "clean" for ${options.gate}: unresolved findings remain at blocking severities [${blocking.join(", ")}]. Fix these findings and re-gate before declaring clean.`,
      );
    }
  }
  if (options.findingsFile) {
    try {
      const fileContent = await readFile(options.findingsFile, "utf8");
      const trimmedEnd = fileContent.replace(/\n+$/, "");
      if (trimmedEnd.length === 0) {
        throw new Error(`--findings-file "${options.findingsFile}" is empty or contains only whitespace`);
      }
      const note = typeof coordination.gateEvidenceNote === "string" ? collapseWhitespace(coordination.gateEvidenceNote) : "";
      const separator = trimmedEnd.includes("\n") ? "\n\n" : "; ";
      const annotated = note.length > 0 ? `${trimmedEnd}${separator}${note}` : trimmedEnd;
      options.findingsSummary = smartTruncate(annotated, MAX_GATE_COMMENT_TEXT_LENGTH);
    } catch (err) {
      throw new Error(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const effectiveFindingsSummary = options.findingsFile
    ? options.findingsSummary
    : appendGateEvidenceNote(options.findingsSummary, coordination.gateEvidenceNote ?? null);
  const desiredBody = renderGateReviewCommentBody({
    ...options,
    headSha: canonicalHeadSha,
    findingsSummary: effectiveFindingsSummary,
    blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
  });
  const gateEvidence = selectGateEvidence(evidence, options.gate);
  const existing = summarizeExistingComment({ ...gateEvidence, headSha: canonicalHeadSha });
  const warning = detectStaleGateCommentWarning({ strict: gateEvidence.strict, headSha: canonicalHeadSha, gate: options.gate });
  if (
    existing
    && existing.contractComplete
    && existing.verdict === options.verdict
    && existing.findingsSummary === effectiveFindingsSummary
    && existing.nextAction === options.nextAction
  ) {
    return {
      ok: true,
      action: "noop",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: canonicalHeadSha,
      currentHeadSha: evidence.currentHeadSha,
      commentId: existing.commentId,
      commentUrl: existing.commentUrl,
      blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
      ...(warning ? { warning } : {}),
    };
  }
  if (existing) {
    const updated = await updateComment({ repo: options.repo, commentId: existing.commentId, body: desiredBody }, { env, ghCommand });
    // Post-update verification: verify the updated comment is visible via direct API fetch by comment ID.
    // PI_SUBAGENT_RUN_ID is set (production context).
    let updateVerificationWarning = null;
    if (envRunId) {
      let verified = await verifyComment({ repo: options.repo, commentId: updated.commentId }, { env, ghCommand });
      if (!verified) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        verified = await verifyComment({ repo: options.repo, commentId: updated.commentId }, { env, ghCommand });
      }
      updateVerificationWarning = !verified
        ? `Post-update verification failed: comment ${updated.commentId} not retrievable after retry.`
        : null;
    }
    return {
      ok: true,
      action: "updated",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: canonicalHeadSha,
      currentHeadSha: evidence.currentHeadSha,
      commentId: updated.commentId,
      commentUrl: updated.commentUrl,
      blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
      ...(warning ? { warning } : {}),
      ...(updateVerificationWarning ? { verificationWarning: updateVerificationWarning } : {}),
    };
  }
  const created = await createComment({ repo: options.repo, pr: options.pr, body: desiredBody }, { env, ghCommand });
  // Post-creation verification: verify the comment is retrievable before returning.
  // GitHub API can have brief eventual-consistency windows where a just-posted
  // comment is not yet returned by paginated list endpoints. A direct fetch
  // by comment ID confirms the comment is persisted, preventing the evidence
  // checker from falsely reporting "missing" and triggering a duplicate post.
  // Only active when PI_SUBAGENT_RUN_ID is set (production context).
  let verified = true;
  let verificationWarning = null;
  if (envRunId) {
    verified = await verifyComment({ repo: options.repo, commentId: created.commentId }, { env, ghCommand });
    if (!verified) {
      // Brief wait then retry — eventual consistency should resolve within ~2s.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      verified = await verifyComment({ repo: options.repo, commentId: created.commentId }, { env, ghCommand });
    }
    verificationWarning = !verified
      ? `Post-creation verification failed: comment ${created.commentId} not retrievable after retry. The comment was created (API confirmed) but may not appear in list endpoints immediately.`
      : null;
  }
  return {
    ok: true,
    action: "created",
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: canonicalHeadSha,
    currentHeadSha: evidence.currentHeadSha,
    commentId: created.commentId,
    commentUrl: created.commentUrl,
    blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
    ...(warning ? { warning } : {}),
    ...(verificationWarning ? { verificationWarning } : {}),
  };
}
async function main() {
  let options;
  try {
    options = parseUpsertCheckpointVerdictCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await upsertCheckpointVerdict(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
