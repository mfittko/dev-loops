#!/usr/bin/env node
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGatePostFindingsComments } from "@dev-loops/core/config";

const USAGE = `Usage: post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --findings <json>
Post (or idempotently update) a visible, marker-tagged PR issue comment that lists the
consolidated gate fan-out findings, grouped by severity. Re-running for the same
gate + head updates the existing comment instead of duplicating it.

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

function validateRepo(repo) {
  const parts = String(repo).split("/");
  if (parts.length !== 2 || parts.some(p => p.length === 0)) {
    throw parseError(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
  }
  for (const p of parts) {
    if (p === "." || p === ".." || /[\s\\]/.test(p)) {
      throw parseError(`--repo segment ${JSON.stringify(p)} contains unsafe characters (dots, whitespace, or backslashes)`);
    }
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

// Hidden marker keyed by gate + head. Re-running for the same gate/head finds and
// updates the same comment instead of posting a duplicate. The HTML comment is not
// rendered by GitHub but is matched on the comment body.
export function buildFindingsMarker({ gate, headSha }) {
  return `<!-- dev-loops:gate-findings gate=${gate} head=${headSha} -->`;
}

export function renderFindingsCommentBody({ gate, headSha, findings }) {
  const marker = buildFindingsMarker({ gate, headSha });
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
      const dispositionSuffix = finding.disposition ? ` — _${finding.disposition}_` : "";
      // angle is a code/label literal → backticks; summary is prose.
      lines.push(`- \`${finding.angle}\`: ${finding.summary}${dispositionSuffix}`);
      if (Array.isArray(finding.files) && finding.files.length > 0) {
        // File refs as plain text path:line so they stay readable; paths use backticks.
        const refs = finding.files.map(f => `\`${f}\``).join(", ");
        lines.push(`  - files: ${refs}`);
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
  const { config } = await loadDevLoopConfig({ repoRoot });
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
  const marker = buildFindingsMarker({ gate: options.gate, headSha: options.headSha });
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
