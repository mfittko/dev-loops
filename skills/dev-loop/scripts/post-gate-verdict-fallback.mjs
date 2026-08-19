#!/usr/bin/env node
// post-gate-verdict-fallback.mjs
//
// Minimal gate-verdict-comment poster for the fallback path used when the
// `@dev-loops/core` package is not installed in the consumer repo and the
// full `scripts/github/upsert-checkpoint-verdict.mjs` helper is therefore
// unavailable. Posts the same visible comment format as the full helper, but
// without the full helper's idempotent same-head update, stale-head detection,
// gate-coordination validation, or internal-only PR short-circuit.
//
// Contract reference: skills/docs/gate-review-comment-contract.md (rendered body must
// remain parser-stable for gate name and head SHA).
//
// Degraded semantics (vs. the full helper):
//   - one-shot create only; no idempotent same-head update
//   - no stale-head detection against existing comments
//   - no gate-coordination state validation
//   - no blocking-severity count enforcement (caller is responsible)
//   - no internal-only PR short-circuit
//
// The script always emits a stderr warning explaining that fallback mode is
// active and the audit trail is degraded. On posting failure it fails closed
// with a non-zero exit so the calling agent does not silently proceed past
// the gate-comment requirement.

import { readFile } from "node:fs/promises";
import { spawn as defaultSpawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const GATE_NAMES = new Set(["draft_gate", "pre_approval_gate"]);
const VERDICTS = new Set(["clean", "findings_present", "blocked"]);
function isSafeRepoSegment(segment) {
  return typeof segment === "string"
    && segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !/[\\/]/.test(segment)
    && !/\s/.test(segment);
}

function isValidRepoSlug(repo) {
  if (typeof repo !== "string") return false;
  const trimmed = repo.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2) return false;
  return isSafeRepoSegment(parts[0]) && isSafeRepoSegment(parts[1]);
}
// FULL head commit SHA only (40-hex SHA-1 / 64-hex SHA-2). This poster writes the
// same `**Reviewed head SHA:**` marker the pre-merge reader parses and compares by
// equality against the resolved full head SHA, so a short prefix would reproduce the
// unfindable/never-current marker block. Mirrors scripts/lib/head-sha.mjs, inlined
// because this fallback ships in the plugin (zero-dep, cannot import scripts/lib).
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const USAGE = `Usage: post-gate-verdict-fallback.mjs --repo <owner/name> --pr <number> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings-summary <text> | --findings-file <path>) --next-action <text> [--gate <draft_gate|pre_approval_gate>] [--gh-command <path>]
Minimal fallback poster for draft_gate / pre_approval_gate checkpoint verdict comments.
Use only when @dev-loops/core is not installed; otherwise prefer scripts/github/upsert-checkpoint-verdict.mjs.
Required:
  --repo <owner/name>
  --pr <number>
  --head-sha <sha>                            FULL head commit SHA (40 or 64 hex chars) — a short prefix is rejected
  --verdict <clean|findings_present|blocked>
  --findings-summary <text>                 Single-line summary
  --findings-file <path>                    Read summary from file (preserves
                                            newlines; takes precedence when
                                            both are provided)
  --next-action <text>
Optional:
  --gate <draft_gate|pre_approval_gate>     Defaults to draft_gate
  --gh-command <path>                       Defaults to "gh"
Output (stdout, JSON):
  {
    "ok": true,
    "action": "created",
    "repo": "owner/repo",
    "pr": 17,
    "gate": "draft_gate",
    "headSha": "abc1234",
    "commentId": 101,
    "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101",
    "fallback": true,
    "warning": "..."
  }
Exit codes:
  0  Success
  1  Argument error or gh failure`.trim();

export function buildParseError(usage) {
  return (message) => {
    const error = new Error(message);
    error.usage = usage;
    return error;
  };
}

function requireOptionValue(args, flag, parseError) {
  // Peek at the next token without consuming it so we can detect a flag-like next value
  // and fail with a clearer error rather than treating it as the current flag's value.
  if (args.length === 0) {
    throw parseError(`${flag} requires a non-empty value`);
  }
  const next = args[0];
  if (typeof next !== "string" || next.length === 0 || /^-/u.test(next)) {
    throw parseError(`${flag} requires a non-empty value (got ${JSON.stringify(next)})`);
  }
  return args.shift();
}

function normalizeRepoSlug(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isValidRepoSlug(trimmed) ? trimmed : null;
}

function normalizePrNumber(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number.parseInt(trimmed, 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function normalizeHeadSha(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return SHA_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeGate(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return GATE_NAMES.has(normalized) ? normalized : null;
}

function normalizeVerdict(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VERDICTS.has(normalized) ? normalized : null;
}

function normalizeRequiredText(value, flag, parseError) {
  if (typeof value !== "string") {
    throw parseError(`${flag} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw parseError(`${flag} must be a non-empty string`);
  }
  return trimmed;
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

// Entity-encode the two literal delimiters a machine-artifact marker opens/closes
// on (see packages/core/src/github/copilot-helpers.mjs's isGateMachineArtifactBody)
// so a free-text field can never quote one at column 0 of a rendered verdict comment
// and get the whole comment mistaken for a machine artifact by the shared summarizers.
// Hand-copied from scripts/github/upsert-checkpoint-verdict.mjs's
// encodeMachineArtifactMarkerDelimiters — this fallback is zero-dep and cannot import it.
// ISSUE/PR-ID GUARD (zero-dep inline copy of packages/core/src/github/comment-id-guard.mjs,
// which this fallback cannot import — it ships in the plugin without @dev-loops/core). A
// generated gate verdict body must never carry a raw `#<digits>` token: public comment
// surfaces auto-link a bare `#<digits>` to that issue/PR, leaking internal cross-references.
// Fail-closed: refuse to POST rather than strip. The full helper offers an
// allowed-refs escape for deliberate cross-references; this degraded fallback
// deliberately omits it — an emergency posting path should stay maximally
// strict, and a body needing a cross-reference can use the full helper.
// A match is excluded only when it forms a well-formed HTML numeric character
// reference — preceded by `&` AND immediately followed by `;` (e.g. `&#91;`,
// the entity-encoded form of `[`). Extraction mirrors the shared copy's
// decode-aware behavior: the body is also scanned after a single
// renderer-like entity decode (numeric references, the named hash and
// ampersand entities — `&amp;` consumed so double-encoded forms stay inert;
// named-entity case-variants decoded as deliberate over-refusal), so a hash
// or digit smuggled as an entity still refuses.
const ISSUE_PR_ID_RE = /#(\d{1,9})/gu;
const DECODABLE_ENTITY_RE = /&(?:#(?:\d{1,7}|x[0-9a-f]{1,6})|num|amp);/giu;
function decodeRenderedText(body) {
  return body.replace(DECODABLE_ENTITY_RE, (entity) => {
    const inner = entity.slice(1, -1).toLowerCase();
    if (inner === "num") return "#";
    if (inner === "amp") return "&";
    const code = inner[1] === "x" ? Number.parseInt(inner.slice(2), 16) : Number.parseInt(inner.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return entity;
    }
  });
}
function isNumericCharacterReference(body, match) {
  return body[match.index - 1] === "&" && body[match.index + match[0].length] === ";";
}
function collectBareIds(text, found) {
  for (const m of text.matchAll(ISSUE_PR_ID_RE)) {
    if (isNumericCharacterReference(text, m)) continue;
    found.push(m[1]);
  }
}
function guardFallbackBodyNoIssuePrIds(body, ctx) {
  if (typeof body !== "string") return body;
  const found = [];
  collectBareIds(String(body), found);
  const decoded = decodeRenderedText(String(body));
  if (decoded !== String(body)) collectBareIds(decoded, found);
  if (found.length > 0) {
    const unique = [...new Set(found)].join(", #");
    throw new Error(
      `post-gate-verdict-fallback refused to post ${ctx}: rendered gate verdict body contains raw ` +
        `issue/PR id reference(s) #${unique}. Bare #digits in generated comment bodies violate ` +
        `the no-ids-in-comments rule (public leakage). Reword the findings summary / next action ` +
        `to avoid a raw #<digits>.`,
    );
  }
  return body;
}

function encodeMachineArtifactMarkerDelimiters(value) {
  return value.replace(/<!--/gu, "&lt;!--").replace(/-->/gu, "--&gt;");
}

// Blockquote-prefix every continuation line (2nd line onward) of the
// newline-preserving findings summary (--findings-file content) before it is
// spliced into the rendered comment body. The shared field parser
// (packages/core's parseGateReviewCommentFields, via stripGateCommentMarkdown)
// trims each line and strips `#`/`**` but NOT a leading "> ", so a
// reviewer-controlled line inside the file — e.g. "Execution mode:
// fanout_fanin" or "Next action: <spoof>" at column 0 — can never reach
// column 0 of its own logical line and match a field regex. Applied AFTER
// truncation/marker-delimiter-encoding so the blockquote markers never count
// against the field's length budget or get re-encoded. Hand-copied from
// scripts/github/upsert-checkpoint-verdict.mjs's blockquoteContinuationLines —
// this fallback is zero-dep and cannot import it.
function blockquoteContinuationLines(value) {
  const lines = String(value).split(/\r?\n/u);
  if (lines.length <= 1) {
    return value;
  }
  return [lines[0], ...lines.slice(1).map((line) => `> ${line}`)].join("\n");
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

export function parsePostGateVerdictFallbackCliArgs(argv, { parseError } = {}) {
  const parseErr = parseError ?? buildParseError(USAGE);
  const args = [...argv];
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    verdict: undefined,
    findingsSummary: undefined,
    findingsFile: undefined,
    nextAction: undefined,
    ghCommand: undefined,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--repo") {
      const repo = normalizeRepoSlug(requireOptionValue(args, "--repo", parseErr));
      if (!repo) {
        throw parseErr("--repo must be of the form owner/name: each segment must be non-empty, must not be \".\" or \"..\", and must not contain whitespace, slashes, or backslashes");
      }
      options.repo = repo;
      continue;
    }
    if (token === "--pr") {
      const pr = normalizePrNumber(requireOptionValue(args, "--pr", parseErr));
      if (!pr) {
        throw parseErr("--pr must be a positive integer");
      }
      options.pr = pr;
      continue;
    }
    if (token === "--head-sha") {
      const headSha = normalizeHeadSha(requireOptionValue(args, "--head-sha", parseErr));
      if (!headSha) {
        throw parseErr("--head-sha must be the FULL head commit SHA (40 or 64 hex chars), not a short prefix — the gate marker is keyed by it and the pre-merge check resolves the full head SHA");
      }
      options.headSha = headSha;
      continue;
    }
    if (token === "--gate") {
      const gate = normalizeGate(requireOptionValue(args, "--gate", parseErr));
      if (!gate) {
        throw parseErr("--gate must be one of: draft_gate, pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token === "--verdict") {
      const verdict = normalizeVerdict(requireOptionValue(args, "--verdict", parseErr));
      if (!verdict) {
        throw parseErr("--verdict must be one of: clean, findings_present, blocked");
      }
      options.verdict = verdict;
      continue;
    }
    if (token === "--findings-summary") {
      options.findingsSummary = normalizeRequiredText(
        requireOptionValue(args, "--findings-summary", parseErr),
        "--findings-summary",
        parseErr,
      );
      continue;
    }
    if (token === "--findings-file") {
      const rawPath = requireOptionValue(args, "--findings-file", parseErr).trim();
      if (rawPath.length === 0) {
        throw parseErr("--findings-file must be a non-empty path");
      }
      options.findingsFile = rawPath;
      continue;
    }
    if (token === "--next-action") {
      // collapseWhitespace (not just trim) for parity with the full helper's
      // normalizeRequiredText: without it this field alone would preserve
      // internal newlines, letting a caller-supplied --next-action carry an
      // embedded "Execution mode: fanout_fanin" (or similar) line at column 0.
      options.nextAction = collapseWhitespace(
        normalizeRequiredText(
          requireOptionValue(args, "--next-action", parseErr),
          "--next-action",
          parseErr,
        ),
      );
      continue;
    }
    if (token === "--gh-command") {
      const cmd = requireOptionValue(args, "--gh-command", parseErr).trim();
      if (cmd.length === 0) {
        throw parseErr("--gh-command must be a non-empty path or executable name");
      }
      options.ghCommand = cmd;
      continue;
    }
    throw parseErr(`Unknown argument: ${token}`);
  }

  const required = ["repo", "pr", "headSha", "verdict", "nextAction"];
  const missing = required.filter((key) => options[key] === undefined);
  if (options.findingsSummary === undefined && options.findingsFile === undefined) {
    missing.push("findingsSummary|findingsFile");
  }
  if (missing.length > 0) {
    throw parseErr(
      `post-gate-verdict-fallback requires --repo, --pr, --head-sha, --verdict, --next-action, and either --findings-summary or --findings-file (missing: ${missing.join(", ")})`,
    );
  }

  if (options.gate === undefined) {
    options.gate = "draft_gate";
  }

  return options;
}

// Per-field cap for findingsSummary when read from --findings-file or supplied inline.
// Mirrors the full helper's MAX_GATE_COMMENT_TEXT_LENGTH behavior so a large file cannot
// blow out the rendered comment; the full template structure (gate name, head SHA, verdict,
// next action) is always preserved so parseGateReviewCommentBody() stays deterministic.
const MAX_FINDINGS_SUMMARY_LENGTH = 2000;

/**
 * Render the visible gate-review comment body in the same parser-stable
 * format used by `scripts/github/upsert-checkpoint-verdict.mjs`'s
 * `renderGateReviewCommentBody`. Mirrors that helper's shape so the existing
 * detectors can still parse gate name and head SHA out of fallback comments.
 */
export function renderFallbackGateReviewCommentBody({
  gate,
  headSha,
  verdict,
  findingsSummary,
  nextAction,
  blockCleanOnFindingSeverities,
}) {
  const summary = blockquoteContinuationLines(
    encodeMachineArtifactMarkerDelimiters(
      smartTruncate(String(findingsSummary ?? ""), MAX_FINDINGS_SUMMARY_LENGTH),
    ),
  );
  const lines = [
    `### Gate review: \`${gate}\``,
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    `**Verdict:** ${verdict}`,
  ];
  if (
    (verdict === "findings_present" || verdict === "blocked")
    && Array.isArray(blockCleanOnFindingSeverities)
    && blockCleanOnFindingSeverities.length > 0
  ) {
    const sevs = blockCleanOnFindingSeverities.join(", ");
    lines.push(`**Blocking severities:** ${sevs} (clean requires no findings matching these severities)`);
  }
  lines.push(
    "",
    `**Findings summary:** ${summary}`,
    "",
    `**Next action:** ${encodeMachineArtifactMarkerDelimiters(String(nextAction ?? ""))}`,
  );
  return lines.join("\n");
}

async function resolveFindingsSummary(options, { parseError }) {
  if (typeof options.findingsFile === "string" && options.findingsFile.length > 0) {
    let content;
    try {
      content = await readFile(options.findingsFile, "utf8");
    } catch (err) {
      throw parseError(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // Match the full helper's --findings-file semantics: trim only trailing newlines so the
    // summary preserves its internal newlines and any intentional leading content. Reject
    // whitespace-only files via a separate .trim()-based emptiness check.
    const trimmedTrailing = content.replace(/\n+$/, "");
    if (trimmedTrailing.trim().length === 0) {
      throw parseError(`--findings-file "${options.findingsFile}" is empty or contains only whitespace`);
    }
    return trimmedTrailing;
  }
  if (typeof options.findingsSummary === "string" && options.findingsSummary.length > 0) {
    // Single-line summaries only; multi-line must use --findings-file.
    return collapseWhitespace(options.findingsSummary);
  }
  throw parseError("post-gate-verdict-fallback requires either --findings-summary or --findings-file");
}

export async function postGateVerdictViaGh({
  repo,
  pr,
  body,
  env = process.env,
  ghCommand = "gh",
  spawnImpl = defaultSpawn,
}) {
  return new Promise((resolve, reject) => {
    // Fail-closed id guard applied immediately before the POST: refuse to emit
    // a rendered body that carries any raw #<digits> (see guardFallbackBodyNoIssuePrIds).
    guardFallbackBodyNoIssuePrIds(body, "gate verdict comment");
    const payload = JSON.stringify({ body });
    const child = spawnImpl(
      ghCommand,
      ["api", "--method", "POST", "-H", "Content-Type: application/json", "--input", "-", `repos/${repo}/issues/${pr}/comments`],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(new Error(`gh api failed to spawn: ${err instanceof Error ? err.message : String(err)}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`gh api failed to post gate verdict comment for ${repo}#${pr}: ${detail}`));
        return;
      }
      let responsePayload;
      try {
        responsePayload = JSON.parse(stdout);
      } catch (err) {
        reject(new Error(`gh api returned non-JSON response for ${repo}#${pr}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const commentId = Number.isInteger(responsePayload?.id) ? responsePayload.id : null;
      const commentUrl = typeof responsePayload?.html_url === "string" && responsePayload.html_url.length > 0
        ? responsePayload.html_url
        : null;
      if (commentId === null || commentUrl === null) {
        reject(new Error(`gh api response missing comment id/html_url for ${repo}#${pr}: ${stdout.trim().slice(0, 200)}`));
        return;
      }
      resolve({ commentId, commentUrl });
    });
    child.stdin.end(payload);
  });
}

export function buildFallbackWarning() {
  return [
    "[post-gate-verdict-fallback] WARNING: fallback mode active.",
    "The full @dev-loops/core helper (scripts/github/upsert-checkpoint-verdict.mjs) was not available,",
    "so this comment was posted via the degraded gh-only fallback poster.",
    "Audit trail is degraded: no idempotent same-head update, no stale-head detection,",
    "no gate-coordination validation, no internal-only PR short-circuit, no blocking-severity count enforcement.",
    "Install @dev-loops/core to restore full gate-comment semantics.",
  ].join(" ");
}

/**
 * Programmatic entry point. Resolves CLI args, renders the visible body,
 * posts via gh, and emits a stderr warning explaining the degraded audit
 * trail. Throws on argument errors or gh failures (fail-closed).
 */
export async function runCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    spawn = defaultSpawn,
    ghCommand,
    stdoutSink,
    stderrSink,
    parseErrorFactory,
  } = {},
) {
  const parseError = parseErrorFactory ?? buildParseError(USAGE);
  const options = parsePostGateVerdictFallbackCliArgs(argv, { parseError });
  const findingsSummary = await resolveFindingsSummary(options, { parseError });
  const body = renderFallbackGateReviewCommentBody({
    gate: options.gate,
    headSha: options.headSha,
    verdict: options.verdict,
    findingsSummary,
    nextAction: options.nextAction,
  });
  const warning = buildFallbackWarning();
  if (stderrSink && Array.isArray(stderrSink)) {
    stderrSink.push(`${warning}\n`);
  } else {
    process.stderr.write(`${warning}\n`);
  }
  const { commentId, commentUrl } = await postGateVerdictViaGh({
    repo: options.repo,
    pr: options.pr,
    body,
    env,
    ghCommand: ghCommand ?? options.ghCommand ?? "gh",
    spawnImpl: spawn,
  });
  const result = {
    ok: true,
    action: "created",
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    commentId,
    commentUrl,
    fallback: true,
    warning,
  };
  if (stdoutSink && Array.isArray(stdoutSink)) {
    stdoutSink.push(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error?.usage) {
      process.stderr.write(`${error.usage}\n`);
    }
    process.exitCode = 1;
  });
}
