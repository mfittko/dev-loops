#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { GATE_FULL_LABEL, loadDevLoopConfig, resolveEffectiveCopilotRoundCap, resolveGateAngleContract, resolveGateConfig, resolveLightMode, resolveRefinementConfig, resolveRejectForeignAngles, resolveRequireFanoutEvidence } from "@dev-loops/core/config";
import { GATE_CONFIG_KEY, SEVERITY_ORDER, VALID_SEVERITIES, checkFanoutAngleCoverage, normalizeSeverity, normalizeSeverityCounts, provenanceConsistencyError, severityRank } from "@dev-loops/core/loop/gate-fanin";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { parseAllowedRefsCsv, parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson as runGhJson } from "@dev-loops/core/github/gh";
import { loadPrGateCoordinationContext } from "../loop/detect-pr-gate-coordination-state.mjs";
import { buildFanoutEnforcement, evaluateInlineFanoutMode } from "./detect-checkpoint-evidence.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { resolveRunId } from "@dev-loops/core/loop/run-context";
import { claimRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { detectInternalOnly } from "../loop/detect-internal-only-pr.mjs";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { convertPrToDraft, markPrReady } from "./_draft-transition.mjs";
import { listIssueComments, resolveAuthenticatedLogin, sanitizeCodeSpan, sanitizeInline } from "./post-gate-findings.mjs";
import { VALID_DISPOSITIONS } from "./write-gate-findings-log.mjs";
import {
  buildCommentableLineSet,
  buildReviewHeaderMarker,
  collectSuppressedFingerprints,
  createGateReview,
  fetchPrFiles,
  fingerprintFinding,
  isLocatableFinding,
  listPrReviews,
  readGateFindingsLedger,
  renderInlineCommentBody,
  renderNonLocatableBlock,
  resolveGateRound,
  updateGateReview,
} from "./_gate-finding-surface.mjs";
import { fetchAllReviewThreads } from "./list-review-threads.mjs";
const GATE_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const GATE_VERDICTS = new Set(["clean", "findings_present", "blocked"]);
const GATE_EXECUTION_MODES = new Set(["fanout_fanin", "inline_single_agent"]);
// Mirrors check-size-budget.mjs's computeSizeBudget outcome enum exactly —
// this file never recomputes the outcome, only validates/renders it.
const SIZE_BUDGET_OUTCOMES = new Set(["pass", "escalate", "block"]);
const DEFAULT_EXECUTION_MODE = "inline_single_agent";
const MAX_GATE_COMMENT_TEXT_LENGTH = 2000;
const MAX_GATE_COMMENT_EXCERPT_LENGTH = 120;
const REMOVED_FLAGS = new Set([
  "--force",
  "--force-reason",
]);
const USAGE = `Usage: upsert-checkpoint-verdict.mjs --repo <owner/name> --pr <number> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings-summary <text> | --findings-file <path> | --findings-json <path>) --next-action <text> [--gate <draft_gate|pre_approval_gate>] [--findings-ledger <path>]
The --findings-json structured per-angle path is preferred for --execution-mode fanout_fanin.
Post the gate round's SINGLE visible surface: one PR review of type COMMENT whose
body carries the checkpoint verdict fields and, with --findings-ledger, the
round's body-filed findings, while every locatable finding becomes one of that
review's inline comments. A finding's text appears exactly ONCE across the round.
Same-head reruns are idempotent: if a visible marker already exists for the same
\`gate + headSha\`, this helper updates its body in place when correction is needed
and suppresses duplicate reposts when the existing visible surface already matches.
A legacy verdict ISSUE comment for the same gate+head is still read and corrected
in place (back-compat); new rounds always post a review.
The gate (draft_gate or pre_approval_gate) is auto-resolved from the PR gate
coordination state when --gate is not provided. Explicit --gate is still accepted
but must match the coordination state's allowed next actions.
Required:
  --repo <owner/name>
  --pr <number>
  --head-sha <sha>                            FULL current head commit SHA (40 or 64 hex chars) — a short prefix is rejected
  --verdict <clean|findings_present|blocked>   Optional when --findings-ledger
                                            carries the consolidator's
                                            overallVerdict (the durable
                                            ledger written by
                                            write-gate-findings-log.mjs from
                                            consolidate-fanin.mjs's
                                            --ledger-out): derived from it by
                                            default, a matching explicit value
                                            is accepted, a contradicting one is
                                            REFUSED (#1616,
                                            GATE-COMMENT-VERDICT-VALUES).
                                            Required otherwise.
  --findings-summary <text>                 Findings summary as a single argument
                                            (use --findings-file for multi-line)
  --findings-file <path>                    Read findings summary from file;
                                            alternative to --findings-summary
                                            (preserves newlines; takes precedence
                                            when both are present)
  --findings-json <path>                    Read STRUCTURED fan-out review
                                            findings from a JSON file. PRIMARY
                                            shape is the per-angle review-results
                                            array (array of { angle, verdict?,
                                            findings:[{severity, summary, file?,
                                            line?, disposition?}] } — the same
                                            per-angle objects that feed
                                            consolidateFanin). A FLAT per-finding
                                            array (array of { severity, summary,
                                            angle?, file?|files?, line?,
                                            disposition? } — consolidateFanin's
                                            OUTPUT / toFindingsLogShape) is also
                                            accepted and is GROUPED by each
                                            finding's .angle. A non-empty input
                                            matching NEITHER shape is rejected
                                            (no silent all-clean). Renders a
                                            readable per-angle breakdown (newlines
                                            preserved); the findings summary line
                                            carries a single-line digest. Takes
                                            precedence over
                                            --findings-summary/--findings-file for
                                            the rendered body. Intended for
                                            --execution-mode fanout_fanin.
                                            --verdict clean is REJECTED when these
                                            per-angle findings carry a finding at a
                                            severity in the gate's
                                            blockCleanOnFindingSeverities — regardless
                                            of --findings-severity-counts — UNLESS that
                                            finding's disposition is "disputed" or
                                            "operator_acknowledged"; every other
                                            disposition (missing, "accepted-for-fix",
                                            "deferred", "needs-answer", or an unrecognized string)
                                            still trips this check. A finding the
                                            normalizer cannot interpret (no usable
                                            summary, or not an object) is never
                                            dropped: it is tallied as UNPARSEABLE
                                            and counts toward this clean-verdict
                                            check on its severity alone (no
                                            disposition to resolve against), so a
                                            blocking severity cannot pass silently
                                            by being unparseable (#1526). The
                                            resolved-disposition rule above and
                                            this tally operate on the same
                                            representation, where "could not
                                            interpret this finding" is
                                            distinguishable from "this finding is
                                            not blocking".
  --next-action <text>
Optional:
  --findings-ledger <path>                  Path to this round's
                                            write-gate-findings-log.mjs ledger
                                            ({ repo, pr, gate, headSha, verdict,
                                            findings[] }). Turns the posted review
                                            into the round's single finding
                                            surface: an in-diff file:line finding
                                            becomes an inline review comment, every
                                            other finding is body-filed, and the
                                            per-angle breakdown degrades to
                                            \`angle → verdict (+ count)\` one-liners
                                            so no finding's text is rendered twice.
                                            A candidate already covered by an
                                            OWN-AUTHORED review body or review
                                            thread (fingerprint match, resolved
                                            threads included) is dropped before
                                            posting. Omit it and the body keeps the
                                            full per-angle breakdown, with no
                                            inline comments. For --execution-mode
                                            fanout_fanin WITHOUT --findings-json (a
                                            withheld/over-budget round), this
                                            ledger's recorded \`provenance.perAngle\`
                                            is the mandatory-angle-coverage proof:
                                            it is re-validated against the gate's
                                            mandatoryAngles and the post is refused
                                            (naming the missing angle(s)) when it
                                            does not cover them, or when the ledger
                                            records no valid provenance. A
                                            fanout_fanin verdict WITHOUT
                                            --findings-json on a gate that
                                            configures mandatory angles
                                            (gates.<gate>.angles entries with
                                            mandatory: true) REQUIRES this
                                            flag; omitting both is refused.
  --gate <draft_gate|pre_approval_gate>     Auto-resolved from coordination state
                                            when omitted. Explicit gate is validated
                                            against allowed coordination actions.
  --lightweight                             This PR is light-dispatched (#1210):
                                            resolve the Copilot round cap as
                                            min(lightMode.maxCopilotRounds ?? 1,
                                            refinement.maxCopilotRounds) instead of
                                            refinement.maxCopilotRounds alone.
  --findings-severity-counts <json>         JSON object mapping severity to count
                                             (e.g. '{"high":0,"medium":0}').
                                             Required for --verdict clean when
                                             blockCleanOnFindingSeverities is configured.
                                             Also, when given alongside --findings-json, its
                                             known-severity (high/medium/low/question/nit)
                                             values are SUMMED and used as the posted
                                             "Findings summary:" total whenever that sum is
                                             HIGHER than --findings-json's own (possibly
                                             budget-marked) count — pass a fan-in's true,
                                             unbudgeted "severityCounts" here so the digest
                                             never undercounts a marker-collapsed round. A
                                             zero or partial counts object never lowers the
                                             digest below --findings-json's own real count.
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
  --allowed-refs <csv>                      Comma-separated numeric issue/PR ids to
                                            allow as deliberate cross-references in
                                            the posted verdict body and any inline/
                                            body-filed finding text (the
                                            no-ids-in-comments guard refuses any
                                            other bare #<digits>).
  --size-budget-json <path>                 Path to check-size-budget.mjs's (or
                                            evaluatePrSizeBudget's) JSON output —
                                            never recomputed here. Records the PR's
                                            size-budget outcome, whether any T1 file
                                            is in the diff (t1SliceLoc > 0), and
                                            waiver state on the posted verdict
                                            (**Size-budget outcome/T1 slice/waiver**
                                            lines). Omit it and those lines are not
                                            rendered at all — a verdict without them
                                            reads back as size evidence ABSENT,
                                            which the size-budget merge gate
                                            (@dev-loops/core/loop/size-budget-merge-gate)
                                            fails closed on, never as a silent pass.
Output (stdout, JSON):
  {
    "ok": true,
    "action": "created"|"updated"|"noop",
    "repo": "owner/repo",
    "pr": 17,
    "gate": "draft_gate",
    "headSha": "abc1234",
    "currentHeadSha": "abc1234",
    "surface": "review",
    "commentId": 101,
    "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-101",
    "round": 1,
    "inlineComments": 2,
    "bodyFiled": 1,
    "suppressed": 0
  }
  \`commentId\`/\`commentUrl\` identify the posted PR review (a legacy verdict issue
  comment when \`surface\` is "issue_comment"). \`round\`/\`inlineComments\`/
  \`bodyFiled\`/\`suppressed\` are present only for a --findings-ledger round.
A \`warning\` field is included when a gate comment for the same gate already
exists on a different head SHA (the old comment is stale for the current head).
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, gh failure, or contradictory gate evidence
  2  Invalid --jq filter`.trim();
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
function normalizeExecutionMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_EXECUTION_MODES.has(normalized) ? normalized : null;
}
// Entity-encode the two literal delimiters this repo's own machine-artifact
// markers open/close on (`<!--`/`-->`, see copilot-helpers.mjs's
// GATE_MACHINE_ARTIFACT_MARKER_RE and this file's own finding/review-header
// markers in close-gate-findings.mjs) so a free-text field can never quote one
// at column 0 of a rendered verdict comment and be mistaken for a genuine
// machine artifact by the shared comment summarizers. sanitizeStructuredInline
// already does this for the --findings-json render path; this is the
// equivalent for the free-text findings-summary/next-action/--findings-file
// paths below, which render with newlines preserved and no other escaping.
function encodeMachineArtifactMarkerDelimiters(value) {
  return value.replace(/<!--/gu, "&lt;!--").replace(/-->/gu, "--&gt;");
}
// Blockquote-prefix every continuation line (2nd line onward) of a newline-preserving
// free-text field (currently only --findings-file content) before it is spliced into
// the rendered comment body. copilot-helpers.mjs's stripGateCommentMarkdown trims each
// line and strips `#`/`**` but NOT a leading "> ", so a reviewer-controlled line inside
// the free text — e.g. "Execution mode: fanout_fanin" or "Next action: <spoof>" at
// column 0 — can never reach column 0 of its own logical line and match a field regex.
// Mirrors close-gate-findings.mjs's renderNonLocatableBlock blockquote defense. Applied
// AFTER truncation/marker-delimiter-encoding so the blockquote markers themselves never
// count against the field's length budget or get re-encoded.
function blockquoteContinuationLines(value) {
  const lines = String(value).split(/\r?\n/u);
  if (lines.length <= 1) {
    return value;
  }
  return [lines[0], ...lines.slice(1).map((line) => `> ${line}`)].join("\n");
}
function normalizeRequiredText(value, flag) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw parseError(`${flag} must be a non-empty string`);
  }
  if (flag === "--findings-summary") {
    return encodeMachineArtifactMarkerDelimiters(summarizeCheckpointVerdictText(normalized));
  }
  return encodeMachineArtifactMarkerDelimiters(enforcePostedCommentLimit(collapseWhitespace(normalized), MAX_GATE_COMMENT_TEXT_LENGTH, flag));
}
function collapseWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}
// Content rendered into an ACTUAL posted gate comment (operator --inline-reason,
// --next-action, findings summary, gate evidence note, structured findings render)
// is NEVER truncated — a silent/marker-bearing truncation reads as audit-trail
// corruption. Render in full up to a generous limit; beyond it, fail closed with
// an actionable error naming the over-long field and its limit, so the caller
// shortens the text before retrying.
// Stable machine-checkable tag on the length-bound throw below — consumers
// (e.g. consolidate-fanin.mjs's fitsRenderBudget/angleRenderCost) discriminate
// "over budget" from a shape/producer defect via this code, never by
// pattern-matching the human-readable message, which can be reworded freely.
const POSTED_COMMENT_LIMIT_EXCEEDED_CODE = "GATE_COMMENT_LIMIT_EXCEEDED";
export function isPostedCommentLimitError(err) {
  return err instanceof Error && err.code === POSTED_COMMENT_LIMIT_EXCEEDED_CODE;
}
function enforcePostedCommentLimit(value, limit, fieldLabel) {
  const text = String(value);
  if (text.length > limit) {
    // parseError (not a bare Error) so the JSON envelope carries `usage`, like
    // every other arg-validation failure in this CLI.
    throw Object.assign(
      parseError(
        `${fieldLabel} exceeds ${limit} chars (${text.length} chars); a posted gate comment is never truncated — shorten ${fieldLabel} and retry.`,
      ),
      { code: POSTED_COMMENT_LIMIT_EXCEEDED_CODE },
    );
  }
  return text;
}
// Bound a digest excerpt (a single captured CI/failure log line) to a length
// with a plain ellipsis — NEVER the `…[truncated N chars]` marker, which the
// posted-comment contract forbids from appearing in any posted comment. The
// excerpt is lossy-by-design condensation of captured output (not authored
// prose), so it bounds rather than fails closed.
function boundExcerpt(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
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
      ciLine = boundExcerpt(line, MAX_GATE_COMMENT_EXCERPT_LENGTH);
      continue;
    }
    if (
      failureExcerpt === null
      && (/^✖\s*/u.test(line) || /^FAIL\b/u.test(line) || /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b/u.test(line) || /\bError:/u.test(line))
    ) {
      failureExcerpt = boundExcerpt(line.replace(/^✖\s*/u, ""), MAX_GATE_COMMENT_EXCERPT_LENGTH);
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
    return enforcePostedCommentLimit(flat, limit, "findings summary");
  }
  const lines = normalized.split(/\r?\n/u);
  const verboseSummary = buildVerboseValidationSummary(lines);
  return enforcePostedCommentLimit(verboseSummary ?? flat, limit, "findings summary");
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
      "findings-ledger": { type: "string" },
      "next-action": { type: "string" },
      "findings-severity-counts": { type: "string" },
      "execution-mode": { type: "string" },
      "inline-reason": { type: "string" },
      "allowed-refs": { type: "string" },
      lightweight: { type: "boolean" },
      "size-budget-json": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
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
    findingsLedger: undefined,
    nextAction: undefined,
    findingsSeverityCounts: undefined,
    executionMode: undefined,
    inlineReason: undefined,
    allowedRefs: [],
    lightweight: false,
    sizeBudgetJson: undefined,
    jq: undefined,
    silent: false,
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
    if (token.name === "lightweight") {
      options.lightweight = true;
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
      const headSha = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!headSha) {
        throw parseError(FULL_HEAD_SHA_ERROR);
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
    if (token.name === "findings-ledger") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--findings-ledger must be a non-empty path");
      }
      options.findingsLedger = rawPath;
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
      for (const [key, value] of Object.entries(parsed)) {
        if (!Number.isInteger(value) || value < 0) {
          throw parseError(`--findings-severity-counts.${key} must be a non-negative integer`);
        }
      }
      // Legacy severity spellings merge into their canonical key.
      options.findingsSeverityCounts = normalizeSeverityCounts(parsed);
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
      options.inlineReason = enforcePostedCommentLimit(reason, MAX_GATE_COMMENT_TEXT_LENGTH, "--inline-reason");
      continue;
    }
    if (token.name === "allowed-refs") {
      options.allowedRefs = parseAllowedRefsCsv(requireTokenValue(token, parseError), "--allowed-refs", parseError);
      continue;
    }
    if (token.name === "size-budget-json") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--size-budget-json must be a non-empty path");
      }
      options.sizeBudgetJson = rawPath;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
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
  // --verdict is OPTIONAL when --findings-ledger is present: the consolidator's
  // computed `overallVerdict` (threaded into the durable ledger by
  // write-gate-findings-log.mjs from consolidate-fanin.mjs's --ledger-out) is
  // the source of truth, so the caller need not pass --verdict at all — it is
  // derived by default and a contradicting explicit value is refused at
  // enforcement time (#1616). The requirement is deferred to runtime
  // (upsertCheckpointVerdict) so a ledger whose `overallVerdict` is absent
  // (a legacy/inline ledger) still requires an explicit --verdict there.
  if (options.findingsLedger) {
    const vIdx = missing.indexOf("verdict");
    if (vIdx !== -1) missing.splice(vIdx, 1);
  }
  if (missing.length > 0) {
    throw parseError("upsert-checkpoint-verdict requires --repo, --pr, --head-sha, --verdict (or --findings-ledger carrying the consolidator's overallVerdict), --findings-summary (or --findings-file or --findings-json), and --next-action");
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
// The closed set of disposition values that mark a blocking finding as already
// resolved without changing its severity. Declared as a literal (not derived
// from VALID_DISPOSITIONS by subtraction) so a disposition added there later
// defaults to still-blocking by construction, rather than silently landing in
// this set the moment it is added upstream. The assertion below fails loudly
// if this set ever drifts to include a value VALID_DISPOSITIONS does not (a
// typo here), rather than drifting the other way (fail-open) as a derived set
// would. Anything outside this set — missing, "accepted-for-fix", "deferred",
// "needs-answer", or an unrecognized/typo'd string — must still count as blocking.
const RESOLVED_DISPOSITIONS = new Set(["disputed", "operator_acknowledged"]);
for (const disposition of RESOLVED_DISPOSITIONS) {
  if (!VALID_DISPOSITIONS.has(disposition)) {
    throw new Error(`RESOLVED_DISPOSITIONS contains "${disposition}", which is not in write-gate-findings-log.mjs's VALID_DISPOSITIONS`);
  }
}
// Thin aliases onto the canonical code-span/prose sanitizer pair
// (post-gate-findings.mjs's sanitizeCodeSpan/sanitizeInline). Both files used
// to keep their own byte-for-byte copy of this logic (plus a ~30-line
// rationale comment on each side citing the other); there is now exactly one
// implementation, imported here, so the two can never drift out of parity
// again. sanitizeStructuredCodeSpan renders enum labels/paths/refs inside a
// backtick code span (angle, file, severity/verdict/disposition); a code span
// is inert to markdown/HTML, so it only needs backtick-stripping (a stray
// backtick would prematurely close the span, unwrapping it back to raw
// markdown) and whitespace collapsing. sanitizeStructuredInline renders bare
// prose (the finding summary, not wrapped in a code span) — it composes that
// same code-span-safe base (so a stray backtick in summary can never shift
// CommonMark's left-to-right backtick pairing and break a LATER field's own
// code span on the same line) plus HTML-comment/tag/link/image-embed
// neutralization, all via HTML entities rather than backslash escapes (an
// entity has no failure mode where a value's own literal character absorbs
// the escape and turns it live again).
const sanitizeStructuredCodeSpan = sanitizeCodeSpan;
const sanitizeStructuredInline = sanitizeInline;
// Normalize a single finding object into a deterministic render entry, or null
// when it carries no usable summary.
function normalizeStructuredFinding(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    return null;
  }
  const summary = typeof f.summary === "string" ? f.summary.trim() : "";
  if (summary.length === 0) {
    return null;
  }
  const entry = {
    // Alias-normalized so a legacy-spelled input can never render the retired
    // word in a freshly posted comment (sort rank and label stay in sync).
    severity: typeof f.severity === "string" ? /** @type {string} */ (normalizeSeverity(f.severity.trim())) : "",
    summary,
  };
  if (typeof f.file === "string" && f.file.trim().length > 0) {
    entry.file = f.file.trim();
  } else if (Array.isArray(f.files)) {
    // Flat consolidated findings (toFindingsLogShape) carry a `files` array
    // rather than a single `file`; surface the first entry as the location ref.
    const file = f.files.find((x) => typeof x === "string" && x.trim().length > 0);
    if (file) {
      entry.file = file.trim();
    }
  }
  if (typeof f.line === "number" && Number.isFinite(f.line)) {
    entry.line = f.line;
  }
  if (typeof f.disposition === "string" && f.disposition.trim().length > 0) {
    entry.disposition = f.disposition.trim();
  }
  // Preserve the judge's relevance-based dispositions (#1525) so the
  // structured findings render shows what was consciously not acted on.
  if (typeof f.judgeDisposition === "string" && f.judgeDisposition.trim().length > 0) {
    entry.judgeDisposition = f.judgeDisposition.trim();
  }
  return entry;
}
// Sort findings by severity (high first, unknown/missing last) for
// deterministic output, preserving input order within a severity.
// severityRank (@dev-loops/core/loop/gate-fanin) is the one rank rule this
// and consolidate-fanin.mjs's angleWorstSeverityRank both share, so the two
// can never drift on how an unknown severity ranks.
function sortStructuredFindings(findings) {
  findings.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  return findings;
}
// Does this item look like a NESTED per-angle entry (consolidateFanin's INPUT
// shape: { angle, verdict?, findings: [...] })? It must carry a `findings`
// ARRAY — that, not the presence of an `angle` string, is what distinguishes a
// per-angle section from a single flat finding.
function looksLikePerAngleEntry(item) {
  return Boolean(item) && typeof item === "object" && !Array.isArray(item) && Array.isArray(item.findings);
}
// Does this item look like a FLAT per-finding entry (consolidateFanin's OUTPUT /
// toFindingsLogShape shape: { severity, summary, angle?, file?/files?, ... })? It
// carries a summary (and typically a severity) but NO nested `findings` array.
function looksLikeFlatFinding(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  if (Array.isArray(item.findings)) {
    return false;
  }
  return typeof item.summary === "string" && item.summary.trim().length > 0;
}
// Build a render-ready per-angle section from a nested entry. A missing/blank
// angle is NOT dropped — its findings still matter for the verdict — so it is
// rendered under a `general` fallback label (consistent with the flat-grouping
// angleless→`general` bucket). Dropping it would let a non-empty structured
// payload silently degrade to the free-text path and hide findings.
//
// A finding that normalization CANNOT interpret (no usable summary, or not an
// object) is NEVER silently dropped (#1526): it is tracked on the section's
// `unparseable` list so the clean-verdict cross-check can still see a blocking
// severity it carries, and the rendered comment can surface it explicitly as
// unparseable. The tally must operate on a representation where "could not
// interpret this finding" is distinguishable from "this finding is not
// blocking" — a dropped finding is neither, so it is kept here. The severity is
// the one field read straight off the raw finding (when present) so the
// cross-check can decide blocking without broadening what normalizeStructuredFinding
// accepts (the non-goal: the question is what happens to what it rejects, not
// whether it should reject less).
function buildAngleSectionFromNested(raw) {
  const trimmedAngle = typeof raw.angle === "string" ? raw.angle.trim() : "";
  const angle = trimmedAngle.length > 0 ? trimmedAngle : "general";
  const findings = [];
  const unparseable = [];
  for (const f of raw.findings) {
    const entry = normalizeStructuredFinding(f);
    if (entry) {
      findings.push(entry);
    } else if (f !== undefined) {
      // normalizeStructuredFinding rejected this entry (no usable summary, or
      // not an object). A bare `null` still counts: something occupied a
      // findings slot the guard cannot interpret, and dropping it silently is
      // exactly the fail-open this list exists to close. `undefined` (a sparse
      // array hole) is the one non-finding value skipped, since nothing was
      // emitted there at all.
      unparseable.push({ severity: readRawSeverity(f) });
    }
  }
  // renderGateReviewCommentBody re-normalizes an already-normalized section
  // (its structuredFindings argument); preserve any unparseable entries carried
  // on the input so re-normalization can never silently re-drop them (#1526).
  // The severity is re-read through readRawSeverity (not copied verbatim) so a
  // non-string severity on a hand-crafted/producer-drift section is coerced to
  // the same canonical vocabulary first-creation uses — never carried as a
  // non-string that normalizeSeverity would skip and the renderer would emit as
  // `[object Object]` (Copilot review feedback on #1526).
  if (Array.isArray(raw.unparseable)) {
    for (const u of raw.unparseable) {
      if (u && typeof u === "object") unparseable.push({ severity: readRawSeverity(u) });
    }
  }
  sortStructuredFindings(findings);
  const verdict = typeof raw.verdict === "string" && raw.verdict.trim().length > 0
    ? raw.verdict.trim()
    : (findings.length > 0 || unparseable.length > 0 ? "findings_present" : "clean");
  return { angle, verdict, findings, unparseable };
}
// Read the severity off a raw finding the normalizer rejected, so the
// clean-verdict cross-check can still decide whether an unparseable finding
// carries a blocking severity (#1526). Returns the normalized severity string
// (or "" when none is readable); an unknown/typo'd value normalizes to itself
// and then matches no blocking severity, same as a parseable unknown severity.
function readRawSeverity(f) {
  if (!f || typeof f !== "object") return "";
  if (typeof f.severity === "string" && f.severity.trim().length > 0) {
    return /** @type {string} */ (normalizeSeverity(f.severity.trim()));
  }
  return "";
}
// Group a FLAT per-finding array into per-angle sections, keyed by each
// finding's `.angle` field (findings without an angle are grouped under a
// shared "general" bucket so they are NOT dropped). The verdict for each
// section is derived from whether it carries findings.
function groupFlatFindingsByAngle(input) {
  const order = [];
  const byAngle = new Map();
  for (const f of input) {
    const entry = normalizeStructuredFinding(f);
    if (!entry) {
      continue;
    }
    const angle = typeof f.angle === "string" && f.angle.trim().length > 0
      ? f.angle.trim()
      : "general";
    if (!byAngle.has(angle)) {
      byAngle.set(angle, []);
      order.push(angle);
    }
    byAngle.get(angle).push(entry);
  }
  const angles = [];
  for (const angle of order) {
    const findings = sortStructuredFindings(byAngle.get(angle));
    angles.push({
      angle,
      verdict: findings.length > 0 ? "findings_present" : "clean",
      findings,
      // Flat per-finding input that lacks a usable summary is rejected by
      // normalizeStructuredFindings' unrecognized-item guard before this grouping
      // runs, so a flat section never carries an unparseable entry. Kept as an
      // empty array so the section shape matches the nested path and consumers
      // can read `angle.unparseable` uniformly (#1526).
      unparseable: [],
    });
  }
  return angles;
}
// Normalize the structured findings input into a deterministic, render-ready
// per-angle shape. Accepts BOTH recognizable shapes without silently zeroing
// findings:
//   1. NESTED per-angle (consolidateFanin INPUT):
//        [{ angle, verdict?, findings: [{ severity, summary, file?, line?, disposition? }] }]
//      → rendered one section per angle.
//   2. FLAT per-finding (consolidateFanin OUTPUT / toFindingsLogShape):
//        [{ severity, summary, angle?, file?|files?, line?, disposition? }]
//      → GROUPED by each finding's `.angle` into per-angle sections.
// Returns null when the input is empty/non-array (caller falls back to the
// free-text summary). THROWS when the input is non-empty but matches NEITHER
// shape, so a wrong input shape can never silently render an all-clean verdict.
// Exported so tests can drive the exact same parsing/validation the
// --findings-json code path below uses, end to end, without spawning a child
// process (see test/loop/consolidate-fanin.test.mjs).
export function normalizeStructuredFindings(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  // A gate verdict comment must NEVER silently hide/drop findings. If ANY item
  // in a non-empty payload is neither a recognizable per-angle entry nor a
  // recognizable flat finding, THROW rather than filter-and-proceed — an
  // unrecognized item (producer drift, malformed entry) could otherwise carry a
  // dropped finding the reviewer never sees.
  const unrecognized = input.filter(
    (item) => !looksLikePerAngleEntry(item) && !looksLikeFlatFinding(item),
  );
  if (unrecognized.length === input.length) {
    throw new Error(
      "--findings-json input is non-empty but matches neither recognized shape: "
      + "a per-angle array ([{ angle, verdict?, findings: [...] }]) or a flat "
      + "per-finding array ([{ severity, summary, angle?, ... }]). Refusing to "
      + "render an all-clean verdict from unrecognized findings.",
    );
  }
  if (unrecognized.length > 0) {
    throw new Error(
      "--findings-json input contains "
      + `${unrecognized.length} of ${input.length} item(s) that match neither a `
      + "per-angle entry (with a nested `findings` array) nor a flat per-finding "
      + "entry (with a non-empty `summary`). Refusing to silently drop them from a "
      + "gate verdict; fix the producer or remove the malformed entries.",
    );
  }
  const nestedCount = input.filter(looksLikePerAngleEntry).length;
  let angles;
  if (nestedCount > 0) {
    // Treat as per-angle. Any flat items mixed in are ambiguous; reject rather
    // than guess (mixing the two shapes is not a supported producer output).
    if (nestedCount !== input.length) {
      throw new Error(
        "--findings-json input mixes per-angle entries (with a nested `findings` "
        + "array) and flat per-finding entries; supply one shape or the other.",
      );
    }
    angles = [];
    for (const raw of input) {
      angles.push(buildAngleSectionFromNested(raw));
    }
  } else {
    angles = groupFlatFindingsByAngle(input);
  }
  return angles.length > 0 ? angles : null;
}
// Render the consolidated per-angle fan-in findings as a readable, multi-line
// markdown block: one section per angle (angle label + per-angle verdict),
// nested findings carrying severity and an optional file:line reference. Newlines
// are intentionally PRESERVED — this block is NOT run through collapseWhitespace /
// summarizeCheckpointVerdictText. The whole block is bounded by
// MAX_GATE_COMMENT_TEXT_LENGTH and THROWS above it (enforcePostedCommentLimit).
// The leading single-line digest is what the marker parser captures for the
// `**Findings summary:**` field; the structured body is nested below it and is
// deliberately written so no nested line matches a gate field regex (no
// `verdict:` / `next action:` / `execution mode:` line starts) — belt-and-braces
// alongside the parser's actual guards. The real guards against a per-angle
// finding's own free text forging a field (including `next action`, which
// renders after this block) are: (1) parseGateReviewCommentFields is
// first-NON-EMPTY-wins per field, so a genuine line rendered before this block
// always wins over a spoofed one rendered after it, and (2) any free-text
// field that preserves newlines (the --findings-file path above) has every
// continuation line blockquoted (`> `) before splicing, so an embedded
// "next action:"/"execution mode:"/etc. line can never sit at column 0 of its
// own logical line for the parser to match. This template's own bullet/
// backtick shape is a redundant third layer, not the only guard.
// Exported so
// consolidate-fanin.mjs can measure whether a candidate findingsJson shape
// actually renders (catching this throw) instead of approximating its
// rendered size — the exact bound this function enforces, not an estimate of
// it (see consolidate-fanin.mjs's fitsRenderBudget).
export function renderStructuredFindings(angles) {
  const lines = [];
  for (const { angle, verdict, findings, unparseable } of angles) {
    // severity/verdict/disposition are enum labels, never prose — rendered
    // inside a backtick code span (like the angle label and file ref already
    // are) rather than bare, so a reviewer-supplied value crafted to look like
    // markdown link/image syntax (e.g. a severity of `high](url)`) cannot
    // break out of its literal `[...]`/`_..._` position: sanitizeStructuredCodeSpan
    // strips any backtick from the value first, so the span it is wrapped in
    // below can never be prematurely closed by the value's own content.
    const angleLabel = sanitizeStructuredCodeSpan(angle);
    lines.push(`- \`${angleLabel}\` → \`${sanitizeStructuredCodeSpan(verdict)}\``);
    for (const finding of findings) {
      const severity = sanitizeStructuredCodeSpan(finding.severity) || "finding";
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
        ? ` — _\`${sanitizeStructuredCodeSpan(finding.disposition)}\`_`
        : "";
      // Judge relevance-based disposition (#1525).
      const judgeSuffix = finding.judgeDisposition
        ? ` — judge: _\`${sanitizeStructuredCodeSpan(finding.judgeDisposition)}\`_`
        : "";
      lines.push(`  - [\`${severity}\`] ${summary}${location}${dispositionSuffix}${judgeSuffix}`);
    }
    // A finding the normalizer could not interpret is reported explicitly as
    // unparseable — never dropped (#1526). Its severity (when readable) is
    // rendered so a reader can see whether it sat at a blocking severity;
    // the `unparseable` label itself distinguishes "could not interpret this
    // finding" from a normal `[severity]` finding that is simply not blocking.
    for (const u of unparseable ?? []) {
      const sev = sanitizeStructuredCodeSpan(u.severity) || "none";
      lines.push(`  - [\`unparseable\`] finding could not be interpreted (severity: \`${sev}\` — counted toward the clean-verdict tally, not dropped)`);
    }
  }
  return enforcePostedCommentLimit(lines.join("\n"), MAX_GATE_COMMENT_TEXT_LENGTH, "--findings-json structured findings render");
}
// The reduced per-angle breakdown for a round that carries its own finding
// surface: angle, per-angle verdict, and the finding COUNT — never a finding's
// text, which lives exactly once on this same review (an inline comment, or the
// body-filed block). Unbounded by construction: one short line per angle, and
// the angle pool is config-bounded, so this can never approach the posted-body
// budget the way a full breakdown can.
export function renderAngleVerdictDigest(angles) {
  return angles
    .map(({ angle, verdict, findings, unparseable }) => {
      // An unparseable finding still occupies a finding slot, so it counts
      // toward the per-angle total — otherwise the digest would undercount a
      // round that the clean-verdict tally and the rendered breakdown both see
      // (#1526).
      const count = findings.length + (Array.isArray(unparseable) ? unparseable.length : 0);
      const suffix = count === 0 ? "" : ` (${count} finding${count === 1 ? "" : "s"})`;
      return `- \`${sanitizeStructuredCodeSpan(angle)}\` → \`${sanitizeStructuredCodeSpan(verdict)}\`${suffix}`;
    })
    .join("\n");
}
// Build the single-line digest shown on the `**Findings summary:**` line when a
// structured per-angle block is rendered. The marker/parse contract requires this
// line to carry non-empty, single-line content (parseGateReviewCommentFields
// captures only the remainder of this one line), so the structured block below it
// is purely presentational.
//
// `angles[].findings.length` undercounts whenever a fan-in's over-budget
// degradation has collapsed an angle's real findings into one marker finding
// (consolidate-fanin.mjs) — the digest would then report e.g. "14 findings"
// for a round that actually carries hundreds. When the caller supplies
// `severityCounts` (--findings-severity-counts, the TRUE unbudgeted totals a
// gate-review fan-in always emits alongside its possibly-marked
// "findingsJson"), sum that instead so the posted digest matches the ledger
// rather than the rendered marker count.
//
// A marker collapse can only ever UNDERcount the rendered content, never
// over-count it, so `severityCounts` may only RAISE the total, never lower
// it: 0 is not nullish, so a zeroed or partial counts object (e.g. the
// mandatory gate-comment template's placeholder, or the clean-verdict
// guard's own required all-blocking-severities-zero shape) must not silently
// replace a real per-angle count with "no findings" while the per-angle
// breakdown below it still lists real findings. Only known severity keys are
// summed — an unrecognized/typo'd key must not inflate the posted total.
function buildStructuredFindingsDigest(angles, severityCounts) {
  // Unparseable findings occupy a finding slot too, so they count toward the
  // per-angle total — the digest must not undercount a round whose tally and
  // rendered breakdown both see the unparseable entries (#1526).
  const angleTotal = angles.reduce((sum, a) => sum + a.findings.length + (Array.isArray(a.unparseable) ? a.unparseable.length : 0), 0);
  const countedTotal = severityCounts && typeof severityCounts === "object" && !Array.isArray(severityCounts)
    ? Object.entries(severityCounts).reduce((sum, [key, n]) => {
        // Keys normalize through the legacy alias map so a "defer"-keyed count
        // still sums into the total; unknown/typo'd keys still never inflate it.
        const sev = /** @type {string} */ (normalizeSeverity(key));
        return sum + (SEVERITY_ORDER.includes(sev) && Number.isFinite(n) ? n : 0);
      }, 0)
    : null;
  const totalFindings = Math.max(countedTotal ?? 0, angleTotal);
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
// Size-budget fields (phase 3 of the fail-closed PR size budget): rendered ONLY when a caller
// supplies `sizeOutcome` (the wiring is opt-in — a caller that never ran the
// size-budget check keeps the exact body shape it has always had). Each
// field is its own line, matching the existing one-field-per-line convention
// (Reviewed head SHA / Verdict / Next action), so
// parseGateReviewCommentFields's per-line label matching (copilot-helpers.mjs)
// round-trips them without a combined-line parse. `sizeWaiverApprovedBy` is
// free text and is routed through sanitizeInline (entity-encoded, never
// backslash-escaped) so a crafted approver name can never forge a markdown
// delimiter or a second field label.
//
// All-or-nothing: `sizeOutcome` alone is not enough. A caller that supplies
// `sizeOutcome` but leaves `sizeTouchesT1`/`sizeWaiverGranted` missing or
// ill-typed gets NOTHING rendered — never a coerced "not touched"/"none"
// line. Persisting that coerced line would read back downstream as
// genuine benign evidence and defeat resolveSizeBudgetHumanApprovalRequired's
// (size-budget-merge-gate.mjs) fail-closed-on-absent-evidence contract. An
// omitted section round-trips as absent (null) instead, which that resolver
// already treats as "human approval required". Only a complete, well-typed
// result renders.
function renderSizeBudgetLines({ sizeOutcome, sizeTouchesT1, sizeWaiverGranted, sizeWaiverApprovedBy }) {
  if (typeof sizeOutcome !== "string" || sizeOutcome.length === 0) {
    return [];
  }
  if (typeof sizeTouchesT1 !== "boolean" || typeof sizeWaiverGranted !== "boolean") {
    return [];
  }
  if (sizeWaiverApprovedBy !== null && sizeWaiverApprovedBy !== undefined && typeof sizeWaiverApprovedBy !== "string") {
    return [];
  }
  const waiverLine = sizeWaiverGranted === true
    ? (typeof sizeWaiverApprovedBy === "string" && sizeWaiverApprovedBy.trim().length > 0
      ? `granted by ${sanitizeInline(sizeWaiverApprovedBy)}`
      : "granted")
    : "none";
  return [
    `**Size-budget outcome:** ${sizeOutcome}`,
    `**Size-budget T1 slice:** ${sizeTouchesT1 === true ? "touched" : "not touched"}`,
    `**Size-budget waiver:** ${waiverLine}`,
  ];
}
export function renderGateReviewCommentBody({ gate, headSha, verdict, findingsSummary, nextAction, blockCleanOnFindingSeverities, executionMode, inlineReason, sizeOutcome, sizeTouchesT1, sizeWaiverGranted, sizeWaiverApprovedBy, structuredFindings, findingsSeverityCounts, gateEvidenceNote, round, nonLocatableFindings }) {
  const lines = [
    `### Gate review: \`${gate}\``,
  ];
  // The gate-findings-review marker records WHICH round this single surface is,
  // scoped to this gate, so the round cross-check can be computed from review
  // bodies alone. Rendered only for a round that actually carries the finding
  // surface (a `--findings-ledger` round); a bare verdict post keeps the exact
  // body shape it has always had.
  if (Number.isInteger(round)) {
    lines.push(buildReviewHeaderMarker({ gate, headSha, round }));
  }
  lines.push(
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    `**Verdict:** ${verdict}`,
    renderExecutionModeLine(executionMode, inlineReason),
    ...renderSizeBudgetLines({ sizeOutcome, sizeTouchesT1, sizeWaiverGranted, sizeWaiverApprovedBy }),
  );
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
  // A round that carries its own finding surface (this review's inline comments
  // plus the body-filed block below) renders each finding's TEXT exactly once,
  // on that surface. The per-angle breakdown then degrades to `angle → verdict
  // (+ finding count)` one-liners: repeating each summary here would put the
  // same text twice on the SAME visible surface. A bare verdict post (no
  // findings ledger, so no finding surface at all) keeps the full breakdown —
  // it is the only place those findings would otherwise appear.
  const hasFindingSurface = Array.isArray(nonLocatableFindings);
  if (angles) {
    lines.push(
      "",
      `**Findings summary:** ${buildStructuredFindingsDigest(angles, findingsSeverityCounts)}`,
      "",
      hasFindingSurface ? renderAngleVerdictDigest(angles) : renderStructuredFindings(angles),
    );
  } else {
    lines.push(
      "",
      `**Findings summary:** ${findingsSummary}`,
    );
  }
  if (hasFindingSurface) {
    lines.push("", "**Body-filed findings** (no in-diff location):");
    if (nonLocatableFindings.length === 0) {
      lines.push("", "> None — every finding this round is an inline comment on this review.");
    } else {
      for (const finding of nonLocatableFindings) {
        lines.push("", renderNonLocatableBlock(finding, { round }));
      }
    }
  }
  // The gate-evidence note (e.g. the round-cap / round-exhaustion fallback note)
  // renders as its own labeled line — never spliced with `;` into the findings
  // summary, which would read as double punctuation and make machine-added text
  // indistinguishable from operator prose. Parity: both the structured and
  // free-text findings-summary paths get this same treatment.
  const normalizedGateEvidenceNote = typeof gateEvidenceNote === "string" ? collapseWhitespace(gateEvidenceNote) : "";
  if (normalizedGateEvidenceNote.length > 0) {
    lines.push(
      "",
      `**Gate evidence note:** ${enforcePostedCommentLimit(normalizedGateEvidenceNote, MAX_GATE_COMMENT_TEXT_LENGTH, "gate evidence note")}`,
    );
  }
  lines.push(
    "",
    `**Next action:** ${nextAction}`,
  );
  // Neutralize any bare @copilot/`/copilot`* tokens in the rendered body (gate
  // evidence legitimately quotes the anti-summon rule, e.g. from a findings
  // excerpt) so posting this comment can never arm request-copilot-review.mjs's
  // anti-summon guard on a later request.
  return sanitizeCopilotSummonTokens(lines.join("\n"));
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
// `surface` arrives already coerced by core's normalizeVerdictSurface (via
// detectCheckpointEvidence's normalizeGateSummary/normalizeGateMarkerSummary);
// pass it through rather than restating the vocabulary a second time here.
function summarizeExistingComment({ strict, marker, headSha }) {
  const strictSameHead = strict?.visible === true && strict.headSha === headSha ? strict : null;
  const markerSameHead = marker?.visible === true && marker.headSha === headSha ? marker : null;
  if (markerSameHead && (!strictSameHead || markerSameHead.commentId !== strictSameHead.commentId)) {
    return {
      kind: "marker",
      surface: markerSameHead.surface,
      commentId: markerSameHead.commentId,
      commentUrl: markerSameHead.commentUrl,
      verdict: markerSameHead.verdict,
      findingsSummary: markerSameHead.findingsSummary ?? null,
      nextAction: markerSameHead.nextAction ?? null,
      executionMode: markerSameHead.executionMode ?? null,
      inlineReason: markerSameHead.inlineReason ?? null,
      sizeOutcome: markerSameHead.sizeOutcome ?? null,
      sizeTouchesT1: markerSameHead.sizeTouchesT1 ?? null,
      sizeWaiverGranted: markerSameHead.sizeWaiverGranted ?? null,
      sizeWaiverApprovedBy: markerSameHead.sizeWaiverApprovedBy ?? null,
      contractComplete: markerSameHead.contractComplete === true,
    };
  }
  if (strictSameHead) {
    return {
      kind: "strict",
      surface: strictSameHead.surface,
      commentId: strictSameHead.commentId,
      commentUrl: strictSameHead.commentUrl,
      verdict: strictSameHead.verdict,
      findingsSummary: strictSameHead.findingsSummary,
      nextAction: strictSameHead.nextAction,
      executionMode: strictSameHead.executionMode ?? markerSameHead?.executionMode ?? null,
      inlineReason: strictSameHead.inlineReason ?? markerSameHead?.inlineReason ?? null,
      sizeOutcome: strictSameHead.sizeOutcome ?? markerSameHead?.sizeOutcome ?? null,
      sizeTouchesT1: strictSameHead.sizeTouchesT1 ?? markerSameHead?.sizeTouchesT1 ?? null,
      sizeWaiverGranted: strictSameHead.sizeWaiverGranted ?? markerSameHead?.sizeWaiverGranted ?? null,
      sizeWaiverApprovedBy: strictSameHead.sizeWaiverApprovedBy ?? markerSameHead?.sizeWaiverApprovedBy ?? null,
      contractComplete: true,
    };
  }
  if (markerSameHead) {
    return {
      kind: "marker",
      surface: markerSameHead.surface,
      commentId: markerSameHead.commentId,
      commentUrl: markerSameHead.commentUrl,
      verdict: markerSameHead.verdict,
      findingsSummary: markerSameHead.findingsSummary ?? null,
      nextAction: markerSameHead.nextAction ?? null,
      executionMode: markerSameHead.executionMode ?? null,
      inlineReason: markerSameHead.inlineReason ?? null,
      sizeOutcome: markerSameHead.sizeOutcome ?? null,
      sizeTouchesT1: markerSameHead.sizeTouchesT1 ?? null,
      sizeWaiverGranted: markerSameHead.sizeWaiverGranted ?? null,
      sizeWaiverApprovedBy: markerSameHead.sizeWaiverApprovedBy ?? null,
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
// Legacy in-place correction path: a verdict posted as an ISSUE comment by an
// older run (or by the fallback poster) is still corrected on its own surface
// rather than duplicated as a new review.
async function updateComment({ repo, commentId, body }, { env, ghCommand, runChild = defaultRunChild }) {
  const payload = await runGhJson(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`], { env, ghCommand, runChild });
  return parseCommentMutationResponse(payload);
}

// Read-back confirmation that the just-created/updated surface is retrievable.
// A PR review and an issue comment live on different endpoints, so the check
// follows the surface it wrote.
async function verifyPostedSurface({ repo, pr, surface, commentId }, { env, ghCommand, runChild = defaultRunChild }) {
  const route = surface === "review"
    ? `repos/${repo}/pulls/${pr}/reviews/${commentId}`
    : `repos/${repo}/issues/comments/${commentId}`;
  try {
    const payload = await runGhJson(["api", route], { env, ghCommand, runChild });
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
async function postDraftGateViaDraftTransition(options, { env, ghCommand, repoRoot, runChild = defaultRunChild }) {
  process.stderr.write(
    `[draft_gate] ${options.repo}#${options.pr} is ready but needs clean draft_gate evidence; ` +
    `temporarily converting to draft to post the verdict, then restoring ready.\n`,
  );
  const conversion = await convertPrToDraft({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
  let result;
  try {
    // The PR is now a draft, so RUN_DRAFT_GATE is the legal action. Re-enter with
    // the caller's full options; prIsDraft is now true so this branch is skipped.
    // `_draftTransitionInProgress` guards against unbounded recursion: if GitHub's
    // draft-state read still lags the conversion mutation on re-entry (isDraft reads
    // false again), the reconcile branch must NOT fire a second time — it fails closed
    // with a clear error instead of recursing indefinitely (exit 13). (#1020)
    result = await upsertCheckpointVerdict(
      { ...options, _draftTransitionInProgress: true },
      { env, ghCommand, repoRoot, runChild },
    );
  } catch (error) {
    if (conversion.alreadyDraft !== true) {
      try {
        await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
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
      await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
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

// #1472: builds the exact input object passed to evaluatePrGateCoordination.
// Exported (and used by upsertCheckpointVerdict below, not duplicated) so a
// test can assert the real production wiring — e.g. that unresolvedThreadCount
// is threaded from coordinationContext.snapshot rather than a test
// re-implementing this object literal.
export function buildCoordinationEvaluatorInput({
  coordinationContext,
  maxCopilotRounds,
  draftGateConfig,
  preApprovalGateConfig,
  reviewMode,
}) {
  return {
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
    // #1472: lets the evaluator's ROUND_CAP_REACHED handling independently
    // confirm "zero unresolved threads" (the exhaustion note's own promise)
    // rather than trusting a stale/compound lifecycleState label alone.
    unresolvedThreadCount: coordinationContext.snapshot?.unresolvedThreadCount ?? null,
    sameHeadCleanConverged: coordinationContext.interpretation.sameHeadCleanConverged,
    // Operator-authorized post-convergence suppression (#1441): computed and
    // verified once in loadPrGateCoordinationContext (resolvePostConvergenceReviewSuppressed)
    // — see detect-pr-gate-coordination-state.mjs.
    postConvergenceReviewSuppressed: coordinationContext.postConvergenceReviewSuppressed === true,
    // Independent gate-ENTRY re-check (#1190): fed alongside (not derived from)
    // sameHeadCleanConverged, so an outstanding request on the current head refuses
    // RUN_PRE_APPROVAL_GATE even if sameHeadCleanConverged were somehow stale/wrong.
    copilotReviewRequestStatus: coordinationContext.snapshot?.copilotReviewRequestStatus ?? "none",
    draftGateRequireCi: draftGateConfig.requireCi,
    preApprovalRequireCi: preApprovalGateConfig.requireCi,
    draftGate: coordinationContext.gateEvidence.draftGate,
    draftGateMarker: coordinationContext.gateEvidence.draftGateMarker,
    refinementArtifact: coordinationContext.refinementArtifact,
    preApprovalGate: coordinationContext.gateEvidence.preApprovalGate,
    preApprovalGateMarker: coordinationContext.gateEvidence.preApprovalGateMarker,
    ...(reviewMode ? { reviewMode } : {}),
  };
}

// Post-time fan-out evidence enforcement. `detect-checkpoint-evidence.mjs`
// already enforces gates.requireFanoutEvidence reactively at the pre-merge
// check; this refuses an inline verdict at the PRODUCE step instead, before it
// is ever posted as visible PR evidence, by reusing the exact merge-time
// acceptance predicate (buildFanoutEnforcement + evaluateInlineFanoutMode) —
// never mirroring the threshold/label/scope logic — so the two boundaries
// cannot drift apart. Applies to every verdict value (clean/findings_present/
// blocked): mode qualification does not depend on the conclusion being
// recorded. Throws when the candidate does not qualify; resolves silently
// otherwise (fanout_fanin candidates, light-mode-accepted inline candidates,
// and any candidate while requireFanoutEvidence is off).
async function enforcePostTimeFanoutMode({ repo, pr, gate, executionMode, inlineReason, headSha, config }, { env, ghCommand, repoRoot, runChild }) {
  let hasFullLabel = false;
  let baseRef = null;
  // Light-mode facts only matter for an inline candidate under active
  // enforcement; fetched lazily so a fanout_fanin post (the common path) pays
  // no extra gh call, and so does an inline post once light mode itself is
  // off (no facts could ever change the outcome).
  if (executionMode === "inline_single_agent" && resolveRequireFanoutEvidence(config) && resolveLightMode(config) != null) {
    try {
      const prFacts = await runGhJson(
        ["pr", "view", String(pr), "--repo", repo, "--json", "baseRefOid,labels"],
        { env, ghCommand, runChild },
      );
      baseRef = typeof prFacts?.baseRefOid === "string" && prFacts.baseRefOid.trim().length > 0
        ? prFacts.baseRefOid.trim()
        : null;
      hasFullLabel = Array.isArray(prFacts?.labels)
        && prFacts.labels.some((label) => (typeof label === "string" ? label : label?.name) === GATE_FULL_LABEL);
    } catch {
      // Fail CLOSED: without the label/base facts an inline verdict cannot be
      // safely accepted — baseRef stays null, so scope re-derivation below is
      // skipped and the light-mode carve-out cannot apply.
    }
  }
  // A candidate marker describing the verdict ABOUT TO BE POSTED — no comment
  // exists yet, so this is shaped exactly like a posted marker
  // (buildFanoutEnforcement only reads .visible/.executionMode/.inlineReason/
  // .headSha off it). The other gate is marked invisible so only the gate
  // actually being posted is evaluated this call.
  const candidateMarker = { visible: true, executionMode, inlineReason: inlineReason ?? null, headSha };
  const inactiveMarker = { visible: false };
  const fanoutEnforcement = await buildFanoutEnforcement({
    repo,
    pr,
    currentHeadSha: headSha,
    draftGateMarker: gate === "draft_gate" ? candidateMarker : inactiveMarker,
    preApprovalGateMarker: gate === "pre_approval_gate" ? candidateMarker : inactiveMarker,
    config,
    cwd: repoRoot,
    hasFullLabel,
    baseRef,
  });
  if (!fanoutEnforcement.required) return;
  for (const gateResult of fanoutEnforcement.gates) {
    const modeFailure = evaluateInlineFanoutMode(gateResult, fanoutEnforcement);
    if (modeFailure) {
      throw new Error(`Cannot post a ${executionMode} verdict for ${repo}#${pr} ${gate}: ${modeFailure}`);
    }
  }
}

/**
 * Resolve this round's finding surface from `--findings-ledger`: the round
 * number, the fingerprint-suppressed candidate set, and its split into inline
 * (locatable, in-diff) and body-filed findings. Returns null when no ledger was
 * supplied — that round posts a plain verdict body with no finding surface.
 *
 * `isUpdate` collapses the split: an already-submitted review can only have its
 * BODY corrected (GitHub exposes no endpoint to add inline comments to it), so
 * a same-head correction body-files every still-unposted finding rather than
 * silently dropping the locatable ones.
 */
// Shared fanout foreign-angle policy for both the --findings-json and the
// --findings-ledger's-provenance coverage checks: refuse (fail-closed) unless
// gates.rejectForeignAngles is false, in which case warn instead of failing.
function enforceForeignAngles(foreignAngles, { sourceLabel, gate, gateKey, config, silent }) {
  if (foreignAngles.length === 0) {
    return;
  }
  const message = `${sourceLabel} for ${gate} names angle(s) outside the configured pool: ${foreignAngles.join(", ")}`;
  if (resolveRejectForeignAngles(config)) {
    throw new Error(
      `${message} (add them to gates.${gateKey}.angles, or set gates.rejectForeignAngles: false to warn instead of fail)`,
    );
  }
  // rejectForeignAngles: false is WARNING mode, not silence — one line per call.
  if (!silent) {
    process.stderr.write(`WARNING: ${message} (gates.rejectForeignAngles is false; recorded as a warning)\n`);
  }
}
// Read `--findings-ledger` and confirm it is THIS round's ledger (same
// repo/pr/gate/head), not a stale or foreign one. Shared by the finding-surface
// resolver below and the withheld-tier mandatory-angle-coverage check, so
// both trust the ledger only after the identical cross-check.
async function loadMatchingFindingsLedger(options, headSha) {
  if (!options.findingsLedger) {
    return null;
  }
  const ledger = await readGateFindingsLedger(options.findingsLedger);
  if (ledger.repo !== options.repo || ledger.pr !== options.pr || ledger.gate !== options.gate || ledger.headSha !== headSha) {
    throw new Error(
      `--findings-ledger "${options.findingsLedger}" is for ${ledger.repo}#${ledger.pr} ${ledger.gate} @ ${ledger.headSha}, `
      + `but this verdict is for ${options.repo}#${options.pr} ${options.gate} @ ${headSha}; refuse to post another round's findings.`,
    );
  }
  return ledger;
}
async function resolveFindingSurface({ options, headSha, repoRoot, isUpdate, preloadedLedger }, gh) {
  // The withheld-tier coverage check above already loaded and validated this
  // same --findings-ledger file for this same round; reuse it instead of
  // reading it a second time (undefined means it was never preloaded, e.g. a
  // structured or inline round, so load it fresh here as before).
  const ledger = preloadedLedger !== undefined ? preloadedLedger : await loadMatchingFindingsLedger(options, headSha);
  if (!ledger) {
    return null;
  }
  const login = await resolveAuthenticatedLogin(gh);
  const reviews = await listPrReviews({ repo: options.repo, pr: options.pr }, gh);
  const issueComments = await listIssueComments({ repo: options.repo, pr: options.pr }, gh);
  // The cheap thread LISTING is enough for fingerprint suppression: a finding
  // thread's first comment opens with its finding marker, and that marker is
  // bounded well under list-review-threads.mjs's 200-char listing excerpt (a
  // 16-hex fingerprint plus two 40-char slugged fields, a round, and an
  // optional disposition), so the fingerprint always survives the excerpt.
  const threads = await fetchAllReviewThreads({ repo: options.repo, pr: options.pr }, gh);
  const suppressed = collectSuppressedFingerprints({ reviews, threads, login });
  const round = await resolveGateRound({
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha,
    reviews,
    issueComments,
    repoRoot,
  });
  const candidates = ledger.findings.filter((f) => !suppressed.has(fingerprintFinding(f)));
  const surface = {
    round,
    suppressedCount: ledger.findings.length - candidates.length,
    locatable: [],
    nonLocatable: candidates,
  };
  if (isUpdate || candidates.length === 0) {
    return surface;
  }
  const commentableSet = buildCommentableLineSet(await fetchPrFiles({ repo: options.repo, pr: options.pr }, gh));
  surface.locatable = [];
  surface.nonLocatable = [];
  for (const finding of candidates) {
    (isLocatableFinding(finding, commentableSet) ? surface.locatable : surface.nonLocatable).push(finding);
  }
  return surface;
}

// GATE-COMMENT-DRAFT-REQUIREMENTS / GATE-COMMENT-PREAPPROVAL-REQUIREMENTS
// (skills/docs/gate-review-comment-contract.md): a non-clean verdict must not
// carry an advancing next action. The mandated next action for a round that
// found blocking findings is a closed set, so the tool DERIVES it rather than
// accepting caller prose into a machine-read evidence surface (#1621). Returns
// null for a `clean` verdict — the caller's value is accepted unchanged
// (derivation is non-clean only; validating clean-verdict next actions is out
// of scope for #1621).
function deriveEffectiveNextAction(verdict, gate) {
  if (verdict !== "findings_present" && verdict !== "blocked") {
    return null;
  }
  // draft_gate: the PR stays draft and fixes are required before retrying.
  // pre_approval_gate: follow-up fixes are required before final approval —
  // address the findings and re-run the gate.
  return gate === "draft_gate" ? "stay draft and fix" : "rerun gate";
}

// Shared per-angle blocking-severity scan over structuredFindings, used by both
// roundCarriesBlockingSeverity's escalation check and the clean-verdict
// refusal's structured-findings cross-check. The RESOLVED_DISPOSITIONS skip
// applies only to parseable findings; an angle.unparseable entry carries no
// disposition to resolve against and is judged on severity alone. Returns the
// subset of `blocking` actually observed (in `blocking`'s order, so a caller
// can render it directly into a message) plus whether any observed hit came
// from an unparseable finding.
function scanBlockingFindings(structuredFindings, blocking) {
  const observed = new Set();
  let unparseableBlocking = false;
  for (const angle of structuredFindings) {
    for (const f of angle.findings) {
      if (RESOLVED_DISPOSITIONS.has(f.disposition)) continue;
      const sev = /** @type {string} */ (normalizeSeverity(f.severity));
      if (blocking.includes(sev)) observed.add(sev);
    }
    for (const u of angle.unparseable ?? []) {
      const sev = /** @type {string} */ (normalizeSeverity(u.severity));
      if (blocking.includes(sev)) {
        observed.add(sev);
        unparseableBlocking = true;
      }
    }
  }
  return { blockingObserved: blocking.filter((sev) => observed.has(sev)), unparseableBlocking };
}

// GATE-EXEC-LIGHT-ESCALATION (#1621): does this round carry a finding at a
// blocking severity? A `findings_present` verdict is DEFINED as "found issues
// at blocking severities" (GATE-COMMENT-VERDICT-VALUES), so it always carries
// one when blocking severities are configured. Structured per-angle findings
// and explicit severity counts are inspected directly so a marker-collapsed or
// free-text round still escalates on its real blocking findings. A `blocked`
// verdict (gate could not complete) carries no finding evidence by itself.
function roundCarriesBlockingSeverity({ verdict, structuredFindings, findingsSeverityCounts, activeGateConfig }) {
  const blocking = Array.isArray(activeGateConfig?.blockCleanOnFindingSeverities) ? activeGateConfig.blockCleanOnFindingSeverities : [];
  if (blocking.length === 0) {
    return false;
  }
  if (structuredFindings) {
    return scanBlockingFindings(structuredFindings, blocking).blockingObserved.length > 0;
  }
  if (findingsSeverityCounts && typeof findingsSeverityCounts === "object") {
    return blocking.some((sev) => (findingsSeverityCounts[sev] ?? 0) > 0);
  }
  return verdict === "findings_present";
}

// Apply the gate:full PR label so the next round forces full fan-out. Mirrors
// create-label.mjs's idempotent "already exists" handling for the label
// resource, then adds it to the PR (adding an already-present label is a
// no-op success). Both existing consumers (detect-checkpoint-evidence.mjs,
// write-gate-context.mjs) already honor the label. Applied (not a post refusal)
// so it never collides with GATE-EXEC-POST-BEFORE-FIX (#1621).
async function applyGateFullLabel({ repo, pr }, { env, ghCommand, runChild = defaultRunChild }) {
  const createResult = await runChild(
    ghCommand,
    ["label", "create", GATE_FULL_LABEL, "--repo", repo, "--color", "d73a4a", "--description", "Inline gate round surfaced a blocking finding; force full fan-out review"],
    env,
  );
  if (createResult.code !== 0 && !/already exists/i.test(createResult.stderr)) {
    throw new Error(`Cannot apply ${GATE_FULL_LABEL} label for ${repo}#${pr}: gh label create failed: ${(createResult.stderr ?? "").trim() || `exit code ${createResult.code}`}`);
  }
  const addResult = await runChild(
    ghCommand,
    ["pr", "edit", String(pr), "--repo", repo, "--add-label", GATE_FULL_LABEL],
    env,
  );
  if (addResult.code !== 0) {
    throw new Error(`Cannot apply ${GATE_FULL_LABEL} label to ${repo}#${pr}: gh pr edit --add-label failed: ${(addResult.stderr ?? "").trim() || `exit code ${addResult.code}`}`);
  }
}

export async function upsertCheckpointVerdict(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), runChild = defaultRunChild } = {}) {
  const gh = { env, ghCommand, repoRoot, runChild };
  // loadDevLoopConfig never throws: on a validation failure it returns the raw
  // merged config alongside its errors. Every other severity consumer
  // (consolidate-fanin, close-gate-findings, detect-checkpoint-evidence) fails
  // closed on a non-empty errors array; the poster that WRITES the verdict
  // must not be the one place a schema-invalid config still resolves gate
  // config and posts. Checked before any GitHub read so the refusal is
  // immediate and side-effect free.
  const { config, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
  if (Array.isArray(configErrors) && configErrors.length > 0) {
    throw new Error(`This worktree's config (repoRoot ${JSON.stringify(repoRoot)}) could not be fully loaded/validated; refusing to post a gate verdict: ${JSON.stringify(configErrors)}`);
  }
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
  // Thread the light-dispatch signal (#1210) so the context interpreter and the
  // maxCopilotRounds resolution below both use the composed lightweight cap —
  // the two must never disagree at the cap boundary (#1126).
  const coordinationContext = await loadPrGateCoordinationContext({ repo: options.repo, pr: options.pr, lightweight: options.lightweight === true }, gh);
  const evidence = coordinationContext.gateEvidence;
  const canonicalHeadSha = resolveRequestedHeadSha(options.headSha, evidence.currentHeadSha);
  const draftGateConfig = resolveGateConfig(config, "draft");
  const preApprovalGateConfig = resolveGateConfig(config, "preApproval");
  const maxCopilotRounds = options.lightweight === true
    ? resolveEffectiveCopilotRoundCap(config, { lightweight: true })
    : resolveRefinementConfig(config, "maxCopilotRounds");
  // Root cause 2: detect internal-only PRs so the Copilot convergence requirement
  // is suppressed. Docs-only / tooling-only PRs should go straight to pre_approval_gate
  // without requiring an external Copilot review cycle.
  let reviewMode = null;
  try {
    const internalResult = await detectInternalOnly({ repo: options.repo, pr: options.pr }, gh);
    if (internalResult?.ok && internalResult.internalOnly) {
      reviewMode = "internal_only";
    }
  } catch {
    // Non-fatal: internal-only detection failure is best-effort.
    // Proceed with the default (external Copilot review) mode.
  }
  const coordination = evaluatePrGateCoordination(buildCoordinationEvaluatorInput({
    coordinationContext,
    maxCopilotRounds,
    draftGateConfig,
    preApprovalGateConfig,
    reviewMode,
  }));
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
    && !options._draftTransitionInProgress
    && !coordination.draftGateAlreadySatisfied
    && coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE)
  ) {
    return await postDraftGateViaDraftTransition(options, { env, ghCommand, repoRoot, runChild });
  }
  // Fail closed on a lagged draft-state read: we are re-entering FROM
  // postDraftGateViaDraftTransition (which just converted the PR to draft) yet the
  // coordination context still reports the PR as non-draft. Recursing would loop
  // indefinitely (the original #1020 hang → exit 13, error swallowed). Surface a
  // clear, actionable error instead so the operator knows the draft conversion did
  // not take (or GitHub's read lags the mutation) and can retry. (#1020)
  if (
    options.gate === "draft_gate"
    && !prIsDraft
    && options._draftTransitionInProgress
  ) {
    throw new Error(
      `draft_gate self-heal for ${options.repo}#${options.pr} failed: the PR was converted to draft ` +
      `to post the verdict, but GitHub still reports it as non-draft on re-entry (draft-state read lagged ` +
      `the conversion mutation, or the conversion did not take). Not recursing. Re-run the draft_gate post ` +
      `once the PR reflects the draft state, or reconcile manually with ` +
      `\`gh pr ready ${options.pr} --repo ${options.repo}\` / ` +
      `\`node scripts/github/reconcile-draft-gate.mjs --repo ${options.repo} --pr ${options.pr}\`.`,
    );
  }
  if (gateActionForbidden) {
    throw new Error(buildGateEntryRefusalError({ options, coordination }));
  }
  // Post-time fan-out evidence enforcement: refuse an under-qualified inline
  // verdict here, before it is posted, for every verdict value. No override
  // flag — requireFanoutEvidence: false is the only opt-out, and that is
  // already handled inside buildFanoutEnforcement.
  await enforcePostTimeFanoutMode(
    {
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
      inlineReason: options.inlineReason,
      headSha: canonicalHeadSha,
      config,
    },
    { env, ghCommand, repoRoot, runChild },
  );
  const activeGateConfig = options.gate === "draft_gate" ? draftGateConfig : preApprovalGateConfig;
  // Normalized at the CONSUME site, not only in the CLI parser: a direct
  // programmatic caller may pass legacy-keyed counts, and the guard below
  // must compare canonical keys on both sides.
  if (options.findingsSeverityCounts && typeof options.findingsSeverityCounts === "object") {
    options.findingsSeverityCounts = normalizeSeverityCounts(options.findingsSeverityCounts);
  }
  // Verdict consistency enforcement (#1616): when --findings-ledger is present
  // and carries the consolidator's computed `overallVerdict` (threaded from
  // consolidate-fanin.mjs's --ledger-out via write-gate-findings-log.mjs), the
  // posted --verdict MUST agree with it. The consolidator already computed the
  // verdict from the round's findings and the gate's blockCleanOnFindingSeverities
  // — re-deriving or hand-picking a different value is the defect this guards
  // against. Loaded here (before the clean-verdict guard) so the resolved
  // verdict drives every downstream guard; reused by the withheld-tier
  // coverage check and resolveFindingSurface so the file is read once.
  let preloadedFindingsLedger;
  if (options.findingsLedger) {
    preloadedFindingsLedger = await loadMatchingFindingsLedger(options, canonicalHeadSha);
  }
  if (preloadedFindingsLedger && preloadedFindingsLedger.overallVerdict) {
    const ledgerVerdict = preloadedFindingsLedger.overallVerdict;
    if (options.verdict === undefined) {
      // Derive: the caller need not pass --verdict at all when the ledger
      // carries the consolidator's verdict (#1616 AC: "passing no --verdict
      // is valid and correct").
      options.verdict = ledgerVerdict;
    } else if (options.verdict !== ledgerVerdict) {
      // Refuse the contradiction, naming both values and the head, citing the
      // rule whose meaning the consolidator's computation already implements.
      // No override flag (#1616 AC): a round whose verdict genuinely differs
      // from the computed one is a consolidator bug to fix, not an operator
      // decision to override.
      throw new Error(
        `--verdict "${options.verdict}" for ${options.gate} @ ${canonicalHeadSha} contradicts the consolidated ledger's overallVerdict "${ledgerVerdict}" (from --findings-ledger "${options.findingsLedger}" for ${preloadedFindingsLedger.repo}#${preloadedFindingsLedger.pr} ${preloadedFindingsLedger.gate} @ ${preloadedFindingsLedger.headSha}). The verdict must match the fan-in consolidator's computed value — GATE-COMMENT-VERDICT-VALUES (skills/docs/gate-review-comment-contract.md): "clean" = no findings at a blocking severity remain; "findings_present" = the gate found issues at blocking severities. Re-run the gate fan-in (dev-loops gate consolidate-fanin) and let its overallVerdict flow through, or post the matching verdict. A contradicting posted verdict is a contract breach this script refuses to record.`,
      );
    }
    // else: a matching explicit --verdict is accepted unchanged.
  } else if (options.verdict === undefined) {
    // --findings-ledger absent OR present without overallVerdict (a legacy/
    // inline ledger): --verdict is still required. The parser allows omitting
    // it only when --findings-ledger is present, so reach this with a ledger
    // that carries no overallVerdict.
    throw new Error(
      `--verdict is required for ${options.gate} @ ${canonicalHeadSha}${options.findingsLedger ? `: --findings-ledger "${options.findingsLedger}" carries no overallVerdict to derive it from` : ""}. Pass --verdict, or supply a --findings-ledger written from a consolidate-fanin --ledger-out that carries overallVerdict.`,
    );
  }
  if (
    options.verdict === "clean"
    && activeGateConfig.blockCleanOnFindingSeverities
    && activeGateConfig.blockCleanOnFindingSeverities.length > 0
  ) {
    if (!options.findingsSeverityCounts) {
      throw new Error(
        `Cannot set verdict "clean" for ${options.gate}: --findings-severity-counts is required to verify that no unresolved blocking severities remain (example: --findings-severity-counts '{"high":0,"medium":0,"low":0,"question":0,"nit":0}') (blocking: [${activeGateConfig.blockCleanOnFindingSeverities.join(", ")}]).`,
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
  // ACCEPT-CRITERIA-VERIFY-AND-REFLECT (#1621): a `clean` pre_approval_gate
  // verdict must not be recorded while the spec-of-record still has unticked
  // Acceptance criteria. The spec-of-record's AC data is carried by
  // coordinationContext.refinementArtifact (loaded above) — for a tracker-backed
  // ready PR this fetches the linked issue body and surfaces `uncheckedAcItems`.
  // Only an actual unticked checkbox (`- [ ]`) counts; a ticked box and a plain
  // bullet (no checkbox) are excluded (see extractUncheckedChecklistItems). An
  // artifact that did not resolve AC data (no linked issue, or the fetch failed)
  // carries no uncheckedAcItems and does not block — the gate cannot verify what
  // it cannot read, and the absence of a spec-of-record is owned by the draft-gate
  // refinement check, not this precondition.
  if (
    options.verdict === "clean"
    && options.gate === "pre_approval_gate"
    && Array.isArray(coordinationContext.refinementArtifact?.uncheckedAcItems)
    && coordinationContext.refinementArtifact.uncheckedAcItems.length > 0
  ) {
    const acArtifact = coordinationContext.refinementArtifact;
    const items = acArtifact.uncheckedAcItems;
    throw new Error(
      `Cannot set verdict "clean" for ${options.gate} @ ${canonicalHeadSha}: the spec-of-record (linked issue(s) ${(acArtifact.linkedIssues ?? []).map((n) => `#${n}`).join(", ") || "?"}) still has ${items.length} unticked Acceptance criteria item(s): ${items.slice(0, 3).map((t) => `\`${t}\``).join(", ")}${items.length > 3 ? ", …" : ""}. Tick the satisfied ACs in the tracker issue before declaring the pre-approval gate clean — ACCEPT-CRITERIA-VERIFY-AND-REFLECT (skills/docs/acceptance-criteria-verification.md): a clean pre_approval_gate must not rely on a spec-of-record with unticked acceptance criteria.`,
    );
  }
  // GATE-COMMENT-DRAFT-REQUIREMENTS / GATE-COMMENT-PREAPPROVAL-REQUIREMENTS
  // (#1621): a non-clean verdict must not carry an advancing next action. The
  // mandated next action for a round that found blocking findings is a closed
  // set (gate-review-comment-contract.md), so derive it at the OPTION seam —
  // mutating options.nextAction — so BOTH the render and the same-head
  // idempotency compare see the derived value (a render-only fix would break
  // idempotency: the parsed body would carry the derived string while the
  // compare read the raw caller string). Deriving beats validating here: for a
  // non-clean verdict the mandated action is closed, so the tool produces it
  // rather than accepting prose into a machine-read evidence surface.
  const derivedNextAction = deriveEffectiveNextAction(options.verdict, options.gate);
  if (derivedNextAction !== null) {
    options.nextAction = derivedNextAction;
  }
  // Structured per-angle findings (consolidated fan-in shape) take precedence
  // over the free-text summary: when present, the verdict comment renders a
  // multi-line per-angle breakdown and the `**Findings summary:**` line carries a
  // single-line digest (so the marker/parse contract still round-trips).
  let structuredFindings = null;
  let rawFindingsInput = null;
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
    rawFindingsInput = candidate;
    try {
      structuredFindings = normalizeStructuredFindings(candidate);
    } catch (err) {
      throw new Error(`--findings-json "${options.findingsJson}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!structuredFindings) {
      throw new Error(`--findings-json "${options.findingsJson}" did not contain any renderable findings (expected a non-empty per-angle array of { angle, findings } entries, or a flat per-finding array of { severity, summary, angle? } entries)`);
    }
  }
  // The clean-verdict guard above trusts --findings-severity-counts alone, so a
  // caller can hand-type an all-zero counts object (the exact placeholder the
  // docs warn against) and pass it even when --findings-json's own per-angle
  // findings carry a blocking severity. Cross-check directly against the
  // parsed findings themselves: a marker-collapsed round can only UNDERcount
  // its own findings (a marker never invents a finding), so tallying
  // structuredFindings and failing when EITHER source shows a blocking
  // severity is equivalent to failing on max(supplied, observed). Only skip a
  // finding whose disposition is in the closed RESOLVED_DISPOSITIONS set below
  // ("disputed"/"operator_acknowledged", write-gate-findings-log.mjs's
  // sanctioned vocabulary for a blocking finding the fix cycle/operator has
  // already closed out without changing its severity). Every other value —
  // missing, "accepted-for-fix", "deferred", "needs-answer", or an unrecognized/typo'd string
  // — counts as still unresolved, so an arbitrary disposition can never
  // silently exempt a blocking finding.
  if (
    structuredFindings
    && options.verdict === "clean"
    && activeGateConfig.blockCleanOnFindingSeverities
    && activeGateConfig.blockCleanOnFindingSeverities.length > 0
  ) {
    // An unparseable finding carries no disposition to resolve against, so it
    // is judged on its severity alone — a blocking severity fails, any other
    // value (including none at all) is reported explicitly as unparseable in
    // the rendered comment rather than blocking the clean verdict. The
    // `unparseableBlocking` flag lets the refusal message name the real cause
    // (a finding the normalizer dropped used to pass this cross-check
    // silently; now it fails the verdict exactly as a parseable blocking
    // finding would).
    const { blockingObserved, unparseableBlocking } = scanBlockingFindings(
      structuredFindings,
      activeGateConfig.blockCleanOnFindingSeverities,
    );
    if (blockingObserved.length > 0) {
      throw new Error(
        `Cannot set verdict "clean" for ${options.gate}: --findings-json's own per-angle findings show unresolved findings at blocking severities [${blockingObserved.join(", ")}], regardless of --findings-severity-counts.${unparseableBlocking ? " At least one of these is an UNPARSEABLE finding (no usable summary) the normalizer would otherwise have dropped silently (#1526)." : ""} Fix these findings and re-gate before declaring clean.`,
      );
    }
  }
  // Populated early (above) whenever --findings-ledger is present, so the
  // consolidator's `overallVerdict` can resolve/refuse the posted --verdict
  // BEFORE the clean-verdict guard runs, and reused by the withheld-tier
  // coverage check and resolveFindingSurface so the same ledger file is never
  // read from disk twice for one round.
  // Fan-out angle-coverage enforcement (fail closed): a fanout_fanin verdict's
  // per-angle results (structured, or the withheld branch's ledger provenance)
  // must cover every configured mandatory angle, and (default) must not name
  // an angle outside the gate's configured pool. gateKey/mandatoryAngles/pool
  // are the same lookup either branch below needs, so resolve them once.
  if ((options.executionMode ?? DEFAULT_EXECUTION_MODE) === "fanout_fanin") {
    const gateKey = GATE_CONFIG_KEY[options.gate];
    const { mandatoryAngles, pool } = resolveGateAngleContract(config, gateKey);
    if (structuredFindings) {
      // Angle-less entries would be bucketed under the synthetic `general` label
      // by normalization and then surface as a CONFUSING foreign-angle error.
      // Fail first with a dedicated message naming the real problem instead.
      const angleless = (rawFindingsInput ?? []).filter(
        (e) => !e || typeof e !== "object" || typeof e.angle !== "string" || e.angle.trim().length === 0,
      ).length;
      if (angleless > 0) {
        throw new Error(
          `--findings-json for ${options.gate}: ${angleless} entr${angleless === 1 ? "y" : "ies"} lack a non-empty .angle — a fanout_fanin verdict must attribute every per-angle entry/finding to its review angle (use the nested [{ angle, verdict, findings }] shape, or add .angle to each flat finding)`,
        );
      }
      const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(structuredFindings, {
        mandatoryAngles,
        pool,
      });
      if (missingMandatory.length > 0) {
        throw new Error(
          `--findings-json for ${options.gate} is missing mandatory angle(s): ${missingMandatory.join(", ")} (derived from gates.${gateKey}.angles entries with mandatory: true; add a per-angle entry for each before posting a fanout_fanin verdict)`,
        );
      }
      enforceForeignAngles(foreignAngles, { sourceLabel: "--findings-json", gate: options.gate, gateKey, config, silent: options.silent });
    } else {
      // No --findings-json: either genuinely withheld (consolidate-fanin's tier
      // 4 — even the cheapest per-angle shape did not fit the comment budget) or
      // simply omitted, so the mandatory-angle check above never ran and this
      // comment carries no per-angle data to check instead. Per
      // skills/docs/gate-review-sub-loop-contract.md, prove coverage from the
      // round's disposition ledger — the write-gate-findings-log.mjs ledger's
      // `provenance.perAngle`, written before this comment and unbudgeted —
      // rather than from the comment. Reuses checkFanoutAngleCoverage, the SAME
      // coverage function the structured branch above and
      // detect-checkpoint-evidence.mjs's read-time re-validation both use, so
      // write-time refusal and read-time enforcement can never silently define
      // "covered" differently — for BOTH the mandatory-angle and foreign-angle
      // checks, mirroring the structured branch's `pool`/`foreignAngles`
      // handling above. Runs whenever the gate contract defines a mandatory
      // angle OR a pool (same trigger as the structured branch, which always
      // runs); the neither-artifact refusal below stays keyed on mandatory
      // angles only — a pool with no mandatory angle carries no proof
      // obligation for a caller that supplies neither artifact at all.
      if (mandatoryAngles.length > 0 || (Array.isArray(pool) && pool.length > 0)) {
        if (!options.findingsLedger) {
          if (mandatoryAngles.length > 0) {
            throw new Error(
              `Cannot post a fanout_fanin verdict for ${options.gate} without --findings-json: mandatory angle coverage (${mandatoryAngles.join(", ")}, derived from gates.${gateKey}.angles entries with mandatory: true) requires coverage proof via --findings-json or --findings-ledger.`,
            );
          }
        } else {
          // Reuse the ledger loaded early for verdict enforcement (#1616) —
          // only load here if it was not (defensive; options.findingsLedger
          // truthy at this point means the early load already populated it).
          preloadedFindingsLedger ??= await loadMatchingFindingsLedger(options, canonicalHeadSha);
          const consistencyErr = provenanceConsistencyError(preloadedFindingsLedger?.provenance ?? null);
          if (consistencyErr && mandatoryAngles.length > 0) {
            throw new Error(
              `Cannot post a fanout_fanin verdict for ${options.gate} without --findings-json: mandatory angle coverage (${mandatoryAngles.join(", ")}) must be proven from --findings-ledger's recorded provenance instead, and it is invalid (${consistencyErr}). Write the ledger with --provenance covering the mandatory angles (write-gate-findings-log.mjs --provenance), or supply --findings-json.`,
            );
          }
          // A gate with no mandatory angle carries no coverage-proof
          // obligation: a ledger without valid provenance proves nothing but
          // blocks nothing either (vacuously covered). Only a ledger that DOES
          // record valid provenance gets the angle-less and foreign-angle
          // passes below.
          if (!consistencyErr) {
          // Same angle-less guard as the --findings-json branch above: a
          // provenance.perAngle entry missing a non-empty .angle would otherwise
          // be silently dropped by checkFanoutAngleCoverage's own filtering — it
          // can then only ever fail to satisfy an angle, never satisfy one, but
          // this fails closed with the real problem instead of a confusing
          // missing-angle error.
          const angleless = (preloadedFindingsLedger.provenance.perAngle ?? []).filter(
            (e) => !e || typeof e !== "object" || typeof e.angle !== "string" || e.angle.trim().length === 0,
          ).length;
          if (angleless > 0) {
            throw new Error(
              `--findings-ledger's provenance for ${options.gate}: ${angleless} entr${angleless === 1 ? "y" : "ies"} lack a non-empty .angle — every provenance.perAngle entry must attribute its review to an angle.`,
            );
          }
          const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(preloadedFindingsLedger.provenance.perAngle, { mandatoryAngles, pool });
          if (missingMandatory.length > 0) {
            throw new Error(
              `Cannot post a fanout_fanin verdict for ${options.gate} without --findings-json: --findings-ledger's provenance is missing mandatory angle(s): ${missingMandatory.join(", ")} (derived from gates.${gateKey}.angles entries with mandatory: true; the ledger's --provenance must record a per-angle entry for each).`,
            );
          }
          enforceForeignAngles(foreignAngles, { sourceLabel: "--findings-ledger's provenance", gate: options.gate, gateKey, config, silent: options.silent });
          }
        }
      }
    }
  }
  // --findings-json takes precedence; when structured findings are present, do not
  // read --findings-file at all (avoids a spurious hard failure if a caller passes
  // both and the file is missing/invalid even though it would be ignored anyway).
  if (!structuredFindings && options.findingsFile) {
    // Only genuine read failures are wrapped as "Cannot read ..."; the empty and
    // over-limit checks are argument-validation failures (parseError, carrying
    // usage) and must propagate as such — not be masked as a file-read error.
    let fileContent;
    try {
      fileContent = await readFile(options.findingsFile, "utf8");
    } catch (err) {
      throw new Error(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const trimmedEnd = fileContent.replace(/\n+$/, "");
    if (trimmedEnd.length === 0) {
      throw parseError(`--findings-file "${options.findingsFile}" is empty or contains only whitespace`);
    }
    // The gate evidence note is NOT spliced into the file content here — it
    // renders as its own `**Gate evidence note:**` line (see
    // renderGateReviewCommentBody), driven by coordination.gateEvidenceNote
    // passed straight through below.
    options.findingsSummary = blockquoteContinuationLines(
      encodeMachineArtifactMarkerDelimiters(
        enforcePostedCommentLimit(trimmedEnd, MAX_GATE_COMMENT_TEXT_LENGTH, "--findings-file content"),
      ),
    );
  }
  // Size-budget fields (phase 3 of the fail-closed PR size budget): reuses check-size-budget.mjs's
  // (or evaluatePrSizeBudget's) OWN JSON output verbatim — never recomputed
  // here. Optional: omitting --size-budget-json posts a verdict with no size
  // evidence at all (the fields simply are not rendered), which the
  // size-budget merge gate reads as "human approval required" downstream,
  // never as a silent pass.
  if (options.sizeBudgetJson) {
    let sizeBudgetContent;
    try {
      sizeBudgetContent = await readFile(options.sizeBudgetJson, "utf8");
    } catch (err) {
      throw new Error(`Cannot read --size-budget-json "${options.sizeBudgetJson}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let sizeBudget;
    try {
      sizeBudget = parseJsonText(sizeBudgetContent);
    } catch (err) {
      throw parseError(`--size-budget-json "${options.sizeBudgetJson}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!SIZE_BUDGET_OUTCOMES.has(sizeBudget?.outcome)) {
      throw parseError(`--size-budget-json "${options.sizeBudgetJson}" must carry a .outcome of "pass", "escalate", or "block"`);
    }
    // Fail closed on the T1-touch signal, mirroring the .outcome check above:
    // a missing/non-numeric/negative/non-finite .t1SliceLoc must abort BEFORE
    // any verdict posts, not silently derive `sizeTouchesT1: false` — that
    // false would persist as a definite, readable "not touched" and defeat
    // resolveSizeBudgetHumanApprovalRequired's (size-budget-merge-gate.mjs)
    // fail-closed-on-absent-evidence contract downstream.
    const t1SliceLoc = sizeBudget.t1SliceLoc;
    if (typeof t1SliceLoc !== "number" || !Number.isFinite(t1SliceLoc) || t1SliceLoc < 0) {
      throw parseError(`--size-budget-json "${options.sizeBudgetJson}" must carry a finite, non-negative numeric .t1SliceLoc`);
    }
    // Same fail-closed treatment for the waiver fields this CLI derives: a
    // partially-readable/malformed .waiver must abort rather than fold into
    // a benign `sizeWaiverGranted: false` ("no waiver"). check-size-budget.mjs
    // always emits a `.waiver` object with boolean `.t1Valid`/`.defaultValid`
    // (see computeSizeBudget), so a genuine producer's output always passes
    // this check; only a truncated/hand-edited/malformed JSON trips it.
    const waiver = sizeBudget.waiver;
    if (waiver === null || typeof waiver !== "object" || typeof waiver.t1Valid !== "boolean" || typeof waiver.defaultValid !== "boolean") {
      throw parseError(`--size-budget-json "${options.sizeBudgetJson}" must carry a .waiver object with boolean .t1Valid and .defaultValid`);
    }
    options.sizeOutcome = sizeBudget.outcome;
    options.sizeTouchesT1 = t1SliceLoc > 0;
    const waiverGranted = waiver.t1Valid === true || waiver.defaultValid === true;
    options.sizeWaiverGranted = waiverGranted;
    options.sizeWaiverApprovedBy = waiverGranted && typeof waiver.approvedBy === "string" && waiver.approvedBy.trim().length > 0
      ? waiver.approvedBy.trim()
      : null;
  }
  // The findings-summary the comment is compared/round-tripped against. With a
  // structured render this is the single-line digest (what the marker parser
  // recovers from the `**Findings summary:**` line); otherwise the free-text path.
  // Note: this never includes the gate evidence note (that renders on its own
  // line and is not part of the parsed/compared findings-summary field), so a
  // gate-evidence-note-only change across same-head calls does not by itself
  // force a re-post — a known, narrow ceiling of the current parser contract,
  // which this fix does not extend.
  const effectiveFindingsSummary = structuredFindings
    ? buildStructuredFindingsDigest(structuredFindings, options.findingsSeverityCounts)
    : options.findingsSummary;
  const gateEvidence = selectGateEvidence(evidence, options.gate);
  const existing = summarizeExistingComment({ ...gateEvidence, headSha: canonicalHeadSha });
  const warning = detectStaleGateCommentWarning({ strict: gateEvidence.strict, headSha: canonicalHeadSha, gate: options.gate });
  // The round's finding surface (this same review): resolved BEFORE the body is
  // rendered, since the body carries the round number, the body-filed findings,
  // and the reduced per-angle digest that depends on them.
  const findingSurface = await resolveFindingSurface(
    { options, headSha: canonicalHeadSha, repoRoot, isUpdate: existing !== null, preloadedLedger: preloadedFindingsLedger },
    gh,
  );
  const desiredBody = renderGateReviewCommentBody({
    ...options,
    headSha: canonicalHeadSha,
    findingsSummary: effectiveFindingsSummary,
    structuredFindings,
    gateEvidenceNote: coordination.gateEvidenceNote ?? null,
    blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
    ...(findingSurface ? { round: findingSurface.round, nonLocatableFindings: findingSurface.nonLocatable } : {}),
  });
  // ISSUE/PR-ID GUARD (#1731): the rendered gate verdict body must never emit a
  // raw issue/PR id (fail-closed unless explicitly allowlisted). Guarded here at
  // the single desiredBody choke point so BOTH the review surface (create/update
  // gate review) and the legacy issue-comment surface (updateComment below) are
  // covered, in addition to the low-level guards in the write helpers.
  guardCommentBodyNoIssuePrIds(desiredBody, { ref: "gate verdict comment body", allowedRefs: options.allowedRefs });
  const findingSurfaceFields = findingSurface
    ? {
        round: findingSurface.round,
        inlineComments: findingSurface.locatable.length,
        bodyFiled: findingSurface.nonLocatable.length,
        suppressed: findingSurface.suppressedCount,
      }
    : {};
  const desiredExecutionMode = options.executionMode ?? DEFAULT_EXECUTION_MODE;
  // GATE-EXEC-LIGHT-ESCALATION (#1621): an inline round that surfaces a blocking
  // finding escalates the next round to full fan-out by applying the gate:full
  // PR label. Applied (not a post refusal) so it never collides with
  // GATE-EXEC-POST-BEFORE-FIX. Only when fan-out evidence is required — the
  // label's sole purpose is to force fan-out, so a repo with
  // requireFanoutEvidence:false has nothing to escalate. Computed here (after
  // structuredFindings is finalized) and applied on the created/updated/noop
  // paths — noop re-applies it too (idempotent) so a prior post whose label
  // application failed is retried at the same head, never left un-escalated.
  const escalateGateFullLabel = resolveRequireFanoutEvidence(config)
    && desiredExecutionMode === "inline_single_agent"
    && roundCarriesBlockingSeverity({
      verdict: options.verdict,
      structuredFindings,
      findingsSeverityCounts: options.findingsSeverityCounts,
      activeGateConfig,
    });
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
  // The finding surface is part of what a same-head rerun would post, and the
  // structured digest collapses findings to severity counts — so a ledger whose
  // findings changed at unchanged counts renders an identical digest. Compare
  // the surface itself: every candidate the fingerprint pass did NOT suppress is
  // still unposted, so a round carrying one is never a noop, whatever the fields
  // say. A rerun of the same ledger suppresses all of its findings against the
  // posted review/threads and reaches zero here.
  const unpostedFindings = findingSurface
    ? findingSurface.locatable.length + findingSurface.nonLocatable.length
    : 0;
  // Size-budget fields (phase 3 of the fail-closed PR size budget) join the noop comparison so a
  // waiver granted (or a size-budget evaluation run for the first time) at an
  // otherwise-unchanged head still forces a re-post rather than silently
  // keeping stale evidence — e.g. a T1-slice waiver approved after the
  // initial escalated post at the same head.
  const desiredSizeOutcome = options.sizeOutcome ?? null;
  const desiredSizeTouchesT1 = options.sizeOutcome ? (options.sizeTouchesT1 === true) : null;
  const desiredSizeWaiverGranted = options.sizeOutcome ? (options.sizeWaiverGranted === true) : null;
  const desiredSizeWaiverApprovedBy = options.sizeOutcome ? (options.sizeWaiverApprovedBy ?? null) : null;
  if (
    existing
    && existing.contractComplete
    && existing.verdict === options.verdict
    && existing.findingsSummary === effectiveFindingsSummary
    && existing.nextAction === options.nextAction
    && (existing.executionMode ?? DEFAULT_EXECUTION_MODE) === desiredExecutionMode
    && existingInlineReason === desiredInlineReason
    && (existing.sizeOutcome ?? null) === desiredSizeOutcome
    && (existing.sizeTouchesT1 ?? null) === desiredSizeTouchesT1
    && (existing.sizeWaiverGranted ?? null) === desiredSizeWaiverGranted
    && (existing.sizeWaiverApprovedBy ?? null) === desiredSizeWaiverApprovedBy
    && unpostedFindings === 0
  ) {
    // GATE-EXEC-LIGHT-ESCALATION (#1621): a same-head noop rerun must still
    // ensure the gate:full label is on the PR — if the original post succeeded
    // but its label application failed (network/permissions), the noop would
    // otherwise never retry it. The add is idempotent (a present label is a
    // no-op success), so re-applying on noop is harmless and closes the gap.
    if (escalateGateFullLabel) {
      await applyGateFullLabel({ repo: options.repo, pr: options.pr }, gh);
    }
    return {
      ok: true,
      action: "noop",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: canonicalHeadSha,
      currentHeadSha: evidence.currentHeadSha,
      surface: existing.surface,
      commentId: existing.commentId,
      commentUrl: existing.commentUrl,
      blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
      executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
      ...findingSurfaceFields,
      ...(existingInlineReason ? { inlineReason: existingInlineReason } : {}),
      ...(warning ? { warning } : {}),
      ...(escalateGateFullLabel ? { gateFullLabelApplied: true } : {}),
    };
  }
  if (existing) {
    // In-place correction on the surface the existing verdict actually lives
    // on: a PR review body via the review endpoint, a legacy verdict issue
    // comment via the issue-comment endpoint. Inline comments are never
    // re-posted here — GitHub has no endpoint to add them to a submitted
    // review, which is why resolveFindingSurface body-files everything on this
    // path.
    const updated = existing.surface === "review"
      ? await updateGateReview({ repo: options.repo, pr: options.pr, reviewId: existing.commentId, body: desiredBody, allowedRefs: options.allowedRefs }, gh)
        .then((r) => ({ commentId: r.reviewId, commentUrl: r.reviewUrl ?? existing.commentUrl }))
      : await updateComment({ repo: options.repo, commentId: existing.commentId, body: desiredBody }, gh);
    // Post-update verification: verify the updated surface is retrievable via a
    // direct API fetch by id. A run id is set (production context) — DEVLOOPS_RUN_ID.
    let updateVerificationWarning = null;
    if (envRunId) {
      const verifyTarget = { repo: options.repo, pr: options.pr, surface: existing.surface, commentId: updated.commentId };
      let verified = await verifyPostedSurface(verifyTarget, gh);
      if (!verified) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        verified = await verifyPostedSurface(verifyTarget, gh);
      }
      updateVerificationWarning = !verified
        ? `Post-update verification failed: ${existing.surface === "review" ? "review" : "comment"} ${updated.commentId} not retrievable after retry.`
        : null;
    }
    if (escalateGateFullLabel) {
      await applyGateFullLabel({ repo: options.repo, pr: options.pr }, gh);
    }
    return {
      ok: true,
      action: "updated",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: canonicalHeadSha,
      currentHeadSha: evidence.currentHeadSha,
      surface: existing.surface,
      commentId: updated.commentId,
      commentUrl: updated.commentUrl,
      blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
      executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
      ...findingSurfaceFields,
      ...(options.inlineReason ? { inlineReason: options.inlineReason } : {}),
      ...(warning ? { warning } : {}),
      ...(updateVerificationWarning ? { verificationWarning: updateVerificationWarning } : {}),
      ...(escalateGateFullLabel ? { gateFullLabelApplied: true } : {}),
    };
  }
  const createdReview = await createGateReview({
    repo: options.repo,
    pr: options.pr,
    headSha: canonicalHeadSha,
    body: desiredBody,
    comments: (findingSurface?.locatable ?? []).map((finding) => ({
      path: finding.files[0],
      line: finding.line,
      side: "RIGHT",
      body: renderInlineCommentBody(finding, { round: findingSurface.round }),
    })),
    allowedRefs: options.allowedRefs,
  }, gh);
  const created = { commentId: createdReview.reviewId, commentUrl: createdReview.reviewUrl };
  // Post-creation verification: verify the review is retrievable before returning.
  // GitHub API can have brief eventual-consistency windows where a just-posted
  // surface is not yet returned by paginated list endpoints. A direct fetch by
  // id confirms it is persisted, preventing the evidence checker from falsely
  // reporting "missing" and triggering a duplicate post.
  // Only active when a run id is set (production context) — DEVLOOPS_RUN_ID.
  let verified = true;
  let verificationWarning = null;
  if (envRunId) {
    const verifyTarget = { repo: options.repo, pr: options.pr, surface: "review", commentId: created.commentId };
    verified = await verifyPostedSurface(verifyTarget, gh);
    if (!verified) {
      // Brief wait then retry — eventual consistency should resolve within ~2s.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      verified = await verifyPostedSurface(verifyTarget, gh);
    }
    verificationWarning = !verified
      ? `Post-creation verification failed: review ${created.commentId} not retrievable after retry. The review was created (API confirmed) but may not appear in list endpoints immediately.`
      : null;
  }
  if (escalateGateFullLabel) {
    await applyGateFullLabel({ repo: options.repo, pr: options.pr }, gh);
  }
  return {
    ok: true,
    action: "created",
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: canonicalHeadSha,
    currentHeadSha: evidence.currentHeadSha,
    surface: "review",
    commentId: created.commentId,
    commentUrl: created.commentUrl,
    blockCleanOnFindingSeverities: activeGateConfig.blockCleanOnFindingSeverities,
    executionMode: options.executionMode ?? DEFAULT_EXECUTION_MODE,
    ...findingSurfaceFields,
    ...(options.inlineReason ? { inlineReason: options.inlineReason } : {}),
    ...(warning ? { warning } : {}),
    ...(verificationWarning ? { verificationWarning } : {}),
    ...(escalateGateFullLabel ? { gateFullLabelApplied: true } : {}),
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
    // Suppress it under --silent, which contracts to zero output (exit code only).
    if (inlineWarning && !options.silent) {
      process.stderr.write(`${inlineWarning}\n`);
    }
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    // formatCliError surfaces `error.usage` when present, so an over-limit
    // posted-comment field thrown from execution context (findings-file, gate
    // evidence note, structured render) carries the same usage payload as an
    // arg-parse failure — the fail-closed error is actionable everywhere.
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
