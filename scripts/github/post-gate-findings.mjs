#!/usr/bin/env node
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGatePostFindingsComments } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";

const USAGE = `Usage: post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --findings <json>
Post (or idempotently update) a visible, marker-tagged PR issue comment that lists the
consolidated gate fan-out findings, grouped by severity. The comment is idempotent
per gate: there is exactly one comment per gate, updated in place on each run
(the reviewed head is shown in the body) instead of duplicating it.

The disposition ledger (write-gate-findings-log.mjs) is the durable source of truth and is
written regardless of this comment. This helper only posts the auditable PR summary, and
no-ops when gates.postFindingsComments is set to false in config.

Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>                 Current head SHA or hexadecimal prefix
  --findings <json>                JSON array of findings in the findings-log shape
                                   ([{severity, angle, summary, disposition?, files?}])
Output (stdout, JSON):
  { "ok": true, "action": "created"|"updated"|"noop"|"skipped", ... }
Exit codes:
  0  Success
  1  Argument error or gh failure`.trim();

const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
// Severity ordering for grouped rendering (most-blocking first).
const SEVERITY_ORDER = ["must-fix", "worth-fixing-now", "defer"];
const SEVERITY_LABELS = {
  "must-fix": "Must fix",
  "worth-fixing-now": "Worth fixing now",
  "defer": "Defer",
};

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function normalizeGate(value) {
  const gates = new Set(["draft_gate", "pre_approval_gate"]);
  const normalized = String(value).trim().toLowerCase();
  return gates.has(normalized) ? normalized : null;
}

function normalizeHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

// Validate via the centralized repo-slug validator shared by sibling GitHub
// scripts (parseRepoSlug). It enforces owner/name structure and rejects unsafe
// segments (".", "..", slashes, whitespace); we re-throw as a parseError so the
// CLI usage banner is preserved.
function validateRepo(repo) {
  try {
    parseRepoSlug(repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return repo;
}

export function parseFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--findings must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw parseError("--findings must be a JSON array");
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object") {
      throw parseError(`--findings[${i}] must be an object`);
    }
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      throw parseError(`--findings[${i}].severity must be one of: must-fix, worth-fixing-now, defer`);
    }
    if (!f.angle || typeof f.angle !== "string" || f.angle.trim().length === 0) {
      throw parseError(`--findings[${i}].angle is required`);
    }
    if (!f.summary || typeof f.summary !== "string" || f.summary.trim().length === 0) {
      throw parseError(`--findings[${i}].summary is required`);
    }
    const entry = {
      severity: f.severity,
      angle: f.angle.trim(),
      summary: f.summary.trim(),
    };
    if ("disposition" in f && typeof f.disposition === "string" && f.disposition.trim().length > 0) {
      entry.disposition = f.disposition.trim();
    }
    if (Array.isArray(f.files)) {
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
    }
    return entry;
  });
}

export function parsePostGateFindingsCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    findings: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = validateRepo(requireOptionValue(args, "--repo", parseError).trim());
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    if (token === "--gate") {
      const gate = normalizeGate(requireOptionValue(args, "--gate", parseError));
      if (!gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
      options.gate = gate;
      continue;
    }
    if (token === "--head-sha") {
      const sha = normalizeHeadSha(requireOptionValue(args, "--head-sha", parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token === "--findings") {
      options.findings = requireOptionValue(args, "--findings", parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  const missing = ["repo", "pr", "gate", "headSha", "findings"]
    .filter(k => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  return options;
}

// Hidden marker keyed by GATE ONLY. There is exactly one findings comment per
// gate, updated in place each run. The marker deliberately does NOT include the
// head SHA: --head-sha accepts any 7-64 hex prefix, so keying on its literal
// value would let a different prefix length (or the full SHA) for the same head
// miss the marker and post a duplicate. The reviewed head is still shown in the
// comment body for context. The HTML comment is not rendered by GitHub but is
// matched on the comment body.
export function buildFindingsMarker({ gate }) {
  return `<!-- dev-loops:gate-findings gate=${gate} -->`;
}

// Collapse any run of whitespace (newlines, tabs, repeated spaces) to a single
// space and trim. LLM-generated free text often carries embedded newlines, which
// would otherwise break a single Markdown list item across lines.
//
// Additionally neutralize any embedded HTML-comment delimiters (`<!--` / `-->`).
// The findings comment is keyed by a hidden marker that IS an HTML comment
// (buildFindingsMarker), and free text comes from scoped-review agents. Without
// this, a finding field could inject a second `<!-- dev-loops:gate-findings ... -->`
// marker (breaking idempotent comment matching) or otherwise smuggle an HTML
// comment into the rendered body. We escape the opening/closing angle brackets so
// the delimiter renders as visible literal text and cannot form a real comment.
function sanitizeInline(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .trim();
}

// Sanitize free text that is rendered INSIDE an inline backtick code span
// (`angle`, file refs). On top of sanitizeInline, strip any literal backtick:
// a backtick inside the span would prematurely close it, breaking out into raw
// Markdown (injection) for the remainder of the list item. Backticks are never
// meaningful in an angle label or a file path, so dropping them is safe.
function sanitizeCodeSpan(value) {
  return sanitizeInline(String(value).replace(/`/g, ""));
}

export function renderFindingsCommentBody({ gate, headSha, findings }) {
  const marker = buildFindingsMarker({ gate });
  const lines = [
    marker,
    `### Gate fan-out findings: ${gate}`,
    "",
    // Plain text head SHA (no backticks) so GitHub autolinks the commit.
    `Reviewed head: ${headSha}`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No findings. All review angles passed for this head.");
    return lines.join("\n");
  }
  const grouped = new Map();
  for (const sev of SEVERITY_ORDER) {
    grouped.set(sev, []);
  }
  for (const finding of findings) {
    grouped.get(finding.severity).push(finding);
  }
  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev);
    if (group.length === 0) continue;
    lines.push(`#### ${SEVERITY_LABELS[sev]} (${group.length})`);
    for (const finding of group) {
      // Sanitize free-text fields so embedded newlines/whitespace don't break
      // the single-line Markdown list item.
      const summary = sanitizeInline(finding.summary);
      const dispositionSuffix = finding.disposition ? ` — _${sanitizeInline(finding.disposition)}_` : "";
      // angle is a code/label literal → backticks; summary is prose. angle is
      // free text from a scoped-review agent and is rendered inside an inline
      // code span, so it must be sanitized too: an embedded backtick or newline
      // would otherwise break the code span (markdown injection) or split the
      // list item. Use sanitizeCodeSpan (backtick-stripping) since it lives
      // inside backticks, consistent with the file refs below.
      const angle = sanitizeCodeSpan(finding.angle);
      lines.push(`- \`${angle}\`: ${summary}${dispositionSuffix}`);
      if (Array.isArray(finding.files) && finding.files.length > 0) {
        // File refs go inside backticks; sanitize each so embedded whitespace,
        // newlines, or backticks can't break the single Markdown list item /
        // code span, and drop any that sanitize to empty.
        const refs = finding.files
          .map(f => sanitizeCodeSpan(f))
          .filter(f => f.length > 0)
          .map(f => `\`${f}\``)
          .join(", ");
        if (refs.length > 0) {
          lines.push(`  - files: ${refs}`);
        }
      }
    }
    lines.push("");
  }
  // Drop trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 3).join(" ")}` });
}

async function listIssueComments({ repo, pr }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
    { env, ghCommand },
  );
  // --slurp returns an array of pages; flatten to a single comment list.
  if (Array.isArray(payload) && payload.every(p => Array.isArray(p))) {
    return payload.flat();
  }
  return Array.isArray(payload) ? payload : [];
}

function findMarkedComment(comments, marker) {
  for (const comment of comments) {
    if (comment && typeof comment.body === "string" && comment.body.includes(marker)) {
      return comment;
    }
  }
  return null;
}

function parseCommentMutationResponse(payload) {
  const commentId = Number.isInteger(payload?.id) ? payload.id : null;
  const commentUrl = typeof payload?.html_url === "string" && payload.html_url.trim().length > 0
    ? payload.html_url.trim()
    : null;
  if (commentId === null || commentUrl === null) {
    throw new Error("Gate findings comment mutation did not return a comment id and html_url");
  }
  return { commentId, commentUrl };
}

async function createComment({ repo, pr, body }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

async function updateComment({ repo, commentId, body }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

export async function postGateFindings(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const findings = parseFindings(options.findings);
  // loadDevLoopConfig never throws: it returns { config, warnings, errors }.
  // A non-empty errors array means the config could not be loaded/validated, so
  // log it (stderr) and fall back to default behavior (config-unavailable →
  // null → resolveGatePostFindingsComments defaults on → proceed to post),
  // rather than trusting a malformed/partial config object. Mirrors how
  // detect-checkpoint-evidence treats config-unavailable.
  const { config: loadedConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
  let config = loadedConfig;
  if (Array.isArray(configErrors) && configErrors.length > 0) {
    process.stderr.write(
      `post-gate-findings: dev-loop config could not be loaded/validated; using default behavior. errors=${JSON.stringify(configErrors)}\n`,
    );
    config = null;
  }
  if (!resolveGatePostFindingsComments(config)) {
    return {
      ok: true,
      action: "skipped",
      reason: "gates.postFindingsComments is false",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.headSha,
      findingsCount: findings.length,
    };
  }
  const marker = buildFindingsMarker({ gate: options.gate });
  const desiredBody = renderFindingsCommentBody({ gate: options.gate, headSha: options.headSha, findings });
  const comments = await listIssueComments({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const existing = findMarkedComment(comments, marker);
  const base = {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    findingsCount: findings.length,
  };
  if (existing) {
    if (typeof existing.body === "string" && existing.body === desiredBody) {
      return {
        ...base,
        action: "noop",
        commentId: Number.isInteger(existing.id) ? existing.id : null,
        commentUrl: typeof existing.html_url === "string" ? existing.html_url : null,
      };
    }
    const updated = await updateComment({ repo: options.repo, commentId: existing.id, body: desiredBody }, { env, ghCommand });
    return { ...base, action: "updated", ...updated };
  }
  const created = await createComment({ repo: options.repo, pr: options.pr, body: desiredBody }, { env, ghCommand });
  return { ...base, action: "created", ...created };
}

async function main() {
  let options;
  try {
    options = parsePostGateFindingsCliArgs(process.argv.slice(2));
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
    const result = await postGateFindings(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
