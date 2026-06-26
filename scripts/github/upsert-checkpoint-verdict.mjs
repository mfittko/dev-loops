#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveRefinementConfig } from "@dev-loops/core/config";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { truncateText } from "@dev-loops/core/bash-exit-one";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadPrGateCoordinationContext } from "../loop/detect-pr-gate-coordination-state.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { resolveRunId } from "@dev-loops/core/loop/run-context";
import { claimRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { detectInternalOnly } from "../loop/detect-internal-only-pr.mjs";
const GATE_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const GATE_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const GATE_EXECUTION_MODES = new Set(["fanout_fanin", "inline_single_agent"]);
const DEFAULT_EXECUTION_MODE = "inline_single_agent";
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
  --findings-json <path>                    Read STRUCTURED consolidated fan-in
                                            findings from a JSON file (array of
                                            { angle, verdict?, findings:[{severity,
                                            summary, file?, line?, disposition?}] }).
                                            Renders a readable per-angle breakdown
                                            (newlines preserved); the findings
                                            summary line carries a single-line
                                            digest. Takes precedence over
                                            --findings-summary/--findings-file for
                                            the rendered body. Intended for
                                            --execution-mode fanout_fanin.
  --next-action <text>
Optional:
  --gate <draft_gate|pre_approval_gate>     Auto-resolved from coordination state
                                            when omitted. Explicit gate is validated
                                            against allowed coordination actions.
  --findings-severity-counts <json>         JSON object mapping severity to count
                                             (e.g. '{"must-fix":0,"worth-fixing-now":0}').
                                             Required for --verdict clean when
                                             blockCleanOnFindingSeverities is configured.
  --execution-mode <fanout_fanin|inline_single_agent>
                                            How the gate review was executed.
                                            Defaults to inline_single_agent. Inline
                                            runs (default or explicit) emit a stderr
                                            warning that the fan-out/fan-in sub-loop
                                            was not run and REQUIRE --inline-reason.
  --inline-reason <text>                    REQUIRED when executionMode resolves to
                                            inline_single_agent (the default mode):
                                            short reason recorded for why the gate
                                            ran inline. A bare call with neither
                                            --execution-mode nor --inline-reason
                                            errors. Optional and ignored (dropped)
                                            for --execution-mode fanout_fanin.
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
function normalizeExecutionMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_EXECUTION_MODES.has(normalized) ? normalized : null;
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
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      verdict: { type: "string" },
      "findings-summary": { type: "string" },
      "findings-file": { type: "string" },
      "findings-json": { type: "string" },
      "next-action": { type: "string" },
      "findings-severity-counts": { type: "string" },
      "execution-mode": { type: "string" },
      "inline-reason": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    verdict: undefined,
    findingsSummary: undefined,
    findingsFile: undefined,
    findingsJson: undefined,
    nextAction: undefined,
    findingsSeverityCounts: undefined,
    executionMode: undefined,
    inlineReason: undefined,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (REMOVED_FLAGS.has(token.rawName)) {
      rejectRemovedFlag(token.rawName);
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "gate") {
      const gate = normalizeGateName(requireTokenValue(token, parseError));
      if (!gate) {
        throw parseError("--gate must be one of: draft_gate, pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token.name === "head-sha") {
      const headSha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!headSha) {
        throw parseError("--head-sha must be a 7-64 character hexadecimal SHA");
      }
      options.headSha = headSha;
      continue;
    }
    if (token.name === "verdict") {
      const verdict = normalizeVerdict(requireTokenValue(token, parseError));
      if (!verdict) {
        throw parseError("--verdict must be one of: clean, findings_present, blocked");
      }
      options.verdict = verdict;
      continue;
    }
    if (token.name === "findings-summary") {
      options.findingsSummary = normalizeRequiredText(requireTokenValue(token, parseError), "--findings-summary");
      continue;
    }
    if (token.name === "findings-file") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--findings-file must be a non-empty path");
      }
      options.findingsFile = rawPath;
      continue;
    }
    if (token.name === "findings-json") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--findings-json must be a non-empty path");
      }
      options.findingsJson = rawPath;
      continue;
    }
    if (token.name === "next-action") {
      options.nextAction = normalizeRequiredText(requireTokenValue(token, parseError), "--next-action");
      continue;
    }
    if (token.name === "findings-severity-counts") {
      const raw = requireTokenValue(token, parseError);
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
    if (token.name === "execution-mode") {
      const mode = normalizeExecutionMode(requireTokenValue(token, parseError));
      if (!mode) {
        throw parseError("--execution-mode must be one of: fanout_fanin, inline_single_agent");
      }
      options.executionMode = mode;
      continue;
    }
    if (token.name === "inline-reason") {
      const reason = collapseWhitespace(requireTokenValue(token, parseError));
      if (reason.length === 0) {
        throw parseError("--inline-reason must be a non-empty string");
      }
      options.inlineReason = smartTruncate(reason, MAX_GATE_COMMENT_EXCERPT_LENGTH);
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  // Default execution mode to inline_single_agent when omitted. inlineReason is
  // only meaningful for inline mode; drop it for fanout_fanin to avoid recording
  // a misleading reason.
  options.executionMode = options.executionMode ?? DEFAULT_EXECUTION_MODE;
  if (options.executionMode !== "inline_single_agent") {
    options.inlineReason = undefined;
  }
  const missing = ["repo", "pr", "headSha", "verdict", "findingsSummary", "nextAction"]
    .filter((key) => options[key] === undefined);
  // --findings-file and --findings-json each provide the findings body, so either
  // satisfies the findingsSummary requirement.
  if (options.findingsFile || options.findingsJson) {
    const fsIdx = missing.indexOf("findingsSummary");
    if (fsIdx !== -1) missing.splice(fsIdx, 1);
  }
  if (missing.length > 0) {
    throw parseError("upsert-checkpoint-verdict requires --repo, --pr, --head-sha, --verdict, --findings-summary (or --findings-file or --findings-json), and --next-action");
  }
  // Contract (skills/copilot-pr-followup/SKILL.md): inline runs MUST pass
  // --inline-reason. Inline is the default mode, so a complete call that resolves
  // to inline without a reason errors here. fanout_fanin does not require a
  // reason. Checked after required-field validation so an incomplete call still
  // reports the missing-field error first.
  if (options.executionMode === "inline_single_agent" && options.inlineReason === undefined) {
    throw parseError(
      "--inline-reason is required for executionMode inline_single_agent (the default). Pass --execution-mode fanout_fanin for fan-out/fan-in runs, or --inline-reason \"<why>\" to record why the gate ran inline.",
    );
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
const STRUCTURED_FINDINGS_SEVERITY_ORDER = ["must-fix", "worth-fixing-now", "defer"];
// Sanitize free text for a single-line markdown bullet. Collapse whitespace
// (LLM text often carries embedded newlines, which would split a bullet across
// lines) and neutralize HTML-comment delimiters so a finding field cannot smuggle
// a hidden marker into the rendered body. Mirrors post-gate-findings.mjs.
function sanitizeStructuredInline(value) {
  return String(value)
    .replace(/\s+/gu, " ")
    .replace(/<!--/gu, "&lt;!--")
    .replace(/-->/gu, "--&gt;")
    .trim();
}
// Sanitize text rendered inside an inline backtick code span (angle labels,
// file refs): additionally strip backticks so an embedded backtick cannot close
// the span and break out into raw markdown.
function sanitizeStructuredCodeSpan(value) {
  return sanitizeStructuredInline(String(value).replace(/`/gu, ""));
}
// Normalize the structured per-angle findings input into a deterministic,
// render-ready shape. Accepts the consolidated fan-in shape:
//   [{ angle, verdict?, findings: [{ severity, summary, file?, line?, disposition? }], disposition? }]
// Returns null when there is nothing structural to render (so the caller falls
// back to the free-text findings summary).
function normalizeStructuredFindings(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  const angles = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const angle = typeof raw.angle === "string" ? raw.angle.trim() : "";
    if (angle.length === 0) {
      continue;
    }
    const findingsInput = Array.isArray(raw.findings) ? raw.findings : [];
    const findings = [];
    for (const f of findingsInput) {
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        continue;
      }
      const summary = typeof f.summary === "string" ? f.summary.trim() : "";
      if (summary.length === 0) {
        continue;
      }
      const entry = {
        severity: typeof f.severity === "string" ? f.severity.trim() : "",
        summary,
      };
      if (typeof f.file === "string" && f.file.trim().length > 0) {
        entry.file = f.file.trim();
      }
      if (typeof f.line === "number" && Number.isFinite(f.line)) {
        entry.line = f.line;
      }
      if (typeof f.disposition === "string" && f.disposition.trim().length > 0) {
        entry.disposition = f.disposition.trim();
      }
      findings.push(entry);
    }
    // Sort findings by severity (must-fix first) for deterministic output,
    // preserving input order within a severity.
    findings.sort(
      (a, b) =>
        STRUCTURED_FINDINGS_SEVERITY_ORDER.indexOf(a.severity)
        - STRUCTURED_FINDINGS_SEVERITY_ORDER.indexOf(b.severity),
    );
    const verdict = typeof raw.verdict === "string" && raw.verdict.trim().length > 0
      ? raw.verdict.trim()
      : (findings.length > 0 ? "findings_present" : "clean");
    angles.push({ angle, verdict, findings });
  }
  return angles.length > 0 ? angles : null;
}
// Render the consolidated per-angle fan-in findings as a readable, multi-line
// markdown block: one section per angle (angle label + per-angle verdict),
// nested findings carrying severity and an optional file:line reference. Newlines
// are intentionally PRESERVED — this block is NOT run through collapseWhitespace /
// summarizeCheckpointVerdictText. The whole block is bounded by
// MAX_GATE_COMMENT_TEXT_LENGTH. The leading single-line digest is what the marker
// parser captures for the `**Findings summary:**` field; the structured body is
// nested below it and is deliberately written so no nested line matches a gate
// field regex (no `verdict:` / `next action:` / `execution mode:` line starts).
function renderStructuredFindings(angles) {
  const lines = [];
  for (const { angle, verdict, findings } of angles) {
    const angleLabel = sanitizeStructuredCodeSpan(angle);
    lines.push(`- \`${angleLabel}\` → ${sanitizeStructuredInline(verdict)}`);
    for (const finding of findings) {
      const severity = sanitizeStructuredInline(finding.severity) || "finding";
      const summary = sanitizeStructuredInline(finding.summary);
      let location = "";
      if (finding.file) {
        const fileRef = sanitizeStructuredCodeSpan(finding.file);
        const lineRef = Number.isFinite(finding.line) ? `:${finding.line}` : "";
        if (fileRef.length > 0) {
          location = ` (\`${fileRef}${lineRef}\`)`;
        }
      }
      const dispositionSuffix = finding.disposition
        ? ` — _${sanitizeStructuredInline(finding.disposition)}_`
        : "";
      lines.push(`  - [${severity}] ${summary}${location}${dispositionSuffix}`);
    }
  }
  return smartTruncate(lines.join("\n"), MAX_GATE_COMMENT_TEXT_LENGTH);
}
// Build the single-line digest shown on the `**Findings summary:**` line when a
// structured per-angle block is rendered. The marker/parse contract requires this
// line to carry non-empty, single-line content (parseGateReviewCommentFields
// captures only the remainder of this one line), so the structured block below it
// is purely presentational.
function buildStructuredFindingsDigest(angles) {
  const totalFindings = angles.reduce((sum, a) => sum + a.findings.length, 0);
  const angleWord = angles.length === 1 ? "angle" : "angles";
  if (totalFindings === 0) {
    return `${angles.length} ${angleWord} reviewed; no findings (see per-angle breakdown below).`;
  }
  const findingWord = totalFindings === 1 ? "finding" : "findings";
  return `${angles.length} ${angleWord} reviewed; ${totalFindings} ${findingWord} (see per-angle breakdown below).`;
}
function renderExecutionModeLine(executionMode, inlineReason) {
  const mode = executionMode ?? DEFAULT_EXECUTION_MODE;
  if (mode === "inline_single_agent") {
    const reason = typeof inlineReason === "string" ? collapseWhitespace(inlineReason) : "";
    return reason.length > 0
      ? `**Execution mode:** inline_single_agent — ${reason}`
      : "**Execution mode:** inline_single_agent";
  }
  return `**Execution mode:** ${mode}`;
}
export function renderGateReviewCommentBody({ gate, headSha, verdict, findingsSummary, nextAction, blockCleanOnFindingSeverities, executionMode, inlineReason, structuredFindings }) {
  const lines = [
    `### Gate review: \`${gate}\``,
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    `**Verdict:** ${verdict}`,
    renderExecutionModeLine(executionMode, inlineReason),
  ];
  if ((verdict === "findings_present" || verdict === "blocked") && blockCleanOnFindingSeverities && blockCleanOnFindingSeverities.length > 0) {
    const sevs = blockCleanOnFindingSeverities.join(", ");
    lines.push(`**Blocking severities:** ${sevs} (clean requires no findings matching these severities)`);
  }
  // When structured per-angle fan-in data is supplied, render it as a readable
  // multi-line block. The `**Findings summary:**` line still carries a non-empty
  // single-line digest so the marker/parse contract (which captures only that
  // one line) keeps round-tripping; the structured breakdown is nested below it
  // with newlines preserved (NOT collapsed to a run-on line).
  const angles = normalizeStructuredFindings(structuredFindings);
  if (angles) {
    lines.push(
      "",
      `**Findings summary:** ${buildStructuredFindingsDigest(angles)}`,
      "",
      renderStructuredFindings(angles),
    );
  } else {
    lines.push(
      "",
      `**Findings summary:** ${findingsSummary}`,
    );
  }
  lines.push(
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
      executionMode: markerSameHead.executionMode ?? null,
      inlineReason: markerSameHead.inlineReason ?? null,
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
      executionMode: strictSameHead.executionMode ?? markerSameHead?.executionMode ?? null,
      inlineReason: strictSameHead.inlineReason ?? markerSameHead?.inlineReason ?? null,
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
      executionMode: markerSameHead.executionMode ?? null,
      inlineReason: markerSameHead.inlineReason ?? null,
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

// Post a draft_gate verdict on a PR that is currently READY (non-draft) by
// briefly transitioning it back to draft, posting the verdict (which is only
// legal while the PR is a draft), then restoring the ready state. The caller's
// options — verdict, execution mode (e.g. fanout_fanin), findings, ledger — are
// preserved verbatim by re-entering upsertCheckpointVerdict once the PR is a
// draft. Unlike `reconcile-draft-gate` (which posts an inline verdict and so
// cannot satisfy requireFanoutEvidence on draft_gate), this preserves fanout
// evidence. On any failure mid-transition the PR is best-effort restored to
// ready before rethrowing. (#891)
//
// Durability note: there is a bounded window between convertPrToDraft and
// markPrReady (the recursive verdict post does network I/O) in which a process
// crash would leave the PR in draft INDEFINITELY — until a later dev-loop run (or a
// manual `gh pr ready`) restores it. Recovery is automatic but NOT instantaneous:
// the next run re-enters as a draft, posts normally, and restores ready. The
// transition is logged (below) so a stuck-draft PR leaves a breadcrumb. There is no
// mutual exclusion around the GitHub draft toggle itself; the convert and
// markPrReady mutations are individually idempotent, so concurrent cooperating
// runners cause at most a transient draft flicker (not a stuck draft) — only a hard
// crash mid-transition can leave the PR drafted until a subsequent run.
async function postDraftGateViaDraftTransition(options, { env, ghCommand, repoRoot }) {
  const { convertPrToDraft, markPrReady } = await import("./reconcile-draft-gate.mjs");
  process.stderr.write(
    `[draft_gate] ${options.repo}#${options.pr} is ready but needs clean draft_gate evidence; ` +
    `temporarily converting to draft to post the verdict, then restoring ready.\n`,
  );
  const conversion = await convertPrToDraft({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  let result;
  try {
    // The PR is now a draft, so RUN_DRAFT_GATE is the legal action. Re-enter with
    // the caller's full options; prIsDraft is now true so this branch is skipped.
    result = await upsertCheckpointVerdict(options, { env, ghCommand, repoRoot });
  } catch (error) {
    if (conversion.alreadyDraft !== true) {
      try {
        await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand });
        process.stderr.write(`[draft_gate] restored ${options.repo}#${options.pr} to ready after a failed verdict post.\n`);
      } catch (restoreError) {
        // Best-effort restore; surface the original error but log the restore failure
        // so the transient draft state is not silent.
        process.stderr.write(
          `[draft_gate] WARNING: failed to restore ${options.repo}#${options.pr} to ready after a failed verdict post; ` +
          `it may be left in draft: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`,
        );
      }
    }
    throw error;
  }
  if (conversion.alreadyDraft !== true) {
    try {
      await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand });
    } catch (restoreError) {
      // The verdict WAS posted successfully; only the ready-restore failed. Make that
      // explicit so the caller does not re-post the gate (the comment already exists)
      // and knows the PR may be left in draft until restored. (#891, Copilot review)
      throw new Error(
        `draft_gate verdict was posted to ${options.repo}#${options.pr} (comment ${result.commentId ?? "?"}), ` +
        `but restoring the PR to ready failed; it may be left in draft. Do not re-post the gate — re-run ` +
        `\`gh pr ready ${options.pr}\` (or the dev-loop) to restore ready. Cause: ` +
        `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
    process.stderr.write(`[draft_gate] restored ${options.repo}#${options.pr} to ready after posting draft_gate evidence.\n`);
  }
  return { ...result, draftTransition: true };
}

export async function upsertCheckpointVerdict(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  // Root cause 1: allow resurrected sessions to claim ownership when the previous
  // run's coordination record is stale. Without this, a new run ID is rejected even
  // though the old run is dead, forcing manual file deletion.
  const envRunId = resolveRunId(env) ?? "";
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
  const prIsDraft = Boolean(coordinationContext.prData?.isDraft);
  if (options.gate === "draft_gate" && coordination.draftGateAlreadySatisfied) {
    // The draft gate is a one-time boundary: a non-draft PR with clean draft_gate
    // evidence (on any head) has already passed it, and the pre-merge gate check
    // accepts that evidence. Re-posting is therefore a no-op, not an error —
    // return idempotent success so scripted/automated callers are not dead-ended
    // by a hard throw. (#891)
    const satisfied = coordinationContext.gateEvidence?.draftGate ?? {};
    // executionMode lives on the gate MARKER summary, not the COMMENT (strict)
    // summary: the strict `draftGate` summary is parsed from the visible comment
    // body via normalizeGateSummary, which carries no executionMode field, so it
    // would always collapse to inline_single_agent — misleading when the satisfied
    // gate actually ran fanout_fanin. Prefer the marker's executionMode; if the
    // marker is unavailable, OMIT the field rather than report a misleading default.
    const satisfiedExecutionMode =
      coordinationContext.gateEvidence?.draftGateMarker?.executionMode
      ?? satisfied.executionMode
      ?? null;
    return {
      ok: true,
      action: "noop",
      reason: "draft_gate already satisfied (clean evidence exists; draft→ready boundary recorded)",
      repo: options.repo,
      pr: options.pr,
      gate: "draft_gate",
      // Report the head the existing clean evidence was recorded on (which may be a
      // stale head — the draft gate is a one-time boundary accepted on any head),
      // not the request's canonical head, so the field is not misleading.
      headSha: satisfied.headSha ?? canonicalHeadSha,
      currentHeadSha: evidence.currentHeadSha,
      draftGateAlreadySatisfied: true,
      // Mirror the field shape of the other success paths for consistent consumers.
      blockCleanOnFindingSeverities: draftGateConfig.blockCleanOnFindingSeverities,
      ...(satisfiedExecutionMode != null ? { executionMode: satisfiedExecutionMode } : {}),
      ...(satisfied.commentId != null ? { commentId: satisfied.commentId } : {}),
      ...(satisfied.commentUrl ? { commentUrl: satisfied.commentUrl } : {}),
    };
  }
  const gateActionForbidden = coordination.forbiddenActions.includes(requestedGateAction);
  // Draft gate can only be posted while the PR is a draft (RUN_DRAFT_GATE is
  // forbidden once the PR is ready). A PR opened directly as ready — or any ready
  // PR that still needs clean draft_gate evidence for the pre-merge check — would
  // otherwise dead-end: the poster refuses, yet the pre-merge gate check fails
  // closed on "missing visible clean draft_gate comment". Rather than force the
  // operator to manually toggle the PR back to draft, perform the
  // draft→post→ready transition here, preserving the caller's verdict, execution
  // mode (e.g. fanout_fanin), findings, and ledger. This is the fanout-aware
  // analogue of `reconcile-draft-gate` (which only posts inline and so cannot
  // satisfy requireFanoutEvidence on draft_gate). (#891)
  //
  // Trigger ONLY when coordination explicitly allows RECONCILE_DRAFT_GATE — i.e. the
  // state machine determined this ready PR genuinely needs draft-gate evidence
  // reconciled (a converged/merge-progression state with no clean draft evidence).
  // RUN_DRAFT_GATE is forbidden on a ready PR in many OTHER states too (merge
  // conflicts, waiting-for-CI, unresolved feedback, blocked); converting those to
  // draft would be wrong, so we must NOT key off `gateActionForbidden` alone. (#891)
  if (
    options.gate === "draft_gate"
    && !prIsDraft
    && !coordination.draftGateAlreadySatisfied
    && coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE)
  ) {
    return await postDraftGateViaDraftTransition(options, { env, ghCommand, repoRoot });
  }
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
  // Structured per-angle findings (consolidated fan-in shape) take precedence
  // over the free-text summary: when present, the verdict comment renders a
  // multi-line per-angle breakdown and the `**Findings summary:**` line carries a
  // single-line digest (so the marker/parse contract still round-trips).
  let structuredFindings = null;
  if (options.findingsJson) {
    let raw;
    try {
      raw = await readFile(options.findingsJson, "utf8");
    } catch (err) {
      throw new Error(`Cannot read --findings-json "${options.findingsJson}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`--findings-json "${options.findingsJson}" is not valid JSON`);
    }
    // Accept either a bare array of per-angle entries or an object wrapping it
    // under `angles` / `findings` (defensive against caller shape drift).
    const candidate = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.angles) ? parsed.angles : (Array.isArray(parsed?.findings) ? parsed.findings : null));
    structuredFindings = normalizeStructuredFindings(candidate);
    if (!structuredFindings) {
      throw new Error(`--findings-json "${options.findingsJson}" did not contain any renderable per-angle findings (expected a non-empty array of { angle, findings } entries)`);
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
  // The findings-summary the comment is compared/round-tripped against. With a
  // structured render this is the single-line digest (what the marker parser
  // recovers from the `**Findings summary:**` line); otherwise the free-text path.
  const effectiveFindingsSummary = structuredFindings
    ? buildStructuredFindingsDigest(structuredFindings)
    : (options.findingsFile
      ? options.findingsSummary
      : appendGateEvidenceNote(options.findingsSummary, coordination.gateEvidenceNote ?? null));
  const desiredBody = renderGateReviewCommentBody({
    ...options,
    headSha: canonicalHeadSha,
    findingsSummary: effectiveFindingsSummary,
    structuredFindings,
    blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
  });
  const gateEvidence = selectGateEvidence(evidence, options.gate);
  const existing = summarizeExistingComment({ ...gateEvidence, headSha: canonicalHeadSha });
  const warning = detectStaleGateCommentWarning({ strict: gateEvidence.strict, headSha: canonicalHeadSha, gate: options.gate });
  const desiredExecutionMode = options.executionMode ?? DEFAULT_EXECUTION_MODE;
  // inlineReason is only meaningful for inline mode and is dropped for
  // fanout_fanin at parse time, so normalize both sides to null when the
  // resolved mode is not inline. This makes the noop short-circuit fire only
  // when verdict/summary/nextAction/executionMode AND the inline reason all
  // match, so a changed/added --inline-reason forces a comment update.
  const desiredInlineReason = desiredExecutionMode === "inline_single_agent"
    ? (options.inlineReason ?? null)
    : null;
  const existingInlineReason = (existing?.executionMode ?? DEFAULT_EXECUTION_MODE) === "inline_single_agent"
    ? (existing?.inlineReason ?? null)
    : null;
  if (
    existing
    && existing.contractComplete
    && existing.verdict === options.verdict
    && existing.findingsSummary === effectiveFindingsSummary
    && existing.nextAction === options.nextAction
    && (existing.executionMode ?? DEFAULT_EXECUTION_MODE) === desiredExecutionMode
    && existingInlineReason === desiredInlineReason
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
      executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
      ...(existingInlineReason ? { inlineReason: existingInlineReason } : {}),
      ...(warning ? { warning } : {}),
    };
  }
  if (existing) {
    const updated = await updateComment({ repo: options.repo, commentId: existing.commentId, body: desiredBody }, { env, ghCommand });
    // Post-update verification: verify the updated comment is visible via direct API fetch by comment ID.
    // A run id is set (production context) — DEVLOOPS_RUN_ID, or the PI_SUBAGENT_RUN_ID alias.
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
      executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
      ...(options.inlineReason ? { inlineReason: options.inlineReason } : {}),
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
  // Only active when a run id is set (production context) — DEVLOOPS_RUN_ID or the PI_SUBAGENT_RUN_ID alias.
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
    executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
    ...(options.inlineReason ? { inlineReason: options.inlineReason } : {}),
    ...(warning ? { warning } : {}),
    ...(verificationWarning ? { verificationWarning } : {}),
  };
}
export function buildInlineExecutionWarning(executionMode, inlineReason) {
  if ((executionMode ?? DEFAULT_EXECUTION_MODE) !== "inline_single_agent") {
    return null;
  }
  const reason = typeof inlineReason === "string" ? inlineReason.trim() : "";
  const base = "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).";
  return reason.length > 0 ? `${base} Reason: ${reason}` : base;
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
  const inlineWarning = buildInlineExecutionWarning(options.executionMode, options.inlineReason);
  try {
    const result = await upsertCheckpointVerdict(options);
    // Emit the inline-execution warning only on success so the JSON error
    // envelope on stderr stays clean and machine-parseable on failures.
    if (inlineWarning) {
      process.stderr.write(`${inlineWarning}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
