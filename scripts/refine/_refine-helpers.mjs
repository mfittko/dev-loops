#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { buildParseError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue } from "../_cli-primitives.mjs";
import { detectRepoSlug, parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson } from "@dev-loops/core/github/gh";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

export const FORBIDDEN_PROSE_PATTERNS = [
  /Child of #/iu,
  /Parent:\s*#/iu,
  /Depends on:\s*#/iu,
  /sub-issue of #/iu,
];

export const DEFAULT_USAGE_SUFFIX = `
Output:
  Default output is human-readable text.
  Add --json for machine-readable JSON.

${JQ_OUTPUT_USAGE}
(--jq/--silent only apply together with --json; the verdict is always in the
payload, never the exit code — a parsed --json run always exits 0 unless
--jq/--silent explicitly turns the verdict into the exit code.)`.trim();

export function parseCheckerCliArgs(argv, usage, checkerName) {
  const parseError = buildParseError(usage);
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      json: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, input: undefined, json: false };
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
    if (token.name === "input") {
      options.input = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "json") {
      options.json = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (typeof options.input !== "string" || options.input.trim().length === 0) {
    throw parseError(`${checkerName} requires --input <path>`);
  }
  return options;
}

export function normalizeTreePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Refinement tree input must be a JSON object");
  }
  const rootIssueNumber = parsePositiveInteger(
    payload.rootIssueNumber ?? payload.root,
    "root issue number",
    (message) => new Error(message),
  );
  if (!Array.isArray(payload.issues) || payload.issues.length === 0) {
    throw new Error("Refinement tree input requires a non-empty issues array");
  }

  const issues = [];
  const byNumber = new Map();
  for (const rawIssue of payload.issues) {
    if (!rawIssue || typeof rawIssue !== "object") {
      throw new Error("Each issue entry must be an object");
    }
    const number = parsePositiveInteger(rawIssue.number, "issue number", (message) => new Error(message));
    const title = typeof rawIssue.title === "string" ? rawIssue.title : "";
    const body = typeof rawIssue.body === "string" ? rawIssue.body : "";
    const state = typeof rawIssue.state === "string" ? rawIssue.state : "open";

    let parentNumber = null;
    if (rawIssue.parentNumber !== undefined && rawIssue.parentNumber !== null) {
      parentNumber = parsePositiveInteger(rawIssue.parentNumber, "parent issue number", (message) => new Error(message));
    }

    const children = Array.isArray(rawIssue.children)
      ? rawIssue.children.map((child) => parsePositiveInteger(child, "child issue number", (message) => new Error(message)))
      : [];

    if (byNumber.has(number)) {
      throw new Error(`Duplicate issue number in tree input: ${number}`);
    }
    const issue = { number, title, body, state, parentNumber, children };
    byNumber.set(number, issue);
    issues.push(issue);
  }

  const edges = [];
  for (const issue of issues) {
    for (const child of issue.children) {
      edges.push({ parent: issue.number, child });
    }
  }

  return {
    mode: payload.mode === "online" ? "online" : "offline",
    repo: typeof payload.repo === "string" ? payload.repo : null,
    rootIssueNumber,
    issues,
    byNumber,
    edges,
  };
}

export async function loadTreeFromInput(inputPath) {
  const raw = await readFile(inputPath, "utf8");
  return normalizeTreePayload(parseJsonText(raw));
}

export async function loadTreeOnline({ issue, repo, cwd = process.cwd(), ghCommand = "gh", env = process.env }) {
  const resolvedRepo = typeof repo === "string" && repo.trim().length > 0
    ? repo.trim()
    : detectRepoSlug(cwd);
  if (!resolvedRepo) {
    throw new Error("Unable to detect repository slug. Pass --repo <owner/name>.");
  }
  const parsed = parseRepoSlug(resolvedRepo, { errorMessage: "--repo must match <owner/name>" });
  const { owner, name } = parsed;

  const byNumber = new Map();
  const edges = [];
  const queuedNumbers = new Set([issue]);
  const queue = [{ number: issue, parentNumber: null }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!Number.isInteger(current.number) || current.number <= 0) {
      continue;
    }

    const issuePayload = await ghJson([
      "api", `repos/${owner}/${name}/issues/${current.number}`,
    ], { ghCommand, env, label: "gh api command" });

    const number = issuePayload?.number;
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Invalid issue payload for #${current.number}`);
    }

    const existing = byNumber.get(number);
    if (!existing) {
      byNumber.set(number, {
        number,
        title: typeof issuePayload.title === "string" ? issuePayload.title : "",
        body: typeof issuePayload.body === "string" ? issuePayload.body : "",
        state: typeof issuePayload.state === "string" ? issuePayload.state : "open",
        parentNumber: current.parentNumber,
        children: [],
      });
    } else if (existing.parentNumber === null && current.parentNumber !== null) {
      existing.parentNumber = current.parentNumber;
    }

    const subIssuesPayload = await ghJson([
      "api", `repos/${owner}/${name}/issues/${number}/sub_issues`,
    ], { ghCommand, env, label: "gh api command" });

    const currentIssue = byNumber.get(number);
    const children = [];
    if (Array.isArray(subIssuesPayload)) {
      for (const entry of subIssuesPayload) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const childNumber = entry.number;
        if (!Number.isInteger(childNumber) || childNumber <= 0) {
          continue;
        }
        children.push(childNumber);
        edges.push({ parent: number, child: childNumber });
        if (!byNumber.has(childNumber) && !queuedNumbers.has(childNumber)) {
          queuedNumbers.add(childNumber);
          queue.push({ number: childNumber, parentNumber: number });
        }
      }
    } else {
      throw new Error(`Invalid sub-issues payload for #${number}: expected array`);
    }

    currentIssue.children = [...new Set(children)];
  }

  return {
    mode: "online",
    repo: resolvedRepo,
    rootIssueNumber: issue,
    issues: [...byNumber.values()],
    byNumber,
    edges,
  };
}

export function extractSection(body, headingText) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, "imu");
  const match = headingPattern.exec(body);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const remaining = body.slice(start);
  const nextHeadingMatch = /^##\s+/imu.exec(remaining);
  const end = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? start + nextHeadingMatch.index
    : body.length;
  return body.slice(start, end).trim();
}

/**
 * Shared base-section checker for the phase-doc-format validators (plan + spike).
 * For each heading, reports its distinct missing_* code when the section is
 * absent or has an empty body. Pure; no side effects.
 *
 * @param {string} markdownText
 * @param {string} checker  checker name echoed back in the result
 * @param {Record<string,string>} sectionCodes  heading → missing_* code (key order = section order)
 * @returns {{ checker: string, ok: boolean, errors: { code: string, message: string }[] }}
 */
export function checkBaseSections(markdownText, checker, sectionCodes) {
  const errors = [];
  for (const [heading, code] of Object.entries(sectionCodes)) {
    if (!extractSection(markdownText, heading)) {
      errors.push({ code, message: `Missing or empty ## ${heading} section.` });
    }
  }
  return { checker, ok: errors.length === 0, errors };
}

export function normalizeScopeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, "")
    .replace(/^[:\-\s]+|[:\-\s]+$/gu, "")
    .replace(/\s+/gu, " ");
}

// Returns the process exit code to use. Documented contract: the verdict lives
// in the payload, not the exit code — a parsed --json run exits 0 even when
// result.ok is false, unless --jq/--silent explicitly turns the verdict into
// the exit code (predicate/--silent semantics from the shared jq-output contract).
export function writeCheckerOutput(result, { stdout = process.stdout, stderr = process.stderr, json = false, jq, silent }) {
  if (json) {
    return emitResult(result, { jq, silent, stdout, stderr, ok: true });
  }

  const status = result.ok ? "PASS" : "FAIL";
  const lines = [`${result.checker}: ${status}`];
  if (result.errors.length === 0) {
    lines.push("  - No problems found.");
  } else {
    for (const error of result.errors) {
      const issuePart = Number.isInteger(error.issue) ? ` (#${error.issue})` : "";
      lines.push(`  - [${error.code}]${issuePart} ${error.message}`);
    }
  }
  stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// Re-exported for checker scripts
export { isDirectCliRun };
